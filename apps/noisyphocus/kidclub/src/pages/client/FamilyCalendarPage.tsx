import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { getDoc, getDocs, query, where, addDoc, deleteDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { Family, Child, StudyRoomEntry, TransportationSubscription } from '@shared/models';
import { format, eachDayOfInterval, startOfToday, addWeeks } from 'date-fns';
import { pt } from 'date-fns/locale';
import { useUser } from '@shared/hooks';
import { familyService } from '../../services/familyService';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const PT_DAY: Record<string, string> = {
  monday: 'Segunda', tuesday: 'Terça', wednesday: 'Quarta',
  thursday: 'Quinta', friday: 'Sexta', saturday: 'Sábado', sunday: 'Domingo',
};

interface Occurrence {
  key: string;
  date: Date;
  dateStr: string;
  time: string;
  kind: 'study' | 'transport';
  childName: string;
  detail: string; // e.g. transport route, or "com transporte"
  subscriptionId: string;
  eventId?: string; // transport only — per-trip precision
  cancellationId?: string;
}

interface DayGroup {
  dateStr: string;
  date: Date;
  items: Occurrence[];
}

export default function FamilyCalendarPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [dayGroups, setDayGroups] = useState<DayGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'study' | 'transport'>('all');

  useEffect(() => {
    if (user) loadData();
  }, [user]);

  const loadData = async () => {
    if (!user) return;
    setIsLoading(true);
    setError(null);
    try {
      const fam = await familyService.getOrCreateFamily(
        user.uid,
        user.name || user.email?.split('@')[0] || '',
        user.email || ''
      );
      setFamily(fam);

      const children = await familyService.getFamilyChildren(fam.id, false, user.uid);
      const perChild = await Promise.all(
        children.map(async (child: Child) => {
          const { study, transport } = await familyService.getChildSubscriptions(child.id, user.uid);
          return {
            child,
            study: study.filter((s: StudyRoomEntry) => s.status === 'active'),
            transport: transport.filter((t: TransportationSubscription) => t.status === 'active'),
          };
        })
      );

      const activeStudyIds = perChild.flatMap(c => c.study.map(s => s.id));
      const activeTransportIds = perChild.flatMap(c => c.transport.map(t => t.id));

      const [calSnap, studyModsSnap, transportModsSnap] = await Promise.all([
        getDoc(docRef('config', 'schoolCalendar')),
        activeStudyIds.length
          ? getDocs(query(
              col('eventModifications'),
              where('subscriptionId', 'in', activeStudyIds.slice(0, 30)),
              where('subscriptionType', '==', 'study'),
              where('modificationType', '==', 'cancelled'),
              where('status', '==', 'approved'),
            ))
          : Promise.resolve(null),
        activeTransportIds.length
          ? getDocs(query(
              col('eventModifications'),
              where('subscriptionId', 'in', activeTransportIds.slice(0, 30)),
              where('subscriptionType', '==', 'transport'),
              where('modificationType', '==', 'cancelled'),
              where('status', '==', 'approved'),
            ))
          : Promise.resolve(null),
      ]);

      // Study cancellations keyed by `${subscriptionId}_${dateStr}`
      const studyCancellations: Record<string, string> = {};
      studyModsSnap?.docs.forEach(d => {
        const data = d.data();
        const date = data.date?.toDate?.() ?? new Date(data.date);
        studyCancellations[`${data.subscriptionId}_${format(date, 'yyyy-MM-dd')}`] = d.id;
      });

      // Transport cancellations keyed by eventId
      const transportCancellations: Record<string, string> = {};
      transportModsSnap?.docs.forEach(d => {
        const data = d.data();
        if (data.eventId) transportCancellations[data.eventId] = d.id;
      });

      const schoolYearEnd: Date | null =
        calSnap.exists() && calSnap.data().yearEndDate
          ? new Date(`${calSnap.data().yearEndDate}T23:59:59`)
          : null;

      const today = startOfToday();
      const rangeEnd = addWeeks(today, 4);
      const effectiveEnd = schoolYearEnd
        ? (rangeEnd < schoolYearEnd ? rangeEnd : schoolYearEnd)
        : rangeEnd;

      const groupMap = new Map<string, DayGroup>();
      const addOccurrence = (day: Date, occ: Occurrence) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        if (!groupMap.has(dateStr)) groupMap.set(dateStr, { dateStr, date: day, items: [] });
        groupMap.get(dateStr)!.items.push(occ);
      };

      for (const day of eachDayOfInterval({ start: today, end: effectiveEnd })) {
        const dayName = DAY_NAMES[day.getDay()];
        const dateStr = format(day, 'yyyy-MM-dd');

        for (const { child, study, transport } of perChild) {
          for (const entry of study) {
            for (const sel of entry.days ?? []) {
              if (sel.day !== dayName) continue;
              addOccurrence(day, {
                key: `study_${entry.id}_${dateStr}_${sel.hour}`,
                date: day,
                dateStr,
                time: sel.hour,
                kind: 'study',
                childName: child.firstName,
                detail: sel.transport ? 'Sala de Estudo · com transporte 🚌' : 'Sala de Estudo',
                subscriptionId: entry.id,
                cancellationId: studyCancellations[`${entry.id}_${dateStr}`],
              });
            }
          }

          for (const sub of transport) {
            const subStart = sub.startDate ? new Date(sub.startDate) : today;
            const subEnd = sub.endDate ? new Date(sub.endDate) : null;
            if (day < subStart || (subEnd && day > subEnd)) continue;
            for (const sched of sub.schedule ?? []) {
              if (sched.dayOfWeek !== dayName) continue;
              const eventId = `transport_sub_${sub.id}_${dateStr}_${sched.pickupTime.replace(':', '')}`;
              addOccurrence(day, {
                key: eventId,
                date: day,
                dateStr,
                time: sched.pickupTime,
                kind: 'transport',
                childName: child.firstName,
                detail: `${sched.pickupLocation} → ${sched.dropoffLocation}`,
                subscriptionId: sub.id,
                eventId,
                cancellationId: transportCancellations[eventId],
              });
            }
          }
        }
      }

      const groups = Array.from(groupMap.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
      groups.forEach(g => g.items.sort((a, b) => a.time.localeCompare(b.time)));
      setDayGroups(groups);
    } catch (err: any) {
      console.error('FamilyCalendarPage load error:', err);
      setError(err?.message || 'Erro ao carregar calendário.');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleOccurrence = async (occ: Occurrence) => {
    if (!user) return;
    setActionInProgress(occ.key);
    try {
      if (occ.cancellationId) {
        await deleteDoc(docRef('eventModifications', occ.cancellationId));
      } else {
        await addDoc(col('eventModifications'), {
          subscriptionId: occ.subscriptionId,
          subscriptionType: occ.kind,
          ...(occ.eventId ? { eventId: occ.eventId } : {}),
          date: occ.date,
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

  const filteredGroups = useMemo(() => {
    if (filter === 'all') return dayGroups;
    return dayGroups
      .map(g => ({ ...g, items: g.items.filter(i => i.kind === filter) }))
      .filter(g => g.items.length > 0);
  }, [dayGroups, filter]);

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-sm text-red-700">
        <p className="font-semibold mb-1">Erro ao carregar calendário</p>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <Link to="/client" className="text-sm text-blue-600 hover:underline">
          ← Dashboard
        </Link>
        <div className="flex items-center justify-between mt-2">
          <h1 className="text-2xl font-bold">Calendário</h1>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Sala de Estudo e Transporte de {family?.primaryContact.name.split(' ')[0]}, num só sítio.
          Cancele um dia diretamente aqui.
        </p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(['all', 'study', 'transport'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-sm px-3 py-1.5 rounded-lg font-medium transition ${
              filter === f ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {f === 'all' ? 'Tudo' : f === 'study' ? '📚 Sala de Estudo' : '🚌 Transporte'}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <p className="text-sm text-gray-500">
            Próximas 4 semanas. O cancelamento é imediato e pode ser revertido.
          </p>
        </div>

        {filteredGroups.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">
            Sem sessões ou viagens previstas nas próximas 4 semanas.
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            {filteredGroups.map(group => (
              <div key={group.dateStr} className="px-6 py-4">
                <p className="text-sm font-semibold text-gray-700 mb-2 capitalize">
                  {format(group.date, "EEEE, d 'de' MMMM", { locale: pt })}
                </p>
                <div className="space-y-2 pl-2">
                  {group.items.map(occ => {
                    const isCancelled = !!occ.cancellationId;
                    const inProgress = actionInProgress === occ.key;
                    return (
                      <div
                        key={occ.key}
                        className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                          isCancelled ? 'bg-gray-50' : occ.kind === 'study' ? 'bg-blue-50' : 'bg-green-50'
                        }`}
                      >
                        <div className={isCancelled ? 'opacity-40 line-through' : ''}>
                          <p className="text-sm font-medium">
                            {occ.time} · {occ.childName} {occ.kind === 'study' ? '📚' : '🚌'}
                          </p>
                          <p className="text-xs text-gray-500">{occ.detail}</p>
                        </div>
                        <button
                          onClick={() => toggleOccurrence(occ)}
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
    </div>
  );
}
