import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getDocs, getDoc, updateDoc, addDoc, deleteDoc, deleteField, query, where } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import PlacesInput from '../../components/PlacesInput';
import EnrollmentDetailsForm, { EnrollmentDetailsValue, EMPTY_ENROLLMENT_DETAILS, EMPTY_ENROLLMENT_ADDRESS, validateEnrollmentDetails } from '../../components/EnrollmentDetailsForm';
import { getTransportationConfig } from '../../services/transportationService';
import { familyService } from '../../services/familyService';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { Child, Family } from '@shared/models';
import { resolvePersonalData } from '../../lib/personalData';
import WeekSchedulePicker, { WeekScheduleValue, DayConfig } from '../../components/WeekSchedulePicker';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import { DiscountRule, AppliedDiscount, DiscountScope } from '@shared/models/Discount';
import { getDiscountRules, applyDiscounts, resolveAutoDiscounts, grossFromAppliedDiscounts, DayLike } from '../../services/discountService';
import { calculateAge, normalizeName, SubStatus, normalizeSubStatus } from '../../lib/utils';

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
  // Operational tracking only — never gates status. Transport's old "planned"
  // status used to double as "awaiting route assignment"; now that's this
  // independent boolean instead of a hidden third status axis.
  routeAssigned?: boolean;
  // Returning student discount (legacy)
  returningStudent?: boolean;
  originalFee?: number;    // transport: fee before discount
  basePrice?: number;      // study: fee before discount
  // Central discount system
  appliedDiscounts?: AppliedDiscount[];
  /** Admin overrides of the automatic discounts, by rule id. See DiscountOverrides. */
  discountOverrides?: Record<string, boolean>;
  weekPattern?: 'all' | 'odd' | 'even';
  // Common
  status: SubStatus;
  statusReason?: string;
  note?: string;
  createdAt: Date;
  cancelRequested?: boolean;
  feeReviewRequired?: boolean;
  // Two-way in-app review flags (no email for this). clientReviewPending: set
  // whenever admin changes a subscription (status or details) that's already
  // linked to a family/child — surfaced as a review prompt on the parent's
  // dashboard, cleared once they act. adminReviewPending: set whenever a
  // client-initiated change happens (e.g. a cancel request) — surfaced here,
  // cleared once admin views/acts on it. lastClientAction records *what* the
  // client did last, so the adminReviewPending badge can say what to do next
  // instead of a single generic "review needed" for every case.
  clientReviewPending?: boolean;
  adminReviewPending?: boolean;
  lastClientAction?: LastClientAction;
}

type LastClientAction = 'confirmed' | 'cancelRequested' | 'edited' | 'rejected';

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
// ─── Badges ───────────────────────────────────────────────────────────────────
const StatusBadge = ({ status, cancelRequested }: { status: SubStatus; cancelRequested?: boolean }) => {
  if (cancelRequested && status === 'active')
    return <span className="text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full font-medium">Cancelamento pedido</span>;
  const map: Record<SubStatus, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    active: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  const label: Record<SubStatus, string> = {
    pending: 'Pendente', active: 'Ativa', cancelled: 'Cancelada',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status]}`}>{label[status]}</span>;
};

// What the admin should do next for each kind of client-initiated change —
// one generic "review needed" badge doesn't say whether it's ready to
// activate, needs a call about a cancellation, or is just an FYI.
const CLIENT_ACTION_BADGE: Record<LastClientAction, { label: string; cls: string }> = {
  confirmed: { label: '✅ Confirmado — ativar', cls: 'bg-green-100 text-green-800 hover:bg-green-200' },
  cancelRequested: { label: '🚫 Pedido de cancelamento', cls: 'bg-red-100 text-red-800 hover:bg-red-200' },
  edited: { label: '✏️ Encarregado editou o pedido', cls: 'bg-blue-100 text-blue-800 hover:bg-blue-200' },
  rejected: { label: '⚠️ Encarregado recusou a alteração', cls: 'bg-amber-100 text-amber-800 hover:bg-amber-200' },
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

// ─── Discount picker (shared by ManualEnrollForm and EditForm) ────────────────
// Single source of truth for the fee math: applyDiscounts() here is the exact
// same function the list view's toggleManualDiscount/computeGross use, so
// whatever total is shown on screen is exactly what gets persisted.
function DiscountPicker({ rules, scope, selected, onToggle, gross }: {
  rules: DiscountRule[];
  scope: DiscountScope;
  selected: AppliedDiscount[];
  onToggle: (rule: DiscountRule) => void;
  gross: number;
}) {
  const applicable = rules.filter(r => r.active && r.appliesTo.includes(scope));
  const net = applyDiscounts(gross, selected);
  if (applicable.length === 0 && selected.length === 0) return null;
  return (
    <div className="space-y-2 bg-gray-50 rounded-lg p-3 border border-gray-100">
      <p className="text-xs font-semibold text-gray-600">Descontos</p>
      <div className="flex flex-wrap gap-2">
        {applicable.map(rule => {
          const isSelected = selected.some(d => d.ruleId === rule.id);
          return (
            <label key={rule.id}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400'}`}>
              <input type="checkbox" checked={isSelected} onChange={() => onToggle(rule)} className="accent-blue-600" />
              {rule.name} -{(rule.percentage * 100).toFixed(0)}%
            </label>
          );
        })}
        {applicable.length === 0 && <p className="text-xs text-gray-400">Sem regras de desconto para este serviço.</p>}
      </div>
      <div className="flex items-baseline gap-2 text-sm pt-1">
        {net < gross - 0.01 && <span className="text-gray-400 line-through">€{gross.toFixed(2)}</span>}
        <span className="font-semibold text-gray-800">€{net.toFixed(2)}/mês</span>
      </div>
    </div>
  );
}

// ─── Grouping model ───────────────────────────────────────────────────────────
// The list is family → child → subscriptions. Personal data belongs to the
// first two levels and is edited there, exactly once; a subscription row below
// carries only what is genuinely per-subscription. Before this, every
// subscription card repeated (and separately edited) the child's name, school
// and guardian contact — which is how one child's transport and study
// documents ended up naming two different schools.
interface ChildGroup {
  key: string;
  childId?: string;
  familyId?: string;
  childName: string;
  schoolName?: string;
  schoolYear?: string;
  items: SubItem[];
}

interface FamilyGroup {
  key: string;
  label: string | null;
  familyId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  children: ChildGroup[];
  count: number;
}

// ─── Child details form ───────────────────────────────────────────────────────
// Writes the canonical children/{childId} record, then mirrors the handful of
// fields functions/src/kidclub still reads off the subscription onto EVERY one
// of this child's subscriptions at once — which is the point: one edit, one
// value, no way for two subscriptions of the same child to disagree.
function ChildDetailsForm({ group, onSaved, onCancel }: {
  group: ChildGroup;
  onSaved: (patch: Partial<SubItem>, newChildId?: string) => void;
  onCancel: () => void;
}) {
  const [details, setDetails] = useState<EnrollmentDetailsValue>(() => {
    const parts = group.childName.trim().split(' ');
    return {
      ...EMPTY_ENROLLMENT_DETAILS,
      firstName: parts[0] ?? '', lastName: parts.slice(1).join(' '),
      schoolName: group.schoolName ?? '', schoolYear: group.schoolYear ?? '',
    };
  });
  const [errors, setErrors] = useState<Partial<Record<keyof EnrollmentDetailsValue, string>>>({});
  const [loading, setLoading] = useState(!!group.childId);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const originalSchool = group.schoolName ?? '';

  // dateOfBirth and homeAddress only exist on the children doc.
  useEffect(() => {
    if (!group.childId) return;
    familyService.getChild(group.childId).then(c => {
      if (!c) { setLoadFailed(true); return; }
      setDetails(prev => ({
        ...prev,
        firstName: c.firstName ?? prev.firstName,
        lastName: c.lastName ?? prev.lastName,
        dateOfBirth: c.dateOfBirth && !isNaN(c.dateOfBirth.getTime()) ? c.dateOfBirth.toISOString().split('T')[0] : '',
        schoolName: c.schoolName ?? prev.schoolName,
        schoolYear: c.schoolYear ?? prev.schoolYear,
        homeAddress: c.homeAddress
          ? { street: c.homeAddress.street ?? '', city: c.homeAddress.city ?? '', postalCode: c.homeAddress.postalCode ?? '', country: c.homeAddress.country ?? '' }
          : EMPTY_ENROLLMENT_ADDRESS,
      }));
    }).catch(() => setLoadFailed(true)).finally(() => setLoading(false));
  }, [group.childId]);

  const submit = async () => {
    const errs = validateEnrollmentDetails(details);
    // Guardian contact is edited at the family level, not here.
    delete errs.contactEmail;
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const fullName = `${details.firstName.trim()} ${details.lastName.trim()}`;
      const dob = new Date(details.dateOfBirth + 'T12:00:00');
      const childDoc = {
        firstName: details.firstName.trim(), lastName: details.lastName.trim(),
        dateOfBirth: dob, age: calculateAge(dob),
        schoolName: details.schoolName.trim() || null,
        schoolYear: details.schoolYear.trim() || null,
        homeAddress: {
          street: details.homeAddress.street.trim(), city: details.homeAddress.city.trim(),
          postalCode: details.homeAddress.postalCode.trim(), country: details.homeAddress.country.trim() || null,
        },
        updatedAt: new Date(),
      };

      let childId = group.childId;
      if (childId) {
        await updateDoc(docRef('children', childId), childDoc);
      } else {
        // Legacy gap: a subscription predating automatic child creation. Same
        // familyId: '' placeholder ManualEnrollForm uses for an admin-created
        // child awaiting claim — the claim flow links to it rather than
        // duplicating it (see PendingChild.existingChild).
        const ref = await addDoc(col('children'), {
          ...childDoc, familyId: group.familyId ?? '', status: 'active', createdAt: new Date(),
        });
        childId = ref.id;
      }

      // Mirror onto every subscription this child holds. These copies are not
      // read by any page any more, but functions/src/kidclub still reads them:
      // sub.childName (billing line-item titles, notification emails) and
      // sub.schoolName (discountRecalc's auto_school rule — the 20% Colégio
      // Bissaya Barreto transport discount).
      const failures: string[] = [];
      for (const item of group.items) {
        const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
        const patch: Record<string, any> = {
          childName: fullName,
          schoolName: details.schoolName.trim() || null,
          updatedAt: new Date(),
        };
        if (item._type === 'study') patch.schoolYear = details.schoolYear.trim() || null;
        if (!item.childId && childId) patch.childId = childId;
        // The parent should see a change the team made to their child's record.
        if (item.familyId) patch.clientReviewPending = true;
        try {
          await updateDoc(docRef(colName, item.id), patch);
        } catch (err: any) {
          console.error(`Failed to mirror child details onto ${colName}/${item.id}:`, err);
          failures.push(item.id);
        }
      }
      if (failures.length) {
        setSaveError(`Dados da criança guardados, mas ${failures.length} inscrição(ões) não ficaram sincronizadas. Recarregue e tente novamente.`);
        return;
      }

      onSaved({
        childName: fullName,
        schoolName: details.schoolName.trim() || undefined,
        schoolYear: details.schoolYear.trim() || undefined,
      }, group.childId ? undefined : childId);
    } catch (err: any) {
      console.error('Failed to save child details:', err);
      setSaveError(`Falha ao guardar os dados da criança: ${err?.message ?? 'erro desconhecido'}`);
    } finally { setSaving(false); }
  };

  const schoolChanged = details.schoolName.trim() !== originalSchool.trim();

  return (
    <div className="bg-white rounded-lg border border-blue-200 p-4 mb-2 space-y-3">
      <p className="text-sm font-semibold text-gray-700">Dados da criança</p>
      <p className="text-xs text-gray-400">
        Aplica-se a todas as inscrições desta criança ({group.items.length}).
      </p>
      {!group.childId && (
        <p className="text-xs text-amber-600">
          Esta criança ainda não tem registo próprio — ao guardar, cria-se um e as inscrições ficam associadas a ele.
        </p>
      )}
      {loadFailed && (
        <p className="text-xs text-amber-600">Não foi possível carregar o registo da criança — data de nascimento e morada podem estar em branco.</p>
      )}
      {loading ? (
        <p className="text-xs text-gray-400">A carregar dados da criança…</p>
      ) : (
        <EnrollmentDetailsForm value={details} onChange={setDetails} showContactFields={false} errors={errors} />
      )}
      {schoolChanged && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Mudar a escola pode alterar a mensalidade de transporte — o desconto de escola é
          resolvido a partir deste campo.
        </p>
      )}
      {saveError && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">{saveError}</p>
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || loading}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
          {saving ? 'A guardar…' : 'Guardar'}
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200">Cancelar</button>
      </div>
    </div>
  );
}

// ─── Family contact form ──────────────────────────────────────────────────────
// Guardian details, edited once for the whole family. Writes
// families/{id}.primaryContact (the canonical record every page now reads),
// then mirrors onto the family's children and subscriptions — the children
// copy because the Firestore rules let a parent claim an admin-created child
// by matching children/{id}.contactEmail against their auth token, the
// subscription copy because notifications.ts sends to sub.contactEmail.
function FamilyContactForm({ group, onSaved, onCancel }: {
  group: FamilyGroup;
  onSaved: (patch: Partial<SubItem>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(group.contactName ?? '');
  const [email, setEmail] = useState(group.contactEmail ?? '');
  const [phone, setPhone] = useState(group.contactPhone ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim()) { setSaveError('Email do encarregado é obrigatório.'); return; }
    setSaving(true);
    setSaveError(null);
    try {
      if (group.familyId) {
        const famSnap = await getDoc(docRef('families', group.familyId));
        const prev = famSnap.exists() ? (famSnap.data().primaryContact ?? {}) : {};
        await updateDoc(docRef('families', group.familyId), {
          // Merge: blanking an optional field here must not wipe what the
          // family already has.
          primaryContact: {
            ...prev,
            ...(name.trim() ? { name: name.trim() } : {}),
            email: email.trim(),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
          },
          updatedAt: new Date(),
        });
      }

      const childIds = new Set(group.children.map(c => c.childId).filter(Boolean) as string[]);
      for (const childId of childIds) {
        try {
          await updateDoc(docRef('children', childId), {
            contactEmail: email.trim(),
            ...(phone.trim() ? { contactPhone: phone.trim() } : {}),
            updatedAt: new Date(),
          });
        } catch (err) {
          console.error(`Failed to mirror contact onto children/${childId}:`, err);
        }
      }

      const failures: string[] = [];
      for (const item of group.children.flatMap(c => c.items)) {
        const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
        const patch: Record<string, any> = {
          contactName: name.trim() || null,
          contactEmail: email.trim(),
          updatedAt: new Date(),
        };
        // transport spells it contactMobile, study spells it contactPhone
        if (item._type === 'transport') patch.contactMobile = phone.trim() || null;
        else patch.contactPhone = phone.trim() || null;
        try {
          await updateDoc(docRef(colName, item.id), patch);
        } catch (err: any) {
          console.error(`Failed to mirror contact onto ${colName}/${item.id}:`, err);
          failures.push(item.id);
        }
      }
      if (failures.length) {
        setSaveError(`Contactos guardados, mas ${failures.length} inscrição(ões) não ficaram sincronizadas. Recarregue e tente novamente.`);
        return;
      }

      onSaved({
        contactName: name.trim() || undefined,
        contactEmail: email.trim(),
        contactPhone: phone.trim() || undefined,
      });
    } catch (err: any) {
      console.error('Failed to save family contact:', err);
      setSaveError(`Falha ao guardar os contactos: ${err?.message ?? 'erro desconhecido'}`);
    } finally { setSaving(false); }
  };

  const fieldCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300';

  return (
    <div className="bg-white rounded-lg border border-gray-300 p-4 mb-2 space-y-3">
      <p className="text-sm font-semibold text-gray-700">Contactos do encarregado</p>
      <p className="text-xs text-gray-400">
        Aplica-se a toda a família ({group.count} inscrição{group.count !== 1 ? 'ões' : ''}).
      </p>
      {!group.familyId && (
        <p className="text-xs text-amber-600">
          Sem conta vinculada — os contactos ficam guardados nas próprias inscrições até o encarregado reclamar a conta.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Nome do encarregado</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} className={fieldCls} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Email do encarregado *</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldCls} />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-500 mb-1">Telefone</label>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className={fieldCls} />
        </div>
      </div>
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

// ─── Edit Form ────────────────────────────────────────────────────────────────
// Subscription-specific fields ONLY: schedule, week pattern, discounts, fee,
// internal note. Who the child is, which school they attend and how to reach
// their guardian are edited once per child / once per family, in
// ChildDetailsForm and FamilyContactForm above — not here, and not once per
// subscription. Repeating that block on every subscription is what let a
// child's two subscriptions end up claiming two different schools.
function EditForm({ item, transportConfig, studyConfig, discountRules, onSave, onCancel }: {
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

// ─── Unified Manual Enrollment Form (transport + study, same as client) ───────
function ManualEnrollForm({ transportConfig, studyConfig, discountRules, onSave, onCancel }: {
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
      const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', details.contactEmail.trim())));
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
        const monthlyFee = Math.round(applyDiscounts(transportGross, transportSelected) * 100) / 100;
        const ref = await addDoc(col('transportationSubscriptions'), {
          childId, childName: fullName,
          contactName: details.contactName.trim() || null,
          contactEmail: details.contactEmail.trim() || null, contactMobile: details.contactPhone.trim() || null,
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
          contactEmail: details.contactEmail.trim() || undefined,
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
          contactEmail: details.contactEmail.trim() || null,
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
          contactEmail: details.contactEmail.trim() || undefined,
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
        const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', item.contactEmail)));
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
