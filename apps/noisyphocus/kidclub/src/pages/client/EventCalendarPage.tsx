import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where, addDoc, Timestamp } from 'firebase/firestore';
import { Event, EventModification, StudyRoomEntry, TransportationSubscription } from '@shared/models';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isPast, startOfWeek, endOfWeek, addWeeks } from 'date-fns';
import { eventService } from '../../services/eventService';

export default function EventCalendarPage() {
  const { childId } = useParams<{ childId: string }>();
  const user = useUser();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [events, setEvents] = useState<(Event & { isCancelled?: boolean; groupKey?: string; createdAt?: Date; cancellationReason?: string })[]>([]);
  const [modifications, setModifications] = useState<EventModification[]>([]);
  const [subscriptions, setSubscriptions] = useState<{ study: StudyRoomEntry[]; transport: TransportationSubscription[] }>({ study: [], transport: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<{ event: Event; date: Date } | null>(null);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    if (childId && user) {
      fetchData();
    }
  }, [childId, user, currentMonth]);

  const fetchData = async () => {
    if (!childId || !user) return;
    
    setIsLoading(true);
    try {
      // Fetch subscriptions to match events
      const [studySubs, transportSubs] = await Promise.all([
        getDocs(query(collection(db, 'studyroom'), where('childId', '==', childId))),
        getDocs(query(collection(db, 'transportationSubscriptions'), where('childId', '==', childId))),
      ]);

      const studySubscriptions = studySubs.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
      } as StudyRoomEntry));

      const transportSubscriptions = transportSubs.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
      } as TransportationSubscription));

      setSubscriptions({ study: studySubscriptions, transport: transportSubscriptions });

      // Use eventService to get events with proper grouping and stacking metadata
      const allEvents = await eventService.getEvents(currentMonth);
      
      // Filter events to only those belonging to this child's subscriptions
      const childEventIds = [
        ...studySubscriptions.map(s => s.id),
        ...transportSubscriptions.map(t => t.id)
      ];
      
      const childEvents = allEvents.filter(e => 
        childEventIds.includes(e.bookingId) && 
        (e.type === 'study' || e.type === 'transport')
      ) as (Event & { isCancelled?: boolean; groupKey?: string; createdAt?: Date; cancellationReason?: string })[];
      
      setEvents(childEvents);

      // Fetch modifications - note: Firestore doesn't support range queries on dates easily
      // We'll fetch all modifications for the child and filter client-side
      const modsQuery = query(
        collection(db, 'eventModifications'),
        where('childId', '==', childId)
      );
      const modsSnapshot = await getDocs(modsQuery);
      const allMods = modsSnapshot.docs.map(doc => ({
        ...doc.data(),
        id: doc.id,
        date: doc.data().date?.toDate?.() || new Date(doc.data().date),
        createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt),
        updatedAt: doc.data().updatedAt?.toDate?.() || new Date(doc.data().updatedAt),
      } as EventModification));
      
      // Filter modifications by month
      const monthMods = allMods.filter(mod => {
        const modDate = mod.date;
        return modDate >= monthStart && modDate <= monthEnd;
      });
      
      setModifications(monthMods);
    } catch (error) {
      console.error('Error fetching events:', error);
      alert('Error loading calendar events.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelEvent = async () => {
    if (!selectedEvent || !childId || !user) return;

    try {
      // Find the subscription this event belongs to
      const subscription = [...subscriptions.study, ...subscriptions.transport].find(
        s => s.id === selectedEvent.event.bookingId
      );

      if (!subscription) {
        alert('Subscription not found');
        return;
      }

      // Find family
      const familiesQuery = query(
        collection(db, 'families'),
        where('primaryContact.userId', '==', user.uid)
      );
      const familiesSnapshot = await getDocs(familiesQuery);
      if (familiesSnapshot.empty) {
        alert('Family not found');
        return;
      }
      const family = familiesSnapshot.docs[0];

      // Create modification record
      const modification: Omit<EventModification, 'id'> = {
        eventId: selectedEvent.event.id,
        subscriptionId: selectedEvent.event.bookingId,
        subscriptionType: selectedEvent.event.type === 'study' ? 'study' : 'transport',
        familyId: family.id,
        childId,
        date: selectedEvent.date,
        modificationType: 'cancelled',
        reason: cancelReason || 'Cancelled by parent',
        affectsPricing: false, // Cancellations don't change subscription price
        requestedBy: user.uid,
        requestedByName: user.name || user.email?.split('@')[0] || 'Parent',
        status: 'approved', // Auto-approve parent cancellations for now
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await addDoc(collection(db, 'eventModifications'), modification);

      // Don't modify the original event - Event Sourcing principle: events are immutable
      // The cancellation is recorded in EventModification, which we'll use when reading events

      await fetchData();
      setShowCancelModal(false);
      setSelectedEvent(null);
      setCancelReason('');
      alert('Event cancelled successfully. Teachers and drivers have been notified.');
    } catch (error: any) {
      console.error('Error cancelling event:', error);
      alert(`Error cancelling event: ${error.message}`);
    }
  };

  const isEventCancelled = (event: Event & { isCancelled?: boolean }, date: Date): boolean => {
    // Event Sourcing: Use isCancelled flag from eventService (already computed from EventModifications)
    return event.isCancelled || false;
  };

  const getEventsForDate = (date: Date): Event[] => {
    return events.filter(event => {
      const eventDate = (event.start as Timestamp).toDate();
      return isSameDay(eventDate, date);
    });
  };

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(currentMonth)),
    end: endOfWeek(endOfMonth(currentMonth)),
  });

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const weeks = [];
  for (let weekStart = startOfWeek(monthStart); weekStart <= monthEnd; weekStart = addWeeks(weekStart, 1)) {
    weeks.push(eachDayOfInterval({ start: weekStart, end: endOfWeek(weekStart) }));
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading calendar...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link 
            to={childId ? `/client/children/${childId}` : '/client'} 
            className="text-blue-600 hover:underline text-sm mb-2 inline-block"
          >
            ← Back
          </Link>
          <h1 className="text-2xl font-bold">Event Calendar</h1>
          <p className="text-sm text-gray-600">Manage individual occurrences</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}
            className="px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            ← Prev
          </button>
          <span className="font-semibold">{format(currentMonth, 'MMMM yyyy')}</span>
          <button
            onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}
            className="px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Next →
          </button>
        </div>
      </div>

      {/* Calendar */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        {/* Week day headers */}
        <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
            <div key={day} className="p-3 text-center text-sm font-semibold text-gray-700">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar days */}
        <div className="grid grid-cols-7">
          {weeks.map((week, weekIndex) =>
            week.map((day, dayIndex) => {
              const dayEvents = getEventsForDate(day);
              const isCurrentMonth = day >= monthStart && day <= monthEnd;
              const isToday = isSameDay(day, new Date());

              return (
                <div
                  key={`${weekIndex}-${dayIndex}`}
                  className={`min-h-32 border-r border-b border-gray-200 p-2 ${
                    !isCurrentMonth ? 'bg-gray-50' : 'bg-white'
                  } ${isToday ? 'bg-blue-50' : ''}`}
                >
                  <div className={`text-sm mb-1 ${!isCurrentMonth ? 'text-gray-400' : isToday ? 'font-bold text-blue-600' : 'text-gray-700'}`}>
                    {format(day, 'd')}
                  </div>
                  <div className="space-y-1">
                    {(() => {
                      // Group events by groupKey (same logical occurrence)
                      const eventsByGroup = new Map<string, (typeof dayEvents[0])[]>();
                      dayEvents.forEach(event => {
                        const key = (event as any).groupKey || event.id;
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
                        // Sort events within group: latest first
                        const sortedGroup = [...groupEvents].sort((a, b) => {
                          const timeA = (a as any).createdAt?.getTime() || 0;
                          const timeB = (b as any).createdAt?.getTime() || 0;
                          return timeB - timeA; // Latest first
                        });
                        
                        const latestEvent = sortedGroup[0];
                        const eventDate = latestEvent.start.toDate();
                        const eventTime = format(eventDate, 'HH:mm');
                        const cancelled = isEventCancelled(latestEvent, day);
                        const hasMultipleVersions = sortedGroup.length > 1;
                        
                        return (
                          <div
                            key={groupKey}
                            onClick={() => {
                              if (!cancelled && !isPast(eventDate)) {
                                setSelectedEvent({ event: latestEvent, date: day });
                                setShowCancelModal(true);
                              }
                            }}
                            className={`text-xs p-1 rounded relative ${
                              cancelled 
                                ? 'bg-gray-100 text-gray-500 line-through cursor-not-allowed' 
                                : `cursor-pointer ${
                                    latestEvent.type === 'study' 
                                      ? 'bg-blue-100 text-blue-800 hover:bg-blue-200' 
                                      : 'bg-green-100 text-green-800 hover:bg-green-200'
                                  }`
                            } ${isPast(eventDate) && !cancelled ? 'opacity-50' : ''}`}
                            title={cancelled ? 'This event has been cancelled' : hasMultipleVersions ? `${sortedGroup.length} versions (latest on top)` : undefined}
                          >
                            <div className="font-medium">{eventTime}</div>
                            <div className="flex items-center gap-1">
                              <div>{latestEvent.title}</div>
                              {hasMultipleVersions && (
                                <span className="text-xs bg-blue-200 text-blue-800 px-1 rounded">
                                  {sortedGroup.length}
                                </span>
                              )}
                            </div>
                            {cancelled && (
                              <div className="text-xs text-red-600 mt-0.5">Cancelled</div>
                            )}
                            {/* Stacked indicator - show small cards behind */}
                            {hasMultipleVersions && sortedGroup.length > 1 && (
                              <div className="absolute -right-1 -bottom-1 w-2 h-2 bg-gray-400 rounded-sm opacity-50" 
                                   style={{ zIndex: sortedGroup.length }} />
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-sm flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-blue-100 rounded"></div>
          <span>Study Room</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-green-100 rounded"></div>
          <span>Transport</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 bg-gray-100 rounded border border-gray-300"></div>
          <span className="line-through text-gray-500">Cancelled</span>
        </div>
        <div className="text-xs text-gray-500 italic">
          💡 Cancelled events won't be regenerated when admin generates events for the month
        </div>
      </div>

      {/* Cancel Modal */}
      {showCancelModal && selectedEvent && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 shadow-xl max-w-md w-full mx-4">
            <h2 className="text-xl font-bold mb-4">Cancel Event</h2>
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-2">
                <strong>Event:</strong> {selectedEvent.event.title}
              </p>
              <p className="text-sm text-gray-600 mb-2">
                <strong>Date:</strong> {format(selectedEvent.date, 'MMMM d, yyyy')}
              </p>
              <p className="text-sm text-gray-600 mb-4">
                <strong>Time:</strong> {format((selectedEvent.event.start as Timestamp).toDate(), 'HH:mm')}
              </p>
              <p className="text-xs text-gray-500 mb-4">
                <strong>Important:</strong> Cancelling this event will notify teachers/drivers. 
                Your subscription price will remain unchanged - monthly subscription fees are not affected by individual event cancellations.
              </p>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Reason (optional):
              </label>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="e.g., Child will be absent, alternative arrangements made..."
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCancelEvent}
                className="flex-1 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700"
              >
                Cancel Event
              </button>
              <button
                onClick={() => {
                  setShowCancelModal(false);
                  setSelectedEvent(null);
                  setCancelReason('');
                }}
                className="flex-1 bg-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-300"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

