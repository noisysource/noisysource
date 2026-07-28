import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getDoc, updateDoc, query, where, getDocs, addDoc, deleteDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { TransportationSubscription } from '@shared/models';
import { format, eachDayOfInterval, startOfToday, addWeeks } from 'date-fns';
import { pt } from 'date-fns/locale';
import { useUser } from '@shared/hooks';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const PT_DAY: Record<string, string> = {
  monday: 'Segunda', tuesday: 'Terça', wednesday: 'Quarta',
  thursday: 'Quinta', friday: 'Sexta', saturday: 'Sábado', sunday: 'Domingo',
};

interface UpcomingTrip {
  eventId: string;
  date: Date;
  dateStr: string;
  pickupTime: string;
  pickupLocation: string;
  dropoffLocation: string;
  cancellationId?: string;
}

interface DayGroup {
  dateStr: string;
  date: Date;
  trips: UpcomingTrip[];
}

export default function TransportSubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useUser();
  const [subscription, setSubscription] = useState<TransportationSubscription | null>(null);
  const [dayGroups, setDayGroups] = useState<DayGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const loadData = async () => {
    if (!id) return;
    setIsLoading(true);
    try {
      const subSnap = await getDoc(docRef('transportationSubscriptions', id));
      if (!subSnap.exists()) return;
      const data = subSnap.data();
      const sub = { ...data, id: subSnap.id } as TransportationSubscription;
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
          where('subscriptionType', '==', 'transport'),
          where('modificationType', '==', 'cancelled'),
          where('status', '==', 'approved'),
        ),
      );
      // Key cancellations by eventId for per-trip precision
      const cancelledByEventId: Record<string, string> = {};
      modsSnap.docs.forEach(d => {
        const eventId = d.data().eventId;
        if (eventId) cancelledByEventId[eventId] = d.id;
      });

      const today = startOfToday();
      const rangeEnd = addWeeks(today, 4);
      const effectiveEnd = schoolYearEnd
        ? (rangeEnd < schoolYearEnd ? rangeEnd : schoolYearEnd)
        : rangeEnd;

      const subStart = sub.startDate ? new Date(sub.startDate) : today;
      const subEnd = sub.endDate ? new Date(sub.endDate) : null;

      const groupMap = new Map<string, DayGroup>();

      for (const day of eachDayOfInterval({ start: today, end: effectiveEnd })) {
        if (day < subStart) continue;
        if (subEnd && day > subEnd) continue;
        const dayName = DAY_NAMES[day.getDay()];
        const dateStr = format(day, 'yyyy-MM-dd');

        for (const sched of sub.schedule ?? []) {
          if (sched.dayOfWeek !== dayName) continue;
          // Match the same eventId format used in eventService.ts
          const eventId = `transport_sub_${id}_${dateStr}_${sched.pickupTime.replace(':', '')}`;
          const trip: UpcomingTrip = {
            eventId,
            date: day,
            dateStr,
            pickupTime: sched.pickupTime,
            pickupLocation: sched.pickupLocation,
            dropoffLocation: sched.dropoffLocation,
            cancellationId: cancelledByEventId[eventId],
          };
          if (!groupMap.has(dateStr)) {
            groupMap.set(dateStr, { dateStr, date: day, trips: [] });
          }
          groupMap.get(dateStr)!.trips.push(trip);
        }
      }

      const groups = Array.from(groupMap.values()).sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      );
      groups.forEach(g => g.trips.sort((a, b) => a.pickupTime.localeCompare(b.pickupTime)));
      setDayGroups(groups);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTrip = async (trip: UpcomingTrip) => {
    if (!user || !id) return;
    setActionInProgress(trip.eventId);
    try {
      if (trip.cancellationId) {
        await deleteDoc(docRef('eventModifications', trip.cancellationId));
      } else {
        await addDoc(col('eventModifications'), {
          subscriptionId: id,
          subscriptionType: 'transport',
          eventId: trip.eventId,
          date: trip.date,
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

  const cancelSubscription = async () => {
    if (!id) return;
    setCancelling(true);
    try {
      await updateDoc(docRef('transportationSubscriptions', id), {
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

  const isActive = subscription.status === 'active';
  const isPending = subscription.status === 'pending';

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
        <h1 className="text-2xl font-bold mt-2">Transporte</h1>
      </div>

      {/* Summary card */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-semibold text-lg">{subscription.childName}</p>
            {subscription.contactEmail && (
              <p className="text-gray-500 text-sm">{subscription.contactEmail}</p>
            )}
          </div>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>
        </div>

        <p className="mt-4 text-2xl font-bold text-gray-900">
          €{(subscription.monthlyFee ?? 0).toFixed(2)}
          <span className="text-base font-normal text-gray-500">/mês</span>
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {(subscription.schedule ?? []).map((s, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 bg-green-50 text-green-800 text-sm px-3 py-1 rounded-full"
            >
              {PT_DAY[s.dayOfWeek] ?? s.dayOfWeek} · {s.pickupTime}
            </span>
          ))}
        </div>
      </div>

      {/* Pending notice */}
      {isPending && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-5 py-4 text-sm text-yellow-800">
          O seu pedido está a ser analisado pela equipa. Receberá confirmação em breve.
        </div>
      )}

      {/* Upcoming trips grouped by day */}
      {isActive && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="font-semibold">Próximas viagens</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              Cancele viagens individualmente. O cancelamento é imediato e pode ser revertido.
            </p>
          </div>

          {dayGroups.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-8">
              Sem viagens previstas nas próximas 4 semanas.
            </p>
          ) : (
            <div className="divide-y divide-gray-100">
              {dayGroups.map(group => (
                <div key={group.dateStr} className="px-6 py-4">
                  {/* Date header */}
                  <p className="text-sm font-semibold text-gray-700 mb-2 capitalize">
                    {format(group.date, "EEEE, d 'de' MMMM", { locale: pt })}
                  </p>

                  {/* Trips for this day */}
                  <div className="space-y-2 pl-2">
                    {group.trips.map(trip => {
                      const isCancelled = !!trip.cancellationId;
                      const inProgress = actionInProgress === trip.eventId;
                      return (
                        <div
                          key={trip.eventId}
                          className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                            isCancelled ? 'bg-gray-50' : 'bg-green-50'
                          }`}
                        >
                          <div className={isCancelled ? 'opacity-40 line-through' : ''}>
                            <p className="text-sm font-medium">{trip.pickupTime}</p>
                            <p className="text-xs text-gray-500">
                              {trip.pickupLocation} → {trip.dropoffLocation}
                            </p>
                          </div>
                          <button
                            onClick={() => toggleTrip(trip)}
                            disabled={!!actionInProgress}
                            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition disabled:opacity-50 ${
                              isCancelled
                                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                                : 'bg-red-50 text-red-600 hover:bg-red-100'
                            }`}
                          >
                            {inProgress ? '...' : isCancelled ? 'Restaurar' : 'Cancelar'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
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
              A subscrição de transporte de <strong>{subscription.childName}</strong> será
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
