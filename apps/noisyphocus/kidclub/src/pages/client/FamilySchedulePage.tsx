import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where, addDoc } from 'firebase/firestore';
import { Family, Child, StudyRoomEntry, TransportationSubscription, Booking } from '@shared/models';
import { Link } from 'react-router-dom';
import { format, parseISO, isFuture, isPast, startOfDay, addDays } from 'date-fns';

interface ScheduleEvent {
  id: string;
  type: 'study' | 'transport' | 'party';
  title: string;
  date: Date;
  time?: string;
  status: string;
  childId: string;
  childName: string;
  description?: string;
  link?: string;
}

type ViewMode = 'family' | 'child' | 'calendar';
type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export default function FamilySchedulePage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [studySubscriptions, setStudySubscriptions] = useState<StudyRoomEntry[]>([]);
  const [transportSubscriptions, setTransportSubscriptions] = useState<TransportationSubscription[]>([]);
  const [partyBookings, setPartyBookings] = useState<Booking[]>([]);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('family');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      fetchFamilyData();
    }
  }, [user]);

  const fetchFamilyData = async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const familiesQuery = query(
        collection(db, 'families'),
        where('primaryContact.userId', '==', user.uid)
      );
      const familiesSnapshot = await getDocs(familiesQuery);

      if (familiesSnapshot.empty) {
        // Auto-create family if it doesn't exist
        const newFamily: Omit<Family, 'id'> = {
          primaryContact: {
            name: user.name || user.email?.split('@')[0] || 'User',
            email: user.email || '',
            phone: '',
            userId: user.uid,
          },
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const familyRef = await addDoc(collection(db, 'families'), newFamily);
        const familyData = {
          ...newFamily,
          id: familyRef.id,
        } as Family;
        setFamily(familyData);
        setChildren([]);
        setStudySubscriptions([]);
        setTransportSubscriptions([]);
        setPartyBookings([]);
        setIsLoading(false);
        return;
      }

      if (!familiesSnapshot.empty) {
        const familyData = {
          ...familiesSnapshot.docs[0].data(),
          id: familiesSnapshot.docs[0].id,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Family;
        setFamily(familyData);

        const familyId = familyData.id;

        // Fetch all data for the family
        const [childrenSnap, studySnap, transportSnap, partiesSnap] = await Promise.all([
          getDocs(query(collection(db, 'children'), where('familyId', '==', familyId))),
          getDocs(query(collection(db, 'studyroom'), where('familyId', '==', familyId))),
          getDocs(query(collection(db, 'transportationSubscriptions'), where('familyId', '==', familyId))),
          getDocs(query(collection(db, 'bookings'), where('familyId', '==', familyId))),
        ]);

        setChildren(childrenSnap.docs.map(d => ({ ...d.data(), id: d.id } as Child)));
        setStudySubscriptions(studySnap.docs.map(d => ({ ...d.data(), id: d.id } as StudyRoomEntry)));
        setTransportSubscriptions(transportSnap.docs.map(d => ({ ...d.data(), id: d.id } as TransportationSubscription)));
        setPartyBookings(partiesSnap.docs.map(d => ({ ...d.data(), id: d.id } as Booking)));
      }
    } catch (error) {
      console.error('Error fetching schedule data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Get events for calendar/list view
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
          childId: booking.childId,
          childName: booking.childName,
          description: `${booking.partyType} · €${booking.total.toFixed(2)}`,
        });
      } catch (e) {
        console.error('Error parsing booking date:', e);
      }
    });

    return events.sort((a, b) => a.date.getTime() - b.date.getTime());
  };

  // Weekly schedule by child
  const getWeeklySchedule = () => {
    const weeklySchedule: Record<DayOfWeek, Record<string, Array<{ type: 'study' | 'transport'; title: string; time: string; link: string }>>> = {
      monday: {},
      tuesday: {},
      wednesday: {},
      thursday: {},
      friday: {},
      saturday: {},
      sunday: {},
    };

    const normalizeDayName = (day: string): DayOfWeek | null => {
      const normalized = day.toLowerCase().trim();
      const dayMap: Record<string, DayOfWeek> = {
        'monday': 'monday', 'tuesday': 'tuesday', 'wednesday': 'wednesday',
        'thursday': 'thursday', 'friday': 'friday', 'saturday': 'saturday', 'sunday': 'sunday',
        'segunda': 'monday', 'terça': 'tuesday', 'quarta': 'wednesday',
        'quinta': 'thursday', 'sexta': 'friday', 'sábado': 'saturday', 'domingo': 'sunday',
      };
      return dayMap[normalized] || null;
    };

    studySubscriptions.forEach(sub => {
      sub.days.forEach(day => {
        const dayKey = normalizeDayName(day.day);
        if (dayKey) {
          if (!weeklySchedule[dayKey][sub.childId]) {
            weeklySchedule[dayKey][sub.childId] = [];
          }
          weeklySchedule[dayKey][sub.childId].push({
            type: 'study',
            title: sub.childName,
            time: day.hour,
            link: `/client/children/${sub.childId}/subscriptions/study/${sub.id}`,
          });
        }
      });
    });

    transportSubscriptions.forEach(sub => {
      sub.schedule?.forEach(item => {
        const dayKey = normalizeDayName(item.dayOfWeek);
        if (dayKey) {
          if (!weeklySchedule[dayKey][sub.childId]) {
            weeklySchedule[dayKey][sub.childId] = [];
          }
          weeklySchedule[dayKey][sub.childId].push({
            type: 'transport',
            title: sub.childName,
            time: item.pickupTime,
            link: `/client/children/${sub.childId}/subscriptions/transport/${sub.id}`,
          });
        }
      });
    });

    return weeklySchedule;
  };

  const scheduleEvents = getScheduleEvents();
  const weeklySchedule = getWeeklySchedule();
  const filteredEvents = selectedChildId
    ? scheduleEvents.filter(e => e.childId === selectedChildId)
    : scheduleEvents;

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'confirmed':
      case 'active':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'party': return '🎉';
      case 'study': return '📚';
      case 'transport': return '🚌';
      default: return '📅';
    }
  };

  if (isLoading) {
    return <div className="flex justify-center items-center h-64"><div className="text-gray-500">Loading...</div></div>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Family Schedule</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('family')}
            className={`px-4 py-2 rounded-lg text-sm ${viewMode === 'family' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          >
            Family View
          </button>
          <button
            onClick={() => setViewMode('child')}
            className={`px-4 py-2 rounded-lg text-sm ${viewMode === 'child' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          >
            By Child
          </button>
        </div>
      </div>

      {/* Child Filter */}
      {viewMode === 'child' && (
        <div className="mb-4 flex gap-2 flex-wrap">
          <button
            onClick={() => setSelectedChildId(null)}
            className={`px-4 py-2 rounded-lg text-sm ${!selectedChildId ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
          >
            All Children
          </button>
          {children.map(child => (
            <button
              key={child.id}
              onClick={() => setSelectedChildId(child.id)}
              className={`px-4 py-2 rounded-lg text-sm ${selectedChildId === child.id ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
            >
              {child.firstName} {child.lastName}
            </button>
          ))}
        </div>
      )}

      {/* Weekly Schedule View */}
      {viewMode === 'family' && (
        <div className="mb-8">
          <h2 className="text-xl font-bold mb-4">Weekly Recurring Schedule</h2>
          <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
            {(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as DayOfWeek[]).map(day => (
              <div key={day} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
                <h3 className="text-lg font-bold capitalize mb-3 text-center">{day}</h3>
                {Object.keys(weeklySchedule[day]).length > 0 ? (
                  <div className="space-y-2">
                    {Object.entries(weeklySchedule[day]).map(([childId, activities]) => {
                      const child = children.find(c => c.id === childId);
                      return (
                        <div key={childId} className="mb-3">
                          <p className="text-xs font-semibold text-gray-600 mb-1">
                            {child?.firstName || 'Unknown'}
                          </p>
                          {activities
                            .sort((a, b) => a.time.localeCompare(b.time))
                            .map((activity, i) => (
                              <Link
                                key={i}
                                to={activity.link}
                                className="block p-2 rounded border hover:shadow-sm transition-shadow mb-1"
                              >
                                <div className="flex items-start gap-2">
                                  <span>{activity.type === 'study' ? '📚' : '🚌'}</span>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium truncate">{activity.title}</p>
                                    <p className="text-xs text-gray-500">{activity.time}</p>
                                  </div>
                                </div>
                              </Link>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-4">No activities</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming Events */}
      <div>
        <h2 className="text-xl font-bold mb-4">
          {selectedChildId ? `Events for ${children.find(c => c.id === selectedChildId)?.firstName}` : 'All Upcoming Events'}
        </h2>
        {filteredEvents.filter(e => isFuture(e.date) || (isPast(e.date) && !isPast(addDays(e.date, 1)))).length > 0 ? (
          <div className="space-y-4">
            {filteredEvents
              .filter(e => isFuture(e.date) || (isPast(e.date) && !isPast(addDays(e.date, 1))))
              .map(event => (
                <div key={event.id} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
                  <div className="flex items-start gap-4">
                    <div className="text-3xl">{getTypeIcon(event.type)}</div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-semibold">{event.title}</h4>
                        <span className={`px-2 py-1 rounded text-xs ${getStatusColor(event.status)}`}>
                          {event.status}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600">
                        {format(event.date, 'MMMM dd, yyyy')} {event.time && `at ${event.time}`}
                      </p>
                      <p className="text-sm text-gray-500 mt-1">Child: {event.childName}</p>
                      {event.description && (
                        <p className="text-sm text-gray-600 mt-1">{event.description}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
            <p className="text-gray-500">No upcoming events scheduled.</p>
          </div>
        )}
      </div>
    </div>
  );
}

