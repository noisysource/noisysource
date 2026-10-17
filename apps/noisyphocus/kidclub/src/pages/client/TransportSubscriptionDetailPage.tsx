import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getDoc, updateDoc, query, where, getDocs } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { callable } from '../../lib/callable';
import { reportClientError } from '../../lib/clientErrors';
import { Child, Family, TransportationSubscription, kidclubVatNote } from '@shared/models';
import { normalizeSubStatus , coerceSubscriptionDate } from '../../lib/utils';
import { PersonalData, resolvePersonalData } from '../../lib/personalData';
import { format, eachDayOfInterval, startOfToday, addWeeks } from 'date-fns';
import { pt } from 'date-fns/locale';
import { useUser } from '@shared/hooks';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const PT_DAY: Record<string, string> = {
  monday: 'Segunda', tuesday: 'Terça', wednesday: 'Quarta',
  thursday: 'Quinta', friday: 'Sexta', saturday: 'Sábado', sunday: 'Domingo',
};

interface UpcomingTrip {
  date: Date;
  dateStr: string;
  pickupTime: string;
  pickupLocation: string;
  dropoffLocation: string;
  reservationEventId?: string; // undefined if no ReservationEvent was generated for this exact date+leg
  cancelled: boolean;
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
  // Child/guardian details are resolved from children/{childId} and
  // families/{familyId}.primaryContact, not from this subscription's own
  // denormalized copies — see lib/personalData.ts.
  const [person, setPerson] = useState<PersonalData | null>(null);
  const [dayGroups, setDayGroups] = useState<DayGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [showReviewReject, setShowReviewReject] = useState(false);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const loadData = async () => {
    if (!id) return;
    setIsLoading(true);
    try {
      const [subSnap, calSnap] = await Promise.all([
        getDoc(docRef('transportationSubscriptions', id)),
        getDoc(docRef('config', 'schoolCalendar')),
      ]);
      if (!subSnap.exists()) return;
      const data = subSnap.data();
      const sub = { ...data, id: subSnap.id, status: normalizeSubStatus(data.status) } as TransportationSubscription;
      setSubscription(sub);

      // Personal data (name, school, guardian contact) comes from the child
      // and family documents. Best-effort: an admin-created child that no
      // parent has claimed yet carries no userId, so the security rules can
      // deny this read — fall back to the subscription's own copies rather
      // than failing the whole page.
      let child: Child | null = null;
      let family: Family | null = null;
      try {
        const [childSnap, famSnap] = await Promise.all([
          sub.childId ? getDoc(docRef('children', sub.childId)) : Promise.resolve(null),
          sub.familyId ? getDoc(docRef('families', sub.familyId)) : Promise.resolve(null),
        ]);
        if (childSnap?.exists()) child = { ...childSnap.data(), id: childSnap.id } as Child;
        if (famSnap?.exists()) family = { ...famSnap.data(), id: famSnap.id } as Family;
      } catch (err) {
        console.warn('[TransportSubscriptionDetailPage] personal data read failed:', err);
      }
      setPerson(resolvePersonalData(child, family, sub));

      const schoolYearEnd: Date | null =
        calSnap.exists() && calSnap.data().yearEndDate
          ? new Date(`${calSnap.data().yearEndDate}T23:59:59`)
          : null;

      const today = startOfToday();
      const rangeEnd = addWeeks(today, 4);
      const effectiveEnd = schoolYearEnd
        ? (rangeEnd < schoolYearEnd ? rangeEnd : schoolYearEnd)
        : rangeEnd;

      // coerceSubscriptionDate, not new Date(): transport stores startDate as a
      // "YYYY-MM-DD" string, which new Date() reads as UTC midnight — 01:00 in
      // Lisbon — so `day < subStart` was true for the start day itself and the
      // subscription's first day never appeared in this list.
      const subStart = coerceSubscriptionDate(sub.startDate, 'start') ?? today;
      const subEnd = coerceSubscriptionDate(sub.endDate, 'end');

      // Keyed by "date_legIndex" — matching how reservationEvents.ts ids each
      // leg. Keying by direction collided: no schedule entry carries one, so
      // both legs of a day resolved to the same occurrence and cancelling one
      // cancelled both.
      const eventsSnap = await getDocs(
        query(
          col('reservationEvents'),
          where('subscriptionId', '==', id),
          where('date', '>=', format(today, 'yyyy-MM-dd')),
          where('date', '<=', format(effectiveEnd, 'yyyy-MM-dd')),
        ),
      );
      const eventByDateLeg: Record<string, { id: string; status: string }> = {};
      eventsSnap.docs.forEach(d => {
        const data = d.data();
        eventByDateLeg[`${data.date}_${data.legIndex ?? 0}`] = { id: d.id, status: data.status };
      });
      const hasAnyEvents = eventsSnap.docs.length > 0;

      const groupMap = new Map<string, DayGroup>();

      for (const day of eachDayOfInterval({ start: today, end: effectiveEnd })) {
        if (day < subStart) continue;
        if (subEnd && day > subEnd) continue;
        const dayName = DAY_NAMES[day.getDay()];
        const dateStr = format(day, 'yyyy-MM-dd');

        for (const [legIndex, sched] of (sub.schedule ?? []).entries()) {
          if (sched.dayOfWeek !== dayName) continue;
          const ev = eventByDateLeg[`${dateStr}_${legIndex}`];
          if (ev?.status === 'VOIDED') continue; // subscription no longer covers this date
          // No occurrence for a scheduled weekday means this date isn't a
          // service day — normal for a biweekly (odd/even) subscription,
          // where only half the matching weekdays are active. Listing it
          // anyway produced rows that looked like trips but couldn't be
          // cancelled. Only skip when SOME occurrences exist: if the
          // subscription has none at all, keep the rows so the
          // "no occurrences generated" banner below still has something to
          // explain rather than showing a misleading empty list.
          if (!ev && hasAnyEvents) continue;
          const trip: UpcomingTrip = {
            date: day,
            dateStr,
            pickupTime: sched.pickupTime,
            pickupLocation: sched.pickupLocation,
            dropoffLocation: sched.dropoffLocation,
            reservationEventId: ev?.id,
            cancelled: ev?.status === 'CANCELLED',
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
    // See StudySubscriptionDetailPage's toggleDay — a missing ReservationEvent
    // means the occurrence was never generated; say so rather than no-op.
    if (!trip.reservationEventId) {
      setActionError('Esta viagem ainda não tem ocorrência gerada, por isso não pode ser cancelada. Peça ao Kid Club para gerar as ocorrências desta inscrição.');
      return;
    }
    setActionInProgress(trip.reservationEventId);
    setActionError(null);
    try {
      const fn = callable<{ eventId: string; status: 'EXPECTED' | 'CANCELLED' }, { ok: boolean }>('setReservationEventStatus');
      await fn({ eventId: trip.reservationEventId, status: trip.cancelled ? 'EXPECTED' : 'CANCELLED' });
      await loadData();
    } catch (err: any) {
      reportClientError('[TransportSubscriptionDetailPage] action failed', err);
      setActionError(err?.message ?? 'Não foi possível guardar. Tente novamente.');
    } finally {
      setActionInProgress(null);
    }
  };

  const confirmReview = async () => {
    if (!id) return;
    setReviewing(true);
    try {
      await updateDoc(docRef('transportationSubscriptions', id), {
        clientReviewPending: false, clientReviewedAt: new Date(),
        // A confirmed PENDING request is ready to activate, so it goes back to
        // the admin. Confirming a change to an already-active subscription is
        // just the parent acknowledging it: recorded, but nothing to act on.
        adminReviewPending: normalizeSubStatus(subscription?.status) === 'pending',
        lastClientAction: 'confirmed',
        updatedAt: new Date(),
      });
      setSubscription(prev => prev ? { ...prev, clientReviewPending: false } : prev);
    } finally { setReviewing(false); }
  };

  const rejectReview = async () => {
    if (!id) return;
    setReviewing(true);
    try {
      // Doesn't auto-revert the edit — flags it for the team to follow up on directly,
      // since there's no snapshot of the pre-edit values to restore.
      await updateDoc(docRef('transportationSubscriptions', id), {
        clientReviewPending: false, clientReviewedAt: new Date(),
        adminReviewPending: true, lastClientAction: 'rejected',
        updatedAt: new Date(),
      });
      setSubscription(prev => prev ? { ...prev, clientReviewPending: false } : prev);
      setShowReviewReject(false);
    } finally { setReviewing(false); }
  };

  const cancelSubscription = async () => {
    if (!id) return;
    setCancelling(true);
    try {
      await updateDoc(docRef('transportationSubscriptions', id), {
        status: 'cancelled',
        cancelledAt: new Date(),
        // Client-initiated change — surfaced to admin as a review prompt on next login.
        adminReviewPending: true,
        lastClientAction: 'cancelRequested',
        updatedAt: new Date(),
      });
      navigate('/client/subscriptions', { replace: true });
    } finally {
      setCancelling(false);
    }
  };

  // Derived state
  const isActive = subscription?.status === 'active';
  const isPending = subscription?.status === 'pending';
  const needsReview = subscription?.clientReviewPending === true;

  const statusBadge = isActive
    ? { label: 'Ativa', cls: 'bg-green-100 text-green-800' }
    : isPending
    ? { label: 'Pendente de aprovação', cls: 'bg-yellow-100 text-yellow-800' }
    : { label: 'Cancelada', cls: 'bg-gray-100 text-gray-600' };

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
            <p className="font-semibold text-lg">{person?.childName}</p>
            {person?.schoolName && (
              <p className="text-gray-500 text-sm">{person.schoolName}</p>
            )}
            {person?.contactEmail && (
              <p className="text-gray-400 text-xs">{person.contactEmail}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${statusBadge.cls}`}>
              {statusBadge.label}
            </span>
            {isPending && (
              <Link
                to={`/client/enroll/transport?childId=${subscription.childId}&editId=${id}`}
                className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap"
              >
                ✏️ Editar pedido
              </Link>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {(() => {
            const fee = subscription.monthlyFee ?? 0;
            return (
              <>
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-2xl font-bold text-gray-900">€{fee.toFixed(2)}</span>
                  <span className="text-base font-normal text-gray-500">/mês</span>
                </div>
                <p className="text-xs text-gray-400">IVA incluído · {kidclubVatNote(fee, 'transport')}</p>
              </>
            );
          })()}
        </div>

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

      {/* Admin edited this subscription — parent must review */}
      {needsReview && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl px-5 py-5">
          <h3 className="font-semibold text-purple-900 mb-1">Inscrição alterada</h3>
          <p className="text-sm text-purple-700 mb-4">
            A equipa fez alterações à inscrição de transporte de <strong>{person?.childName}</strong>.
            Reveja os detalhes acima e confirme, ou recuse se não estiver correto.
          </p>
          <div className="flex gap-3">
            <button
              onClick={confirmReview}
              disabled={reviewing}
              className="flex-1 bg-purple-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-purple-700 disabled:opacity-60"
            >
              {reviewing ? 'A confirmar…' : 'Confirmar alteração'}
            </button>
            <Link
              to={`/client/enroll/transport?childId=${subscription.childId}&editId=${id}`}
              className="flex-1 text-center bg-white text-purple-700 border border-purple-200 py-2.5 rounded-lg text-sm font-medium hover:bg-purple-50"
            >
              Editar
            </Link>
            <button
              onClick={() => setShowReviewReject(true)}
              disabled={reviewing}
              className="flex-1 bg-white text-gray-600 border border-gray-200 py-2.5 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-60"
            >
              Recusar
            </button>
          </div>
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
            {subscription?.weekPattern && subscription.weekPattern !== 'all' && (
              <p className="text-xs text-gray-500 mt-1">
                Esta inscrição é <strong>quinzenal</strong> ({subscription.weekPattern === 'odd' ? '1.ª e 3.ª semanas' : '2.ª e 4.ª semanas'} do mês),
                por isso só aparecem as semanas em que há serviço.
              </p>
            )}
            {actionError && (
              <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                {actionError}
              </p>
            )}
            {dayGroups.length > 0 && dayGroups.every(g => g.trips.every(t => !t.reservationEventId)) && (
              <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                ⚠️ Esta inscrição ainda não tem ocorrências geradas — as viagens abaixo não podem
                ser canceladas até que isso seja feito.
              </p>
            )}
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
                      const isCancelled = trip.cancelled;
                      const inProgress = actionInProgress === trip.reservationEventId;
                      return (
                        <div
                          key={trip.reservationEventId ?? `${trip.dateStr}_${trip.pickupTime}`}
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
                            disabled={!!actionInProgress || !trip.reservationEventId}
                            title={!trip.reservationEventId ? 'Sem ocorrência gerada para esta viagem — não pode ser cancelada' : undefined}
                            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${
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

      {showReviewReject && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h3 className="font-bold text-lg mb-2">Recusar alteração?</h3>
            <p className="text-gray-600 text-sm mb-6">
              A equipa será notificada de que não concorda com a alteração feita à inscrição de <strong>{person?.childName}</strong> e entrará em contacto.
            </p>
            <div className="flex gap-3">
              <button
                onClick={rejectReview}
                disabled={reviewing}
                className="flex-1 bg-red-600 text-white py-2.5 rounded-lg hover:bg-red-700 disabled:opacity-60 text-sm font-medium"
              >
                {reviewing ? 'A recusar...' : 'Confirmar recusa'}
              </button>
              <button
                onClick={() => setShowReviewReject(false)}
                className="flex-1 bg-gray-100 text-gray-700 py-2.5 rounded-lg hover:bg-gray-200 text-sm"
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      )}

      {showCancelConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h3 className="font-bold text-lg mb-2">Cancelar subscrição?</h3>
            <p className="text-gray-600 text-sm mb-6">
              A subscrição de transporte de <strong>{person?.childName}</strong> será
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
