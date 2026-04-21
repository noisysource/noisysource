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
import { Event } from '@shared/models';
import { ChevronLeft, ChevronRight, PartyPopper, BookOpen, Bus, EuroIcon, X } from 'lucide-react';
import { eventService } from '../../services/eventService';
import Notification from '../Notification';

interface AugmentedEvent extends Event {
  booking?: any; 
  amount?: number;
  accountId?: string;
  isCancelled?: boolean;
  groupKey?: string; // For grouping events that represent the same logical occurrence
  createdAt?: Date; // For sorting within group (latest on top)
  cancellationReason?: string;
}

const financialAccountLabels: { [key: string]: string } = {
  'driver-wage': 'Driver Wage',
  'teacher-wage': 'Teacher Wage',
};

const eventTypes = [
  { key: 'study', label: 'Study', color: 'blue' },
  { key: 'transport', label: 'Transport', color: 'purple' },
  { key: 'party', label: 'Party', color: 'pink' },
  { key: 'financial', label: 'Financial', color: 'green' },
];

export default function AdminCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [events, setEvents] = useState<AugmentedEvent[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [refreshEvents, setRefreshEvents] = useState(false);
  const [selectedEventTypes, setSelectedEventTypes] = useState(['study', 'transport', 'party', 'financial']);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchEvents = async () => {
      // getEvents() returns all events with isCancelled flag (Event Sourcing: events are immutable)
      const eventList = await eventService.getEvents(currentMonth);
      
      // Deduplicate by ID just to be safe (shouldn't happen, but prevents confusion)
      const eventsById = new Map<string, AugmentedEvent>();
      eventList.forEach(event => {
        if (!eventsById.has(event.id)) {
          eventsById.set(event.id, event as AugmentedEvent);
        }
      });
      
      setEvents(Array.from(eventsById.values()));
    };
    fetchEvents();
  }, [currentMonth, refreshEvents]);

  const allDays = eachDayOfInterval({
    start: startOfWeek(startOfMonth(currentMonth), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(currentMonth), { weekStartsOn: 1 }),
  });

  const getLabel = (date: Date) => format(date, 'yyyy-MM-dd');

  const getEventsForDay = (date: Date): AugmentedEvent[] => {
    const dayEvents = events
      .filter(event => selectedEventTypes.includes(event.type))
      .filter(
        (event) => format(event.start.toDate(), 'yyyy-MM-dd') === format(date, 'yyyy-MM-dd')
      );
    
    // Group events by groupKey (same logical occurrence)
    const grouped = new Map<string, AugmentedEvent[]>();
    dayEvents.forEach(event => {
      const key = event.groupKey || event.id; // Fallback to id if no groupKey
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(event);
    });
    
    // Flatten groups, keeping latest first (already sorted by service)
    return Array.from(grouped.values()).flat();
  };

  const handleGenerateEvents = async () => {
    try {
      const result = await eventService.generateEvents(currentMonth);
      setNotification({ message: `${result} events created successfully!`, type: 'success' });
      setRefreshEvents(prev => !prev);
    } catch (error) {
      setNotification({ message: `Error generating events: ${(error as Error).message}`, type: 'error' });
    }
  };

  return (
    <div className="flex gap-6 p-6 bg-gray-100 min-h-screen font-sans">
      {/* 📅 Main Calendar */}
      <div className="flex-1 bg-white p-6 rounded-xl shadow-lg">
        <div className="flex justify-between items-center mb-6">
          <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-2 rounded-full hover:bg-gray-200 transition-colors">
            <ChevronLeft className="w-6 h-6 text-gray-600" />
          </button>
          <h2 className="text-2xl font-bold text-gray-800">{format(currentMonth, 'MMMM yyyy')}</h2>
          <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-2 rounded-full hover:bg-gray-200 transition-colors">
            <ChevronRight className="w-6 h-6 text-gray-600" />
          </button>
        </div>
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center space-x-2">
            {eventTypes.map(type => (
              <button
                key={type.key}
                onClick={() => {
                  if (selectedEventTypes.includes(type.key)) {
                    setSelectedEventTypes(selectedEventTypes.filter(t => t !== type.key));
                  } else {
                    setSelectedEventTypes([...selectedEventTypes, type.key]);
                  }
                }}
                className={`px-3 py-1 text-sm font-medium rounded-full ${selectedEventTypes.includes(type.key)
                    ? `bg-${type.color}-500 text-white`
                    : 'bg-gray-200 text-gray-700'
                  }`}
              >
                {type.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleGenerateEvents}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Generate Events
          </button>
        </div>
        <div className="grid grid-cols-7 text-center font-semibold text-gray-600 mb-2">
          {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-2 text-sm">
          {allDays.map((d, i) => {
            const dateKey = getLabel(d);
            const dayEvents = getEventsForDay(d);
            // Count only non-cancelled events (cancelled ones are shown but not counted)
            // Event Sourcing: cancellation is determined by isCancelled flag from EventModifications
            // Group events by groupKey to avoid double counting
            const uniqueGroups = new Set<string>();
            dayEvents.forEach(e => {
              if (e.groupKey && !e.isCancelled) {
                uniqueGroups.add(e.groupKey);
              } else if (!e.isCancelled) {
                uniqueGroups.add(e.id); // Fallback
              }
            });
            
            const studyCount = Array.from(uniqueGroups).filter(key => {
              const event = dayEvents.find(e => (e.groupKey || e.id) === key && e.type === 'study' && !e.isCancelled);
              return !!event;
            }).length;
            const transportCount = Array.from(uniqueGroups).filter(key => {
              const event = dayEvents.find(e => (e.groupKey || e.id) === key && e.type === 'transport' && !e.isCancelled);
              return !!event;
            }).length;
            const partyCount = Array.from(uniqueGroups).filter(key => {
              const event = dayEvents.find(e => (e.groupKey || e.id) === key && e.type === 'party' && !e.isCancelled);
              return !!event;
            }).length;
            const financialEvents = dayEvents.filter(e => e.type === 'financial');

            return (
              <div
                key={i}
                onClick={() => setSelectedDay(dateKey)}
                className={`cursor-pointer border rounded-xl p-3 h-40 overflow-auto transition-all duration-200 ${!isSameMonth(d, currentMonth)
                  ? 'bg-gray-50 text-gray-300'
                  : 'bg-white hover:shadow-lg'
                  } ${isToday(d) ? 'border-pink-500' : 'border-gray-200'} ${selectedDay === dateKey ? 'ring-2 ring-pink-500 shadow-lg' : ''
                  }`}
              >
                <div className="font-bold text-right text-gray-700">{format(d, 'd')}</div>
                <div className="flex flex-col gap-1 mt-2 text-xs">
                  {partyCount > 0 && (
                    <div key="party" className="flex items-center gap-1 bg-pink-100 text-pink-800 rounded-full px-2 py-1">
                      <PartyPopper className="w-4 h-4" /> {partyCount} festa(s)
                    </div>
                  )}
                  {studyCount > 0 && (
                    <div key="study" className="flex items-center gap-1 bg-blue-100 text-blue-800 rounded-full px-2 py-1">
                      <BookOpen className="w-4 h-4" /> {studyCount} aluno(s)
                    </div>
                  )}
                  {transportCount > 0 && (
                    <div key="transport" className="flex items-center gap-1 bg-purple-100 text-purple-800 rounded-full px-2 py-1">
                      <Bus className="w-4 h-4" /> {transportCount} transporte(s)
                    </div>
                  )}
                  {financialEvents.map(financialEvent => (
                    <div key={financialEvent.id} className="flex items-center gap-1 bg-green-100 text-green-800 rounded-full px-2 py-1 text-xs">
                      <EuroIcon className="w-3 h-3" />
                      <span className="font-medium">{financialAccountLabels[financialEvent.accountId || ''] || 'Forecast'}:</span>
                      <span className="font-bold">€{financialEvent.amount?.toFixed(2)}</span>
                    </div>
                  ))}
                </div>              </div>
            );
          })}
        </div>
      </div>

      {/* 📋 Side Agenda */}
      {selectedDay && (
        <div className="w-[400px] shrink-0 bg-white p-6 rounded-xl shadow-lg">
          <div className="font-bold text-xl mb-6 text-gray-800">
            📋 Agenda para {format(new Date(selectedDay), 'dd/MM/yyyy')}
          </div>

          <div className="space-y-4 mt-6">
            {(() => {
              const dayEvents = getEventsForDay(new Date(selectedDay))
                .filter(e => selectedEventTypes.includes(e.type));
              
              // Group events by groupKey (same logical occurrence)
              const eventsByGroup = new Map<string, AugmentedEvent[]>();
              dayEvents.forEach(event => {
                const key = event.groupKey || event.id;
                if (!eventsByGroup.has(key)) {
                  eventsByGroup.set(key, []);
                }
                eventsByGroup.get(key)!.push(event);
              });
              
              // Sort groups by time, then render each group with stacking
              const sortedGroups = Array.from(eventsByGroup.entries()).sort(([keyA, eventsA], [keyB, eventsB]) => {
                const timeA = eventsA[0].start.toDate().getTime();
                const timeB = eventsB[0].start.toDate().getTime();
                return timeA - timeB;
              });
              
              return sortedGroups.map(([groupKey, groupEvents]) => {
                // Sort events within group: latest first (already sorted by service)
                const sortedGroup = [...groupEvents].sort((a, b) => {
                  const timeA = a.createdAt?.getTime() || 0;
                  const timeB = b.createdAt?.getTime() || 0;
                  return timeB - timeA; // Latest first
                });
                
                // Find the original event (oldest by createdAt) for time display
                // Also find the earliest start time to ensure we show the correct original time
                const originalEvent = sortedGroup.reduce((oldest, current) => {
                  const oldestTime = oldest.createdAt?.getTime() || 0;
                  const currentTime = current.createdAt?.getTime() || 0;
                  return currentTime < oldestTime ? current : oldest;
                });
                const earliestStartTime = sortedGroup.reduce((earliest, current) => {
                  const earliestTime = earliest.start.toDate().getTime();
                  const currentTime = current.start.toDate().getTime();
                  return currentTime < earliestTime ? current : earliest;
                });
                const latestEvent = sortedGroup[0];
                const hasMultipleVersions = sortedGroup.length > 1;
                const isExpanded = expandedGroups.has(groupKey);
                
                return (
                  <div key={groupKey} className="flex items-start gap-4">
                    <div className="font-semibold text-gray-600 w-12 text-right pt-1">
                      {format(earliestStartTime.start.toDate(), 'HH:mm')}
                    </div>
                    <div className="flex-1 relative">
                      {/* Main card - latest event */}
                      <div
                        className={`relative flex items-start gap-3 p-3 rounded-lg border-l-4 transition-all ${
                          latestEvent.isCancelled
                            ? 'bg-gray-100 border-gray-400'
                            : latestEvent.type === 'party'
                              ? 'bg-pink-50 border-pink-500'
                              : latestEvent.type === 'transport' && latestEvent.id.includes('_study_')
                                ? 'bg-yellow-50 border-yellow-500'
                                : latestEvent.type === 'transport' && latestEvent.id.includes('_sub_')
                                  ? 'bg-purple-50 border-purple-500'
                                  : latestEvent.type === 'financial'
                                    ? 'bg-green-50 border-green-500'
                                    : 'bg-blue-50 border-blue-500'
                        } ${hasMultipleVersions ? 'cursor-pointer hover:shadow-lg' : ''} shadow-md`}
                        onClick={() => {
                          if (hasMultipleVersions) {
                            setExpandedGroups(prev => {
                              const newSet = new Set(prev);
                              if (newSet.has(groupKey)) {
                                newSet.delete(groupKey);
                              } else {
                                newSet.add(groupKey);
                              }
                              return newSet;
                            });
                          }
                        }}
                      >
                        <div className="flex flex-shrink-0 mt-1">
                          {latestEvent.type === 'party' && <PartyPopper className="w-5 h-5 text-pink-500" />}
                          {latestEvent.type === 'study' && <BookOpen className="w-5 h-5 text-blue-500" />}
                          {latestEvent.type === 'transport' && <Bus className="w-5 h-5 text-purple-500 ml-1" />}
                          {latestEvent.type === 'financial' && <EuroIcon className="w-5 h-5 text-green-500 ml-1" />}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className={`font-bold ${latestEvent.isCancelled ? 'text-gray-500 line-through' : 'text-gray-800'}`}>
                              {latestEvent.title}
                            </p>
                            {latestEvent.isCancelled && (
                              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <X className="w-3 h-3" />
                                Cancelled
                              </span>
                            )}
                            {hasMultipleVersions && (
                              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                                {sortedGroup.length} version{sortedGroup.length > 1 ? 's' : ''} {isExpanded ? '▼' : '▶'}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-600 mt-1">
                            {latestEvent.type === 'party'
                              ? 'Festa de Aniversário'
                              : latestEvent.type === 'study'
                                ? `Sala de Estudo`
                                : latestEvent.type === 'transport'
                                  ? 'Transporte'
                                  : financialAccountLabels[latestEvent.accountId || ''] || 'Financial Event'}
                          </p>
                          {latestEvent.cancellationReason && (
                            <p className="text-xs text-gray-500 mt-1 italic">
                              Reason: {latestEvent.cancellationReason}
                            </p>
                          )}
                          {latestEvent.type === 'transport' && latestEvent.booking && latestEvent.id.includes('_study_') && (
                            <p className="text-xs text-gray-500 mt-1">
                              {latestEvent.booking.schoolName}
                            </p>
                          )}
                          {latestEvent.type === 'transport' && latestEvent.booking && latestEvent.id.includes('_sub_') && (
                            <p className="text-xs text-gray-500 mt-1">
                              {typeof latestEvent.booking.schedule?.[0]?.pickupLocation === 'string'
                                ? latestEvent.booking.schedule?.[0]?.pickupLocation
                                : latestEvent.booking.schedule?.[0]?.pickupLocation?.address}
                            </p>
                          )}
                          {hasMultipleVersions && earliestStartTime.id !== latestEvent.id && (
                            <p className="text-xs text-blue-600 mt-1">
                              Original: {format(earliestStartTime.start.toDate(), 'HH:mm')}
                            </p>
                          )}
                        </div>
                      </div>
                      
                      {/* Expanded history - show all versions */}
                      {isExpanded && hasMultipleVersions && (
                        <div className="mt-2 space-y-2 pl-4 border-l-2 border-gray-200">
                          {sortedGroup.slice(1).map((e, idx) => (
                            <div
                              key={e.id}
                              className={`flex items-start gap-3 p-2 rounded border-l-2 ${
                                e.isCancelled
                                  ? 'bg-gray-50 border-gray-300'
                                  : 'bg-gray-50 border-gray-200'
                              }`}
                            >
                              <div className="flex-shrink-0 w-16 text-xs text-gray-500 pt-1">
                                {format(e.start.toDate(), 'HH:mm')}
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <p className={`text-sm ${e.isCancelled ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                                    {e.title}
                                  </p>
                                  {e.isCancelled && (
                                    <span className="text-xs bg-red-50 text-red-600 px-1.5 py-0.5 rounded">
                                      Cancelled
                                    </span>
                                  )}
                                </div>
                                {e.cancellationReason && (
                                  <p className="text-xs text-gray-500 mt-0.5 italic">
                                    {e.cancellationReason}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
            {getEventsForDay(new Date(selectedDay)).filter(e => selectedEventTypes.includes(e.type)).length === 0 && (
              <p className="text-sm text-gray-400 text-center py-8">Nenhum evento para este dia.</p>
            )}
          </div>
        </div>
      )}
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