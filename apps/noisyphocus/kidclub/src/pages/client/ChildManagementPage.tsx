import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { Family, Child, StudyRoomEntry, TransportationSubscription } from '@shared/models';
import { Link } from 'react-router-dom';
import { updateDoc, getDoc, getDocs, addDoc, query, where } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { callable } from '../../lib/callable';
import { calculateAge } from '../../lib/utils';
import { familyService } from '../../services/familyService';
import PlacesInput from '../../components/PlacesInput';
import { format, eachDayOfInterval, startOfToday, addWeeks } from 'date-fns';
import { pt } from 'date-fns/locale';

interface ChildWithSubs {
  child: Child;
  study: StudyRoomEntry[];
  transport: TransportationSubscription[];
}

type SelectedSub =
  | { type: 'transport'; sub: TransportationSubscription; childName: string }
  | { type: 'study'; sub: StudyRoomEntry; childName: string };

const STATUS_LABEL: Record<string, string> = {
  active: 'Ativo', confirmed: 'Ativo',
  pending: 'Pendente de aprovação', planned: 'Pendente',
  offered: 'Aguarda confirmação',
  cancelled: 'Cancelado', canceled: 'Cancelado', archived: 'Cancelado', inactive: 'Cancelado',
  suspended: 'Suspenso',
};
const STATUS_CLASS: Record<string, string> = {
  active: 'bg-green-100 text-green-800', confirmed: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800', planned: 'bg-yellow-100 text-yellow-800',
  offered: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-gray-100 text-gray-600', canceled: 'bg-gray-100 text-gray-600',
  archived: 'bg-gray-100 text-gray-600', inactive: 'bg-gray-100 text-gray-600',
  suspended: 'bg-red-100 text-red-800',
};
const isCancelled = (s: string) => ['cancelled', 'canceled', 'archived', 'inactive'].includes(s);

const PT_DAY: Record<string, string> = {
  monday: 'Segunda', tuesday: 'Terça', wednesday: 'Quarta',
  thursday: 'Quinta', friday: 'Sexta', saturday: 'Sábado', sunday: 'Domingo',
};

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const TIME_SLOTS = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30', '18:00',
];

interface UpcomingSession {
  date: Date;
  dateStr: string;
  hour: string;
  transport: boolean;
  reservationEventId?: string;
  cancelled: boolean;
}

// ─── Detail panel ─────────────────────────────────────────────────────────────
function SubDetailPanel({ selected, onClose, onUpdated, userId }: {
  selected: SelectedSub;
  onClose: () => void;
  onUpdated: (type: 'transport' | 'study', id: string, patch: Record<string, any>) => void;
  userId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [sessions, setSessions] = useState<UpcomingSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionAction, setSessionAction] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [draftDays, setDraftDays] = useState<StudyRoomEntry['days']>([]);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [editingTransport, setEditingTransport] = useState(false);
  const [draftSchedule, setDraftSchedule] = useState<TransportationSubscription['schedule']>([]);
  const [savingTransport, setSavingTransport] = useState(false);

  const colName = selected.type === 'transport' ? 'transportationSubscriptions' : 'studyroom';
  const id = selected.sub.id;
  const status = selected.sub.status as string;
  const fee = selected.type === 'transport'
    ? (selected.sub as TransportationSubscription).monthlyFee
    : (selected.sub as StudyRoomEntry).monthlyPrice;

  const isActive = status === 'active';
  const isPending = status === 'pending';
  const isCancelled_ = isCancelled(status);

  // Load upcoming sessions when a study subscription is selected and active
  useEffect(() => {
    if (selected.type !== 'study' || !isActive) { setSessions([]); return; }
    const load = async () => {
      setLoadingSessions(true);
      try {
        const sub = selected.sub as StudyRoomEntry;
        const today = startOfToday();
        const rangeEnd = addWeeks(today, 4);

        const [calSnap] = await Promise.all([
          getDoc(docRef('config', 'schoolCalendar')),
        ]);

        const schoolYearEnd: Date | null = calSnap.exists() && calSnap.data().yearEndDate
          ? new Date(`${calSnap.data().yearEndDate}T23:59:59`) : null;
        const effectiveEnd = schoolYearEnd ? (rangeEnd < schoolYearEnd ? rangeEnd : schoolYearEnd) : rangeEnd;

        const eventsSnap = await getDocs(query(
          col('reservationEvents'),
          where('subscriptionId', '==', id),
          where('date', '>=', format(today, 'yyyy-MM-dd')),
          where('date', '<=', format(effectiveEnd, 'yyyy-MM-dd')),
        ));
        const eventByDate: Record<string, { id: string; status: string }> = {};
        eventsSnap.docs.forEach(d => {
          const data = d.data();
          eventByDate[data.date] = { id: d.id, status: data.status };
        });
        const hasAnyEvents = eventsSnap.docs.length > 0;

        const upcoming: UpcomingSession[] = [];
        for (const day of eachDayOfInterval({ start: today, end: effectiveEnd })) {
          const dayName = DAY_NAMES[day.getDay()];
          for (const sel of sub.days ?? []) {
            if (sel.day !== dayName) continue;
            const dateStr = format(day, 'yyyy-MM-dd');
            const ev = eventByDate[dateStr];
            if (ev?.status === 'VOIDED') continue;
            // Off-pattern day of a biweekly subscription — not a service day.
            if (!ev && hasAnyEvents) continue;
            upcoming.push({ date: day, dateStr, hour: sel.hour, transport: (sel as any).transport, reservationEventId: ev?.id, cancelled: ev?.status === 'CANCELLED' });
          }
        }
        upcoming.sort((a, b) => a.date.getTime() - b.date.getTime());
        setSessions(upcoming);
      } catch (e) {
        console.error('Failed to load sessions:', e);
      } finally {
        setLoadingSessions(false);
      }
    };
    load();
  }, [selected.sub.id, status]);

  // Save an immutable snapshot of the subscription BEFORE every mutation.
  // The admin can reconstruct the full history by sorting versions by changedAt.
  const saveVersion = async (changeType: string, patch: Record<string, any>) => {
    const sub = selected.sub as any;
    const snapshot: Record<string, any> = {};
    for (const k of Object.keys(sub)) {
      const v = sub[k];
      snapshot[k] = v instanceof Date ? v.toISOString() : v;
    }
    await addDoc(col('subscriptionVersions'), {
      subscriptionId: id,
      subscriptionType: selected.type,
      changedAt: new Date(),
      changedBy: { userId, role: 'parent' },
      changeType,
      snapshot,
      patchApplied: patch,
    });
  };

  const act = async (patch: Record<string, any>, changeType = 'status_change') => {
    setBusy(true);
    try {
      if (isActive) await saveVersion(changeType, patch);
      await updateDoc(docRef(colName, id), { ...patch, updatedAt: new Date() });
      onUpdated(selected.type, id, patch);
    } finally { setBusy(false); }
  };

  const toggleDay = async (session: UpcomingSession) => {
    // No ReservationEvent = the occurrence was never generated; surface that
    // instead of silently doing nothing (see StudySubscriptionDetailPage).
    if (!session.reservationEventId) {
      setSessionError('Este dia ainda não tem ocorrência gerada, por isso não pode ser cancelado.');
      return;
    }
    setSessionAction(session.dateStr);
    setSessionError(null);
    try {
      const fn = callable<{ eventId: string; status: 'EXPECTED' | 'CANCELLED' }, { ok: boolean }>('setReservationEventStatus');
      const nextStatus = session.cancelled ? 'EXPECTED' : 'CANCELLED';
      await fn({ eventId: session.reservationEventId, status: nextStatus });
      setSessions(prev => prev.map(s => s.dateStr === session.dateStr ? { ...s, cancelled: nextStatus === 'CANCELLED' } : s));
    } catch (e: any) {
      console.error('Failed to toggle day:', e);
      setSessionError(e?.message ?? 'Não foi possível guardar. Tente novamente.');
    } finally {
      setSessionAction(null);
    }
  };

  const saveSchedule = async () => {
    if (!id) return;
    setSavingSchedule(true);
    try {
      const patch = { days: draftDays };
      if (isActive) await saveVersion('schedule_edit', patch);
      await updateDoc(docRef('studyroom', id), { ...patch, updatedAt: new Date() });
      onUpdated('study', id, patch);
      setEditingSchedule(false);
    } finally { setSavingSchedule(false); }
  };

  const saveTransportSchedule = async () => {
    setSavingTransport(true);
    try {
      const patch = { schedule: draftSchedule, feeReviewRequired: isActive };
      if (isActive) await saveVersion('schedule_edit', patch);
      await updateDoc(docRef('transportationSubscriptions', id), { ...patch, updatedAt: new Date() });
      onUpdated('transport', id, patch);
      setEditingTransport(false);
    } finally { setSavingTransport(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50">
        <div>
          <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
            {selected.type === 'transport' ? '🚌 Transporte' : '📚 Sala de Estudo'}
          </p>
          <p className="font-semibold text-gray-900 mt-0.5">{selected.childName}</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1">×</button>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Status */}
        <span className={`inline-block text-xs px-3 py-1 rounded-full font-medium ${STATUS_CLASS[status] ?? 'bg-gray-100 text-gray-600'}`}>
          {STATUS_LABEL[status] ?? status}
        </span>

        {/* Fee */}
        {!isCancelled_ && (
          <div>
            <p className="text-2xl font-bold text-gray-900">
              €{(fee ?? 0).toFixed(2)}<span className="text-base font-normal text-gray-500">/mês</span>
            </p>
          </div>
        )}

        {/* Transport schedule (read-only + editable) */}
        {selected.type === 'transport' && (() => {
          const schedule = (selected.sub as TransportationSubscription).schedule ?? [];
          if (editingTransport) {
            return (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Editar horário</p>
                {draftSchedule.map((entry, i) => (
                  <div key={i} className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50">
                    <div className="flex items-center justify-between">
                      <select value={entry.dayOfWeek}
                        onChange={e => { const u = [...draftSchedule]; u[i] = { ...u[i], dayOfWeek: e.target.value as any }; setDraftSchedule(u); }}
                        className="text-sm font-medium text-gray-800 border-0 bg-transparent focus:outline-none p-0">
                        {Object.entries(PT_DAY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      <button onClick={() => setDraftSchedule(prev => prev.filter((_, idx) => idx !== i))}
                        className="text-xs text-red-400 hover:text-red-600 font-medium">✕ Remover</button>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-500 w-9 shrink-0">Hora</label>
                      <select value={entry.pickupTime}
                        onChange={e => { const u = [...draftSchedule]; u[i] = { ...u[i], pickupTime: e.target.value }; setDraftSchedule(u); }}
                        className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500">
                        {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Origem</label>
                      <PlacesInput value={entry.pickupLocation}
                        onChange={v => { const u = [...draftSchedule]; u[i] = { ...u[i], pickupLocation: v }; setDraftSchedule(u); }}
                        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Destino</label>
                      <PlacesInput value={entry.dropoffLocation}
                        onChange={v => { const u = [...draftSchedule]; u[i] = { ...u[i], dropoffLocation: v }; setDraftSchedule(u); }}
                        className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => setDraftSchedule(prev => [...prev, { dayOfWeek: 'monday' as any, pickupTime: '08:00', pickupLocation: '', dropoffLocation: '' }] as any)}
                  className="w-full text-xs text-blue-600 border border-dashed border-blue-300 rounded-lg py-2 hover:bg-blue-50">
                  + Adicionar dia
                </button>
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  A mensalidade pode ser revista após alteração do horário.
                </p>
                <div className="flex gap-2">
                  <button onClick={saveTransportSchedule} disabled={savingTransport}
                    className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
                    {savingTransport ? '...' : 'Guardar'}
                  </button>
                  <button onClick={() => setEditingTransport(false)}
                    className="flex-1 bg-gray-100 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-200">
                    Cancelar
                  </button>
                </div>
              </div>
            );
          }
          const byDay: Record<string, typeof schedule> = {};
          schedule.forEach(s => { (byDay[s.dayOfWeek] ??= []).push(s); });
          return (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Horário</p>
                {!isCancelled_ && (
                  <button onClick={() => { setDraftSchedule([...schedule]); setEditingTransport(true); }}
                    className="text-xs text-blue-600 hover:underline">Editar</button>
                )}
              </div>
              {Object.keys(byDay).length > 0 ? (
                Object.entries(byDay).map(([day, trips]) => (
                  <div key={day} className="text-sm">
                    <span className="font-medium text-gray-700">{PT_DAY[day] ?? day}</span>
                    {trips.map((t, i) => (
                      <div key={i} className="text-xs text-gray-500 mt-0.5 pl-2">
                        {t.pickupTime} · {String(t.pickupLocation).split(',')[0]} → {String(t.dropoffLocation).split(',')[0]}
                      </div>
                    ))}
                  </div>
                ))
              ) : (
                <p className="text-xs text-gray-400">Sem horário definido.</p>
              )}
              {(selected.sub as any).feeReviewRequired && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                  Horário alterado — mensalidade em revisão pelo administrador.
                </p>
              )}
            </div>
          );
        })()}

        {/* Study schedule (editable) */}
        {selected.type === 'study' && (() => {
          const days = (selected.sub as StudyRoomEntry).days ?? [];
          if (!editingSchedule) {
            return days.length > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Dias</p>
                  {!isCancelled_ && (
                    <button onClick={() => { setDraftDays([...days]); setEditingSchedule(true); }}
                      className="text-xs text-blue-600 hover:underline">Editar</button>
                  )}
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {days.map((d: any, i: number) => (
                    <span key={i} className="text-xs bg-blue-50 text-blue-800 px-3 py-1 rounded-full font-medium">
                      {PT_DAY[d.day ?? d] ?? d.day ?? d} {d.hour ? `· ${d.hour}` : ''}{d.transport ? ' 🚌' : ''}
                    </span>
                  ))}
                </div>
              </div>
            ) : null;
          }
          return (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Editar horário</p>
              {(draftDays ?? []).map((d, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-sm font-medium w-20 shrink-0">{PT_DAY[d.day] ?? d.day}</span>
                  <select value={d.hour}
                    onChange={e => {
                      const updated = [...(draftDays ?? [])];
                      updated[i] = { ...updated[i], hour: e.target.value };
                      setDraftDays(updated);
                    }}
                    className="flex-1 border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {(d as any).transport && <span className="text-sm">🚌</span>}
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <button onClick={saveSchedule} disabled={savingSchedule}
                  className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-60">
                  {savingSchedule ? '...' : 'Guardar'}
                </button>
                <button onClick={() => setEditingSchedule(false)}
                  className="bg-gray-100 text-gray-700 text-sm px-4 py-1.5 rounded-lg hover:bg-gray-200">
                  Cancelar
                </button>
              </div>
            </div>
          );
        })()}

        {/* Upcoming study sessions */}
        {selected.type === 'study' && isActive && !editingSchedule && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Próximas sessões</p>
            {sessionError && (
              <p className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">{sessionError}</p>
            )}
            {!loadingSessions && sessions.length > 0 && sessions.every(s => !s.reservationEventId) && (
              <p className="mb-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                ⚠️ Sem ocorrências geradas para esta inscrição — os dias abaixo não podem ser cancelados.
              </p>
            )}
            {loadingSessions ? (
              <p className="text-xs text-gray-400">A carregar...</p>
            ) : sessions.length === 0 ? (
              <p className="text-xs text-gray-400">Sem sessões nas próximas 4 semanas.</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {sessions.map(session => {
                  const cancelled = session.cancelled;
                  const inProgress = sessionAction === session.dateStr;
                  return (
                    <div key={session.dateStr} className={`flex items-center justify-between py-1.5 ${cancelled ? 'opacity-50' : ''}`}>
                      <div className={cancelled ? 'line-through' : ''}>
                        <p className="text-xs font-medium text-gray-800 capitalize">
                          {format(session.date, "EEE, d MMM", { locale: pt })}
                        </p>
                        <p className="text-xs text-gray-400">{session.hour}{session.transport ? ' · 🚌' : ''}</p>
                      </div>
                      <button onClick={() => toggleDay(session)}
                        disabled={!!sessionAction || !session.reservationEventId}
                        title={!session.reservationEventId ? 'Sem ocorrência gerada para este dia' : undefined}
                        className={`text-xs px-2 py-1 rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition ${
                          cancelled ? 'bg-green-50 text-green-700 hover:bg-green-100' : 'bg-red-50 text-red-600 hover:bg-red-100'
                        }`}>
                        {inProgress ? '...' : cancelled ? 'Restaurar' : 'Cancelar'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Pending notice for study */}
        {selected.type === 'study' && isPending && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3">
            <p className="text-xs text-yellow-800">O seu pedido está a ser analisado. Receberá confirmação em breve.</p>
            <Link
              to={`/client/enroll/study?childId=${(selected.sub as StudyRoomEntry).childId}&editId=${id}`}
              className="inline-block mt-2 text-xs font-medium text-yellow-900 bg-white border border-yellow-300 px-3 py-1.5 rounded-lg hover:bg-yellow-50"
            >
              ✏️ Editar pedido
            </Link>
          </div>
        )}

        {/* Cancel active/pending */}
        {(isActive || isPending) && (
          confirmCancel ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-3">
              <p className="text-sm text-red-800">Tem a certeza que quer cancelar esta inscrição?</p>
              <div className="flex gap-2">
                <button onClick={() => act({ status: 'cancelled', cancelRequested: true, cancelledAt: new Date(), adminReviewPending: true, lastClientAction: 'cancelRequested' })} disabled={busy}
                  className="flex-1 bg-red-600 text-white text-sm py-2 rounded-lg hover:bg-red-700 disabled:opacity-60 font-medium">
                  {busy ? '…' : 'Sim, cancelar'}
                </button>
                <button onClick={() => setConfirmCancel(false)}
                  className="flex-1 bg-white border border-gray-200 text-gray-600 text-sm py-2 rounded-lg hover:bg-gray-50">
                  Manter
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setConfirmCancel(true)}
              className="w-full text-sm text-red-500 border border-red-200 rounded-lg py-2 hover:bg-red-50 transition-colors">
              Cancelar inscrição
            </button>
          )
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ChildManagementPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [childData, setChildData] = useState<ChildWithSubs[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selected, setSelected] = useState<SelectedSub | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => Promise<void> } | null>(null);

  useEffect(() => { if (user) load(); }, [user]);

  const load = async () => {
    if (!user) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const fam = await familyService.getOrCreateFamily(
        user.uid, user.name || user.email?.split('@')[0] || 'Utilizador', user.email || ''
      );
      setFamily(fam);
      const kids = await familyService.getFamilyChildren(fam.id, true, user.uid);
      const active = kids.filter(c => c.status !== 'inactive');
      const withSubs = await Promise.all(
        active.map(async child => {
          try {
            const { study, transport } = await familyService.getChildSubscriptions(child.id, user.uid);
            return { child, study, transport };
          } catch { return { child, study: [], transport: [] }; }
        })
      );
      setChildData(withSubs);
    } catch (err: any) {
      console.error('ChildManagementPage load error:', err);
      setLoadError(err?.message ?? 'Erro ao carregar dados. Tente novamente.');
    } finally { setIsLoading(false); }
  };

  const handleAddChild = async (data: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>) => {
    if (!family || !user) return;
    await familyService.addChild(family.id, user.uid, data);
    await load();
    setShowAddForm(false);
  };

  const handleRemoveChild = async (child: Child) => {
    // Use local state to count active subs — avoids a childId-based query that fails security rules for non-admin users
    const cd = childData.find(({ child: c }) => c.id === child.id);
    const count = (cd?.study ?? []).filter(s => !isCancelled(s.status ?? '')).length
                + (cd?.transport ?? []).filter(t => !isCancelled(t.status ?? '')).length;
    const message = count > 0
      ? `${child.firstName} tem ${count} inscrição(ões) ativas. Deseja desativar a criança (mantém os dados)?`
      : `Tem a certeza que pretende remover ${child.firstName} ${child.lastName}?`;
    setConfirmModal({
      message,
      onConfirm: async () => {
        setConfirmModal(null);
        if (count > 0) await familyService.deactivateChild(child.id);
        else await familyService.deleteChild(child.id);
        await load();
      },
    });
  };

  const handleSubUpdated = (type: 'transport' | 'study', id: string, patch: Record<string, any>) => {
    setChildData(prev => prev.map(({ child, study, transport }) => ({
      child,
      study: type === 'study' ? study.map(s => s.id === id ? { ...s, ...patch } : s) : study,
      transport: type === 'transport' ? transport.map(t => t.id === id ? { ...t, ...patch } : t) : transport,
    })));
    // Update panel
    setSelected(prev => prev && prev.sub.id === id ? { ...prev, sub: { ...prev.sub, ...patch } } as SelectedSub : prev);
  };

  if (isLoading) return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;

  if (loadError) return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-sm text-red-700">
      <p className="font-semibold mb-1">Erro ao carregar dados</p>
      <p className="mb-4">{loadError}</p>
      <button onClick={load} className="text-red-700 border border-red-300 px-4 py-2 rounded-lg hover:bg-red-100">
        Tentar novamente
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <p className="text-gray-800 mb-6">{confirmModal.message}</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmModal(null)} className="px-4 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50">Cancelar</button>
              <button onClick={confirmModal.onConfirm} className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700">Confirmar</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">As minhas crianças</h1>
        <button onClick={() => setShowAddForm(!showAddForm)} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
          {showAddForm ? 'Cancelar' : '+ Adicionar criança'}
        </button>
      </div>

      {showAddForm && <AddChildForm onSave={handleAddChild} onCancel={() => setShowAddForm(false)} />}

      {childData.length === 0 && !showAddForm ? (
        <div className="bg-white p-8 rounded-lg border border-gray-200 text-center">
          <p className="text-gray-500 mb-4">Ainda não adicionou nenhuma criança.</p>
          <button onClick={() => setShowAddForm(true)} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700">
            Adicionar primeira criança
          </button>
        </div>
      ) : (
        <div className="flex gap-4 items-start">
          {/* Left: children list */}
          <div className={`space-y-4 min-w-0 transition-all ${selected ? 'flex-1' : 'w-full'}`}>
            {/* Campos de Férias placeholder */}
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
              <div className="bg-gray-50 border-b border-gray-200 px-6 py-4 flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Campos de Férias</h3>
                  <p className="text-sm text-gray-500">Inscrições em campos de férias e atividades</p>
                </div>
                <Link to="/client/camps" className="text-xs bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
                  + Inscrever
                </Link>
              </div>
              <div className="px-6 py-5 text-sm text-gray-400 text-center">Sem inscrições em campos de férias.</div>
            </div>

            {childData.map(({ child, study, transport }) => {
              const monthly =
                study.filter(s => !isCancelled(s.status ?? '')).reduce((s, x) => s + (x.monthlyPrice ?? 0), 0) +
                transport.filter(t => !isCancelled(t.status ?? '')).reduce((s, x) => s + (x.monthlyFee ?? 0), 0);

              const allSubs = [
                ...study.map(s => ({
                  key: `study-${s.id}`, icon: '📚', type: 'Sala de Estudo',
                  status: s.status ?? '',
                  price: s.monthlyPrice,
                  detail: s.days?.length ? s.days.map((d: any) => PT_DAY[d.day ?? d] ?? d.day ?? d).join(', ') : null,
                  since: (s as any).startDate ? new Date((s as any).startDate?.toDate?.() ?? (s as any).startDate).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' }) : null,
                  onSelect: () => setSelected({ type: 'study', sub: s, childName: `${child.firstName} ${child.lastName}` }),
                  isSelected: selected?.sub.id === s.id,
                })),
                ...transport.map(t => ({
                  key: `transport-${t.id}`, icon: '🚌', type: 'Transporte Escolar',
                  status: t.status ?? '',
                  price: t.monthlyFee,
                  detail: null,
                  since: t.startDate ? new Date(t.startDate).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' }) : null,
                  onSelect: () => setSelected({ type: 'transport', sub: t, childName: `${child.firstName} ${child.lastName}` }),
                  isSelected: selected?.sub.id === t.id,
                })),
              ];

              return (
                <div key={child.id} className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
                  <div className="bg-gray-50 border-b border-gray-200 px-6 py-4 flex items-start justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">{child.firstName} {child.lastName}</h3>
                      <p className="text-sm text-gray-500">
                        {child.schoolName ?? ''}
                        {child.schoolYear ? ` · ${child.schoolYear}` : ''}
                      </p>
                    </div>
                    <Link to={`/client/enroll/transport?childId=${child.id}`}
                      className="text-xs bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
                      + Inscrever
                    </Link>
                  </div>

                  <div className="divide-y divide-gray-100">
                    {allSubs.length === 0 ? (
                      <div className="px-6 py-5 text-sm text-gray-400 text-center">Sem inscrições activas.</div>
                    ) : (
                      allSubs.map(sub => (
                        <button key={sub.key} onClick={sub.onSelect}
                          className={`w-full text-left flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors ${sub.isSelected ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''}`}>
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-xl shrink-0">{sub.icon}</span>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900">{sub.type}</p>
                              <p className="text-xs text-gray-400">
                                {sub.detail ? `${sub.detail} · ` : ''}
                                {sub.since ? `Desde ${sub.since}` : ''}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0 ml-3">
                            {!isCancelled(sub.status) && sub.price != null && (
                              <span className="text-sm font-semibold text-gray-900">€{sub.price.toFixed(2)}/mês</span>
                            )}
                            <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${STATUS_CLASS[sub.status] ?? 'bg-gray-100 text-gray-600'}`}>
                              {STATUS_LABEL[sub.status] ?? sub.status}
                            </span>
                            <span className={`text-sm ${sub.isSelected ? 'text-blue-500' : 'text-gray-300'}`}>›</span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>

                  <div className="bg-gray-50 border-t border-gray-200 px-6 py-3 flex items-center justify-between">
                    <button onClick={() => handleRemoveChild(child)} className="text-xs text-red-400 hover:text-red-600">
                      Remover criança
                    </button>
                    {monthly > 0 && (
                      <span className="text-sm font-bold text-gray-900">€{monthly.toFixed(2)}/mês</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right: detail panel */}
          {selected && (
            <div className="w-80 shrink-0 sticky top-4 hidden md:block">
              <SubDetailPanel
                selected={selected}
                onClose={() => setSelected(null)}
                onUpdated={handleSubUpdated}
                userId={user!.uid}
              />
            </div>
          )}
        </div>
      )}

      {/* Mobile: bottom sheet */}
      {selected && (
        <div className="fixed inset-x-0 bottom-0 z-40 md:hidden bg-white rounded-t-2xl shadow-2xl border-t border-gray-200 max-h-[80vh] overflow-y-auto">
          <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mt-3 mb-1" />
          <SubDetailPanel selected={selected} onClose={() => setSelected(null)} onUpdated={handleSubUpdated} userId={user!.uid} />
        </div>
      )}
    </div>
  );
}

// ─── Add child form ────────────────────────────────────────────────────────────
function AddChildForm({ onSave, onCancel }: {
  onSave: (data: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({ firstName: '', lastName: '', dateOfBirth: '', schoolName: '', schoolYear: '' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const dob = new Date(form.dateOfBirth + 'T12:00:00');
    onSave({
      firstName: form.firstName, lastName: form.lastName,
      dateOfBirth: dob, age: calculateAge(dob),
      schoolName: form.schoolName || undefined,
      schoolYear: form.schoolYear || undefined,
      status: 'active',
    });
  };

  return (
    <div className="bg-white p-6 rounded-lg border-2 border-blue-200">
      <h2 className="text-xl font-bold mb-4">Adicionar criança</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Primeiro nome *</label>
            <input type="text" required value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Apelido *</label>
            <input type="text" required value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Data de nascimento *</label>
          <input type="date" required value={form.dateOfBirth} onChange={e => setForm({ ...form, dateOfBirth: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Escola</label>
            <PlacesInput value={form.schoolName} onChange={v => setForm({ ...form, schoolName: v })}
              types={['school', 'primary_school', 'secondary_school']} nameOnly
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ano letivo</label>
            <input type="text" placeholder="ex: 2024/2025" value={form.schoolYear}
              onChange={e => setForm({ ...form, schoolYear: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div className="flex gap-3">
          <button type="submit" className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700">Guardar</button>
          <button type="button" onClick={onCancel} className="bg-gray-200 text-gray-700 px-6 py-2 rounded-lg hover:bg-gray-300">Cancelar</button>
        </div>
      </form>
    </div>
  );
}
