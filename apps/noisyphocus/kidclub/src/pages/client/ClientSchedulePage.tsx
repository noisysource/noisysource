import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { StudyRoomEntry, TransportationSubscription, Booking } from '@shared/models';
import { format, parseISO, isPast, isFuture, startOfDay, addDays } from 'date-fns';
import { Link } from 'react-router-dom';
import { safeDate } from '@shared/lib/dates';

type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

interface ScheduleEvent {
  id: string;
  type: 'study' | 'transport' | 'party';
  title: string;
  date: Date;
  time?: string;
  status: string;
  description?: string;
  link?: string;
  subscriptionId?: string;
}

export default function ClientSchedulePage() {
  const user = useUser();
  const [studySubscriptions, setStudySubscriptions] = useState<StudyRoomEntry[]>([]);
  const [transportSubscriptions, setTransportSubscriptions] = useState<TransportationSubscription[]>([]);
  const [partyBookings, setPartyBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'upcoming' | 'all' | 'weekly'>('upcoming');

  useEffect(() => {
    if (user) {
      const fetchData = async () => {
        setIsLoading(true);

        // Fetch study room subscriptions
        const studyQuery = query(collection(db, 'studyroom'), where('userId', '==', user.uid));
        const studySnapshot = await getDocs(studyQuery);
        setStudySubscriptions(
          studySnapshot.docs.map(doc => {
            const data = doc.data();
            return {
              ...data,
              id: doc.id,
              startDate: data.startDate?.toDate?.() || new Date(data.startDate),
              endDate: data.endDate?.toDate?.() || new Date(data.endDate),
              createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            } as StudyRoomEntry;
          })
        );

        // Fetch transport subscriptions - check both userId and email
        // First try userId (uid), then email as fallback
        let transportSnapshot;
        const transportQueryByUserId = query(
          collection(db, 'transportationSubscriptions'),
          where('userId', '==', user.uid)
        );
        transportSnapshot = await getDocs(transportQueryByUserId);
        
        // If no results by userId, try by email
        if (transportSnapshot.empty && user.email) {
          const transportQueryByEmail = query(
            collection(db, 'transportationSubscriptions'),
            where('contactEmail', '==', user.email)
          );
          transportSnapshot = await getDocs(transportQueryByEmail);
        }
        
        console.log('Transport subscriptions found:', transportSnapshot.size, 'for user:', user.uid, user.email);
        const transportSubs = transportSnapshot.docs.map(doc => {
          const data = doc.data();
          console.log('Transport sub:', { 
            id: doc.id, 
            userId: data.userId, 
            email: data.contactEmail, 
            status: data.status, 
            scheduleCount: data.schedule?.length,
            schedule: data.schedule 
          });
          return {
            ...data,
            id: doc.id,
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
          } as TransportationSubscription;
        });
        setTransportSubscriptions(transportSubs);
        console.log('Final transport subscriptions state:', transportSubs.length);

        // Fetch party bookings by email
        if (user.email) {
          const bookingsQuery = query(
            collection(db, 'bookings'),
            where('email', '==', user.email)
          );
          const bookingsSnapshot = await getDocs(bookingsQuery);
          const bookings = bookingsSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
              ...data,
              id: doc.id,
              date: String(data.date ?? ''),
              time: String(data.time ?? ''),
              createdAt: safeDate(data.createdAt),
            } as Booking;
          });
          // Sort by date (upcoming first)
          bookings.sort((a, b) => {
            const dateA = parseISO(a.date + 'T' + (a.time || '00:00'));
            const dateB = parseISO(b.date + 'T' + (b.time || '00:00'));
            return dateA.getTime() - dateB.getTime();
          });
          setPartyBookings(bookings);
        }

        setIsLoading(false);
      };

      fetchData();
    }
  }, [user]);

  // Convert bookings to schedule events
  const getScheduleEvents = (): ScheduleEvent[] => {
    const events: ScheduleEvent[] = [];

    // Add party bookings
    partyBookings.forEach(booking => {
      try {
        const bookingDate = parseISO(booking.date + 'T' + (booking.time || '00:00'));
        events.push({
          id: booking.id,
          type: 'party',
          title: `Party: ${booking.childName}`,
          date: bookingDate,
          time: booking.time,
          status: booking.status,
          description: `${booking.partyType} · ${booking.numKids} children · €${booking.total.toFixed(2)}`,
        });
      } catch (e) {
        console.error('Error parsing booking date:', e);
      }
    });

    return events.sort((a, b) => a.date.getTime() - b.date.getTime());
  };

  const scheduleEvents = getScheduleEvents();
  const today = startOfDay(new Date());
  const nextWeek = addDays(today, 7);

  // Filter events based on view mode
  const filteredEvents =
    viewMode === 'upcoming'
      ? scheduleEvents.filter(e => isFuture(e.date) || isPast(e.date) && !isPast(addDays(e.date, 1)))
      : scheduleEvents;

  // Group events by date
  const eventsByDate = filteredEvents.reduce((acc, event) => {
    const dateKey = format(event.date, 'yyyy-MM-dd');
    if (!acc[dateKey]) {
      acc[dateKey] = [];
    }
    acc[dateKey].push(event);
    return acc;
  }, {} as Record<string, ScheduleEvent[]>);

  const sortedDates = Object.keys(eventsByDate).sort();

  // Weekly schedule for subscriptions
  const weeklySchedule: Record<DayOfWeek, Array<{ type: 'study' | 'transport'; title: string; time: string; link: string }>> = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  };

  // Helper to normalize day names
  const normalizeDayName = (day: string): DayOfWeek | null => {
    const normalized = day.toLowerCase().trim();
    const dayMap: Record<string, DayOfWeek> = {
      'monday': 'monday',
      'tuesday': 'tuesday',
      'wednesday': 'wednesday',
      'thursday': 'thursday',
      'friday': 'friday',
      'saturday': 'saturday',
      'sunday': 'sunday',
      'segunda': 'monday',
      'terça': 'tuesday',
      'quarta': 'wednesday',
      'quinta': 'thursday',
      'sexta': 'friday',
      'sábado': 'saturday',
      'domingo': 'sunday',
    };
    return dayMap[normalized] || null;
  };

  studySubscriptions
    .filter(sub => sub.status === 'confirmed' || sub.status === 'pending')
    .forEach(sub => {
      sub.days.forEach(day => {
        const dayKey = normalizeDayName(day.day);
        if (dayKey && weeklySchedule[dayKey]) {
          weeklySchedule[dayKey].push({
            type: 'study',
            title: `${sub.childName} - Study Room`,
            time: day.hour,
            link: `/client/study/${sub.id}`,
          });
        }
      });
    });

  transportSubscriptions
    .filter(sub => sub.status === 'active' || sub.status === 'pending')
    .forEach(sub => {
      if (sub.schedule && Array.isArray(sub.schedule) && sub.schedule.length > 0) {
        sub.schedule.forEach(item => {
          // Handle both string and the actual dayOfWeek type
          const dayName = typeof item.dayOfWeek === 'string' ? item.dayOfWeek : String(item.dayOfWeek);
          const dayKey = normalizeDayName(dayName);
          if (dayKey && weeklySchedule[dayKey]) {
            weeklySchedule[dayKey].push({
              type: 'transport',
              title: `${sub.childName} - Transport`,
              time: item.pickupTime || 'N/A',
              link: `/client/transport/${sub.id}`,
            });
          }
        });
      }
    });

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'confirmed':
      case 'active':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'rejected':
      case 'cancelled':
      case 'inactive':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'party':
        return '🎉';
      case 'study':
        return '📚';
      case 'transport':
        return '🚌';
      default:
        return '📅';
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading schedule...</div>
      </div>
    );
  }

  const hasActiveSubscriptions =
    studySubscriptions.some(s => s.status === 'confirmed' || s.status === 'pending') ||
    transportSubscriptions.some(t => t.status === 'active' || t.status === 'pending');

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">My Schedule</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('upcoming')}
            className={`px-4 py-2 rounded-lg text-sm ${
              viewMode === 'upcoming'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Upcoming
          </button>
          <button
            onClick={() => setViewMode('weekly')}
            className={`px-4 py-2 rounded-lg text-sm ${
              viewMode === 'weekly'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Weekly Schedule
          </button>
          <button
            onClick={() => setViewMode('all')}
            className={`px-4 py-2 rounded-lg text-sm ${
              viewMode === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            All Events
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active Subscriptions</p>
              <p className="text-2xl font-bold mt-1">
                {studySubscriptions.filter(s => s.status === 'confirmed' || s.status === 'pending').length +
                  transportSubscriptions.filter(t => t.status === 'active' || t.status === 'pending').length}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {studySubscriptions.filter(s => s.status === 'confirmed' || s.status === 'pending').length} study · {transportSubscriptions.filter(t => t.status === 'active' || t.status === 'pending').length} transport
              </p>
            </div>
            <div className="text-3xl">📚</div>
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Upcoming Parties</p>
              <p className="text-2xl font-bold mt-1">
                {scheduleEvents.filter(e => e.type === 'party' && isFuture(e.date)).length}
              </p>
            </div>
            <div className="text-3xl">🎉</div>
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Events</p>
              <p className="text-2xl font-bold mt-1">{filteredEvents.length}</p>
            </div>
            <div className="text-3xl">📅</div>
          </div>
        </div>
      </div>

      {viewMode === 'weekly' ? (
        /* Weekly Schedule View */
        <div>
          <h2 className="text-xl font-bold mb-4">Weekly Recurring Schedule</h2>
          {hasActiveSubscriptions ? (
            <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
              {Object.entries(weeklySchedule).map(([day, activities]) => (
                <div key={day} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
                  <h3 className="text-lg font-bold capitalize mb-3 text-center">{day}</h3>
                  {activities.length > 0 ? (
                    <div className="space-y-2">
                      {activities
                        .sort((a, b) => a.time.localeCompare(b.time))
                        .map((activity, i) => (
                          <Link
                            key={i}
                            to={activity.link}
                            className="block p-2 rounded border hover:shadow-sm transition-shadow"
                          >
                            <div className="flex items-start gap-2">
                              <span className="text-lg">{getTypeIcon(activity.type)}</span>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{activity.title}</p>
                                <p className="text-xs text-gray-500">{activity.time}</p>
                              </div>
                            </div>
                          </Link>
                        ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 text-center py-4">No scheduled activities</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
              <p className="text-gray-500">You have no active subscriptions with scheduled activities.</p>
            </div>
          )}
        </div>
      ) : (
        /* Calendar/List View */
        <div>
          <h2 className="text-xl font-bold mb-4">
            {viewMode === 'upcoming' ? 'Upcoming Events' : 'All Events'}
          </h2>
          {sortedDates.length > 0 ? (
            <div className="space-y-6">
              {sortedDates.map(dateKey => {
                const date = parseISO(dateKey);
                const events = eventsByDate[dateKey];
                const isPastDate = isPast(startOfDay(date)) && !isFuture(addDays(startOfDay(date), 1));

                return (
                  <div key={dateKey} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                    <div className={`px-6 py-3 border-b ${isPastDate ? 'bg-gray-50' : 'bg-blue-50'}`}>
                      <h3 className="text-lg font-semibold">
                        {format(date, 'EEEE, MMMM dd, yyyy')}
                        {isPastDate && <span className="ml-2 text-sm text-gray-500">(Past)</span>}
                      </h3>
                    </div>
                    <div className="p-6">
                      <div className="space-y-3">
                        {events.map(event => (
                          <div
                            key={event.id}
                            className="flex items-start gap-4 p-4 rounded-lg border border-gray-200 hover:shadow-sm transition-shadow"
                          >
                            <div className="text-3xl">{getTypeIcon(event.type)}</div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <h4 className="font-semibold">{event.title}</h4>
                                <span
                                  className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(event.status)}`}
                                >
                                  {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
                                </span>
                              </div>
                              {event.time && (
                                <p className="text-sm text-gray-600 mb-1">
                                  <strong>Time:</strong> {event.time}
                                </p>
                              )}
                              {event.description && (
                                <p className="text-sm text-gray-600">{event.description}</p>
                              )}
                            </div>
                            {event.link && (
                              <Link
                                to={event.link}
                                className="text-blue-600 hover:underline text-sm whitespace-nowrap"
                              >
                                View Details →
                              </Link>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
              <p className="text-gray-500">
                {viewMode === 'upcoming'
                  ? 'No upcoming events scheduled.'
                  : 'No events found in your schedule.'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Subscriptions Overview */}
      {(studySubscriptions.length > 0 || transportSubscriptions.length > 0) && (
        <div className="mt-8">
          <h2 className="text-xl font-bold mb-4">My Subscriptions</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Study Room Subscriptions */}
            {studySubscriptions.length > 0 ? (
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span>📚</span> Study Room Subscriptions ({studySubscriptions.length})
                </h3>
                <div className="space-y-3">
                  {studySubscriptions.map(sub => (
                    <Link
                      key={sub.id}
                      to={`/client/study/${sub.id}`}
                      className="block p-3 rounded border hover:shadow-sm transition-shadow"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-medium">{sub.childName}</p>
                          <p className="text-sm text-gray-600">
                            {sub.days?.length || 0} day(s) per week · €{sub.monthlyPrice.toFixed(2)}/month
                          </p>
                        </div>
                        <span className={`px-2 py-1 rounded text-xs ${getStatusColor(sub.status)}`}>
                          {sub.status}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span>📚</span> Study Room Subscriptions
                </h3>
                <p className="text-sm text-gray-500">No study room subscriptions</p>
              </div>
            )}

            {/* Transport Subscriptions */}
            {transportSubscriptions.length > 0 ? (
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span>🚌</span> Transport Subscriptions ({transportSubscriptions.length})
                </h3>
                <div className="space-y-3">
                  {transportSubscriptions.map(sub => {
                    const scheduleCount = Array.isArray(sub.schedule) ? sub.schedule.length : 0;
                    return (
                      <Link
                        key={sub.id}
                        to={`/client/transport/${sub.id}`}
                        className="block p-3 rounded border hover:shadow-sm transition-shadow"
                      >
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <p className="font-medium">{sub.childName}</p>
                            <p className="text-sm text-gray-600">
                              {scheduleCount > 0 ? `${scheduleCount} trip(s) per week` : 'No schedule set'} · €{sub.monthlyFee.toFixed(2)}/month
                            </p>
                            {scheduleCount === 0 && (
                              <p className="text-xs text-yellow-600 mt-1">Schedule not configured</p>
                            )}
                          </div>
                          <span className={`px-2 py-1 rounded text-xs whitespace-nowrap ${getStatusColor(sub.status)}`}>
                            {sub.status}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span>🚌</span> Transport Subscriptions
                </h3>
                <p className="text-sm text-gray-500">No transport subscriptions</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
