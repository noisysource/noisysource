import { useEffect, useState } from 'react';
import {
  startOfMonth,
  endOfMonth,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameMonth,
  isToday,
  startOfWeek,
  addMonths,
  subMonths,
} from 'date-fns';
import { updateDoc } from 'firebase/firestore';
import { docRef } from '../../lib/db';
import { Event, partyVatBreakdown } from '@shared/models';
import { ChevronLeft, ChevronRight, PartyPopper, BookOpen, Bus, EuroIcon, X, Pencil, Check } from 'lucide-react';
import { eventService, schoolCalendarService } from '../../services/eventService';
import Notification from '../Notification';

interface AugmentedEvent extends Event {
  booking?: any;
  amount?: number;
  accountId?: string;
  isCancelled?: boolean;
  cancellationReason?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeOf(e: AugmentedEvent) {
  return format(e.start.toDate(), 'HH:mm');
}

interface TimeSlot {
  time: string;
  study: AugmentedEvent[];
  transport: AugmentedEvent[];
  party: AugmentedEvent[];
  financial: AugmentedEvent[];
}

function groupByTime(dayEvents: AugmentedEvent[]): TimeSlot[] {
  const map = new Map<string, TimeSlot>();
  for (const e of dayEvents) {
    const t = timeOf(e);
    if (!map.has(t)) map.set(t, { time: t, study: [], transport: [], party: [], financial: [] });
    const slot = map.get(t)!;
    if (e.type === 'study') slot.study.push(e);
    else if (e.type === 'transport') slot.transport.push(e);
    else if (e.type === 'party') slot.party.push(e);
    else if (e.type === 'financial') slot.financial.push(e);
  }
  return Array.from(map.values()).sort((a, b) => a.time.localeCompare(b.time));
}

// ── Component ─────────────────────────────────────────────────────────────────

const financialAccountLabels: Record<string, string> = {
  'driver-wage': 'Motorista',
  'teacher-wage': 'Professora',
};

const FILTER_TYPES = [
  { key: 'study',     label: 'Estudo',     color: 'blue'   },
  { key: 'transport', label: 'Transporte',  color: 'purple' },
  { key: 'party',     label: 'Festas',      color: 'pink'   },
  { key: 'financial', label: 'Financeiro',  color: 'green'  },
];

export default function AdminCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [events, setEvents] = useState<AugmentedEvent[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [refreshEvents, setRefreshEvents] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState(['study', 'transport', 'party', 'financial']);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schoolYearEnd, setSchoolYearEnd] = useState<string>('');
  const [editingYearEnd, setEditingYearEnd] = useState(false);
  const [yearEndDraft, setYearEndDraft] = useState('');

  // Load school year end date once
  useEffect(() => {
    schoolCalendarService.get().then(cfg => {
      if (cfg?.yearEndDate) {
        setSchoolYearEnd(cfg.yearEndDate);
        setYearEndDraft(cfg.yearEndDate);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setLoadError(null);
    (async () => {
      try {
        const list = await eventService.getEvents(currentMonth);
        const byId = new Map<string, AugmentedEvent>();
        list.forEach(e => { if (!byId.has(e.id)) byId.set(e.id, e as AugmentedEvent); });
        setEvents(Array.from(byId.values()));
      } catch (err: any) {
        console.error('[AdminCalendar] getEvents failed:', err);
        setLoadError(err?.message || 'Erro ao carregar eventos.');
      }
    })();
  }, [currentMonth, refreshEvents]);

  const saveYearEnd = async () => {
    if (!yearEndDraft) return;
    await schoolCalendarService.save({ yearEndDate: yearEndDraft });
    setSchoolYearEnd(yearEndDraft);
    setEditingYearEnd(false);
    setRefreshEvents(p => !p);
  };

  const allDays = eachDayOfInterval({
    start: startOfWeek(startOfMonth(currentMonth), { weekStartsOn: 1 }),
    end:   endOfWeek(endOfMonth(currentMonth),   { weekStartsOn: 1 }),
  });

  function eventsForDay(date: Date): AugmentedEvent[] {
    const key = format(date, 'yyyy-MM-dd');
    return events.filter(
      e => selectedTypes.includes(e.type) && format(e.start.toDate(), 'yyyy-MM-dd') === key
    );
  }

  const toggleType = (key: string) =>
    setSelectedTypes(prev => prev.includes(key) ? prev.filter(t => t !== key) : [...prev, key]);

  const handleGenerateEvents = async () => {
    try {
      const n = await eventService.generateEvents(currentMonth);
      setNotification({ message: `${n} eventos gerados.`, type: 'success' });
      setRefreshEvents(p => !p);
    } catch (err) {
      setNotification({ message: `Erro: ${(err as Error).message}`, type: 'error' });
    }
  };

  const approveSubscription = async (subscriptionType: 'study' | 'transport', subscriptionId?: string) => {
    if (!subscriptionId) return;
    try {
      const colName = subscriptionType === 'study' ? 'studyroom' : 'transportationSubscriptions';
      const newStatus = subscriptionType === 'study' ? 'confirmed' : 'active';
      await updateDoc(docRef(colName, subscriptionId), { status: newStatus, updatedAt: new Date() });
      setNotification({ message: 'Subscrição aprovada!', type: 'success' });
      setRefreshEvents(p => !p);
    } catch (err) {
      setNotification({ message: `Erro ao aprovar: ${(err as Error).message}`, type: 'error' });
    }
  };

  // ── Monthly grid day cell ───────────────────────────────────────────────────

  function DayCell({ d }: { d: Date }) {
    const dayKey = format(d, 'yyyy-MM-dd');
    const dayEvents = eventsForDay(d);
    const slots = groupByTime(dayEvents);

    // Compact summary for the grid: show one pill per unique time slot
    const studySlots = slots.filter(s => s.study.some(e => !e.isCancelled));
    const transportSlots = slots.filter(s => s.transport.some(e => !e.isCancelled));
    const partySlots = slots.filter(s => s.party.length > 0);
    const financialSlots = slots.filter(s => s.financial.length > 0);

    return (
      <div
        onClick={() => setSelectedDay(dayKey)}
        className={`cursor-pointer border rounded-xl p-2 h-36 overflow-hidden transition-all duration-200 flex flex-col
          ${!isSameMonth(d, currentMonth) ? 'bg-gray-50 text-gray-300' : 'bg-white hover:shadow-md'}
          ${isToday(d) ? 'border-pink-400' : 'border-gray-200'}
          ${selectedDay === dayKey ? 'ring-2 ring-pink-500 shadow-md' : ''}
        `}
      >
        <div className="text-right text-sm font-bold text-gray-700 mb-1">{format(d, 'd')}</div>
        <div className="flex flex-col gap-0.5 text-xs overflow-hidden">
          {/* Transport slots */}
          {transportSlots.map(s => {
            const active = s.transport.filter(e => !e.isCancelled && e.status !== 'pending');
            const pending = s.transport.filter(e => !e.isCancelled && e.status === 'pending');
            return (
              <div key={`tr-${s.time}`} className="flex items-center gap-1 text-purple-700 bg-purple-50 rounded px-1.5 py-0.5">
                <Bus className="w-3 h-3 shrink-0" />
                <span className="font-semibold">{s.time}</span>
                <span className="text-purple-500">·</span>
                <span>{active.length + pending.length}</span>
                {pending.length > 0 && <span className="text-amber-500 text-xs">⏳{pending.length}</span>}
              </div>
            );
          })}
          {/* Study slots */}
          {studySlots.map(s => {
            const active = s.study.filter(e => !e.isCancelled && e.status !== 'pending');
            const pending = s.study.filter(e => !e.isCancelled && e.status === 'pending');
            return (
              <div key={`st-${s.time}`} className="flex items-center gap-1 text-blue-700 bg-blue-50 rounded px-1.5 py-0.5">
                <BookOpen className="w-3 h-3 shrink-0" />
                <span className="font-semibold">{s.time}</span>
                <span className="text-blue-400">·</span>
                <span>{active.length + pending.length}</span>
                {pending.length > 0 && <span className="text-amber-500 text-xs">⏳{pending.length}</span>}
              </div>
            );
          })}
          {/* Parties */}
          {partySlots.map(s =>
            s.party.map(e => {
              const pending = (e as any).status === 'pending';
              return (
                <div key={e.id} className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${pending ? 'bg-yellow-50 text-yellow-700' : 'bg-pink-50 text-pink-700'}`}>
                  <PartyPopper className="w-3 h-3 shrink-0" />
                  <span className="truncate">{e.booking?.childName ?? e.title}</span>
                  {pending && <span>⏳</span>}
                </div>
              );
            })
          )}
          {/* Financial */}
          {financialSlots.map(s =>
            s.financial.map(e => (
              <div key={e.id} className="flex items-center gap-1 text-green-700 bg-green-50 rounded px-1.5 py-0.5">
                <EuroIcon className="w-3 h-3 shrink-0" />
                <span className="truncate">{financialAccountLabels[(e as any).accountId] ?? 'Forecast'} €{(e as any).amount?.toFixed(0)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // ── Side panel ─────────────────────────────────────────────────────────────

  function SidePanel() {
    if (!selectedDay) return null;
    const date = new Date(`${selectedDay}T12:00`);
    const dayEvents = eventsForDay(date);
    const slots = groupByTime(dayEvents);

    return (
      <div className="w-[380px] shrink-0 bg-white rounded-xl shadow-lg flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide">{format(date, 'EEEE', { locale: undefined })}</p>
            <p className="font-bold text-lg text-gray-800">{format(date, 'dd/MM/yyyy')}</p>
          </div>
          <button onClick={() => setSelectedDay(null)} className="text-gray-300 hover:text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Slots */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {slots.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-10">Sem eventos para este dia.</p>
          )}

          {slots.map(slot => (
            <div key={slot.time}>
              {/* Time heading */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-bold text-gray-700">{slot.time}</span>
                <div className="flex-1 h-px bg-gray-100" />
                {slot.study.filter(e => !e.isCancelled).length > 0 && (
                  <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">
                    {slot.study.filter(e => !e.isCancelled).length} estudo
                  </span>
                )}
                {slot.transport.filter(e => !e.isCancelled).length > 0 && (
                  <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5">
                    {slot.transport.filter(e => !e.isCancelled).length} transporte
                  </span>
                )}
              </div>

              <div className="space-y-1.5 pl-1">
                {/* Transport students */}
                {slot.transport.map(e => {
                  const isPending = e.status === 'pending';
                  return (
                    <div
                      key={e.id}
                      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm
                        ${e.isCancelled ? 'bg-gray-50 opacity-50' : isPending ? 'bg-amber-50' : 'bg-purple-50'}`}
                    >
                      <Bus className={`w-4 h-4 mt-0.5 shrink-0 ${isPending ? 'text-amber-500' : 'text-purple-500'}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium text-gray-800 ${e.isCancelled ? 'line-through' : ''}`}>
                          {e.booking?.childName ?? e.title}
                        </p>
                        {e.booking?.pickupLocation && (
                          <p className="text-xs text-gray-500 truncate">
                            📍 {typeof e.booking.pickupLocation === 'string'
                              ? e.booking.pickupLocation
                              : e.booking.pickupLocation?.address ?? '—'}
                            {e.booking?.dropoffLocation && (
                              <span className="text-gray-400"> → {
                                typeof e.booking.dropoffLocation === 'string'
                                  ? e.booking.dropoffLocation
                                  : e.booking.dropoffLocation?.address ?? ''
                              }</span>
                            )}
                          </p>
                        )}
                        {e.isCancelled && (
                          <span className="text-xs text-red-500">Cancelado{e.cancellationReason ? ` — ${e.cancellationReason}` : ''}</span>
                        )}
                        {isPending && !e.isCancelled && (
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">⏳ Pendente</span>
                            <button
                              onClick={() => approveSubscription('transport', e.booking?.subscriptionId)}
                              className="text-xs bg-green-600 text-white px-2 py-0.5 rounded hover:bg-green-700"
                            >
                              Aprovar
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Study students */}
                {slot.study.map(e => {
                  const isPending = e.status === 'pending';
                  return (
                    <div
                      key={e.id}
                      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm
                        ${e.isCancelled ? 'bg-gray-50 opacity-50' : isPending ? 'bg-amber-50' : 'bg-blue-50'}`}
                    >
                      <BookOpen className={`w-4 h-4 mt-0.5 shrink-0 ${isPending ? 'text-amber-500' : 'text-blue-500'}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`font-medium text-gray-800 ${e.isCancelled ? 'line-through' : ''}`}>
                          {e.booking?.childName ?? e.title}
                        </p>
                        {e.booking?.schoolName && (
                          <p className="text-xs text-gray-500 truncate">🏫 {e.booking.schoolName}</p>
                        )}
                        {e.booking?.hasTransport && !e.isCancelled && !isPending && (
                          <p className="text-xs text-purple-500">+ transporte incluído</p>
                        )}
                        {e.isCancelled && (
                          <span className="text-xs text-red-500">Cancelado{e.cancellationReason ? ` — ${e.cancellationReason}` : ''}</span>
                        )}
                        {isPending && !e.isCancelled && (
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">⏳ Pendente</span>
                            <button
                              onClick={() => approveSubscription('study', e.booking?.subscriptionId)}
                              className="text-xs bg-green-600 text-white px-2 py-0.5 rounded hover:bg-green-700"
                            >
                              Aprovar
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Parties */}
                {slot.party.map(e => {
                  const pending = (e as any).status === 'pending';
                  return (
                    <div
                      key={e.id}
                      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm
                        ${pending ? 'bg-yellow-50' : 'bg-pink-50'}`}
                    >
                      <PartyPopper className={`w-4 h-4 mt-0.5 shrink-0 ${pending ? 'text-yellow-500' : 'text-pink-500'}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-gray-800">
                            Festa — {e.booking?.childName ?? e.title}
                          </p>
                          {pending && (
                            <span className="text-xs bg-yellow-100 text-yellow-700 border border-yellow-200 rounded-full px-2 py-0.5">
                              ⏳ Pendente
                            </span>
                          )}
                        </div>
                        {e.booking && (
                          <p className="text-xs text-gray-500 mt-0.5">
                            {e.booking.numKids} crianças · €{partyVatBreakdown(e.booking.total ?? 0).total.toFixed(2)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Financial */}
                {slot.financial.map(e => (
                  <div key={e.id} className="flex items-start gap-2 rounded-lg px-3 py-2 text-sm bg-green-50">
                    <EuroIcon className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-gray-800">
                        {financialAccountLabels[(e as any).accountId] ?? 'Previsão financeira'}
                      </p>
                      <p className="text-xs text-gray-500">€{(e as any).amount?.toFixed(2)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-4 p-6 bg-gray-100 min-h-screen font-sans">
      {/* Main calendar */}
      <div className="flex-1 bg-white p-6 rounded-xl shadow-lg min-w-0">
        {loadError && (
          <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            ⚠️ {loadError}
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between items-center mb-5">
          <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-2 rounded-full hover:bg-gray-100">
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </button>
          <h2 className="text-xl font-bold text-gray-800">{format(currentMonth, 'MMMM yyyy')}</h2>
          <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-2 rounded-full hover:bg-gray-100">
            <ChevronRight className="w-5 h-5 text-gray-600" />
          </button>
        </div>

        {/* School year end */}
        <div className="flex items-center gap-2 mb-4 text-sm text-gray-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          <span className="font-medium text-amber-700">Fim do ano letivo:</span>
          {editingYearEnd ? (
            <>
              <input
                type="date"
                value={yearEndDraft}
                onChange={e => setYearEndDraft(e.target.value)}
                className="border border-gray-300 rounded px-2 py-0.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <button onClick={saveYearEnd} className="text-green-600 hover:text-green-700">
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => { setEditingYearEnd(false); setYearEndDraft(schoolYearEnd); }} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <span className="text-amber-900 font-semibold">
                {schoolYearEnd
                  ? new Date(`${schoolYearEnd}T12:00`).toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' })
                  : 'Não definido'}
              </span>
              <button onClick={() => setEditingYearEnd(true)} className="text-amber-500 hover:text-amber-700 ml-1">
                <Pencil className="w-3.5 h-3.5" />
              </button>
              {!schoolYearEnd && (
                <span className="text-xs text-amber-600 ml-1">— subscrições sem fim não serão limitadas</span>
              )}
            </>
          )}
        </div>

        {/* Filters + generate */}
        <div className="flex justify-between items-center mb-4">
          <div className="flex gap-2 flex-wrap">
            {FILTER_TYPES.map(t => (
              <button
                key={t.key}
                onClick={() => toggleType(t.key)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition
                  ${selectedTypes.includes(t.key)
                    ? `bg-${t.color}-500 text-white`
                    : 'bg-gray-100 text-gray-500'
                  }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleGenerateEvents}
            className="text-xs px-3 py-1.5 bg-gray-700 text-white rounded-lg hover:bg-gray-800"
          >
            Gerar financeiro
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 text-center text-xs font-semibold text-gray-400 mb-2">
          {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(d => <div key={d}>{d}</div>)}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7 gap-1.5">
          {allDays.map((d, i) => <DayCell key={i} d={d} />)}
        </div>
      </div>

      {/* Side panel */}
      <SidePanel />

      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onClose={() => setNotification(null)}
        />
      )}
    </div>
  );
}
