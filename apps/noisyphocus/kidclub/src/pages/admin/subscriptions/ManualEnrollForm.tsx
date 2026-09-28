import { useState } from 'react';
import { getDocs, addDoc, query, where } from 'firebase/firestore';
import { col } from '../../../lib/db';
import EnrollmentDetailsForm, { EnrollmentDetailsValue, EMPTY_ENROLLMENT_DETAILS, validateEnrollmentDetails } from '../../../components/EnrollmentDetailsForm';
import { familyService } from '../../../services/familyService';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { Child } from '@shared/models';
import WeekSchedulePicker, { WeekScheduleValue } from '../../../components/WeekSchedulePicker';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import { DiscountRule, AppliedDiscount, DiscountScope } from '@shared/models/Discount';
import { applyDiscounts, resolveAutoDiscounts } from '../../../services/discountService';
import { calculateAge, normalizeEmail } from '../../../lib/utils';
import { SubItem } from './model';
import DiscountPicker from './DiscountPicker';

// ─── Unified Manual Enrollment Form (transport + study, same as client) ───────
export default function ManualEnrollForm({ transportConfig, studyConfig, discountRules, onSave, onCancel }: {
  transportConfig: TransportationConfig | null;
  studyConfig: StudyCenterConfig | null;
  discountRules: DiscountRule[];
  onSave: (items: SubItem[]) => void;
  onCancel: () => void;
}) {
  const [details, setDetails] = useState<EnrollmentDetailsValue>(EMPTY_ENROLLMENT_DETAILS);
  const [detailErrors, setDetailErrors] = useState<Partial<Record<keyof EnrollmentDetailsValue, string>>>({});
  const [note, setNote] = useState('');
  const [schedule, setSchedule] = useState<WeekScheduleValue>({ weekPattern: 'all', days: [] });
  const [saving, setSaving] = useState(false);

  // Subscriptions must always reference a real child (never an empty childId) — before
  // saving, search for an existing child by name/contact and let the admin link to it
  // instead of creating a duplicate. null = not checked yet for the current details.
  const [matches, setMatches] = useState<Child[] | null>(null);
  const [checkingMatches, setCheckingMatches] = useState(false);
  const [selectedChildId, setSelectedChildId] = useState<string | 'new' | null>(null);
  // Other children in the same family with an active subscription — feeds the
  // auto_sibling discount check. Resolved alongside the child-match lookup.
  const [siblingCount, setSiblingCount] = useState(0);

  const updateDetails = (v: EnrollmentDetailsValue) => {
    // Identity changed — any previous match resolution no longer applies.
    if (v.firstName !== details.firstName || v.lastName !== details.lastName || v.contactEmail !== details.contactEmail) {
      setMatches(null);
      setSelectedChildId(null);
    }
    setDetails(v);
  };

  const transportDays = schedule.days.filter(d => (d.services.transportTrips?.length ?? 0) > 0);
  const studyDays = schedule.days.filter(d => d.services.study);
  const totalTrips = transportDays.reduce((sum, d) => sum + (d.services.transportTrips?.length ?? 0), 0);

  const hasTransport = totalTrips > 0;
  const hasStudy = studyDays.length > 0;
  const detailsFilled = Object.keys(validateEnrollmentDetails(details)).length === 0 && details.contactEmail.trim();
  const isValid = !!detailsFilled && (hasTransport || hasStudy) &&
    (!hasTransport || transportDays.every(d => d.services.transportTrips!.every(t => t.pickupAddress.trim() && t.dropoffAddress.trim())));

  // isValid collapses several independent requirements into one boolean, so
  // a disabled "Guardar inscrição" button gave no clue which one was unmet
  // — surfaced explicitly instead of leaving the admin to guess.
  const missingReasons: string[] = [];
  if (Object.keys(validateEnrollmentDetails(details)).length > 0) missingReasons.push('Preencha os dados da criança/encarregado acima');
  else if (!details.contactEmail.trim()) missingReasons.push('Email do encarregado é obrigatório');
  if (!hasTransport && !hasStudy) missingReasons.push('Selecione pelo menos um dia (Sala de Estudo ou Transporte) no calendário acima');
  if (hasTransport && !transportDays.every(d => d.services.transportTrips!.every(t => t.pickupAddress.trim() && t.dropoffAddress.trim()))) {
    missingReasons.push('Preencha origem e destino de todas as viagens de transporte');
  }
  if (isValid && matches !== null && !selectedChildId) missingReasons.push('Escolha se é a mesma criança encontrada ou uma criança nova');

  const validateDetails = () => {
    const errs = validateEnrollmentDetails(details);
    if (!details.contactEmail.trim()) errs.contactEmail = 'Obrigatório';
    setDetailErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const checkForMatches = async () => {
    if (!validateDetails()) return;
    setCheckingMatches(true);
    try {
      const found = await familyService.findMatchingChildren(details.firstName, details.lastName, details.contactEmail);
      setMatches(found);
      if (found.length === 0) setSelectedChildId('new');
      const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', normalizeEmail(details.contactEmail))));
      if (!famSnap.empty) {
        const siblings = await familyService.getFamilyChildren(famSnap.docs[0].id);
        const counts = await Promise.all(siblings.map(s => familyService.getChildSubscriptionCounts(s.id)));
        setSiblingCount(counts.filter(c => c > 0).length);
      } else {
        setSiblingCount(0);
      }
    } finally {
      setCheckingMatches(false);
    }
  };

  // Discount selection, per scope. resolveAutoDiscounts() is the single source of
  // truth for which rules auto-apply; admin overrides (explicit check/uncheck)
  // always win over that default, in either direction.
  const [transportOverrides, setTransportOverrides] = useState<Map<string, boolean>>(new Map());
  const [studyOverrides, setStudyOverrides] = useState<Map<string, boolean>>(new Map());

  const transportGross = transportConfig ? totalTrips * transportConfig.flatRatePerTrip * activeWeeksInPattern(schedule.weekPattern) : 0;
  const studyRatePerDay = studyConfig
    ? (studyConfig.pricePerDayPerWeek != null && studyConfig.weeksPerMonth != null
        ? studyConfig.pricePerDayPerWeek * studyConfig.weeksPerMonth
        : studyConfig.monthlyPricePerWeekday)
    : 0;
  const studyWeeksBase = studyConfig?.weeksPerMonth ?? 4;
  const studyGross = studyConfig ? studyDays.length * studyRatePerDay * (activeWeeksInPattern(schedule.weekPattern) / studyWeeksBase) : 0;

  const transportAuto = hasTransport ? resolveAutoDiscounts(discountRules, 'transport', transportDays, details.schoolName, siblingCount) : [];
  const studyAuto = hasStudy ? resolveAutoDiscounts(discountRules, 'study', studyDays, details.schoolName, siblingCount) : [];

  const resolveSelected = (scope: DiscountScope, auto: AppliedDiscount[], overrides: Map<string, boolean>): AppliedDiscount[] =>
    discountRules
      .filter(r => r.active && r.appliesTo.includes(scope))
      .filter(r => overrides.has(r.id) ? overrides.get(r.id)! : auto.some(a => a.ruleId === r.id))
      .map(r => ({
        ruleId: r.id, name: r.name, percentage: r.percentage, appliedAt: new Date(),
        appliedBy: (!overrides.has(r.id) && auto.some(a => a.ruleId === r.id)) ? 'auto' as const : 'admin' as const,
      }));

  const transportSelected = resolveSelected('transport', transportAuto, transportOverrides);
  const studySelected = resolveSelected('study', studyAuto, studyOverrides);

  const toggleTransportDiscount = (rule: DiscountRule) => setTransportOverrides(prev => {
    const next = new Map(prev);
    next.set(rule.id, !transportSelected.some(d => d.ruleId === rule.id));
    return next;
  });
  const toggleStudyDiscount = (rule: DiscountRule) => setStudyOverrides(prev => {
    const next = new Map(prev);
    next.set(rule.id, !studySelected.some(d => d.ruleId === rule.id));
    return next;
  });

  const submit = async () => {
    if (!isValid || !selectedChildId) return;
    setSaving(true);
    try {
      const now = new Date();
      const endDate = new Date(now);
      endDate.setFullYear(endDate.getFullYear() + 1);

      let childId = selectedChildId;
      if (childId === 'new') {
        const dob = new Date(details.dateOfBirth + 'T12:00:00');
        const ref = await addDoc(col('children'), {
          familyId: '', // resolved once the parent claims this subscription
          firstName: details.firstName.trim(),
          lastName: details.lastName.trim(),
          dateOfBirth: dob,
          age: calculateAge(dob),
          schoolName: details.schoolName.trim() || null,
          schoolYear: details.schoolYear.trim() || null,
          homeAddress: {
            street: details.homeAddress.street.trim(),
            city: details.homeAddress.city.trim(),
            postalCode: details.homeAddress.postalCode.trim(),
            country: details.homeAddress.country.trim() || null,
          },
          contactEmail: normalizeEmail(details.contactEmail) || null,
          contactPhone: details.contactPhone.trim() || null,
          status: 'active',
          createdAt: now, updatedAt: now,
        });
        childId = ref.id;
      }

      const fullName = `${details.firstName.trim()} ${details.lastName.trim()}`;
      const created: SubItem[] = [];

      if (hasTransport) {
        const fsSchedule = transportDays.flatMap(d =>
          d.services.transportTrips!.map(t => ({
            dayOfWeek: d.weekday,
            pickupTime: t.time,
            pickupLocation: t.pickupAddress,
            dropoffLocation: t.dropoffAddress,
          }))
        );
        const monthlyFee = Math.round(applyDiscounts(transportGross, transportSelected) * 100) / 100;
        const ref = await addDoc(col('transportationSubscriptions'), {
          childId, childName: fullName,
          contactName: details.contactName.trim() || null,
          contactEmail: normalizeEmail(details.contactEmail) || null, contactMobile: details.contactPhone.trim() || null,
          schoolName: details.schoolName.trim() || null,
          status: 'pending', source: 'manual', monthlyFee, originalFee: transportGross,
          appliedDiscounts: transportSelected,
          discountOverrides: Object.fromEntries(transportOverrides),
          weekPattern: schedule.weekPattern,
          schedule: fsSchedule, note: note.trim() || null,
          createdAt: now, updatedAt: now,
        });
        created.push({
          id: ref.id, _type: 'transport', childId, childName: fullName,
          contactName: details.contactName.trim() || undefined,
          contactEmail: normalizeEmail(details.contactEmail) || undefined,
          contactPhone: details.contactPhone.trim() || undefined,
          schoolName: details.schoolName.trim() || undefined,
          source: 'manual', schedule: fsSchedule, monthlyFee, appliedDiscounts: transportSelected,
          discountOverrides: Object.fromEntries(transportOverrides),
          status: 'pending', note: note.trim() || undefined, createdAt: now,
        });
      }

      if (hasStudy) {
        const monthlyPrice = Math.round(applyDiscounts(studyGross, studySelected) * 100) / 100;
        const days = studyDays.map(d => ({ day: d.weekday, hour: d.hour }));
        const ref = await addDoc(col('studyroom'), {
          childId, childName: fullName, familyId: '',
          schoolName: details.schoolName.trim() || null,
          schoolYear: details.schoolYear.trim() || null,
          contactEmail: normalizeEmail(details.contactEmail) || null,
          contactName: details.contactName.trim() || null,
          contactMobile: details.contactPhone.trim() || null,
          days, weekPattern: schedule.weekPattern,
          monthlyPrice, basePrice: studyGross,
          appliedDiscounts: studySelected,
          discountOverrides: Object.fromEntries(studyOverrides),
          note: note.trim() || null,
          status: 'pending', source: 'manual',
          startDate: now, endDate,
          createdAt: now, updatedAt: now,
          history: [], uploadedFiles: [], statusHistory: [], entryHistory: [],
        });
        created.push({
          id: ref.id, _type: 'study', childId, childName: fullName,
          contactName: details.contactName.trim() || undefined,
          contactEmail: normalizeEmail(details.contactEmail) || undefined,
          contactPhone: details.contactPhone.trim() || undefined,
          schoolName: details.schoolName.trim() || undefined,
          schoolYear: details.schoolYear.trim() || undefined,
          days, monthlyPrice, basePrice: studyGross, appliedDiscounts: studySelected,
          discountOverrides: Object.fromEntries(studyOverrides),
          source: 'manual', status: 'pending',
          note: note.trim() || undefined, createdAt: now,
        });
      }

      onSave(created);
    } finally { setSaving(false); }
  };

  const fieldCls = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400';

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-4 space-y-4">
      <h3 className="font-semibold text-blue-900">Nova inscrição</h3>

      <EnrollmentDetailsForm value={details} onChange={updateDetails} errors={detailErrors} />
      <input value={note} onChange={e => setNote(e.target.value)}
        placeholder="Nota (opcional, apenas interna)" className={fieldCls} />

      <WeekSchedulePicker
        showDiscountBreakdown
        value={schedule}
        onChange={setSchedule}
        availableServices={['transport', 'study']}
        transportConfig={transportConfig}
        studyCenterConfig={studyConfig}
        schoolName={details.schoolName || undefined}
      />

      {hasTransport && (
        <DiscountPicker rules={discountRules} scope="transport" selected={transportSelected} onToggle={toggleTransportDiscount} gross={transportGross} />
      )}
      {hasStudy && (
        <DiscountPicker rules={discountRules} scope="study" selected={studySelected} onToggle={toggleStudyDiscount} gross={studyGross} />
      )}

      {/* Child-matching step: must resolve to an existing or new child before saving */}
      {matches === null ? (
        <button
          onClick={checkForMatches}
          disabled={checkingMatches}
          className="w-full text-sm text-indigo-700 border border-indigo-200 border-dashed rounded-lg py-2 hover:bg-indigo-50 transition disabled:opacity-60"
        >
          {checkingMatches ? 'A verificar…' : 'Verificar criança existente'}
        </button>
      ) : matches.length > 0 && (
        <div className="bg-white border border-indigo-200 rounded-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-indigo-900">
            Encontrámos {matches.length === 1 ? 'uma criança que pode ser a mesma' : `${matches.length} crianças que podem ser a mesma`}:
          </p>
          {matches.map(child => (
            <label key={child.id} className="flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-indigo-50 cursor-pointer">
              <input type="radio" name="childMatch" checked={selectedChildId === child.id}
                onChange={() => setSelectedChildId(child.id)} />
              <span>{child.firstName} {child.lastName}</span>
              {child.schoolName && <span className="text-gray-400">· {child.schoolName}</span>}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-indigo-50 cursor-pointer border-t border-gray-100 pt-2">
            <input type="radio" name="childMatch" checked={selectedChildId === 'new'}
              onChange={() => setSelectedChildId('new')} />
            <span>Não é a mesma — criar criança nova</span>
          </label>
        </div>
      )}

      {missingReasons.length > 0 && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-0.5">
          {missingReasons.map((r, i) => <p key={i}>⚠ {r}</p>)}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={submit} disabled={!isValid || !selectedChildId || saving}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
          {saving ? 'A guardar…' : 'Guardar inscrição'}
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-600">
          Cancelar
        </button>
      </div>
    </div>
  );
}
