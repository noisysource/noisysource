import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getDocs, updateDoc, addDoc, deleteDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import PlacesInput from '../../components/PlacesInput';
import { getTransportationConfig } from '../../services/transportationService';
import { TransportationConfig } from '@shared/models/Transportation';

type SubStatus = 'planned' | 'pending' | 'active' | 'cancelled';
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
  // Common
  status: SubStatus;
  statusReason?: string;
  note?: string;
  createdAt: Date;
  cancelRequested?: boolean;
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
    planned: 'bg-yellow-100 text-yellow-800',
    pending: 'bg-yellow-100 text-yellow-800',
    active: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  const label: Record<SubStatus, string> = {
    planned: 'Pendente', pending: 'Pendente', active: 'Ativa', cancelled: 'Cancelada',
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

  const submit = async () => {
    setSaving(true);
    try {
      const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      const patch: Record<string, any> = {
        childName: name.trim(), contactName: parentName.trim() || null,
        contactEmail: email.trim() || null,
        note: note.trim() || null, updatedAt: new Date(),
      };
      if (item._type === 'transport') {
        patch.contactMobile = phone.trim() || null;
        patch.schedule = tripsToSchedule(trips);
        if (config) patch.monthlyFee = patch.schedule.length * config.flatRatePerTrip * 4;
        // Save schoolName to the children doc (canonical source for transport)
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
      });
    } finally { setSaving(false); }
  };

  const fieldCls = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400';

  return (
    <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
      <p className="text-sm font-semibold text-gray-700">Editar inscrição</p>
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

function ManualTransportForm({ config, onSave, onCancel }: { config: TransportationConfig | null; onSave: (item: SubItem) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [parentName, setParentName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [trips, setTrips] = useState<TripTemplate[]>([newTrip()]);
  const [saving, setSaving] = useState(false);

  const totalSlots = trips.flatMap(t => t.days).length;
  const monthlyFee = config ? totalSlots * config.flatRatePerTrip * 4 : 0;

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const schedule = tripsToSchedule(trips);
    try {
      const ref = await addDoc(col('transportationSubscriptions'), {
        childName: name.trim(), contactName: parentName.trim() || null,
        contactEmail: email.trim() || null, contactMobile: phone.trim() || null,
        status: 'planned', source: 'manual', monthlyFee,
        schedule, note: note.trim() || null,
        createdAt: new Date(), updatedAt: new Date(),
      });
      onSave({
        id: ref.id, _type: 'transport', childName: name.trim(),
        contactName: parentName.trim() || undefined,
        contactEmail: email.trim() || undefined,
        contactPhone: phone.trim() || undefined, source: 'manual',
        schedule, monthlyFee, status: 'planned',
        note: note.trim() || undefined, createdAt: new Date(),
      });
    } finally { setSaving(false); }
  };

  const fieldCls = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400';

  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-4 space-y-3">
      <h3 className="font-semibold text-indigo-900 text-sm">Nova inscrição de transporte</h3>
      <div className="grid grid-cols-2 gap-2">
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          placeholder="Nome da criança *" className={fieldCls} />
        <input value={parentName} onChange={e => setParentName(e.target.value)}
          placeholder="Nome do encarregado" className={fieldCls} />
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          placeholder="Email do encarregado" className={fieldCls} />
        <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
          placeholder="Telefone" className={fieldCls} />
      </div>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nota (opcional)" className={fieldCls} />
      <TripEditor trips={trips} onChange={setTrips} />
      {config && totalSlots > 0 && (
        <div className="flex items-center justify-between bg-indigo-100 rounded-lg px-3 py-2">
          <span className="text-xs text-indigo-700">
            {totalSlots} {totalSlots === 1 ? 'viagem' : 'viagens'}/semana × €{config.flatRatePerTrip.toFixed(2)} × 4 semanas
          </span>
          <span className="text-sm font-bold text-indigo-900">€{monthlyFee.toFixed(2)}/mês</span>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button onClick={submit} disabled={!name.trim() || saving}
          className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-60 font-medium">
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

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function SubscriptionsAdminPage() {
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const highlightRef = useRef<HTMLDivElement | null>(null);

  const [items, setItems] = useState<SubItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SubStatus | 'all'>('pending');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [transportConfig, setTransportConfig] = useState<TransportationConfig | null>(null);

  const load = async () => {
    setIsLoading(true); setError(null);
    try {
      const [studySnap, transportSnap, childrenSnap, cfg] = await Promise.all([
        getDocs(col('studyroom')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('children')),
        getTransportationConfig(),
      ]);
      if (cfg) setTransportConfig(cfg);
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
          status: (x.status === 'confirmed' ? 'active' : x.status) as SubStatus,
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested,
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
          status: x.status as SubStatus,
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested,
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
      const newStatus = item._type === 'study' ? 'confirmed' : 'active';
      await updateDoc(docRef(colName, item.id), { status: newStatus, approvedAt: new Date(), updatedAt: new Date() });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'active' } : i));
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

  const isUnlinked = (i: SubItem) => i.source === 'manual' && !i.familyId;

  const filtered = items
    .filter(i => tab === 'all' || (tab === 'pending' ? (i.status === 'pending' || i.status === 'planned') : i.status === tab))
    .filter(i => {
      if (typeFilter === 'transport') return i._type === 'transport';
      if (typeFilter === 'study') return i._type === 'study';
      if (typeFilter === 'unlinked') return isUnlinked(i);
      return true;
    });

  const grouped = useMemo(() => {
    const map = new Map<string, { key: string; label: string | null; items: SubItem[] }>();
    for (const item of filtered) {
      const key = item.familyId ?? item.contactEmail ?? item.id;
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
    pending: items.filter(i => i.status === 'pending' || i.status === 'planned').length,
    active: items.filter(i => i.status === 'active').length,
    cancelled: items.filter(i => i.status === 'cancelled').length,
    all: items.length,
    unlinked: items.filter(isUnlinked).length,
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
            {counts.pending > 0 && <span className="text-yellow-700 font-medium">{counts.pending} pendente(s) · </span>}

            {counts.active} ativas
            {counts.unlinked > 0 && <span className="text-orange-600 font-medium"> · {counts.unlinked} não vinculada(s)</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setShowManualForm(v => !v); }}
            className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-indigo-700 font-medium">
            + Inscrição manual
          </button>
          <button onClick={load} className="text-sm text-blue-600 hover:underline">Atualizar</button>
        </div>
      </div>

      {/* Manual form */}
      {showManualForm && (
        <ManualTransportForm
          config={transportConfig}
          onSave={item => { setItems(prev => [item, ...prev]); setShowManualForm(false); }}
          onCancel={() => setShowManualForm(false)}
        />
      )}

      {/* Status tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-3">
        {([
          { key: 'pending', label: 'Pendentes', count: counts.pending },
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

      {/* Type filter pills */}
      <div className="flex gap-2 mb-6">
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
                          </div>

                          <MiniWeekCalendar item={item} />

                          {(item.schoolName || item.schoolYear) && (
                            <p className="text-xs text-gray-500 mt-1.5">{[item.schoolName, item.schoolYear].filter(Boolean).join(' · ')}</p>
                          )}
                          {((item._type === 'study' && (item.monthlyPrice ?? 0) > 0) || (item._type === 'transport' && (item.monthlyFee ?? 0) > 0)) && (
                            <p className="text-xs font-medium text-gray-700 mt-1">
                              €{((item.monthlyPrice ?? item.monthlyFee) ?? 0).toFixed(2)}/mês
                            </p>
                          )}
                          {item.note && <p className="text-xs text-gray-500 mt-1 italic">"{item.note}"</p>}
                          {item.statusReason && item.status === 'cancelled' && <p className="text-xs text-red-600 mt-1">Motivo: {item.statusReason}</p>}
                          <p className="text-xs text-gray-400 mt-1.5">{item.createdAt.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 shrink-0">
                        {(item.status === 'pending' || item.status === 'planned') && (
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
                          <button onClick={() => hardDelete(item)} disabled={processing === item.id}
                            className="text-red-400 hover:text-red-600 text-sm px-2 py-1 disabled:opacity-60"
                            title="Eliminar">🗑</button>
                        )}
                        {item.status !== 'cancelled' && (
                          <button onClick={() => setEditId(editId === item.id ? null : item.id)}
                            className="text-gray-400 hover:text-blue-600 text-sm px-2 py-1"
                            title="Editar">✏️</button>
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
    </div>
  );
}
