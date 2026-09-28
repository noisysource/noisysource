import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getDocs, getDoc, updateDoc, deleteDoc, deleteField, query, where } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { getTransportationConfig } from '../../services/transportationService';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { Child, Family } from '@shared/models';
import { resolvePersonalData } from '../../lib/personalData';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import { DiscountRule, AppliedDiscount } from '@shared/models/Discount';
import { getDiscountRules, applyDiscounts, grossFromAppliedDiscounts } from '../../services/discountService';
import { normalizeName, SubStatus, normalizeSubStatus, normalizeEmail } from '../../lib/utils';
import { SubItem, TypeFilter, FamilyGroup, toDate } from './subscriptions/model';
import { StatusBadge, CLIENT_ACTION_BADGE } from './subscriptions/badges';
import ChildDetailsForm from './subscriptions/ChildDetailsForm';
import FamilyContactForm from './subscriptions/FamilyContactForm';
import EditForm from './subscriptions/EditForm';
import ManualEnrollForm from './subscriptions/ManualEnrollForm';
import MiniWeekCalendar from './subscriptions/MiniWeekCalendar';
import VersionHistoryModal from './subscriptions/VersionHistoryModal';

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SubscriptionsAdminPage() {
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const highlightRef = useRef<HTMLDivElement | null>(null);

  const [items, setItems] = useState<SubItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SubStatus | 'all'>('pending');
  const [search, setSearch] = useState('');

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [onlyAdminReview, setOnlyAdminReview] = useState(false);
  const [onlyClientReview, setOnlyClientReview] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  // Which child row / family row has its details form open. Personal data is
  // edited at those two levels, never per subscription — see ChildGroup.
  const [editChildKey, setEditChildKey] = useState<string | null>(null);
  const [editContactKey, setEditContactKey] = useState<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [transportConfig, setTransportConfig] = useState<TransportationConfig | null>(null);
  const [studyConfig, setStudyConfig] = useState<StudyCenterConfig | null>(null);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [historyItem, setHistoryItem] = useState<SubItem | null>(null);

  const load = async () => {
    setIsLoading(true); setError(null);
    try {
      const [studySnap, transportSnap, childrenSnap, familiesSnap, cfg, studyCfgSnap, rules] = await Promise.all([
        getDocs(col('studyroom')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('children')),
        getDocs(col('families')),
        getTransportationConfig(),
        getDoc(docRef('config', 'studyCenter')),
        getDiscountRules(),
      ]);
      if (cfg) setTransportConfig(cfg);
      if (studyCfgSnap.exists()) setStudyConfig(studyCfgSnap.data() as StudyCenterConfig);
      setDiscountRules(rules ?? []);

      // Personal data (child name, school, guardian contact) is resolved from
      // these two collections, not from each subscription's own denormalized
      // copies — a child's details then appear once, identically, on every
      // subscription they hold, instead of once per subscription with the two
      // free to disagree (which is what had happened in prod: 5 of 10
      // dual-service children had two different schoolName values, two of them
      // street addresses). See lib/personalData.ts.
      const childMap = new Map<string, Child>(
        childrenSnap.docs.map(d => [d.id, { ...d.data(), id: d.id } as Child]),
      );
      const familyMap = new Map<string, Family>(
        familiesSnap.docs.map(d => [d.id, { ...d.data(), id: d.id } as Family]),
      );
      const personFor = (x: any) => resolvePersonalData(
        x.childId ? childMap.get(x.childId) : null,
        x.familyId ? familyMap.get(x.familyId) : null,
        { ...x, childName: x.childName ?? x.studentName },
      );
      const study: SubItem[] = studySnap.docs.map(d => {
        const x = d.data();
        const person = personFor(x);
        return {
          id: d.id, _type: 'study',
          childName: person.childName || '—',
          childId: x.childId || undefined,
          familyId: x.familyId,
          contactName: person.contactName,
          contactEmail: person.contactEmail,
          contactPhone: person.contactPhone,
          source: x.source,
          schoolName: person.schoolName, schoolYear: person.schoolYear,
          days: x.days || [], monthlyPrice: x.monthlyPrice ?? x.basePrice ?? 0,
          basePrice: x.basePrice ?? x.monthlyPrice ?? 0,
          returningStudent: x.returningStudent ?? false,
          appliedDiscounts: x.appliedDiscounts ?? [],
          weekPattern: x.weekPattern ?? 'all',
          status: normalizeSubStatus(x.status),
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested,
          feeReviewRequired: x.feeReviewRequired ?? false,
          clientReviewPending: x.clientReviewPending ?? x.needsClientReview ?? false,
          adminReviewPending: x.adminReviewPending ?? false,
          lastClientAction: x.lastClientAction,
        };
      });
      const transport: SubItem[] = transportSnap.docs.map(d => {
        const x = d.data();
        const person = personFor(x);
        return {
          id: d.id, _type: 'transport',
          childName: person.childName || '—',
          childId: x.childId || undefined,
          familyId: x.familyId,
          contactName: person.contactName,
          contactEmail: person.contactEmail, contactPhone: person.contactPhone,
          source: x.source,
          schoolName: person.schoolName, schoolYear: person.schoolYear,
          schedule: x.schedule || [], monthlyFee: x.monthlyFee ?? 0,
          routeAssigned: x.routeAssigned ?? false,
          originalFee: x.originalFee ?? x.monthlyFee ?? 0,
          returningStudent: x.returningStudent ?? false,
          appliedDiscounts: x.appliedDiscounts ?? [],
          weekPattern: x.weekPattern ?? 'all',
          status: normalizeSubStatus(x.status),
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested,
          feeReviewRequired: x.feeReviewRequired ?? false,
          clientReviewPending: x.clientReviewPending ?? x.needsClientReview ?? false,
          adminReviewPending: x.adminReviewPending ?? false,
          lastClientAction: x.lastClientAction,
        };
      });
      setItems([...study, ...transport].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar inscrições.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // When a highlight id is present, switch to the 'all' tab and scroll to the item
  useEffect(() => {
    if (!highlightId || isLoading) return;
    const target = items.find(i => i.id === highlightId);
    if (!target) return;
    setTab('all');
    setTypeFilter('all');
    setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }, [highlightId, isLoading, items]);

  // One direct status control, no approve/offer/reject/revert gating workflow.
  // Admin can set any subscription to any of the 3 states freely.
  const setStatus = async (item: SubItem, newStatus: SubStatus) => {
    if (item.status === newStatus) return;
    if (newStatus === 'cancelled' && !window.confirm(`Cancelar inscrição de ${item.childName}?`)) return;
    setProcessing(item.id);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      const patch: Record<string, unknown> = { status: newStatus, updatedAt: new Date() };
      if (newStatus === 'active') patch.approvedAt = new Date();
      if (newStatus === 'cancelled') patch.cancelledAt = new Date();
      if (newStatus === 'pending') patch.approvedAt = null;

      // Same convenience the old approve() had — try to auto-resolve familyId
      // by contact email if not yet linked. Doesn't gate the status change.
      if (!item.familyId && item.contactEmail) {
        const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', normalizeEmail(item.contactEmail))));
        if (!famSnap.empty) patch.familyId = famSnap.docs[0].id;
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

      await updateDoc(docRef(colName, item.id), patch);
      setItems(prev => prev.map(i => i.id === item.id
        ? {
            ...i, status: newStatus,
            familyId: (patch.familyId as string | undefined) ?? i.familyId,
            clientReviewPending: fulfillsClientConfirmation ? i.clientReviewPending : (linked ? true : i.clientReviewPending),
            adminReviewPending: fulfillsClientConfirmation ? false : i.adminReviewPending,
            lastClientAction: fulfillsClientConfirmation ? undefined : i.lastClientAction,
          }
        : i
      ));
    } finally { setProcessing(null); }
  };

  const toggleRouteAssigned = async (item: SubItem) => {
    if (item._type !== 'transport') return;
    setProcessing(item.id);
    try {
      const next = !item.routeAssigned;
      await updateDoc(docRef('transportationSubscriptions', item.id), { routeAssigned: next, updatedAt: new Date() });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, routeAssigned: next } : i));
    } finally { setProcessing(null); }
  };

  // When the client's last action was "confirmed", actually activates the
  // subscription (via setStatus, which also clears the review flags for
  // this exact case — see its own comment) — the badge for that case reads
  // "✅ Confirmado — ativar", so it has to do what it says. Every other
  // lastClientAction (cancel request, edit, rejection) just dismisses the
  // flag, since those need the admin to act elsewhere (cancel it, review
  // the edit) rather than a status flip.
  const resolveClientAction = async (item: SubItem) => {
    if (item.lastClientAction === 'confirmed' && item.status !== 'active') {
      await setStatus(item, 'active');
      return;
    }
    setProcessing(item.id);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(docRef(colName, item.id), { adminReviewPending: false, lastClientAction: deleteField(), updatedAt: new Date() });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, adminReviewPending: false, lastClientAction: undefined } : i));
    } finally { setProcessing(null); }
  };

  const hardDelete = async (item: SubItem) => {
    if (!window.confirm(`Eliminar definitivamente a inscrição de ${item.childName}?`)) return;
    setProcessing(item.id);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await deleteDoc(docRef(colName, item.id));
      setItems(prev => prev.filter(i => i.id !== item.id));
    } finally { setProcessing(null); }
  };

  const isUnlinked = (i: SubItem) =>
    (i.source === 'manual' && !i.familyId) || (!!i.familyId && !i.childId);

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
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
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

      await updateDoc(docRef(colName, item.id), {
        appliedDiscounts: newDiscounts, [feeField]: newFee, updatedAt: new Date(),
        ...(newOverrides ? { discountOverrides: newOverrides } : {}),
      });
      setItems(prev => prev.map(i => i.id === item.id
        ? { ...i, appliedDiscounts: newDiscounts, ...(i._type === 'transport' ? { monthlyFee: newFee } : { monthlyPrice: newFee }) }
        : i
      ));
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
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(docRef(colName, item.id), {
        discountOverrides: deleteField(), updatedAt: new Date(),
      });
      // The recalculation is a backend trigger, so it lands a moment after the
      // write. Reloading immediately would show the pre-reset fee and read as
      // "the button did nothing" on a money screen.
      await new Promise(r => setTimeout(r, 1500));
      await load();
    } finally { setProcessing(null); }
  };

  const clearFeeReview = async (item: SubItem) => {
    const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
    await updateDoc(docRef(colName, item.id), { feeReviewRequired: false, updatedAt: new Date() });
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, feeReviewRequired: false } : i));
  };

  const linkToFamily = async (item: SubItem) => {
    setProcessing(item.id);
    try {
      // Step 1: resolve familyId (skip if already set)
      let familyId = item.familyId;
      if (!familyId) {
        if (!item.contactEmail) { alert('Sem email de contacto para vincular.'); return; }
        const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', normalizeEmail(item.contactEmail))));
        if (famSnap.empty) { alert(`Nenhuma conta encontrada para ${item.contactEmail}.`); return; }
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

      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      const updates: Record<string, unknown> = { familyId, updatedAt: new Date() };
      if (matches.length === 1) updates.childId = matches[0].id;

      await updateDoc(docRef(colName, item.id), updates);
      setItems(prev => prev.map(i =>
        i.id === item.id
          ? { ...i, familyId, ...(matches.length === 1 ? { childId: matches[0].id } : {}) }
          : i
      ));
    } finally { setProcessing(null); }
  };

  const filtered = items
    .filter(i => tab === 'all' || i.status === tab)
    .filter(i => !onlyAdminReview || i.adminReviewPending)
    .filter(i => !onlyClientReview || i.clientReviewPending)
    .filter(i => {
      if (typeFilter === 'transport') return i._type === 'transport';
      if (typeFilter === 'study') return i._type === 'study';
      if (typeFilter === 'unlinked') return isUnlinked(i);
      return true;
    })
    .filter(i => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        (i.childName || '').toLowerCase().includes(q) ||
        (i.contactName || '').toLowerCase().includes(q) ||
        (i.contactEmail || '').toLowerCase().includes(q) ||
        (i.schoolName || '').toLowerCase().includes(q)
      );
    });

  const grouped = useMemo<FamilyGroup[]>(() => {
    const map = new Map<string, FamilyGroup>();
    for (const item of filtered) {
      const key = item.familyId || item.contactEmail || item.id;
      let fam = map.get(key);
      if (!fam) {
        const contact = [item.contactEmail, item.contactPhone].filter(Boolean).join(' · ');
        fam = {
          key,
          label: item.contactName
            ? `${item.contactName}${contact ? ` · ${contact}` : ''}`
            : contact || null,
          familyId: item.familyId,
          contactName: item.contactName,
          contactEmail: item.contactEmail,
          contactPhone: item.contactPhone,
          children: [],
          count: 0,
        };
        map.set(key, fam);
      }
      // childId is the real identity. A subscription with none yet falls back
      // to the normalized name, so an unlinked transport + study pair for the
      // same kid still collapses into one row rather than appearing twice.
      const childKey = item.childId || `name:${normalizeName(item.childName)}` || item.id;
      let kid = fam.children.find(c => c.key === childKey);
      if (!kid) {
        kid = {
          key: childKey, childId: item.childId, familyId: item.familyId,
          childName: item.childName, schoolName: item.schoolName, schoolYear: item.schoolYear,
          items: [],
        };
        fam.children.push(kid);
      }
      // Both subscriptions resolve school from the same child document now, so
      // these agree — ?? only covers a child record that has no value at all.
      kid.schoolName ??= item.schoolName;
      kid.schoolYear ??= item.schoolYear;
      kid.items.push(item);
      fam.count++;
    }
    for (const fam of map.values()) {
      fam.children.sort((a, b) => a.childName.localeCompare(b.childName, 'pt'));
    }
    return Array.from(map.values());
  }, [filtered]);

  const counts = {
    pending: items.filter(i => i.status === 'pending').length,
    active: items.filter(i => i.status === 'active').length,
    cancelled: items.filter(i => i.status === 'cancelled').length,
    all: items.length,
    unlinked: items.filter(isUnlinked).length,
    feeReview: items.filter(i => i.feeReviewRequired).length,
    adminReview: items.filter(i => i.adminReviewPending).length,
    clientReview: items.filter(i => i.clientReviewPending).length,
  };

  if (isLoading) return <div className="flex justify-center items-center h-64 text-gray-500">A carregar…</div>;
  if (error) return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6">
      <h2 className="font-semibold text-red-800 mb-2">Erro ao carregar inscrições</h2>
      <p className="text-red-700 text-sm mb-4">{error}</p>
      <button onClick={load} className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 text-sm">Tentar novamente</button>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Inscrições</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {counts.pending > 0 && <span className="text-yellow-700 font-medium">{counts.pending} a analisar · </span>}
            {counts.active} ativas
            {counts.unlinked > 0 && <span className="text-orange-600 font-medium"> · {counts.unlinked} não vinculada(s)</span>}
            {counts.feeReview > 0 && <span className="text-amber-600 font-medium"> · {counts.feeReview} mensalidade{counts.feeReview !== 1 ? 's' : ''} em revisão</span>}
            {counts.adminReview > 0 && <span className="text-pink-600 font-medium"> · {counts.adminReview} alteração{counts.adminReview !== 1 ? 'ões' : ''} do cliente por rever</span>}
            {counts.clientReview > 0 && <span className="text-purple-600 font-medium"> · {counts.clientReview} a aguardar confirmação do encarregado</span>}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <button onClick={() => setShowManualForm(v => !v)}
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
            {showManualForm ? '✕ Cancelar' : '+ Inscrever'}
          </button>
          <button onClick={load} className="text-sm text-blue-600 hover:underline"
            title="Recarregar a lista a partir da base de dados (esta página não atualiza sozinha)">
            ↻ Atualizar
          </button>
        </div>
      </div>

      {/* Manual enrollment form */}
      {showManualForm && (
        <ManualEnrollForm
          transportConfig={transportConfig}
          studyConfig={studyConfig}
          discountRules={discountRules}
          onSave={newItems => { setItems(prev => [...newItems, ...prev]); setShowManualForm(false); }}
          onCancel={() => setShowManualForm(false)}
        />
      )}

      {/* Status tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-3 overflow-x-auto">
        {([
          { key: 'pending', label: 'A analisar', count: counts.pending },
          { key: 'active', label: 'Ativas', count: counts.active },
          { key: 'cancelled', label: 'Histórico', count: counts.cancelled },
          { key: 'all', label: 'Todas', count: counts.all },
        ] as const).map(({ key, label, count }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
            {count > 0 && (
              <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${tab === key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Type filter pills + search */}
      <div className="flex flex-wrap gap-2 mb-6 items-center">
        {([
          { key: 'all', label: 'Todos os tipos' },
          { key: 'transport', label: '🚌 Transporte' },
          { key: 'study', label: '📚 Sala de Estudo' },
          { key: 'unlinked', label: `🔗 Não vinculados${counts.unlinked > 0 ? ` (${counts.unlinked})` : ''}` },
        ] as const).map(({ key, label }) => (
          <button key={key} onClick={() => setTypeFilter(key)}
            className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${typeFilter === key ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
            {label}
          </button>
        ))}
        <button onClick={() => setOnlyAdminReview(v => !v)}
          title="O cliente fez uma alteração (pedido, edição, cancelamento) que precisa da sua revisão"
          className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${onlyAdminReview ? 'bg-pink-600 text-white border-pink-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
          🔔 Ação do cliente{counts.adminReview > 0 ? ` (${counts.adminReview})` : ''}
        </button>
        <button onClick={() => setOnlyClientReview(v => !v)}
          className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${onlyClientReview ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}>
          ⏳ Aguarda encarregado{counts.clientReview > 0 ? ` (${counts.clientReview})` : ''}
        </button>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Pesquisar nome, email, escola…"
          className="ml-auto text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          {tab === 'pending' ? 'Sem pedidos pendentes.' : 'Sem inscrições nesta categoria.'}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(group => (
            <div key={group.key}>
              {/* Family header — always shown, always collapsible. Guardian
                  contact is edited here, once for the whole family. */}
              <div className="flex items-center mb-2">
              <button
                onClick={() => setCollapsed(prev => {
                  const next = new Set(prev);
                  next.has(group.key) ? next.delete(group.key) : next.add(group.key);
                  return next;
                })}
                className="flex-1 flex items-center gap-2 px-0.5 text-left group"
              >
                <span className="text-sm">👨‍👩‍👧</span>
                <span className="text-xs font-medium text-gray-500 flex-1">
                  {group.label ?? 'Sem conta vinculada'}
                </span>
                <span className="text-xs text-gray-300 mr-1">{group.count} inscrição{group.count !== 1 ? 'ões' : ''}</span>
                <span className="text-gray-400 text-xs">{collapsed.has(group.key) ? '▶' : '▼'}</span>
              </button>
                <button
                  onClick={() => setEditContactKey(editContactKey === group.key ? null : group.key)}
                  className="text-gray-300 hover:text-blue-600 text-xs px-2 py-1 shrink-0"
                  title="Editar contactos do encarregado (aplica-se a toda a família)">✏️</button>
              </div>
              {editContactKey === group.key && (
                <FamilyContactForm
                  group={group}
                  onSaved={patch => {
                    const ids = new Set(group.children.flatMap(c => c.items).map(i => i.id));
                    setItems(prev => prev.map(i => ids.has(i.id) ? { ...i, ...patch } : i));
                    setEditContactKey(null);
                  }}
                  onCancel={() => setEditContactKey(null)}
                />
              )}
              {!collapsed.has(group.key) && <div className="space-y-4">
                {group.children.map(kid => (
                  <div key={kid.key} className="space-y-2">
                    {/* Child header — the child's details, shown once for all
                        of their subscriptions rather than repeated on each. */}
                    <div className="flex items-baseline gap-2 pl-1">
                      <span className="text-sm font-semibold text-gray-900">{kid.childName}</span>
                      {(kid.schoolName || kid.schoolYear) && (
                        <span className="text-xs text-gray-500">
                          {[kid.schoolName, kid.schoolYear].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      <button
                        onClick={() => setEditChildKey(editChildKey === kid.key ? null : kid.key)}
                        className="text-gray-300 hover:text-blue-600 text-xs px-1.5 py-0.5"
                        title="Editar dados da criança (aplica-se a todas as suas inscrições)">✏️</button>
                      <span className="ml-auto text-xs text-gray-300">
                        {kid.items.length} inscrição{kid.items.length !== 1 ? 'ões' : ''}
                      </span>
                    </div>
                    {editChildKey === kid.key && (
                      <ChildDetailsForm
                        group={kid}
                        onSaved={(patch, newChildId) => {
                          const ids = new Set(kid.items.map(i => i.id));
                          setItems(prev => prev.map(i => ids.has(i.id)
                            ? { ...i, ...patch, ...(newChildId ? { childId: newChildId } : {}) }
                            : i));
                          setEditChildKey(null);
                        }}
                        onCancel={() => setEditChildKey(null)}
                      />
                    )}
                    {kid.items.map(item => (
                      <div
                        key={`${item._type}-${item.id}`}
                        ref={item.id === highlightId ? highlightRef : null}
                        className={`bg-white rounded-lg border p-4 transition-colors ${item.id === highlightId ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200'}`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex gap-3 flex-1 min-w-0">
                            <div className="text-2xl mt-0.5 shrink-0">{item._type === 'study' ? '📚' : '🚌'}</div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                {/* No child name here — it's on the child header
                                    above, once for all of their subscriptions. */}
                                <span className="text-sm font-medium text-gray-700">{item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}</span>
                                <StatusBadge status={item.status} cancelRequested={item.cancelRequested} />
                                {isUnlinked(item) && (
                                  <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">não vinculado</span>
                                )}
                                {item.feeReviewRequired && (
                                  <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium">⚠ rever mensalidade</span>
                                )}
                                {item.adminReviewPending && (
                                  <button onClick={() => resolveClientAction(item)} disabled={processing === item.id}
                                    className={`text-xs px-2 py-0.5 rounded-full font-medium disabled:opacity-60 ${item.lastClientAction ? CLIENT_ACTION_BADGE[item.lastClientAction].cls : 'bg-pink-100 text-pink-800 hover:bg-pink-200'}`}
                                    title={item.lastClientAction === 'confirmed' ? 'Clique para ativar a inscrição' : 'Clique para marcar como revisto'}>
                                    {item.lastClientAction ? CLIENT_ACTION_BADGE[item.lastClientAction].label : '🔔 alteração do cliente'}
                                  </button>
                                )}
                                {item.clientReviewPending && (
                                  <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full font-medium"
                                    title="O encarregado ainda não viu/confirmou esta alteração">
                                    ⏳ aguarda confirmação do encarregado
                                  </span>
                                )}
                                {item._type === 'transport' && item.status !== 'cancelled' && (
                                  <button onClick={() => toggleRouteAssigned(item)} disabled={processing === item.id}
                                    className={`text-xs px-2 py-0.5 rounded-full font-medium disabled:opacity-60 ${item.routeAssigned ? 'bg-teal-100 text-teal-800 hover:bg-teal-50' : 'bg-gray-50 text-gray-400 border border-gray-200 hover:border-gray-400'}`}
                                    title="Rota atribuída (apenas controlo operacional interno)">
                                    {item.routeAssigned ? '🗺 rota atribuída' : '🗺 sem rota'}
                                  </button>
                                )}
                              </div>

                              <MiniWeekCalendar item={item} />

                              {(() => {
                                const fee = item._type === 'transport' ? (item.monthlyFee ?? 0) : (item.monthlyPrice ?? 0);
                                const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
                                const applied = item.appliedDiscounts ?? [];
                                const autoApplied = applied.filter(d => d.appliedBy === 'auto');
                                const adminApplied = applied.filter(d => d.appliedBy === 'admin');

                                // Any active rule for this scope not yet applied — not just
                                // trigger:'manual' ones, so an auto rule that didn't
                                // auto-match can still be turned on by hand from the row.
                                const availableRules = discountRules.filter(r =>
                                  r.active &&
                                  r.appliesTo.includes(item._type) &&
                                  !applied.some(d => d.ruleId === r.id)
                                );

                                if (fee === 0 && applied.length === 0 && availableRules.length === 0) return null;

                                const gross = item._type === 'study'
                                  ? (item.basePrice != null && item.basePrice > fee + 0.01 ? item.basePrice : null)
                                  : grossFromAppliedDiscounts(fee, applied);
                                const hasDiscount = gross != null && gross > fee + 0.01;

                                return (
                                  <div className="mt-1.5 space-y-1.5">
                                    <div className="flex items-baseline gap-1.5">
                                      {hasDiscount && <span className="text-xs text-gray-400 line-through">€{gross!.toFixed(2)}</span>}
                                      <span className={`text-xs font-semibold ${hasDiscount ? 'text-green-700' : 'text-gray-800'}`}>€{fee.toFixed(2)}/mês</span>
                                    </div>

                                    {/* Applied auto discounts — clickable to override off */}
                                    {autoApplied.length > 0 && (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Auto</span>
                                        {autoApplied.map(d => {
                                          const rule = discountRules.find(r => r.id === d.ruleId);
                                          if (!rule) return (
                                            <span key={d.ruleId} className="text-xs px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 font-medium">
                                              {d.name} -{pct(d.percentage)}
                                            </span>
                                          );
                                          return (
                                            <button key={d.ruleId}
                                              onClick={() => toggleManualDiscount(item, rule)}
                                              disabled={processing === item.id}
                                              className="text-xs px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 font-medium hover:bg-blue-100 disabled:opacity-50"
                                              title="Clique para desativar (substitui a deteção automática)">
                                              {d.name} -{pct(d.percentage)}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    )}

                                    {/* Applied admin discounts — clickable to remove */}
                                    {adminApplied.length > 0 && (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Manual</span>
                                        {adminApplied.map(d => {
                                          const rule = discountRules.find(r => r.id === d.ruleId);
                                          if (!rule) return (
                                            <span key={d.ruleId} className="text-xs px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-800 font-medium">
                                              {d.name} -{pct(d.percentage)}
                                            </span>
                                          );
                                          return (
                                            <button key={d.ruleId}
                                              onClick={() => toggleManualDiscount(item, rule)}
                                              disabled={processing === item.id}
                                              className="text-xs px-2 py-0.5 rounded-full border border-amber-300 bg-amber-100 text-amber-800 font-medium hover:bg-amber-50 disabled:opacity-50"
                                              title="Clique para remover">
                                              ★ {d.name} -{pct(d.percentage)}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    )}

                                    {/* Overrides present — offer a way back to automatic */}
                                    {Object.keys(item.discountOverrides ?? {}).length > 0 && (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Ajustado</span>
                                        <button
                                          onClick={() => resetDiscountsToAuto(item)}
                                          disabled={processing === item.id}
                                          className="text-xs px-2 py-0.5 rounded-full border border-purple-300 bg-purple-50 text-purple-700 font-medium hover:bg-purple-100 disabled:opacity-50"
                                          title="Remove os ajustes manuais e volta a calcular os descontos automaticamente">
                                          ↺ Repor automático
                                        </button>
                                      </div>
                                    )}

                                    {/* Any other active rule for this scope — click to apply */}
                                    {item.status !== 'cancelled' && availableRules.length > 0 && (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Adicionar</span>
                                        {availableRules.map(r => (
                                          <button key={r.id}
                                            onClick={() => toggleManualDiscount(item, r)}
                                            disabled={processing === item.id}
                                            className="text-xs px-2 py-0.5 rounded-full border border-gray-200 bg-white text-gray-400 font-medium hover:border-gray-400 hover:text-gray-600 disabled:opacity-50"
                                            title="Clique para aplicar">
                                            ☆ {r.name} -{pct(r.percentage)}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                              {item.note && <p className="text-xs text-gray-500 mt-1 italic">"{item.note}"</p>}
                              {item.statusReason && item.status === 'cancelled' && <p className="text-xs text-red-600 mt-1">Motivo: {item.statusReason}</p>}
                              <p className="text-xs text-gray-400 mt-1.5">{item.createdAt.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                            </div>
                          </div>

                          <div className="flex flex-col gap-1.5 shrink-0">
                            {/* Direct status control — no approve/offer/reject/revert gating, admin
                                can move freely in any direction. */}
                            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
                              {([
                                { key: 'pending' as const, label: 'Pendente' },
                                { key: 'active' as const, label: 'Ativo' },
                                { key: 'cancelled' as const, label: 'Cancelado' },
                              ]).map(({ key, label }, idx) => (
                                <button key={key} onClick={() => setStatus(item, key)} disabled={processing === item.id}
                                  className={`px-2.5 py-1.5 whitespace-nowrap disabled:opacity-60 ${idx > 0 ? 'border-l border-gray-200' : ''} ${item.status === key
                                    ? (key === 'active' ? 'bg-green-600 text-white' : key === 'cancelled' ? 'bg-gray-600 text-white' : 'bg-yellow-500 text-white')
                                    : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                                  {label}
                                </button>
                              ))}
                            </div>
                            {isUnlinked(item) && (
                              <>
                                <button onClick={() => linkToFamily(item)} disabled={processing === item.id}
                                  className="bg-orange-50 text-orange-700 border border-orange-200 text-sm px-3 py-1.5 rounded-lg hover:bg-orange-100 disabled:opacity-60 whitespace-nowrap"
                                  title={item.familyId ? 'Vincular criança pelo nome' : `Vincular família pelo email ${item.contactEmail}`}>
                                  {processing === item.id ? '…' : '🔗 Vincular'}
                                </button>
                                <button onClick={() => hardDelete(item)} disabled={processing === item.id}
                                  className="text-red-400 hover:text-red-600 text-sm px-2 py-1 disabled:opacity-60"
                                  title="Eliminar">🗑</button>
                              </>
                            )}
                            {item.status !== 'cancelled' && (
                              <button onClick={() => setEditId(editId === item.id ? null : item.id)}
                                className="text-gray-400 hover:text-blue-600 text-sm px-2 py-1"
                                title="Editar">✏️</button>
                            )}
                            <button onClick={() => setHistoryItem(item)}
                              className="text-gray-400 hover:text-indigo-600 text-sm px-2 py-1"
                              title="Histórico de alterações">🕐</button>
                            {item.feeReviewRequired && (
                              <button onClick={() => clearFeeReview(item)} disabled={processing === item.id}
                                className="bg-amber-50 text-amber-800 border border-amber-300 text-xs px-2.5 py-1.5 rounded-lg hover:bg-amber-100 disabled:opacity-60 whitespace-nowrap font-medium">
                                {processing === item.id ? '…' : '✓ Mensalidade revista'}
                              </button>
                            )}
                          </div>
                        </div>

                        {editId === item.id && (
                          <EditForm
                            item={item}
                            transportConfig={transportConfig}
                            studyConfig={studyConfig}
                            discountRules={discountRules}
                            onSave={updated => {
                              setItems(prev => prev.map(i => i.id === item.id ? { ...i, ...updated } : i));
                              setEditId(null);
                            }}
                            onCancel={() => setEditId(null)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>}
            </div>
          ))}
        </div>
      )}

      {historyItem && (
        <VersionHistoryModal item={historyItem} onClose={() => setHistoryItem(null)} />
      )}
    </div>
  );
}
