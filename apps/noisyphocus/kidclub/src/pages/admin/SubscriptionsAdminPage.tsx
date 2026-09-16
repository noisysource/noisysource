import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getDocs, getDoc, updateDoc, addDoc, deleteDoc, query, where } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import PlacesInput from '../../components/PlacesInput';
import EnrollmentDetailsForm, { EnrollmentDetailsValue, EMPTY_ENROLLMENT_DETAILS } from '../../components/EnrollmentDetailsForm';
import { getTransportationConfig } from '../../services/transportationService';
import { familyService } from '../../services/familyService';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { Child } from '@shared/models';
import WeekSchedulePicker, { WeekScheduleValue, DayConfig } from '../../components/WeekSchedulePicker';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import { DiscountRule, AppliedDiscount } from '@shared/models/Discount';
import { getDiscountRules, applyDiscounts, grossFromAppliedDiscounts } from '../../services/discountService';
import { calculateAge } from '../../lib/utils';

type SubStatus = 'planned' | 'pending' | 'offered' | 'active' | 'cancelled';
type TypeFilter = 'all' | 'transport' | 'study' | 'unlinked';

interface SubItem {
  id: string;
  _type: 'study' | 'transport';
  childName: string;
  childId?: string;
  familyId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  source?: string;
  // Study + Transport (school name lives on the children doc)
  schoolName?: string;
  schoolYear?: string;
  days?: any[];
  monthlyPrice?: number;
  // Transport
  schedule?: any[];
  monthlyFee?: number;
  // Returning student discount (legacy)
  returningStudent?: boolean;
  originalFee?: number;    // transport: fee before discount
  basePrice?: number;      // study: fee before discount
  // Central discount system
  appliedDiscounts?: AppliedDiscount[];
  weekPattern?: 'all' | 'odd' | 'even';
  // Common
  status: SubStatus;
  statusReason?: string;
  note?: string;
  createdAt: Date;
  cancelRequested?: boolean;
  feeReviewRequired?: boolean;
  // Set when an admin edits a subscription already linked to a family/child — surfaced
  // to the parent as a review prompt (confirm/edit/reject) on their dashboard, cleared
  // once they act. See FamilyDashboardPage.tsx and the client subscription detail pages.
  needsClientReview?: boolean;
}

const toDate = (v: any): Date => v?.toDate?.() ?? new Date(v ?? 0);
const locationStr = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.address || `${v.lat ?? ''},${v.lng ?? ''}`;
};

const WEEKDAYS = [
  { value: 'monday', label: 'Segunda' },
  { value: 'tuesday', label: 'Terça' },
  { value: 'wednesday', label: 'Quarta' },
  { value: 'thursday', label: 'Quinta' },
  { value: 'friday', label: 'Sexta' },
];
const DAY_PT: Record<string, string> = {
  monday: 'Seg', tuesday: 'Ter', wednesday: 'Qua',
  thursday: 'Qui', friday: 'Sex', saturday: 'Sáb', sunday: 'Dom',
};
const dayLabel = (d: any): string => {
  if (typeof d === 'string') return DAY_PT[d] ?? d;
  return DAY_PT[d?.day ?? d?.dayOfWeek] ?? d?.day ?? d?.dayOfWeek ?? '';
};

// ─── Badges ───────────────────────────────────────────────────────────────────
const StatusBadge = ({ status, cancelRequested }: { status: SubStatus; cancelRequested?: boolean }) => {
  if (cancelRequested && status === 'active')
    return <span className="text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full font-medium">Cancelamento pedido</span>;
  const map: Record<SubStatus, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    planned: 'bg-blue-100 text-blue-800',
    offered: 'bg-purple-100 text-purple-800',
    active: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  const label: Record<SubStatus, string> = {
    pending: 'Pendente', planned: 'Planeado', offered: 'Aguarda confirmação',
    active: 'Ativa', cancelled: 'Cancelada',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status]}`}>{label[status]}</span>;
};

// ─── Trip-template form helpers ───────────────────────────────────────────────
interface TripTemplate { id: string; pickup: string; dropoff: string; time: string; days: string[] }
let _tid = 0;
const newTrip = (): TripTemplate => ({ id: String(++_tid), pickup: '', dropoff: '', time: '08:00', days: [] });

const tripsFromSchedule = (schedule: any[]): TripTemplate[] => {
  const map = new Map<string, TripTemplate>();
  for (const s of (schedule ?? [])) {
    const pickup = locationStr(s.pickupLocation);
    const dropoff = locationStr(s.dropoffLocation);
    const time = s.pickupTime ?? '08:00';
    const key = `${pickup}|${dropoff}|${time}`;
    if (!map.has(key)) map.set(key, { id: key, pickup, dropoff, time, days: [] });
    if (s.dayOfWeek) map.get(key)!.days.push(s.dayOfWeek);
  }
  return map.size > 0 ? Array.from(map.values()) : [newTrip()];
};

const tripsToSchedule = (trips: TripTemplate[]) =>
  trips.flatMap(t => t.days.map(day => ({
    dayOfWeek: day, pickupTime: t.time, pickupLocation: t.pickup, dropoffLocation: t.dropoff,
  })));

// ─── Reusable trip list editor ────────────────────────────────────────────────
function TripEditor({ trips, onChange, accent = 'indigo' }: { trips: TripTemplate[]; onChange: (t: TripTemplate[]) => void; accent?: string }) {
  const inputCls = `w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-${accent}-400`;
  const update = (id: string, patch: Partial<TripTemplate>) =>
    onChange(trips.map(t => t.id === id ? { ...t, ...patch } : t));
  const toggleDay = (id: string, day: string) =>
    update(id, { days: trips.find(t => t.id === id)!.days.includes(day)
      ? trips.find(t => t.id === id)!.days.filter(d => d !== day)
      : [...trips.find(t => t.id === id)!.days, day] });

  return (
    <div className="space-y-3">
      {trips.map((trip, idx) => (
        <div key={trip.id} className="border border-gray-200 rounded-lg bg-white p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Viagem {idx + 1}</span>
            {trips.length > 1 && (
              <button type="button" onClick={() => onChange(trips.filter(t => t.id !== trip.id))}
                className="text-xs text-red-400 hover:text-red-600">remover</button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 shrink-0">Hora</label>
            <input type="time" value={trip.time} onChange={e => update(trip.id, { time: e.target.value })}
              className="border border-gray-300 rounded px-1.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 w-28" />
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Dias</p>
            <div className="flex gap-1 flex-wrap">
              {WEEKDAYS.map(w => (
                <button key={w.value} type="button" onClick={() => toggleDay(trip.id, w.value)}
                  className={`text-xs px-2.5 py-1 rounded border font-medium transition-colors ${trip.days.includes(w.value) ? 'bg-indigo-100 text-indigo-700 border-indigo-300' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'}`}>
                  {w.label.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>
          <PlacesInput value={trip.pickup} onChange={v => update(trip.id, { pickup: v })} placeholder="Local de recolha *"
            className={inputCls} />
          <PlacesInput value={trip.dropoff} onChange={v => update(trip.id, { dropoff: v })} placeholder="Destino / entrega"
            className={inputCls} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...trips, newTrip()])}
        className="w-full text-sm text-indigo-700 border border-indigo-200 border-dashed rounded-lg py-2 hover:bg-indigo-50 transition">
        + Adicionar viagem
      </button>
    </div>
  );
}

// ─── Edit Form ────────────────────────────────────────────────────────────────
function EditForm({ item, config, onSave, onCancel }: { item: SubItem; config: TransportationConfig | null; onSave: (updated: Partial<SubItem>) => void; onCancel: () => void; }) {
  const [name, setName] = useState(item.childName);
  const [parentName, setParentName] = useState(item.contactName ?? '');
  const [email, setEmail] = useState(item.contactEmail ?? '');
  const [phone, setPhone] = useState(item.contactPhone ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [trips, setTrips] = useState<TripTemplate[]>(
    item._type === 'transport' ? tripsFromSchedule(item.schedule ?? []) : [newTrip()]
  );
  const [studyDays, setStudyDays] = useState<string[]>(
    item._type === 'study' ? (item.days ?? []).map((d: any) => typeof d === 'string' ? d : d?.day ?? d?.dayOfWeek ?? '') : []
  );
  const [schoolName, setSchoolName] = useState(item.schoolName ?? '');
  const [schoolYear, setSchoolYear] = useState(item.schoolYear ?? '');
  const [saving, setSaving] = useState(false);

  const toggleStudyDay = (day: string) =>
    setStudyDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);

  // Already linked to a family/child — the parent will see this edit and must
  // acknowledge it, rather than it silently changing under them.
  const linkedToFamily = !!item.familyId;

  const submit = async () => {
    setSaving(true);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      const patch: Record<string, any> = {
        childName: name.trim(), contactName: parentName.trim() || null,
        contactEmail: email.trim() || null,
        note: note.trim() || null, updatedAt: new Date(),
      };
      if (linkedToFamily) patch.needsClientReview = true;
      if (item._type === 'transport') {
        patch.contactMobile = phone.trim() || null;
        patch.schedule = tripsToSchedule(trips);
        if (config) patch.monthlyFee = patch.schedule.length * config.flatRatePerTrip * 4;
        // Always save schoolName on the subscription itself as fallback
        patch.schoolName = schoolName.trim() || null;
        // Also save to the children doc (canonical source) when childId is available
        if (item.childId) {
          await updateDoc(docRef('children', item.childId), { schoolName: schoolName.trim() || null, updatedAt: new Date() });
        }
      } else {
        patch.contactPhone = phone.trim() || null;
        patch.schoolName = schoolName.trim() || null;
        patch.schoolYear = schoolYear.trim() || null;
        patch.days = studyDays;
      }
      await updateDoc(docRef(colName, item.id), patch);
      onSave({
        childName: name.trim(), contactName: parentName.trim() || undefined,
        contactEmail: email.trim() || undefined,
        contactPhone: phone.trim() || undefined, note: note.trim() || undefined,
        schedule: item._type === 'transport' ? patch.schedule : item.schedule,
        monthlyFee: item._type === 'transport' ? (patch.monthlyFee ?? item.monthlyFee) : item.monthlyFee,
        schoolName: schoolName.trim() || undefined, schoolYear: schoolYear.trim() || undefined,
        days: item._type === 'study' ? studyDays : item.days,
        needsClientReview: linkedToFamily || item.needsClientReview,
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
      <div className="grid grid-cols-2 gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome da criança *" className={fieldCls} />
        <input value={parentName} onChange={e => setParentName(e.target.value)} placeholder="Nome do encarregado" className={fieldCls} />
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={fieldCls} />
        <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Telefone" className={fieldCls} />
      </div>
      {item._type === 'study' && (
        <div className="grid grid-cols-2 gap-2">
          <PlacesInput
            value={schoolName} onChange={setSchoolName} placeholder="Escola"
            types={['school', 'primary_school', 'secondary_school']} nameOnly
            className={fieldCls}
          />
          <input value={schoolYear} onChange={e => setSchoolYear(e.target.value)} placeholder="Ano escolar" className={fieldCls} />
        </div>
      )}
      {item._type === 'transport' && (
        <PlacesInput
          value={schoolName} onChange={setSchoolName} placeholder="Escola da criança"
          types={['school', 'primary_school', 'secondary_school']} nameOnly
          className={fieldCls}
        />
      )}
      {item._type === 'study' && (
        <div>
          <p className="text-xs text-gray-500 mb-1">Dias</p>
          <div className="flex gap-1 flex-wrap">
            {WEEKDAYS.map(w => (
              <button key={w.value} type="button" onClick={() => toggleStudyDay(w.value)}
                className={`text-xs px-2.5 py-1 rounded border font-medium transition-colors ${studyDays.includes(w.value) ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-gray-500 border-gray-200'}`}>
                {w.label.slice(0, 3)}
              </button>
            ))}
          </div>
        </div>
      )}
      {item._type === 'transport' && <TripEditor trips={trips} onChange={setTrips} accent="blue" />}
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nota (opcional)" className={fieldCls} />
      <div className="flex gap-2">
        <button onClick={submit} disabled={!name.trim() || saving}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
          {saving ? 'A guardar…' : 'Guardar'}
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200">Cancelar</button>
      </div>
    </div>
  );
}

// ─── Unified Manual Enrollment Form (transport + study, same as client) ───────
function ManualEnrollForm({ transportConfig, studyConfig, onSave, onCancel }: {
  transportConfig: TransportationConfig | null;
  studyConfig: StudyCenterConfig | null;
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
  const detailsFilled = details.firstName.trim() && details.lastName.trim() && details.dateOfBirth && details.contactEmail.trim();
  const isValid = !!detailsFilled && (hasTransport || hasStudy) &&
    (!hasTransport || transportDays.every(d => d.services.transportTrips!.every(t => t.pickupAddress.trim() && t.dropoffAddress.trim())));

  const validateDetails = () => {
    const errs: typeof detailErrors = {};
    if (!details.firstName.trim()) errs.firstName = 'Obrigatório';
    if (!details.lastName.trim()) errs.lastName = 'Obrigatório';
    if (!details.dateOfBirth) errs.dateOfBirth = 'Obrigatório';
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
    } finally {
      setCheckingMatches(false);
    }
  };

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
          contactEmail: details.contactEmail.trim() || null,
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
        const weeks = activeWeeksInPattern(schedule.weekPattern);
        const monthlyFee = transportConfig ? totalTrips * transportConfig.flatRatePerTrip * weeks : 0;
        const ref = await addDoc(col('transportationSubscriptions'), {
          childId, childName: fullName,
          contactName: details.contactName.trim() || null,
          contactEmail: details.contactEmail.trim() || null, contactMobile: details.contactPhone.trim() || null,
          schoolName: details.schoolName.trim() || null,
          status: 'planned', source: 'manual', monthlyFee,
          weekPattern: schedule.weekPattern,
          schedule: fsSchedule, note: note.trim() || null,
          createdAt: now, updatedAt: now,
        });
        created.push({
          id: ref.id, _type: 'transport', childId, childName: fullName,
          contactName: details.contactName.trim() || undefined,
          contactEmail: details.contactEmail.trim() || undefined,
          contactPhone: details.contactPhone.trim() || undefined,
          schoolName: details.schoolName.trim() || undefined,
          source: 'manual', schedule: fsSchedule, monthlyFee,
          status: 'planned', note: note.trim() || undefined, createdAt: now,
        });
      }

      if (hasStudy) {
        const ratePerDay = studyConfig
          ? (studyConfig.pricePerDayPerWeek != null && studyConfig.weeksPerMonth != null
              ? studyConfig.pricePerDayPerWeek * studyConfig.weeksPerMonth
              : studyConfig.monthlyPricePerWeekday)
          : 0;
        const weeks = activeWeeksInPattern(schedule.weekPattern);
        const weeksBase = studyConfig?.weeksPerMonth ?? 4;
        const monthlyPrice = studyConfig ? studyDays.length * ratePerDay * (weeks / weeksBase) : 0;
        const days = studyDays.map(d => ({ day: d.weekday, hour: d.hour }));
        const ref = await addDoc(col('studyroom'), {
          childId, childName: fullName, familyId: '',
          schoolName: details.schoolName.trim() || null,
          schoolYear: details.schoolYear.trim() || null,
          contactEmail: details.contactEmail.trim() || null,
          contactName: details.contactName.trim() || null,
          contactMobile: details.contactPhone.trim() || null,
          days, weekPattern: schedule.weekPattern,
          monthlyPrice, basePrice: monthlyPrice,
          note: note.trim() || null,
          status: 'pending', source: 'manual',
          startDate: now, endDate,
          createdAt: now, updatedAt: now,
          history: [], uploadedFiles: [], statusHistory: [], entryHistory: [],
        });
        created.push({
          id: ref.id, _type: 'study', childId, childName: fullName,
          contactName: details.contactName.trim() || undefined,
          contactEmail: details.contactEmail.trim() || undefined,
          contactPhone: details.contactPhone.trim() || undefined,
          schoolName: details.schoolName.trim() || undefined,
          schoolYear: details.schoolYear.trim() || undefined,
          days, monthlyPrice, source: 'manual', status: 'pending',
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
        value={schedule}
        onChange={setSchedule}
        availableServices={['transport', 'study']}
        transportConfig={transportConfig}
        studyCenterConfig={studyConfig}
        schoolName={details.schoolName || undefined}
      />

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

// ─── Mini Week Calendar ───────────────────────────────────────────────────────
const TRIP_COLORS = [
  { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
  { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
  { bg: 'bg-violet-100', text: 'text-violet-700', dot: 'bg-violet-500' },
  { bg: 'bg-rose-100', text: 'text-rose-700', dot: 'bg-rose-500' },
];

function MiniWeekCalendar({ item }: { item: SubItem }) {
  if (item._type === 'study') {
    const activeDays = (item.days ?? []).map((d: any) => typeof d === 'string' ? d : d?.day ?? d?.dayOfWeek ?? '');
    return (
      <div className="flex gap-1 mt-2">
        {WEEKDAYS.map(w => (
          <span key={w.value}
            className={`text-xs w-9 py-0.5 rounded text-center font-medium select-none ${activeDays.includes(w.value) ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-300'}`}>
            {w.label.slice(0, 3)}
          </span>
        ))}
      </div>
    );
  }

  const templates = tripsFromSchedule(item.schedule ?? []);
  const hasData = templates.some(t => t.days.length > 0);
  if (!hasData) return null;

  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left text-gray-400 font-normal pr-3 pb-1 w-14">Hora</th>
            {WEEKDAYS.map(w => (
              <th key={w.value} className="text-center text-gray-400 font-medium pb-1 w-9">{w.label.slice(0, 3)}</th>
            ))}
            <th className="text-left text-gray-400 font-normal pl-3 pb-1">Rota</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((trip, idx) => {
            const c = TRIP_COLORS[idx % TRIP_COLORS.length];
            const pickup = trip.pickup.split(',')[0] || '—';
            const dropoff = trip.dropoff.split(',')[0] || '—';
            return (
              <tr key={trip.id} className="h-6">
                <td className="pr-3 whitespace-nowrap">
                  <span className={`inline-block w-2 h-2 rounded-full ${c.dot} mr-1.5 align-middle`} />
                  <span className="text-gray-600 font-medium align-middle">{trip.time}</span>
                </td>
                {WEEKDAYS.map(w => (
                  <td key={w.value} className="text-center">
                    {trip.days.includes(w.value)
                      ? <span className={`inline-flex items-center justify-center w-6 h-5 rounded text-xs font-bold ${c.bg} ${c.text}`}>✓</span>
                      : <span className="text-gray-200">–</span>}
                  </td>
                ))}
                <td className="pl-3 text-gray-400 whitespace-nowrap">{pickup} → {dropoff}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Version History Modal ────────────────────────────────────────────────────
function VersionHistoryModal({ item, onClose }: { item: SubItem; onClose: () => void }) {
  const [versions, setVersions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDocs(query(col('subscriptionVersions'), where('subscriptionId', '==', item.id)))
      .then(snap => {
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        docs.sort((a: any, b: any) => {
          const ta = a.changedAt?.toDate?.() ?? new Date(a.changedAt ?? 0);
          const tb = b.changedAt?.toDate?.() ?? new Date(b.changedAt ?? 0);
          return tb.getTime() - ta.getTime();
        });
        setVersions(docs);
      })
      .finally(() => setLoading(false));
  }, [item.id]);

  const changeTypeLabel: Record<string, string> = {
    status_change: 'Mudança de estado',
    schedule_edit: 'Alteração de horário',
    fee_change: 'Alteração de mensalidade',
    discount_change: 'Alteração de desconto',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="font-bold text-gray-900">Histórico de alterações</h2>
            <p className="text-xs text-gray-500 mt-0.5">{item.childName} · {item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl font-light leading-none">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">
          {loading ? (
            <div className="text-center text-gray-400 py-8">A carregar…</div>
          ) : versions.length === 0 ? (
            <div className="text-center text-gray-400 py-8">Sem histórico registado.</div>
          ) : (
            <div className="relative pl-8">
              <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-100" />
              <div className="space-y-5">
                {versions.map((v: any, idx) => {
                  const changedAt = v.changedAt?.toDate?.() ?? new Date(v.changedAt ?? 0);
                  const snap = v.snapshot ?? {};
                  const fee = snap.monthlyFee ?? snap.monthlyPrice ?? null;
                  const discounts: AppliedDiscount[] = snap.appliedDiscounts ?? [];
                  const pct = (d: number) => `${(d * 100).toFixed(0)}%`;
                  const newSchedule: any[] | null = v.patchApplied?.schedule ?? null;
                  return (
                    <div key={v.id} className="relative">
                      <div className={`absolute w-2.5 h-2.5 rounded-full border-2 border-white ${idx === 0 ? 'bg-amber-500' : 'bg-gray-300'}`} style={{ top: 4, left: -20 }} />
                      <div className="text-xs text-gray-400 mb-1">
                        {changedAt.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {' · '}
                        <span>{v.changedBy?.role === 'parent' ? 'Encarregado' : 'Admin'}</span>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3 space-y-1.5">
                        <span className="text-xs font-semibold text-gray-700">{changeTypeLabel[v.changeType] ?? v.changeType}</span>
                        {fee != null && (
                          <div className="text-xs text-gray-600">
                            Mensalidade antes: <span className="font-semibold">€{Number(fee).toFixed(2)}</span>
                          </div>
                        )}
                        {discounts.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {discounts.map((d: AppliedDiscount) => (
                              <span key={d.ruleId} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                {d.name} -{pct(d.percentage)}
                              </span>
                            ))}
                          </div>
                        )}
                        {newSchedule && newSchedule.length > 0 && (
                          <div className="text-xs text-gray-500">
                            Novo horário: {newSchedule.map((s: any) => `${DAY_PT[s.dayOfWeek] ?? s.dayOfWeek} ${s.pickupTime ?? ''}`).join(', ')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [transportConfig, setTransportConfig] = useState<TransportationConfig | null>(null);
  const [studyConfig, setStudyConfig] = useState<StudyCenterConfig | null>(null);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [historyItem, setHistoryItem] = useState<SubItem | null>(null);

  const load = async () => {
    setIsLoading(true); setError(null);
    try {
      const [studySnap, transportSnap, childrenSnap, cfg, studyCfgSnap, rules] = await Promise.all([
        getDocs(col('studyroom')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('children')),
        getTransportationConfig(),
        getDoc(docRef('config', 'studyCenter')),
        getDiscountRules(),
      ]);
      if (cfg) setTransportConfig(cfg);
      if (studyCfgSnap.exists()) setStudyConfig(studyCfgSnap.data() as StudyCenterConfig);
      setDiscountRules(rules ?? []);

      const childSchoolMap: Record<string, string> = {};
      childrenSnap.docs.forEach(d => { const s = d.data().schoolName; if (s) childSchoolMap[d.id] = s; });
      const study: SubItem[] = studySnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id, _type: 'study',
          childName: x.childName || x.studentName || '—',
          familyId: x.familyId, contactEmail: x.email || x.contactEmail,
          contactPhone: x.phone || x.contactPhone,
          source: x.source,
          schoolName: x.schoolName, schoolYear: x.schoolYear,
          days: x.days || [], monthlyPrice: x.monthlyPrice ?? x.basePrice ?? 0,
          basePrice: x.basePrice ?? x.monthlyPrice ?? 0,
          returningStudent: x.returningStudent ?? false,
          appliedDiscounts: x.appliedDiscounts ?? [],
          weekPattern: x.weekPattern ?? 'all',
          status: (x.status === 'confirmed' ? 'active' : x.status) as SubStatus,
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested,
          feeReviewRequired: x.feeReviewRequired ?? false,
        };
      });
      const transport: SubItem[] = transportSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id, _type: 'transport',
          childName: x.childName || '—',
          childId: x.childId || undefined,
          familyId: x.familyId, contactName: x.contactName,
          contactEmail: x.contactEmail, contactPhone: x.contactMobile,
          source: x.source,
          schoolName: x.childId ? (childSchoolMap[x.childId] ?? x.schoolName) : x.schoolName,
          schedule: x.schedule || [], monthlyFee: x.monthlyFee ?? 0,
          originalFee: x.originalFee ?? x.monthlyFee ?? 0,
          returningStudent: x.returningStudent ?? false,
          appliedDiscounts: x.appliedDiscounts ?? [],
          weekPattern: x.weekPattern ?? 'all',
          status: x.status as SubStatus,
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested,
          feeReviewRequired: x.feeReviewRequired ?? false,
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

  const approve = async (item: SubItem) => {
    setProcessing(item.id);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      // Study goes confirmed (active); transport goes planned (awaiting route assignment → offered → active)
      const newStatus = item._type === 'study' ? 'confirmed' : 'planned';
      const patch: Record<string, unknown> = { status: newStatus, approvedAt: new Date(), updatedAt: new Date() };

      if (!item.familyId && item.contactEmail) {
        const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', item.contactEmail)));
        if (!famSnap.empty) patch.familyId = famSnap.docs[0].id;
      }

      await updateDoc(docRef(colName, item.id), patch);
      setItems(prev => prev.map(i => i.id === item.id
        ? { ...i, status: newStatus as SubStatus, familyId: (patch.familyId as string | undefined) ?? i.familyId }
        : i
      ));
    } finally { setProcessing(null); }
  };

  const offerToParent = async (item: SubItem) => {
    setProcessing(item.id);
    try {
      await updateDoc(docRef('transportationSubscriptions', item.id), {
        status: 'offered', offeredAt: new Date(), updatedAt: new Date(),
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'offered' as SubStatus } : i));
    } finally { setProcessing(null); }
  };

  const [bulkOffering, setBulkOffering] = useState(false);
  const offerAllPlanned = async () => {
    const toOffer = filtered.filter(i => i._type === 'transport' && i.status === 'planned');
    if (!toOffer.length) return;
    if (!window.confirm(`Publicar ${toOffer.length} inscrição(ões) de transporte para confirmação dos pais?`)) return;
    setBulkOffering(true);
    try {
      await Promise.all(toOffer.map(item =>
        updateDoc(docRef('transportationSubscriptions', item.id), { status: 'offered', offeredAt: new Date(), updatedAt: new Date() })
      ));
      setItems(prev => prev.map(i => toOffer.find(o => o.id === i.id) ? { ...i, status: 'offered' as SubStatus } : i));
    } finally { setBulkOffering(false); }
  };

  const [approveAllBusy, setApproveAllBusy] = useState(false);
  const approveAndPublishAll = async () => {
    const transportToOffer = items.filter(i => i._type === 'transport' && (i.status === 'pending' || i.status === 'planned'));
    const studyToConfirm = items.filter(i => i._type === 'study' && i.status === 'pending');
    const total = transportToOffer.length + studyToConfirm.length;
    if (!total) { alert('Não há inscrições pendentes ou planeadas para aprovar.'); return; }
    if (!window.confirm(`Aprovar ${studyToConfirm.length} inscrição(ões) de Sala de Estudo e publicar ${transportToOffer.length} de Transporte para confirmação dos pais?`)) return;
    setApproveAllBusy(true);
    try {
      await Promise.all([
        ...transportToOffer.map(i => updateDoc(docRef('transportationSubscriptions', i.id), { status: 'offered', offeredAt: new Date(), approvedAt: new Date(), updatedAt: new Date() })),
        ...studyToConfirm.map(i => updateDoc(docRef('studyroom', i.id), { status: 'confirmed', approvedAt: new Date(), updatedAt: new Date() })),
      ]);
      setItems(prev => prev.map(i => {
        if (transportToOffer.find(o => o.id === i.id)) return { ...i, status: 'offered' as SubStatus };
        if (studyToConfirm.find(o => o.id === i.id)) return { ...i, status: 'confirmed' as SubStatus };
        return i;
      }));
    } finally { setApproveAllBusy(false); }
  };

  const revertToPlanned = async (item: SubItem) => {
    setProcessing(item.id);
    try {
      await updateDoc(docRef('transportationSubscriptions', item.id), {
        status: 'planned', offeredAt: null, updatedAt: new Date(),
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'planned' as SubStatus } : i));
    } finally { setProcessing(null); }
  };

  const reject = async (item: SubItem) => {
    if (!rejectReason.trim()) return;
    setProcessing(item.id);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(docRef(colName, item.id), { status: 'cancelled', statusReason: rejectReason, rejectedAt: new Date(), updatedAt: new Date() });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'cancelled', statusReason: rejectReason } : i));
      setRejectId(null); setRejectReason('');
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

  const cancel = async (item: SubItem) => {
    if (!window.confirm(`Cancelar inscrição de ${item.childName}?`)) return;
    setProcessing(item.id);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(docRef(colName, item.id), { status: 'cancelled', statusReason: 'Cancelado pelo administrador', cancelledAt: new Date(), updatedAt: new Date() });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
    } finally { setProcessing(null); }
  };

  const revertToPending = async (item: SubItem) => {
    setProcessing(item.id);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(docRef(colName, item.id), { status: 'pending', approvedAt: null, updatedAt: new Date() });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'pending' } : i));
    } finally { setProcessing(null); }
  };

  const exportCSV = () => {
    const sep = ';';
    const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const headers = ['id', 'tipo', 'nome', 'email', 'telefone', 'escola', 'ano_letivo', 'horario_dias', 'mensalidade', 'estado', 'nota', 'data_inscricao'];
    const rows = filtered.map(item => [
      item.id,
      item._type === 'transport' ? 'Transporte' : 'Sala de Estudo',
      item.childName,
      item.contactEmail ?? '',
      item.contactPhone ?? '',
      item.schoolName ?? '',
      item.schoolYear ?? '',
      item._type === 'study'
        ? (item.days ?? []).map((d: any) => dayLabel(d)).join(', ')
        : (item.schedule ?? []).map((s: any) => `${DAY_PT[s.dayOfWeek] ?? s.dayOfWeek} ${s.pickupTime ?? ''}`).join(' / '),
      ((item.monthlyFee ?? item.monthlyPrice) ?? 0).toFixed(2),
      item.status,
      item.note ?? '',
      item.createdAt.toLocaleDateString('pt-PT'),
    ]);
    const csv = [headers.map(q).join(sep), ...rows.map(r => r.map(q).join(sep))].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inscricoes_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importCSV = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const content = text.startsWith('﻿') ? text.slice(1) : text;
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return;
      const sep = lines[0].includes(';') ? ';' : ',';
      const parseRow = (line: string) => {
        const cols: string[] = [];
        let cur = ''; let inQ = false;
        for (const ch of line + sep) {
          if (ch === '"') { inQ = !inQ; }
          else if (ch === sep && !inQ) { cols.push(cur); cur = ''; }
          else cur += ch;
        }
        return cols;
      };
      const headers = parseRow(lines[0]).map(h => h.toLowerCase().trim());
      const idx = (name: string) => headers.indexOf(name);
      let updated = 0;
      for (const line of lines.slice(1)) {
        const cols = parseRow(line);
        const id = cols[idx('id')]?.trim();
        if (!id) continue;
        const item = items.find(i => i.id === id);
        if (!item) continue;
        const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
        const patch: Record<string, any> = { updatedAt: new Date() };
        const feeRaw = cols[idx('mensalidade')]?.replace(',', '.').trim();
        if (feeRaw) {
          const fee = parseFloat(feeRaw);
          if (!isNaN(fee)) patch[item._type === 'transport' ? 'monthlyFee' : 'monthlyPrice'] = fee;
        }
        const nota = cols[idx('nota')]?.trim();
        if (nota !== undefined) patch.note = nota;
        if (Object.keys(patch).length > 1) { await updateDoc(docRef(colName, id), patch); updated++; }
      }
      await load();
      alert(`${updated} inscrição(ões) atualizadas.`);
    } catch (e: any) {
      alert(`Erro ao importar: ${e?.message}`);
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = '';
    }
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

      const gross = computeGross(item);
      const newFee = Math.round(applyDiscounts(gross, newDiscounts) * 100) / 100;
      const feeField = item._type === 'transport' ? 'monthlyFee' : 'monthlyPrice';

      await updateDoc(docRef(colName, item.id), {
        appliedDiscounts: newDiscounts, [feeField]: newFee, updatedAt: new Date(),
      });
      setItems(prev => prev.map(i => i.id === item.id
        ? { ...i, appliedDiscounts: newDiscounts, ...(i._type === 'transport' ? { monthlyFee: newFee } : { monthlyPrice: newFee }) }
        : i
      ));
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
        const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', item.contactEmail)));
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

  const grouped = useMemo(() => {
    const map = new Map<string, { key: string; label: string | null; items: SubItem[] }>();
    for (const item of filtered) {
      const key = item.familyId || item.contactEmail || item.id;
      const contact = [item.contactEmail, item.contactPhone].filter(Boolean).join(' · ');
      const label = item.contactName
        ? `${item.contactName}${contact ? ` · ${contact}` : ''}`
        : contact || null;
      if (!map.has(key)) map.set(key, { key, label, items: [] });
      map.get(key)!.items.push(item);
    }
    return Array.from(map.values());
  }, [filtered]);

  const counts = {
    pending: items.filter(i => i.status === 'pending').length,
    planned: items.filter(i => i.status === 'planned').length,
    offered: items.filter(i => i.status === 'offered').length,
    active: items.filter(i => i.status === 'active').length,
    cancelled: items.filter(i => i.status === 'cancelled').length,
    all: items.length,
    unlinked: items.filter(isUnlinked).length,
    feeReview: items.filter(i => i.feeReviewRequired).length,
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
            {counts.offered > 0 && <span className="text-purple-700 font-medium">{counts.offered} aguardam confirmação · </span>}
            {counts.active} ativas
            {counts.unlinked > 0 && <span className="text-orange-600 font-medium"> · {counts.unlinked} não vinculada(s)</span>}
            {counts.feeReview > 0 && <span className="text-amber-600 font-medium"> · {counts.feeReview} mensalidade{counts.feeReview !== 1 ? 's' : ''} em revisão</span>}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <button onClick={exportCSV}
            className="text-sm text-gray-600 border border-gray-200 px-3 py-2 rounded-lg hover:bg-gray-50 font-medium"
            title="Exportar lista atual para CSV (Excel)">
            ↓ Exportar CSV
          </button>
          <button onClick={() => importRef.current?.click()} disabled={importing}
            className="text-sm text-gray-600 border border-gray-200 px-3 py-2 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50"
            title="Importar CSV preenchido — atualiza mensalidade e nota">
            {importing ? '…' : '↑ Importar CSV'}
          </button>
          <input ref={importRef} type="file" accept=".csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) importCSV(f); }} />
          {(counts.pending > 0 || counts.planned > 0) && (
            <button onClick={approveAndPublishAll} disabled={approveAllBusy}
              className="bg-purple-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-purple-700 font-medium disabled:opacity-50">
              {approveAllBusy ? 'A processar…' : '📢 Aprovar e publicar tudo'}
            </button>
          )}
          <button onClick={() => setShowManualForm(v => !v)}
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
            {showManualForm ? '✕ Cancelar' : '+ Inscrever'}
          </button>
          <button onClick={load} className="text-sm text-blue-600 hover:underline">Atualizar</button>
        </div>
      </div>

      {/* Manual enrollment form */}
      {showManualForm && (
        <ManualEnrollForm
          transportConfig={transportConfig}
          studyConfig={studyConfig}
          onSave={newItems => { setItems(prev => [...newItems, ...prev]); setShowManualForm(false); }}
          onCancel={() => setShowManualForm(false)}
        />
      )}

      {/* Status tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-3 overflow-x-auto">
        {([
          { key: 'pending', label: 'A analisar', count: counts.pending },
          { key: 'planned', label: 'Planeadas', count: counts.planned },
          { key: 'offered', label: 'Publicadas', count: counts.offered },
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
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Pesquisar nome, email, escola…"
          className="ml-auto text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
      </div>

      {/* Bulk offer button — only on planned tab when transport items exist */}
      {tab === 'planned' && filtered.some(i => i._type === 'transport') && (
        <div className="mb-4">
          <button onClick={offerAllPlanned} disabled={bulkOffering}
            className="bg-purple-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-purple-700 font-medium disabled:opacity-50">
            {bulkOffering ? 'A publicar…' : `📢 Publicar todas para confirmação dos pais`}
          </button>
          <p className="text-xs text-gray-500 mt-1">Move as inscrições de transporte para "aguarda confirmação" — os pais verão o botão "Aceitar e confirmar" no portal.</p>
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          {tab === 'pending' ? 'Sem pedidos pendentes.' : 'Sem inscrições nesta categoria.'}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(group => (
            <div key={group.key}>
              {/* Family header — always shown, always collapsible */}
              <button
                onClick={() => setCollapsed(prev => {
                  const next = new Set(prev);
                  next.has(group.key) ? next.delete(group.key) : next.add(group.key);
                  return next;
                })}
                className="w-full flex items-center gap-2 mb-2 px-0.5 text-left group"
              >
                <span className="text-sm">👨‍👩‍👧</span>
                <span className="text-xs font-medium text-gray-500 flex-1">
                  {group.label ?? 'Sem conta vinculada'}
                </span>
                <span className="text-xs text-gray-300 mr-1">{group.items.length} inscrição{group.items.length !== 1 ? 'ões' : ''}</span>
                <span className="text-gray-400 text-xs">{collapsed.has(group.key) ? '▶' : '▼'}</span>
              </button>
              {!collapsed.has(group.key) && <div className="space-y-2">
                {group.items.map(item => (
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
                            <span className="font-semibold text-gray-900">{item.childName}</span>
                            <StatusBadge status={item.status} cancelRequested={item.cancelRequested} />
                            <span className="text-xs text-gray-400">{item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}</span>
                            {isUnlinked(item) && (
                              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">não vinculado</span>
                            )}
                            {item.feeReviewRequired && (
                              <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium">⚠ rever mensalidade</span>
                            )}
                          </div>

                          <MiniWeekCalendar item={item} />

                          {(item.schoolName || item.schoolYear) && (
                            <p className="text-xs text-gray-500 mt-1.5">{[item.schoolName, item.schoolYear].filter(Boolean).join(' · ')}</p>
                          )}
                          {(() => {
                            const fee = item._type === 'transport' ? (item.monthlyFee ?? 0) : (item.monthlyPrice ?? 0);
                            const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
                            const applied = item.appliedDiscounts ?? [];
                            const autoApplied = applied.filter(d => d.appliedBy === 'auto');
                            const adminApplied = applied.filter(d => d.appliedBy === 'admin');

                            // Manual rules from central system not yet applied
                            const manualRules = discountRules.filter(r =>
                              r.active && r.trigger === 'manual' &&
                              r.appliesTo.includes(item._type) &&
                              !applied.some(d => d.ruleId === r.id)
                            );

                            if (fee === 0 && applied.length === 0 && manualRules.length === 0) return null;

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

                                {/* Applied auto discounts */}
                                {autoApplied.length > 0 && (
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Auto</span>
                                    {autoApplied.map(d => (
                                      <span key={d.ruleId} className="text-xs px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 font-medium">
                                        {d.name} -{pct(d.percentage)}
                                      </span>
                                    ))}
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

                                {/* Available manual rules not yet applied */}
                                {item.status !== 'cancelled' && manualRules.length > 0 && (
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Adicionar</span>
                                    {manualRules.map(r => (
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
                        {item.status === 'pending' && (
                          <>
                            <button onClick={() => approve(item)} disabled={processing === item.id}
                              className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-60 whitespace-nowrap">
                              {processing === item.id ? '…' : '✓ Aprovar'}
                            </button>
                            <button onClick={() => { setRejectId(item.id); setRejectReason(''); }} disabled={processing === item.id}
                              className="bg-red-50 text-red-600 border border-red-200 text-sm px-3 py-1.5 rounded-lg hover:bg-red-100 disabled:opacity-60 whitespace-nowrap">
                              ✕ Rejeitar
                            </button>
                          </>
                        )}
                        {item.status === 'planned' && item._type === 'transport' && (
                          <>
                            <button onClick={() => offerToParent(item)} disabled={processing === item.id}
                              className="bg-purple-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-purple-700 disabled:opacity-60 whitespace-nowrap">
                              {processing === item.id ? '…' : '📢 Publicar'}
                            </button>
                            <button onClick={() => { setRejectId(item.id); setRejectReason(''); }} disabled={processing === item.id}
                              className="bg-red-50 text-red-600 border border-red-200 text-sm px-3 py-1.5 rounded-lg hover:bg-red-100 disabled:opacity-60 whitespace-nowrap">
                              ✕ Rejeitar
                            </button>
                          </>
                        )}
                        {item.status === 'offered' && (
                          <>
                            <button onClick={() => revertToPlanned(item)} disabled={processing === item.id}
                              className="bg-blue-50 text-blue-700 border border-blue-200 text-sm px-3 py-1.5 rounded-lg hover:bg-blue-100 disabled:opacity-60 whitespace-nowrap">
                              {processing === item.id ? '…' : '↩ Rever'}
                            </button>
                            <button onClick={() => approve(item)} disabled={processing === item.id}
                              className="bg-green-50 text-green-700 border border-green-200 text-sm px-3 py-1.5 rounded-lg hover:bg-green-100 disabled:opacity-60 whitespace-nowrap">
                              {processing === item.id ? '…' : '✓ Forçar ativo'}
                            </button>
                          </>
                        )}
                        {item.status === 'active' && (
                          <>
                            <button onClick={() => revertToPending(item)} disabled={processing === item.id}
                              className="bg-yellow-50 text-yellow-700 border border-yellow-200 text-sm px-3 py-1.5 rounded-lg hover:bg-yellow-100 disabled:opacity-60 whitespace-nowrap">
                              {processing === item.id ? '…' : '↩ Pendente'}
                            </button>
                            <button onClick={() => cancel(item)} disabled={processing === item.id}
                              className="bg-gray-100 text-gray-600 border border-gray-200 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-60 whitespace-nowrap">
                              {processing === item.id ? '…' : 'Cancelar'}
                            </button>
                          </>
                        )}
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

                    {rejectId === item.id && (
                      <div className="mt-4 pt-4 border-t border-gray-100">
                        <label className="block text-sm font-medium text-gray-700 mb-1">Motivo da rejeição</label>
                        <input type="text" value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                          placeholder="ex: Sem vagas disponíveis"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 mb-3" autoFocus />
                        <div className="flex gap-2">
                          <button onClick={() => reject(item)} disabled={!rejectReason.trim() || processing === item.id}
                            className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-700 disabled:opacity-60">
                            Confirmar rejeição
                          </button>
                          <button onClick={() => setRejectId(null)} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                    {editId === item.id && (
                      <EditForm
                        item={item}
                        config={transportConfig}
                        onSave={updated => {
                          setItems(prev => prev.map(i => i.id === item.id ? { ...i, ...updated } : i));
                          setEditId(null);
                        }}
                        onCancel={() => setEditId(null)}
                      />
                    )}
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
