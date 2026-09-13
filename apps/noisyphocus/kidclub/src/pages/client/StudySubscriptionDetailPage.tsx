import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getDoc, updateDoc, query, where, getDocs, addDoc, deleteDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { StudyRoomEntry } from '@shared/models';
import { format, eachDayOfInterval, startOfToday, addWeeks } from 'date-fns';
import { pt } from 'date-fns/locale';
import { useUser } from '@shared/hooks';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const PT_DAY: Record<string, string> = {
  monday: 'Segunda', tuesday: 'Terça', wednesday: 'Quarta',
  thursday: 'Quinta', friday: 'Sexta', saturday: 'Sábado', sunday: 'Domingo',
};

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
  cancellationId?: string;
}

export default function StudySubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useUser();
  const [subscription, setSubscription] = useState<StudyRoomEntry | null>(null);
  const [sessions, setSessions] = useState<UpcomingSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [draftDays, setDraftDays] = useState<StudyRoomEntry['days']>([]);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const loadData = async () => {
    if (!id) return;
    setIsLoading(true);
    try {
      const subSnap = await getDoc(docRef('studyroom', id));
      if (!subSnap.exists()) return;
      const data = subSnap.data();
      const sub = {
        ...data,
        id: subSnap.id,
        startDate: data.startDate?.toDate?.() ?? (data.startDate ? new Date(data.startDate) : null),
        endDate: data.endDate?.toDate?.() ?? (data.endDate ? new Date(data.endDate) : null),
      } as StudyRoomEntry;
      setSubscription(sub);

      const calSnap = await getDoc(docRef('config', 'schoolCalendar'));
      const schoolYearEnd: Date | null =
        calSnap.exists() && calSnap.data().yearEndDate
          ? new Date(`${calSnap.data().yearEndDate}T23:59:59`)
          : null;

      const modsSnap = await getDocs(
        query(
          col('eventModifications'),
          where('subscriptionId', '==', id),
          where('subscriptionType', '==', 'study'),
          where('modificationType', '==', 'cancelled'),
          where('status', '==', 'approved'),
        ),
      );
      const cancelledDates: Record<string, string> = {};
      modsSnap.docs.forEach(d => {
        const date = d.data().date?.toDate?.() ?? new Date(d.data().date);
        cancelledDates[format(date, 'yyyy-MM-dd')] = d.id;
      });

      const today = startOfToday();
      const rangeEnd = addWeeks(today, 4);
      const effectiveEnd = schoolYearEnd
        ? (rangeEnd < schoolYearEnd ? rangeEnd : schoolYearEnd)
        : rangeEnd;

      const upcoming: UpcomingSession[] = [];
      for (const day of eachDayOfInterval({ start: today, end: effectiveEnd })) {
        const dayName = DAY_NAMES[day.getDay()];
        for (const sel of sub.days ?? []) {
          if (sel.day !== dayName) continue;
          const dateStr = format(day, 'yyyy-MM-dd');
          upcoming.push({
            date: day,
            dateStr,
            hour: sel.hour,
            transport: sel.transport,
            cancellationId: cancelledDates[dateStr],
          });
        }
      }
      upcoming.sort((a, b) => a.date.getTime() - b.date.getTime());
      setSessions(upcoming);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleDay = async (session: UpcomingSession) => {
    if (!user || !id) return;
    setActionInProgress(session.dateStr);
    try {
      if (session.cancellationId) {
        await deleteDoc(docRef('eventModifications', session.cancellationId));
      } else {
        await addDoc(col('eventModifications'), {
          subscriptionId: id,
          subscriptionType: 'study',
          date: session.date,
          modificationType: 'cancelled',
          status: 'approved',
          userId: user.uid,
          reason: 'Cancelado pelo cliente',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      await loadData();
    } finally {
      setActionInProgress(null);
    }
  };

  const startEditingSchedule = () => {
    setDraftDays(subscription?.days ? [...subscription.days] : []);
    setEditingSchedule(true);
  };

  const saveSchedule = async () => {
    if (!id) return;
    setSavingSchedule(true);
    try {
      await updateDoc(docRef('studyroom', id), {
        days: draftDays,
        updatedAt: new Date(),
      });
      await loadData();
      setEditingSchedule(false);
    } finally {
      setSavingSchedule(false);
    }
  };

  const cancelSubscription = async () => {
    if (!id) return;
    setCancelling(true);
    try {
      await updateDoc(docRef('studyroom', id), {
        status: 'cancelled',
        cancelledAt: new Date(),
        updatedAt: new Date(),
      });
      navigate('/client/subscriptions', { replace: true });
    } finally {
      setCancelling(false);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  if (!subscription) {
    return (
      <div className="bg-white p-8 rounded-lg border text-center">
        <p className="text-gray-500 mb-4">Subscrição não encontrada.</p>
        <Link to="/client/subscriptions" className="text-blue-600 hover:underline">← Voltar</Link>
      </div>
    );
  }

  const isActive = subscription.status === 'confirmed' || (subscription.status as string) === 'active';
  const isPending = subscription.status === 'pending' || (subscription.status as string) === 'planned';

  const statusBadge = isActive
    ? { label: 'Ativa', cls: 'bg-green-100 text-green-800' }
    : isPending
    ? { label: 'Pendente de aprovação', cls: 'bg-yellow-100 text-yellow-800' }
    : { label: 'Cancelada', cls: 'bg-gray-100 text-gray-600' };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <Link to="/client/subscriptions" className="text-sm text-blue-600 hover:underline">
          ← As minhas inscrições
        </Link>
        <h1 className="text-2xl font-bold mt-2">Sala de Estudo</h1>
      </div>

      {/* Summary card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-semibold text-lg">{subscription.childName}</p>
            <p className="text-gray-500 text-sm">{subscription.schoolName}</p>
          </div>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {(() => {
            const fee = subscription.monthlyPrice ?? 0;
            const gross = subscription.basePrice != null && subscription.basePrice > fee + 0.01 ? subscription.basePrice : null;
            return (
              <div className="flex items-baseline gap-1.5 flex-wrap">
                {gross != null && <span className="text-base text-gray-400 line-through">€{gross.toFixed(2)}</span>}
                <span className={`text-2xl font-bold ${gross != null ? 'text-green-700' : 'text-gray-900'}`}>€{fee.toFixed(2)}</span>
                <span className="text-base font-normal text-gray-500">/mês</span>
              </div>
            );
          })()}
          {(subscription.appliedDiscounts ?? []).length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {(subscription.appliedDiscounts ?? []).map(d => (
                <span key={d.ruleId} className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-medium">
                  {d.name} −{Math.round(d.percentage * 100)}%
                </span>
              ))}
            </div>
          )}
        </div>

        {!editingSchedule ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {(subscription.days ?? []).map((d, i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 bg-blue-50 text-blue-800 text-sm px-3 py-1 rounded-full"
              >
                {PT_DAY[d.day] ?? d.day} · {d.hour}
                {d.transport && <span className="ml-0.5">🚌</span>}
              </span>
            ))}
            {isActive && (
              <button
                onClick={startEditingSchedule}
                className="text-xs text-blue-600 hover:text-blue-800 underline ml-1"
              >
                Editar horário
              </button>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {draftDays.map((d, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-sm font-medium w-20 shrink-0">{PT_DAY[d.day] ?? d.day}</span>
                <select
                  value={d.hour}
                  onChange={e => {
                    const updated = [...draftDays];
                    updated[i] = { ...updated[i], hour: e.target.value };
                    setDraftDays(updated);
                  }}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {TIME_SLOTS.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                {d.transport && <span className="text-sm">🚌</span>}
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <button
                onClick={saveSchedule}
                disabled={savingSchedule}
                className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-60"
              >
                {savingSchedule ? 'A guardar...' : 'Guardar'}
              </button>
              <button
                onClick={() => setEditingSchedule(false)}
                className="bg-gray-100 text-gray-700 text-sm px-4 py-1.5 rounded-lg hover:bg-gray-200"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pending notice */}
      {isPending && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-5 py-4">
          <p className="text-sm text-yellow-800 mb-3">O seu pedido está a ser analisado pela equipa. Receberá confirmação em breve.</p>
          <Link
            to={`/client/enroll/study?childId=${subscription.childId}&editId=${id}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-yellow-900 bg-white border border-yellow-300 px-3 py-1.5 rounded-lg hover:bg-yellow-50 transition-colors"
          >
            ✏️ Editar pedido
          </Link>
        </div>
      )}

      {/* Upcoming sessions */}
      {isActive && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold">Próximas sessões</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Cancele dias específicos (ex: férias). O cancelamento é imediato e pode ser revertido.
            </p>
          </div>
          {sessions.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-8">
              Sem sessões previstas nas próximas 4 semanas.
            </p>
          ) : (
            <div className="divide-y divide-gray-50">
              {sessions.map(session => {
                const isCancelled = !!session.cancellationId;
                const inProgress = actionInProgress === session.dateStr;
                return (
                  <div
                    key={session.dateStr}
                    className={`flex items-center justify-between px-6 py-4 ${isCancelled ? 'bg-gray-50' : ''}`}
                  >
                    <div className={isCancelled ? 'opacity-40 line-through' : ''}>
                      <p className="font-medium text-sm capitalize">
                        {format(session.date, "EEEE, d 'de' MMMM", { locale: pt })}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {session.hour}
                        {session.transport && ' · com transporte 🚌'}
                      </p>
                    </div>
                    <button
                      onClick={() => toggleDay(session)}
                      disabled={!!actionInProgress}
                      className={`text-xs px-3 py-1.5 rounded-lg font-medium transition disabled:opacity-50 ${
                        isCancelled
                          ? 'bg-green-100 text-green-700 hover:bg-green-200'
                          : 'bg-red-50 text-red-600 hover:bg-red-100'
                      }`}
                    >
                      {inProgress ? '...' : isCancelled ? 'Restaurar' : 'Cancelar dia'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Cancel subscription */}
      {(isActive || isPending) && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-800 mb-1">Cancelar subscrição</h2>
          <p className="text-sm text-gray-500 mb-4">
            O cancelamento é permanente. Para retomar o serviço terá de fazer uma nova inscrição.
          </p>
          <button
            onClick={() => setShowCancelConfirm(true)}
            className="text-sm text-red-600 border border-red-200 px-4 py-2 rounded-lg hover:bg-red-50 transition"
          >
            Cancelar subscrição
          </button>
        </div>
      )}

      {showCancelConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h3 className="font-bold text-lg mb-2">Cancelar subscrição?</h3>
            <p className="text-gray-600 text-sm mb-6">
              A subscrição de <strong>{subscription.childName}</strong> na Sala de Estudo será
              cancelada. Esta ação não pode ser desfeita.
            </p>
            <div className="flex gap-3">
              <button
                onClick={cancelSubscription}
                disabled={cancelling}
                className="flex-1 bg-red-600 text-white py-2.5 rounded-lg hover:bg-red-700 disabled:opacity-60 text-sm font-medium"
              >
                {cancelling ? 'A cancelar...' : 'Confirmar cancelamento'}
              </button>
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-lg hover:bg-gray-200 text-sm"
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
