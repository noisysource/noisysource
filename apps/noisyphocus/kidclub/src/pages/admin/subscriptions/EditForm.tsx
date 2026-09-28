import { useState, useEffect } from 'react';
import { getDocs, updateDoc, query, where } from 'firebase/firestore';
import { col, docRef } from '../../../lib/db';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import WeekSchedulePicker, { WeekScheduleValue, DayConfig } from '../../../components/WeekSchedulePicker';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import { DiscountRule, AppliedDiscount, DiscountScope } from '@shared/models/Discount';
import { applyDiscounts, resolveAutoDiscounts, DayLike } from '../../../services/discountService';
import { SubItem, locationStr } from './model';
import DiscountPicker from './DiscountPicker';

// ─── Edit Form ────────────────────────────────────────────────────────────────
// Subscription-specific fields ONLY: schedule, week pattern, discounts, fee,
// internal note. Who the child is, which school they attend and how to reach
// their guardian are edited once per child / once per family, in
// ChildDetailsForm and FamilyContactForm above — not here, and not once per
// subscription. Repeating that block on every subscription is what let a
// child's two subscriptions end up claiming two different schools.
export default function EditForm({ item, transportConfig, studyConfig, discountRules, onSave, onCancel }: {
  item: SubItem;
  transportConfig: TransportationConfig | null;
  studyConfig: StudyCenterConfig | null;
  discountRules: DiscountRule[];
  onSave: (updated: Partial<SubItem>) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState(item.note ?? '');

  // Same WeekSchedulePicker ManualEnrollForm (and the client's own enroll/edit
  // pages) use, scoped to this subscription's single existing service —
  // converted from whichever shape is actually stored, defensively tolerating
  // the flat day-name-string corruption a since-fixed EditForm bug could have
  // left behind (same guard as StudyRoomEnrollPage's identical conversion).
  const [schedule, setSchedule] = useState<WeekScheduleValue>(() => {
    if (item._type === 'transport') {
      const dayMap: Record<string, DayConfig> = {};
      for (const s of (item.schedule ?? [])) {
        if (!dayMap[s.dayOfWeek]) dayMap[s.dayOfWeek] = { weekday: s.dayOfWeek, hour: '17:00', services: { transportTrips: [] } };
        dayMap[s.dayOfWeek].services.transportTrips!.push({
          time: s.pickupTime ?? '08:00',
          pickupAddress: locationStr(s.pickupLocation),
          dropoffAddress: locationStr(s.dropoffLocation),
        });
      }
      return { weekPattern: item.weekPattern ?? 'all', days: Object.values(dayMap) };
    }
    const days: DayConfig[] = (item.days ?? []).map((d: any) => ({
      weekday: typeof d === 'string' ? d : (d?.day ?? d?.dayOfWeek ?? ''),
      hour: (typeof d === 'string' ? undefined : d?.hour) ?? '16:00',
      services: { study: true },
    }));
    return { weekPattern: item.weekPattern ?? 'all', days };
  });

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Other children in this family with an active subscription — same
  // auto-discount preview basis ManualEnrollForm uses when creating.
  const [siblingCount, setSiblingCount] = useState(0);

  useEffect(() => {
    if (!item.familyId) return;
    (async () => {
      try {
        const CANCELLED = new Set(['cancelled', 'canceled']);
        const [tSnap, sSnap] = await Promise.all([
          getDocs(query(col('transportationSubscriptions'), where('familyId', '==', item.familyId))),
          getDocs(query(col('studyroom'), where('familyId', '==', item.familyId))),
        ]);
        const siblingChildIds = new Set<string>();
        for (const d of [...tSnap.docs, ...sSnap.docs]) {
          const x = d.data();
          if (!CANCELLED.has(x.status) && x.childId && x.childId !== item.childId) siblingChildIds.add(x.childId);
        }
        setSiblingCount(siblingChildIds.size);
      } catch { /* best-effort */ }
    })();
  }, [item.familyId, item.childId]);

  // Already linked to a family/child — the parent will see this edit and must
  // acknowledge it, rather than it silently changing under them.
  const linkedToFamily = !!item.familyId;
  const scope: DiscountScope = item._type;
  const scheduleDays: DayLike[] = item._type === 'transport'
    ? schedule.days.filter(d => (d.services.transportTrips?.length ?? 0) > 0)
    : schedule.days.filter(d => d.services.study);

  // Discount selection — seeded from the subscription's already-applied discounts
  // (respecting prior admin decisions); only falls back to resolveAutoDiscounts()
  // as a helpful default for legacy subscriptions that never had any recorded.
  const [selectedDiscounts, setSelectedDiscounts] = useState<AppliedDiscount[]>(() => {
    if (item.appliedDiscounts?.length) return item.appliedDiscounts;
    return resolveAutoDiscounts(discountRules, item._type, scheduleDays, item.schoolName, siblingCount);
  });
  const toggleDiscount = (rule: DiscountRule) => {
    setSelectedDiscounts(prev => prev.some(d => d.ruleId === rule.id)
      ? prev.filter(d => d.ruleId !== rule.id)
      : [...prev, { ruleId: rule.id, name: rule.name, percentage: rule.percentage, appliedAt: new Date(), appliedBy: 'admin' as const }]);
  };

  const totalTrips = schedule.days.reduce((sum, d) => sum + (d.services.transportTrips?.length ?? 0), 0);
  const studyDaysCount = schedule.days.filter(d => d.services.study).length;
  const gross = item._type === 'transport'
    ? totalTrips * (transportConfig?.flatRatePerTrip ?? 0) * activeWeeksInPattern(schedule.weekPattern)
    : (() => {
        const ratePerDay = studyConfig
          ? (studyConfig.pricePerDayPerWeek != null && studyConfig.weeksPerMonth != null
              ? studyConfig.pricePerDayPerWeek * studyConfig.weeksPerMonth
              : studyConfig.monthlyPricePerWeekday)
          : 0;
        const weeksBase = studyConfig?.weeksPerMonth ?? 4;
        return studyDaysCount * ratePerDay * (activeWeeksInPattern(schedule.weekPattern) / weeksBase);
      })();
  const netFee = Math.round(applyDiscounts(gross, selectedDiscounts) * 100) / 100;

  const submit = async () => {
    if (item._type === 'transport' && totalTrips === 0) { setSaveError('Adicione pelo menos uma viagem.'); return; }
    if (item._type === 'study' && studyDaysCount === 0) { setSaveError('Selecione pelo menos um dia.'); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      const patch: Record<string, any> = {
        note: note.trim() || null, updatedAt: new Date(),
        appliedDiscounts: selectedDiscounts,
        weekPattern: schedule.weekPattern,
      };
      if (linkedToFamily) patch.clientReviewPending = true;
      if (item._type === 'transport') {
        patch.schedule = schedule.days.flatMap(d =>
          (d.services.transportTrips ?? []).map(t => ({
            dayOfWeek: d.weekday, pickupTime: t.time, pickupLocation: t.pickupAddress, dropoffLocation: t.dropoffAddress,
          }))
        );
        patch.monthlyFee = netFee;
        patch.originalFee = gross;
      } else {
        patch.days = schedule.days.filter(d => d.services.study).map(d => ({ day: d.weekday, hour: d.hour }));
        patch.monthlyPrice = netFee;
        patch.basePrice = gross;
      }

      try {
        await updateDoc(docRef(colName, item.id), patch);
      } catch (err: any) {
        console.error(`Failed to save ${colName}/${item.id}:`, err);
        setSaveError(`Falha ao guardar a inscrição: ${err?.message ?? 'erro desconhecido'}`);
        return;
      }

      onSave({
        note: note.trim() || undefined,
        schedule: item._type === 'transport' ? patch.schedule : item.schedule,
        monthlyFee: item._type === 'transport' ? netFee : item.monthlyFee,
        originalFee: item._type === 'transport' ? gross : item.originalFee,
        monthlyPrice: item._type === 'study' ? netFee : item.monthlyPrice,
        basePrice: item._type === 'study' ? gross : item.basePrice,
        days: item._type === 'study' ? patch.days : item.days,
        weekPattern: schedule.weekPattern,
        appliedDiscounts: selectedDiscounts,
        clientReviewPending: linkedToFamily || item.clientReviewPending,
      });
    } finally { setSaving(false); }
  };

  const fieldCls = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400';

  return (
    <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
      <p className="text-sm font-semibold text-gray-700">Editar inscrição</p>
      {linkedToFamily && (
        <p className="text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded-lg px-3 py-1.5">
          Esta inscrição já está associada a uma família — a alteração ficará marcada para revisão do encarregado.
        </p>
      )}
      <p className="text-xs text-gray-400">
        Nome, escola, ano letivo e contactos editam-se uma vez, em “Editar dados” na linha
        da criança (ou do encarregado) acima — não aqui.
      </p>

      <WeekSchedulePicker
        showDiscountBreakdown
        value={schedule}
        onChange={setSchedule}
        availableServices={[item._type]}
        transportConfig={transportConfig}
        studyCenterConfig={studyConfig}
        discountRules={discountRules}
        schoolName={item.schoolName || undefined}
        activeSiblingCount={siblingCount}
      />

      <DiscountPicker rules={discountRules} scope={scope} selected={selectedDiscounts} onToggle={toggleDiscount} gross={gross} />

      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nota (opcional, apenas interna)" className={fieldCls} />
      {saveError && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">{saveError}</p>
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
          {saving ? 'A guardar…' : 'Guardar'}
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200">Cancelar</button>
      </div>
    </div>
  );
}
