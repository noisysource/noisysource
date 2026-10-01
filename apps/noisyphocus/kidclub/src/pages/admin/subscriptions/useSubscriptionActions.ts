import { useState } from 'react';
import { getDocs, updateDoc, deleteDoc, deleteField, query, where } from 'firebase/firestore';
import { col, docRef } from '../../../lib/db';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import { DiscountRule, AppliedDiscount } from '@shared/models/Discount';
import { applyDiscounts } from '../../../services/discountService';
import { SubStatus, normalizeEmail } from '../../../lib/utils';
import { SubItem, subCollection, isLegacyPricing } from './model';
import { AdminData } from './useAdminData';
import { familyService } from '../../../services/familyService';

const STATUS_LABEL: Record<SubStatus, string> = { pending: 'Pendente', active: 'Ativa', cancelled: 'Cancelada' };

/**
 * What a status change sets off beyond the field itself, spelled out before
 * the admin confirms it. The email rules mirror functions/src/kidclub/
 * notifications.ts (only transitions OUT of pending send anything); the rest
 * is the triggers every subscription write fires.
 */
export function statusChangeEffects(from: SubStatus, to: SubStatus): string[] {
  const effects: string[] = [];
  if (from === 'pending' && to === 'active') effects.push('Envia ao encarregado o email "Inscrição aprovada".');
  if (from === 'pending' && to === 'cancelled') effects.push('Envia ao encarregado um email de recusa, com o motivo indicado.');
  if (to === 'active') effects.push('Gera os eventos do calendário e recalcula as cobranças pendentes.');
  if (to === 'cancelled') effects.push('Fecha a inscrição a partir de hoje: o resto do mês conta como ausência, os meses seguintes deixam de ser cobrados.');
  if (to === 'pending' && from === 'active') effects.push('Recalcula as cobranças pendentes desta família.');
  return effects;
}

/**
 * Every write the page makes to a subscription document. Each one fires the
 * backend triggers (discount recalc, billing recompute of `pending` bills,
 * event regeneration), so each writes only the fields it changes.
 */
export function useSubscriptionActions(data: Pick<AdminData, 'setItems' | 'reload' | 'transportConfig' | 'studyConfig'>) {
  const { setItems, reload, transportConfig, studyConfig } = data;
  const [processing, setProcessing] = useState<string | null>(null);

  const patchItem = (id: string, patch: Partial<SubItem>) =>
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));

  // One direct status control, no approve/offer/reject/revert gating workflow.
  // Admin can set any subscription to any of the 3 states freely — but is told
  // first what the change sets off, since two of the transitions email the
  // parent.
  const setStatus = async (item: SubItem, newStatus: SubStatus, opts: { skipConfirm?: boolean } = {}) => {
    if (item.status === newStatus) return;
    let reason: string | undefined;
    if (!opts.skipConfirm) {
      const effects = statusChangeEffects(item.status, newStatus);
      const msg = `${item.childName} · ${item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}\n`
        + `${STATUS_LABEL[item.status]} → ${STATUS_LABEL[newStatus]}\n\n`
        + (effects.length ? effects.map(e => `• ${e}`).join('\n') : 'Sem outros efeitos.');
      if (newStatus === 'cancelled') {
        const answer = window.prompt(`${msg}\n\nMotivo (opcional):`, item.statusReason ?? '');
        if (answer === null) return;
        reason = answer.trim();
      } else if (!window.confirm(msg)) {
        return;
      }
    }
    setProcessing(item.id);
    try {
      const patch: Record<string, unknown> = { status: newStatus, updatedAt: new Date() };
      if (newStatus === 'active') patch.approvedAt = new Date();
      if (newStatus === 'cancelled') patch.cancelledAt = new Date();
      if (newStatus === 'pending') patch.approvedAt = null;
      if (reason) patch.statusReason = reason;

      // Same convenience the old approve() had — try to auto-resolve familyId
      // by contact email if not yet linked. Doesn't gate the status change.
      if (!item.familyId && item.contactEmail) {
        const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', normalizeEmail(item.contactEmail))));
        if (!famSnap.empty) {
          patch.familyId = famSnap.docs[0].id;
          // Linking by familyId alone leaves the sub invisible to the parent
          // (portal + rules match on userId) — carry the family owner over.
          const ownerUid = famSnap.docs[0].data().primaryContact?.userId;
          if (ownerUid) patch.userId = ownerUid;
        }
      }

      // Already linked to a family — flag this change for the parent to review
      // on next login (in-app only, replaces the old offered-status email dance).
      // Exception: activating a subscription the client already confirmed
      // fulfills what they agreed to — it's not a new change for them to
      // review, so don't re-raise clientReviewPending here or they'd get
      // looped back into "please review" for something they already
      // accepted. Clear the review flags instead, same as resolving the
      // "✅ Confirmado — ativar" badge directly.
      const linked = item.familyId || (patch.familyId as string | undefined);
      const fulfillsClientConfirmation = newStatus === 'active' && item.lastClientAction === 'confirmed';
      if (fulfillsClientConfirmation) {
        patch.adminReviewPending = false;
        patch.lastClientAction = deleteField();
      } else if (linked) {
        patch.clientReviewPending = true;
      }

      await updateDoc(docRef(subCollection(item), item.id), patch);
      patchItem(item.id, {
        status: newStatus,
        ...(reason ? { statusReason: reason } : {}),
        familyId: (patch.familyId as string | undefined) ?? item.familyId,
        clientReviewPending: fulfillsClientConfirmation ? item.clientReviewPending : (linked ? true : item.clientReviewPending),
        adminReviewPending: fulfillsClientConfirmation ? false : item.adminReviewPending,
        lastClientAction: fulfillsClientConfirmation ? undefined : item.lastClientAction,
      });
    } finally { setProcessing(null); }
  };

  const toggleRouteAssigned = async (item: SubItem) => {
    if (item._type !== 'transport') return;
    setProcessing(item.id);
    try {
      const next = !item.routeAssigned;
      await updateDoc(docRef('transportationSubscriptions', item.id), { routeAssigned: next, updatedAt: new Date() });
      patchItem(item.id, { routeAssigned: next });
    } finally { setProcessing(null); }
  };

  // Old pricing on/off for one subscription. Writing it triggers the billing
  // recompute (onTransportBillingSync / onStudyroomBillingSync), so unpaid
  // bills follow straight away; paid ones are never touched.
  const toggleLegacyPricing = async (item: SubItem) => {
    const next = !isLegacyPricing(item);
    const msg = next
      ? 'Passar para o tarifário antigo?\n\nA mensalidade passa a ser a mostrada neste cartão (descontos somados), até ao fim do ano letivo. As faturas por pagar são recalculadas.'
      : 'Passar para o tarifário novo (desconto multi-viagem e de irmão por viagem/criança)?\n\nAs faturas por pagar são recalculadas e o valor pode subir.';
    if (!window.confirm(msg)) return;
    setProcessing(item.id);
    try {
      await updateDoc(docRef(subCollection(item), item.id), { legacyPricing: next, updatedAt: new Date() });
      patchItem(item.id, { legacyPricing: next });
    } finally { setProcessing(null); }
  };

  // When the client confirmed a PENDING subscription, actually activates the
  // subscription (via setStatus, which also clears the review flags for
  // this exact case — see its own comment) — the badge for that case reads
  // "✅ Confirmado — ativar", so it has to do what it says. Every other
  // lastClientAction (cancel request, edit, rejection) just dismisses the
  // flag, since those need the admin to act elsewhere (cancel it, review
  // the edit) rather than a status flip.
  const resolveClientAction = async (item: SubItem) => {
    // Only from pending: a confirmation on a cancelled subscription must not
    // quietly reactivate it.
    if (item.lastClientAction === 'confirmed' && item.status === 'pending') {
      await setStatus(item, 'active');
      return;
    }
    setProcessing(item.id);
    try {
      await updateDoc(docRef(subCollection(item), item.id), { adminReviewPending: false, lastClientAction: deleteField(), updatedAt: new Date() });
      patchItem(item.id, { adminReviewPending: false, lastClientAction: undefined });
    } finally { setProcessing(null); }
  };

  const hardDelete = async (item: SubItem) => {
    if (!window.confirm(`Eliminar definitivamente a inscrição de ${item.childName}?`)) return;
    setProcessing(item.id);
    try {
      await deleteDoc(docRef(subCollection(item), item.id));
      setItems(prev => prev.filter(i => i.id !== item.id));
    } finally { setProcessing(null); }
  };

  const computeGross = (item: SubItem): number => {
    if (item._type === 'transport') {
      const totalTrips = (item.schedule ?? []).length;
      const weeks = activeWeeksInPattern(item.weekPattern ?? 'all');
      return totalTrips * (transportConfig?.flatRatePerTrip ?? 0) * weeks;
    }
    const days = (item.days ?? []).length;
    const ratePerDay = studyConfig
      ? (studyConfig.pricePerDayPerWeek != null && studyConfig.weeksPerMonth != null
          ? studyConfig.pricePerDayPerWeek * studyConfig.weeksPerMonth
          : studyConfig.monthlyPricePerWeekday)
      : 0;
    const weeks = activeWeeksInPattern(item.weekPattern ?? 'all');
    const weeksBase = studyConfig?.weeksPerMonth ?? 4;
    return days * ratePerDay * (weeks / weeksBase);
  };

  const toggleManualDiscount = async (item: SubItem, rule: DiscountRule) => {
    setProcessing(item.id);
    try {
      const current = item.appliedDiscounts ?? [];
      const isApplied = current.some(d => d.ruleId === rule.id);
      const newDiscounts: AppliedDiscount[] = isApplied
        ? current.filter(d => d.ruleId !== rule.id)
        : [...current, { ruleId: rule.id, name: rule.name, percentage: rule.percentage, appliedAt: new Date(), appliedBy: 'admin' as const }];

      // An admin's click on an AUTOMATIC rule is an override, and has to be
      // recorded as one: appliedDiscounts is rewritten from the rules by
      // discountRecalc on every schedule change, so an "off" stored only there
      // is silently undone the next time anyone edits the schedule. Manual
      // rules need no override — they are only ever applied by hand.
      const newOverrides = rule.trigger === 'manual'
        ? item.discountOverrides
        : { ...(item.discountOverrides ?? {}), [rule.id]: !isApplied };

      const gross = computeGross(item);
      const newFee = Math.round(applyDiscounts(gross, newDiscounts) * 100) / 100;
      const feeField = item._type === 'transport' ? 'monthlyFee' : 'monthlyPrice';

      await updateDoc(docRef(subCollection(item), item.id), {
        appliedDiscounts: newDiscounts, [feeField]: newFee, updatedAt: new Date(),
        ...(newOverrides ? { discountOverrides: newOverrides } : {}),
      });
      patchItem(item.id, {
        appliedDiscounts: newDiscounts,
        ...(newOverrides ? { discountOverrides: newOverrides } : {}),
        ...(item._type === 'transport' ? { monthlyFee: newFee } : { monthlyPrice: newFee }),
      });
    } finally { setProcessing(null); }
  };

  /**
   * Drop every admin override on this subscription and let the automatic
   * rules decide again.
   *
   * Only the override field is written. discountRecalc (onDocumentWritten)
   * owns the recomputation of appliedDiscounts and the fee, and it is the only
   * place that counts siblings across BOTH collections — recomputing here
   * would mean a second, worse copy of that logic in the row. Manual
   * concessions ("Aluno do ano anterior") are deliberately kept: they were
   * never automatic, so "back to automatic" has nothing to say about them.
   */
  const resetDiscountsToAuto = async (item: SubItem) => {
    const n = Object.keys(item.discountOverrides ?? {}).length;
    if (!confirm(
      `Repor os descontos automáticos de ${item.childName}?\n\n`
      + `${n} ajuste(s) manual(is) serão removidos e os descontos voltam a ser `
      + `calculados automaticamente. Descontos manuais (ex. "Aluno do ano anterior") são mantidos.`
    )) return;
    setProcessing(item.id);
    try {
      await updateDoc(docRef(subCollection(item), item.id), {
        discountOverrides: deleteField(), updatedAt: new Date(),
      });
      // The recalculation is a backend trigger, so it lands a moment after the
      // write. Reloading immediately would show the pre-reset fee and read as
      // "the button did nothing" on a money screen.
      await new Promise(r => setTimeout(r, 1500));
      await reload();
    } finally { setProcessing(null); }
  };

  const clearFeeReview = async (item: SubItem) => {
    await updateDoc(docRef(subCollection(item), item.id), { feeReviewRequired: false, updatedAt: new Date() });
    patchItem(item.id, { feeReviewRequired: false });
  };

  /** Returns the familyId it linked to, or undefined when it couldn't. */
  const linkToFamily = async (item: SubItem): Promise<string | undefined> => {
    setProcessing(item.id);
    try {
      // Step 1: resolve familyId (skip if already set)
      let familyId = item.familyId;
      if (!familyId) {
        if (!item.contactEmail) { alert('Sem email de contacto para vincular.'); return undefined; }
        const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', normalizeEmail(item.contactEmail))));
        if (famSnap.empty) { alert(`Nenhuma conta encontrada para ${item.contactEmail}.`); return undefined; }
        familyId = famSnap.docs[0].id;
      }

      // Step 2: try to match childId by name (case/diacritics-insensitive, exact full-name match)
      const norm = (s: string) =>
        (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
      const childrenSnap = await getDocs(query(col('children'), where('familyId', '==', familyId)));
      const subName = norm(item.childName);
      const matches = childrenSnap.docs.filter(d => {
        const c = d.data();
        return norm(`${c.firstName ?? ''} ${c.lastName ?? ''}`) === subName;
      });

      const updates: Record<string, unknown> = { familyId, updatedAt: new Date() };
      if (matches.length === 1) updates.childId = matches[0].id;
      // The parent only sees docs whose userId is theirs (portal queries and
      // rules match on userId, not familyId). Set it from the family owner,
      // and fix the matched child too if it was never given one.
      const ownerUid = await familyService.getFamilyOwnerUid(familyId);
      if (ownerUid) updates.userId = ownerUid;

      await updateDoc(docRef(subCollection(item), item.id), updates);
      if (ownerUid && matches.length === 1 && !matches[0].data().userId) {
        await updateDoc(docRef('children', matches[0].id), { userId: ownerUid, updatedAt: new Date() });
      }
      patchItem(item.id, { familyId, ...(matches.length === 1 ? { childId: matches[0].id } : {}) });
      return familyId;
    } finally { setProcessing(null); }
  };

  return {
    processing, patchItem,
    setStatus, toggleRouteAssigned, toggleLegacyPricing, resolveClientAction, hardDelete,
    toggleManualDiscount, resetDiscountsToAuto, clearFeeReview, linkToFamily,
  };
}

export type SubscriptionActions = ReturnType<typeof useSubscriptionActions>;
