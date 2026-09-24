
import { writeBatch, getDoc, setDoc, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { col, docRef } from '../lib/db';
import { Event } from '@shared/models/Event';
import { FinancialEvent } from '@shared/models/FinancialEvent';
import { EventModification, StudyRoomEntry, Booking, TransportationSubscription } from '@shared/models';
import { startOfMonth, endOfMonth, format, eachDayOfInterval, isSameDay, startOfDay } from 'date-fns';
import { safeDate } from '@shared/lib/dates';
import { getTransportBooking } from './transportationService';
import { centsToEuros } from '@shared/lib/money';
import { employeeService } from './employeeService';

// ── School calendar config ────────────────────────────────────────────────────

export interface SchoolCalendarConfig {
  yearEndDate: string; // 'YYYY-MM-DD'
}

const SCHOOL_CAL_DOC = docRef('config', 'schoolCalendar');

export const schoolCalendarService = {
  async get(): Promise<SchoolCalendarConfig | null> {
    const snap = await getDoc(SCHOOL_CAL_DOC);
    return snap.exists() ? (snap.data() as SchoolCalendarConfig) : null;
  },
  async save(cfg: SchoolCalendarConfig): Promise<void> {
    await setDoc(SCHOOL_CAL_DOC, cfg);
  },
};

//<editor-fold desc="Data Fetching">
// "confirmed" is the legacy spelling of "active" for study room (see
// normalizeStatus in @shared/models/StudyRoomEntry) — both mean an enrolled,
// billable subscription. Querying only 'confirmed' silently dropped every
// study-room sub stored as 'active' from event AND income generation, while
// the calendar query below already included both. That mismatch meant a
// subscription could appear on the calendar and contribute nothing to the
// financial summary. Transport has no equivalent split — it only ever uses
// 'active'.
const getConfirmedStudyRoomEntries = async () => {
  const studyRoomQuery = query(col('studyroom'), where('status', 'in', ['confirmed', 'active']));
  const snapshot = await getDocs(studyRoomQuery);
  return snapshot.docs.map(doc => ({ ...doc.data() as StudyRoomEntry, id: doc.id }));
};

const getStudyRoomEntriesForCalendar = async () => {
  const snapshot = await getDocs(query(
    col('studyroom'),
    where('status', 'in', ['confirmed', 'active', 'pending']),
  ));
  return snapshot.docs.map(doc => ({ ...doc.data() as StudyRoomEntry, id: doc.id }));
};

const getConfirmedPartyBookings = async (month: Date) => {
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const partyQuery = query(
    col('bookings'),
    where('status', '==', 'confirmed'),
    where('date', '>=', format(start, 'yyyy-MM-dd')),
    where('date', '<=', format(end, 'yyyy-MM-dd'))
  );
  const snapshot = await getDocs(partyQuery);
  return snapshot.docs.map(doc => ({ ...doc.data() as Booking, id: doc.id }));
};

const getActiveTransportSubscriptions = async () => {
  const transportSubQuery = query(col('transportationSubscriptions'), where('status', '==', 'active'));
  const snapshot = await getDocs(transportSubQuery);
  return snapshot.docs.map(doc => ({ ...doc.data() as TransportationSubscription, id: doc.id }));
};

const getTransportSubscriptionsForCalendar = async () => {
  const snapshot = await getDocs(query(
    col('transportationSubscriptions'),
    where('status', 'in', ['active', 'pending']),
  ));
  return snapshot.docs.map(doc => ({ ...doc.data() as TransportationSubscription, id: doc.id }));
};

const getEmployeesWithContracts = async () => {
  const employees = await employeeService.getEmployees();
  const driver = employees.find(e => e.roles.driver);
  const teacher = employees.find(e => e.roles.teacher);

  let driverHourlyRate = 7;
  if (driver) {
    const contract = await employeeService.getEmployeeContract(driver.uid);
    if (contract && contract.hourlyRateCents) {
      driverHourlyRate = centsToEuros(contract.hourlyRateCents);
    }
  }

  let teacherHourlyRate = 6;
  if (teacher) {
    const contract = await employeeService.getEmployeeContract(teacher.uid);
    if (contract && contract.hourlyRateCents) {
      teacherHourlyRate = centsToEuros(contract.hourlyRateCents);
    }
  }

  return { driver, teacher, driverHourlyRate, teacherHourlyRate };
};

const getApprovedCancellations = async (month: Date): Promise<EventModification[]> => {
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  
  // Fetch all approved cancellations
  const cancellationsQuery = query(
    col('eventModifications'),
    where('modificationType', '==', 'cancelled'),
    where('status', '==', 'approved')
  );
  const cancellationsSnap = await getDocs(cancellationsQuery);
  
  const allCancellations = cancellationsSnap.docs.map(doc => {
    const data = doc.data();
    return {
      ...data,
      id: doc.id,
      date: data.date?.toDate?.() || new Date(data.date),
      createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
      updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
    } as EventModification;
  });
  
  // Filter by month (client-side since Firestore date queries are complex)
  return allCancellations.filter(mod => {
    const modDate = mod.date instanceof Date ? mod.date : new Date(mod.date);
    return modDate >= start && modDate <= end;
  });
};

/**
 * Check if a service event should be skipped due to an approved cancellation
 */
const shouldSkipEvent = (
  eventId: string,
  subscriptionId: string,
  subscriptionType: 'study' | 'transport',
  date: Date,
  cancellations: EventModification[]
): boolean => {
  return cancellations.some(cancellation => {
    const cancellationDate = cancellation.date instanceof Date ? cancellation.date : new Date(cancellation.date);
    return (
      // Match by eventId (if the event was already created and cancelled)
      (cancellation.eventId === eventId) ||
      // Or match by subscription + date + type (for events that haven't been created yet)
      (
        cancellation.subscriptionId === subscriptionId &&
        cancellation.subscriptionType === subscriptionType &&
        isSameDay(cancellationDate, date)
      )
    );
  });
};
//</editor-fold>

//<editor-fold desc="Generic Event Generators">

const generateFinancialEvents = (batch: any, items: any[], mapper: (item: any) => { id: string, event: Partial<FinancialEvent> }[] | { id: string, event: Partial<FinancialEvent> } | null) => {
  items.forEach(item => {
    const result = mapper(item);
    if (result) {
      const events = Array.isArray(result) ? result : [result];
      events.forEach(({ id, event }) => {
        const eventData: FinancialEvent = {
          id,
          label: '',
          amount: 0,
          type: 'income',
          currency: 'EUR',
          date: new Timestamp(0, 0),
          accountId: '',
          createdBy: 'system',
          effective: false,
          createdAt: new Date(),
          eventKind: 'planned',
          ...event,
        };
        batch.set(docRef('financialEvents', id), eventData, { merge: true });
      });
    }
  });
};

// Event Sourcing: Events are immutable. Only create if doesn't exist.
// We check existence before calling this, so we use set() instead of merge()
const createCalendarEvent = (batch: any, id: string, data: Omit<Event, 'id'>) => {
  // Use set() to create new event (immutable fact)
  // We only call this if event doesn't exist (checked before)
  batch.set(docRef('events', id), { ...data, id });
};

const createFinancialEvent = (batch: any, id: string, event: Partial<FinancialEvent>) => {
  const eventData: FinancialEvent = {
    id,
    label: '',
    amount: 0,
    type: 'income',
    currency: 'EUR',
    date: new Timestamp(0, 0),
    accountId: '',
    createdBy: 'system',
    effective: false,
    createdAt: new Date(),
    eventKind: 'planned',
    ...event,
  };
  batch.set(docRef('financialEvents', id), eventData, { merge: true });
};

//</editor-fold>

//<editor-fold desc="Mappers">

const studyRoomIncomeMapper = (month: Date) => (entry: StudyRoomEntry) => {
  const startDate = startOfMonth(month);
  const endDate = endOfMonth(month);
  const year = month.getFullYear();
  const monthNumber = month.getMonth();

  const entryStartDate = safeDate(entry.startDate);
  const entryEndDate = safeDate(entry.endDate);

  if (entryStartDate <= endDate && entryEndDate >= startDate) {
    const events = [];

    const studyEvent = {
      id: `studyroom-${entry.id}-${year}-${monthNumber}`,
      event: {
        label: `Mensalidade Sala de Estudo - ${entry.childName}`,
        amount: entry.basePrice,
        date: Timestamp.fromDate(startDate),
        category: 'Sala de Estudo',
      },
    };
    events.push(studyEvent);

    if (entry.transportFee) {
      const transportEvent = {
        id: `transport_study-${entry.id}-${year}-${monthNumber}`,
        event: {
          label: `Transporte (Estudo) - ${entry.childName}`,
          amount: entry.transportFee,
          date: Timestamp.fromDate(startDate),
          category: 'Transporte (Estudo)',
        },
      };
      events.push(transportEvent);
    }
    return events;
  }
  return null;
};

const transportSubIncomeMapper = (month: Date) => (sub: TransportationSubscription) => {
  const startDate = startOfMonth(month);
  const endDate = endOfMonth(month);
  const year = month.getFullYear();
  const monthNumber = month.getMonth();

  const subStartDate = safeDate(sub.startDate);
  const subEndDate = sub.endDate ? safeDate(sub.endDate) : null;

  if (subStartDate <= endDate && (!subEndDate || subEndDate >= startDate)) {
    return {
      id: `transport_sub-${sub.id}-${year}-${monthNumber}`,
      event: {
        label: `Mensalidade Transporte - ${sub.childName}`,
        amount: sub.monthlyFee,
        date: Timestamp.fromDate(startDate),
        category: 'Transporte (Subscrição)',
      },
    };
  }
  return null;
};

const partyBookingIncomeMapper = (month: Date) => (booking: Booking) => {
  const startDate = startOfMonth(month);
  const endDate = endOfMonth(month);
  const bookingDate = safeDate(booking.date);

  if (bookingDate >= startDate && bookingDate <= endDate) {
    return {
      id: `booking-${booking.id}`,
      event: {
        label: `Festa de Aniversário - ${booking.childName}`,
        amount: booking.total,
        date: Timestamp.fromDate(bookingDate),
        category: 'Festas',
      },
    };
  }
  return null;
};

//</editor-fold>

//<editor-fold desc="Main Service">

export const eventService = {
  async getEvents(month: Date): Promise<Event[]> {
    const start = startOfMonth(month);
    const end = endOfMonth(month);

    // 1. Fetch regular calendar events
    const eventsQuery = query(
      col('events'),
      where('start', '>=', Timestamp.fromDate(start)),
      where('start', '<=', Timestamp.fromDate(end))
    );
    const eventsSnap = await getDocs(eventsQuery);
    
    // 2. Fetch cancellations to check against events
    const cancellations = await getApprovedCancellations(month);
    
    const eventList: Promise<Event>[] = eventsSnap.docs.map(async (doc) => {
      const event = { id: doc.id, ...doc.data() } as Event;
      let booking = null;
      if (event.type === 'transport' && event.bookingId && event.transportType) {
        booking = await getTransportBooking(event.bookingId, event.transportType);
      }
      return { ...event, booking };
    });

    // 3. Event Sourcing: Reconstruct state by applying all events and cancellations
    const resolvedEvents = await Promise.all(eventList);
    
    // Filter out any old events with status='canceled' (legacy from before Event Sourcing fix)
    // Event Sourcing: cancellation is determined by EventModifications, not by event.status
    const allEvents = resolvedEvents.filter(event => event.status !== 'canceled');
    
    // Fetch EventModifications to get creation timestamps for ordering
    const eventModificationsQuery = query(
      col('eventModifications'),
      where('date', '>=', Timestamp.fromDate(start)),
      where('date', '<=', Timestamp.fromDate(end)),
      where('status', '==', 'approved')
    );
    const modificationsSnap = await getDocs(eventModificationsQuery);
    const allModifications = modificationsSnap.docs.map(doc => ({
      ...doc.data(),
      id: doc.id,
      createdAt: doc.data().createdAt?.toDate?.() || new Date(doc.data().createdAt),
    } as EventModification));
    
    // Event Sourcing: Apply cancellations to reconstruct final state
    // Each event is checked against cancellations - if cancelled, mark it
    // Also attach grouping key and creation time for stacking
    const eventsWithState = allEvents.map(event => {
      const eventDate = event.start.toDate();
      const matchingCancellation = cancellations.find(cancellation => {
        const cancellationDate = cancellation.date instanceof Date ? cancellation.date : new Date(cancellation.date);
        return (
          (cancellation.eventId === event.id ||
           (cancellation.subscriptionId === event.bookingId &&
            cancellation.subscriptionType === event.type &&
            isSameDay(cancellationDate, eventDate))) &&
          cancellation.modificationType === 'cancelled' &&
          cancellation.status === 'approved' &&
          isSameDay(cancellationDate, eventDate)
        );
      });
      
      // Get creation timestamp for ordering (latest on top)
      // Event Sourcing: Cancellations are events that happen AFTER the original event
      // So cancelled events should appear on top (they represent the latest state)
      let createdAt: Date;
      if (matchingCancellation) {
        // This event is cancelled - use EventModification creation time (latest state)
        const mod = allModifications.find(m => 
          (m.eventId === event.id && m.modificationType === 'cancelled') ||
          (m.subscriptionId === event.bookingId && 
           m.subscriptionType === event.type &&
           isSameDay(m.date instanceof Date ? m.date : new Date(m.date), eventDate) &&
           m.modificationType === 'cancelled')
        );
        createdAt = mod?.createdAt || new Date();
      } else {
        // This event is not cancelled - it's the original event
        // Use start of month as baseline (older than cancellations)
        createdAt = start;
      }
      
      const dateKey = format(eventDate, 'yyyy-MM-dd');
      const groupKey = `${event.bookingId}_${event.type}_${dateKey}`;
      
      return {
        ...event,
        isCancelled: !!matchingCancellation,
        groupKey, // For grouping events that represent the same logical occurrence
        createdAt, // For sorting within group (latest on top)
        cancellationReason: matchingCancellation?.reason,
      };
    });
    
    // Sort by groupKey, then by createdAt (descending - latest first)
    eventsWithState.sort((a, b) => {
      if (a.groupKey !== b.groupKey) {
        return a.groupKey.localeCompare(b.groupKey);
      }
      // Within same group, latest first
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    
    const eventsWithCancellationInfo = eventsWithState;

    // 4. Fetch planned financial events
    let financialEventList: Event[] = [];
    try {
      const financialEventsQuery = query(
        col('financialEvents'),
        where('eventKind', '==', 'planned'),
        where('date', '>=', Timestamp.fromDate(start)),
        where('date', '<=', Timestamp.fromDate(end))
      );
      const financialEventsSnap = await getDocs(financialEventsQuery);
      financialEventList = financialEventsSnap.docs.map((doc) => {
        const fe = doc.data() as FinancialEvent;
        return {
          id: fe.id,
          title: `${fe.label} - €${fe.amount.toFixed(2)}`,
          amount: fe.amount,
          start: fe.date,
          end: fe.date,
          type: 'financial',
          status: 'confirmed',
          bookingId: fe.id,
          accountId: fe.accountId,
        };
      });
    } catch (err) {
      console.error('[Calendar] failed to fetch financial events:', err);
    }

    // 5. Fetch party bookings directly (pending + confirmed) — no need to generate
    // Use a full collection read (no where clauses) to avoid Firestore rules evaluation
    // issues with range queries, then filter client-side.
    let partyEvents: Event[] = [];
    try {
      const partySnap = await getDocs(col('bookings'));
      const startStr = format(start, 'yyyy-MM-dd');
      const endStr   = format(end,   'yyyy-MM-dd');
      partyEvents = partySnap.docs
        .map(d => ({ id: d.id, ...d.data() } as Booking & { id: string }))
        .filter(b => b.status !== 'rejected' && b.date >= startStr && b.date <= endStr)
        .map(b => {
          const bookingDate = new Date(`${b.date}T${b.time || '10:00'}`);
          return {
            id: `party_${b.id}`,
            title: `Festa — ${b.childName}`,
            start: Timestamp.fromDate(bookingDate),
            end: Timestamp.fromDate(new Date(bookingDate.getTime() + 2 * 60 * 60 * 1000)),
            type: 'party',
            bookingId: b.id,
            status: b.status,
            booking: b,
          } as unknown as Event;
        });
    } catch (err) {
      console.error('[Calendar] failed to fetch party bookings:', err);
    }

    // 6. Compute study & transport events live from subscriptions (no "Generate Events" needed)
    let computedStudyEvents: Event[] = [];
    let computedTransportEvents: Event[] = [];
    try {
      const [studyEntries, transportSubs, schoolCal] = await Promise.all([
        getStudyRoomEntriesForCalendar(),
        getTransportSubscriptionsForCalendar(),
        schoolCalendarService.get(),
      ]);

      // Hard cap: school year end date (null = no cap)
      const schoolYearEnd: Date | null = schoolCal?.yearEndDate
        ? new Date(`${schoolCal.yearEndDate}T23:59:59`)
        : null;

      const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

      // Cancellation state comes from reservationEvents — the collection the
      // billing pipeline and every client cancel path actually write to.
      // shouldSkipEvent() below still reads eventModifications, which nothing
      // writes any more, so on its own the calendar would show every day as
      // not-cancelled no matter what staff or parents had marked.
      const resEventsSnap = await getDocs(query(
        col('reservationEvents'),
        where('date', '>=', format(start, 'yyyy-MM-dd')),
        where('date', '<=', format(end, 'yyyy-MM-dd')),
      ));
      const resByKey = new Map<string, { id: string; status: string }>();
      resEventsSnap.docs.forEach(d => {
        const x = d.data() as any;
        const key = x.subscriptionType === 'transport'
          ? `${x.subscriptionId}_${x.date}_${x.legIndex ?? 0}`
          : `${x.subscriptionId}_${x.date}`;
        resByKey.set(key, { id: d.id, status: x.status });
      });
      const resolveRes = (key: string, fallback: boolean) => {
        const ev = resByKey.get(key);
        if (!ev) return { isCancelled: fallback, voided: false, reservationEventId: undefined as string | undefined };
        return { isCancelled: ev.status === 'CANCELLED', voided: ev.status === 'VOIDED', reservationEventId: ev.id };
      };

      for (const day of eachDayOfInterval({ start, end })) {
        const dayName = DAY_NAMES[day.getDay()];
        const dateStr = format(day, 'yyyy-MM-dd');

        for (const entry of studyEntries) {
          // Trust 'confirmed' status for liveness. School year end is the primary cap.
          // Individual endDate only applies when it's EARLIER than the school year end
          // (i.e. a mid-year cancellation), not when it's a stale value from a past year.
          const rawEnd = entry.endDate ? safeDate(entry.endDate) : null;
          const entryEnd = schoolYearEnd
            ? (rawEnd && rawEnd < schoolYearEnd ? rawEnd : schoolYearEnd)
            : rawEnd;
          if (entryEnd && day > entryEnd) continue;

          for (const daySel of entry.days) {
            if (daySel.day !== dayName) continue;
            const eventId = `study_${entry.id}_${dateStr}`;
            const res = resolveRes(`${entry.id}_${dateStr}`, shouldSkipEvent(eventId, entry.id, 'study', day, cancellations));
            if (res.voided) continue; // subscription no longer covers this date
            const isCancelled = res.isCancelled;
            const startDt = new Date(`${dateStr}T${daySel.hour}`);
            computedStudyEvents.push({
              id: eventId,
              title: entry.childName,
              start: Timestamp.fromDate(startDt),
              end: Timestamp.fromDate(new Date(startDt.getTime() + 5 * 60 * 60 * 1000)),
              type: 'study',
              bookingId: entry.id,
              status: entry.status === 'active' ? 'confirmed' : 'pending',
              isCancelled,
              booking: {
                childName: entry.childName,
                schoolName: entry.schoolName,
                hasTransport: daySel.transport,
                subscriptionId: entry.id,
                subscriptionType: 'study',
              },
            } as unknown as Event);
          }
        }

        for (const sub of transportSubs) {
          // safeDate() returns NOW for a missing date, and `day` is midnight,
          // so a subscription with no startDate (19 of 23 active ones) had
          // today and every past day skipped — transport simply vanished from
          // the calendar. A missing startDate means "no start restriction",
          // not "starts this instant".
          const subStart = sub.startDate ? startOfDay(safeDate(sub.startDate)) : null;
          const rawSubEnd = sub.endDate ? safeDate(sub.endDate) : null;
          const subEnd = rawSubEnd && schoolYearEnd
            ? (rawSubEnd < schoolYearEnd ? rawSubEnd : schoolYearEnd)
            : (rawSubEnd ?? schoolYearEnd);
          if ((subStart && day < subStart) || (subEnd && day > subEnd)) continue;

          for (const [legIndex, sched] of (sub.schedule || []).entries()) {
            if (sched.dayOfWeek !== dayName) continue;
            const eventId = `transport_sub_${sub.id}_${dateStr}_${sched.pickupTime.replace(':', '')}`;
            const res = resolveRes(`${sub.id}_${dateStr}_${legIndex}`, shouldSkipEvent(eventId, sub.id, 'transport', day, cancellations));
            if (res.voided) continue; // subscription no longer covers this date
            const isCancelled = res.isCancelled;
            const startDt = new Date(`${dateStr}T${sched.pickupTime}`);
            computedTransportEvents.push({
              id: eventId,
              title: sub.childName,
              start: Timestamp.fromDate(startDt),
              end: Timestamp.fromDate(startDt),
              type: 'transport',
              bookingId: sub.id,
              status: sub.status === 'active' ? 'confirmed' : 'pending',
              isCancelled,
              booking: {
                childName: sub.childName,
                pickupTime: sched.pickupTime,
                pickupLocation: sched.pickupLocation,
                dropoffLocation: sched.dropoffLocation,
                subscriptionId: sub.id,
                subscriptionType: 'transport',
                // Needed to resolve the matching ReservationEvent doc, whose id
                // is keyed by (date, legIndex) — see reservationEvents.ts.
                direction: sched.direction ?? 'both',
                legIndex,
              },
            } as unknown as Event);
          }
        }
      }
    } catch (err) {
      console.error('[Calendar] failed to compute subscription events:', err);
    }

    // Keep only non-subscription, non-party events from the events collection
    // (study/transport computed live; party comes from bookings collection)
    const coreEvents = eventsWithCancellationInfo.filter(
      e => e.type !== 'study' && e.type !== 'transport' && e.type !== 'party'
    );

    return [
      ...coreEvents,
      ...computedStudyEvents,
      ...computedTransportEvents,
      ...partyEvents,
      ...financialEventList,
    ] as unknown as Event[];
  },

  async generateEvents(month: Date): Promise<number> {
    const batch = writeBatch(db);
    let eventCount = 0;

    const [studyRoomEntries, partyBookings, transportSubscriptions, { driver, teacher, driverHourlyRate, teacherHourlyRate }, cancellations, existingEvents] = await Promise.all([
      getConfirmedStudyRoomEntries(),
      getConfirmedPartyBookings(month),
      getActiveTransportSubscriptions(),
      getEmployeesWithContracts(),
      getApprovedCancellations(month),
      // Event Sourcing: Fetch existing events to avoid duplicates (preserve history)
      (async () => {
        const start = startOfMonth(month);
        const end = endOfMonth(month);
        const eventsQuery = query(
          col('events'),
          where('start', '>=', Timestamp.fromDate(start)),
          where('start', '<=', Timestamp.fromDate(end))
        );
        const eventsSnap = await getDocs(eventsQuery);
        const eventsMap = new Map<string, Event>();
        eventsSnap.docs.forEach(doc => {
          const event = { ...doc.data(), id: doc.id } as Event;
          eventsMap.set(doc.id, event);
        });
        return {
          ids: new Set(eventsMap.keys()),
          events: eventsMap
        };
      })(),
    ]);

    // Generate financial events (income) - these are always generated regardless of cancellations
    // because they represent subscription fees, not individual event fees
    generateFinancialEvents(batch, studyRoomEntries, studyRoomIncomeMapper(month));
    generateFinancialEvents(batch, transportSubscriptions, transportSubIncomeMapper(month));
    generateFinancialEvents(batch, partyBookings, partyBookingIncomeMapper(month));

    const daysOfMonth = eachDayOfInterval({ start: startOfMonth(month), end: endOfMonth(month) });

    for (const day of daysOfMonth) {
      const dateString = format(day, 'yyyy-MM-dd');
      const dayOfWeek = format(day, 'eeee').toLowerCase();

      const dailyStudyEvents: Event[] = [];
      const dailyTransportEvents: Event[] = [];

      studyRoomEntries.forEach(entry => {
        entry.days.forEach(daySelection => {
          if (daySelection.day === dayOfWeek && dayOfWeek !== 'saturday' && dayOfWeek !== 'sunday') {
            const studyEventId = `study_${entry.id}_${dateString}`;
            
            // Event Sourcing: Check if event already exists (immutable - never recreate)
            const eventExists = existingEvents.ids.has(studyEventId);
            const existingEvent = existingEvents.events.get(studyEventId);
            
            // Check if this event is cancelled
            const isCancelled = shouldSkipEvent(studyEventId, entry.id, 'study', day, cancellations);
            
            // Only create if: doesn't exist AND not cancelled
            if (!eventExists && !isCancelled) {
            const studyEvent: Omit<Event, 'id'> = {
              title: `Sala de Estudo - ${entry.childName}`,
              start: Timestamp.fromDate(new Date(`${dateString}T${daySelection.hour}`)),
              end: Timestamp.fromDate(new Date(`${dateString}T19:00`)), // Assuming a fixed end time
              type: 'study',
              bookingId: entry.id,
              status: 'confirmed',
            };
            createCalendarEvent(batch, studyEventId, studyEvent);
            dailyStudyEvents.push({ ...studyEvent, id: studyEventId });
            eventCount++;
            } else if (eventExists && !isCancelled && existingEvent) {
              // Event exists and not cancelled - include it for expense calculation
              // Don't recreate (preserve original event - Event Sourcing)
              dailyStudyEvents.push(existingEvent);
            }
            // If cancelled: preserve existing event (if exists), don't create new one

            if (daySelection.transport) {
              const transportEventId = `transport_study_${entry.id}_${dateString}`;
              
              // Event Sourcing: Check if event already exists
              const eventExists = existingEvents.ids.has(transportEventId);
              const existingEvent = existingEvents.events.get(transportEventId);
              
              // Check if this transport event is cancelled
              const isCancelled = shouldSkipEvent(transportEventId, entry.id, 'transport', day, cancellations);
              
              // Only create if: doesn't exist AND not cancelled
              if (!eventExists && !isCancelled) {
                const transportEvent: Omit<Event, 'id'> = {
                  title: `Transporte (Estudo) - ${entry.childName}`,
                  start: Timestamp.fromDate(new Date(`${dateString}T${daySelection.hour}`)), // Adjust time as needed
                  end: Timestamp.fromDate(new Date(`${dateString}T${daySelection.hour}`)), // Adjust time as needed
                  type: 'transport',
                  transportType: 'study',
                  bookingId: entry.id,
                  status: 'confirmed',
                };
                createCalendarEvent(batch, transportEventId, transportEvent);
                dailyTransportEvents.push({ ...transportEvent, id: transportEventId });
                eventCount++;
              } else if (eventExists && !isCancelled && existingEvent) {
                // Event exists and not cancelled - include for expense calculation
                // Don't recreate (preserve original event - Event Sourcing)
                dailyTransportEvents.push(existingEvent);
              }
              // If cancelled: preserve existing event (if exists), don't create new one
            }
          }
        });
      });

      partyBookings.forEach(booking => {
        const bookingDate = safeDate(booking.date);
        if (format(bookingDate, 'yyyy-MM-dd') === dateString) {
          const eventId = `party_${booking.id}`;
          
          // Event Sourcing: Check if event already exists
          const eventExists = existingEvents.ids.has(eventId);
          
          // Only create if doesn't exist (preserve history)
          if (!eventExists) {
          const newEvent: Omit<Event, 'id'> = {
            title: `Festa - ${booking.childName}`,
            start: Timestamp.fromDate(new Date(`${booking.date}T${booking.time}`)),
            end: Timestamp.fromDate(new Date(new Date(`${booking.date}T${booking.time}`).getTime() + 2 * 60 * 60 * 1000)),
            type: 'party',
            bookingId: booking.id,
            status: 'confirmed',
          };
          createCalendarEvent(batch, eventId, newEvent);
          eventCount++;
          }
          // If exists: preserve original event (immutable)
        }
      });

      transportSubscriptions.forEach(sub => {
        const subStartDate = safeDate(sub.startDate);
        const subEndDate = sub.endDate ? safeDate(sub.endDate) : endOfMonth(day);

        if (day >= subStartDate && day <= subEndDate) {
          (sub.schedule || []).forEach(schedule => {
            if (schedule.dayOfWeek === dayOfWeek && dayOfWeek !== 'saturday' && dayOfWeek !== 'sunday') {
              const eventId = `transport_sub_${sub.id}_${dateString}_${schedule.pickupTime.replace(':', '')}`;
              
              // Event Sourcing: Check if event already exists
              const eventExists = existingEvents.ids.has(eventId);
              const existingEvent = existingEvents.events.get(eventId);
              
              // Check if this transport event is cancelled
              const isCancelled = shouldSkipEvent(eventId, sub.id, 'transport', day, cancellations);
              
              // Only create if: doesn't exist AND not cancelled
              if (!eventExists && !isCancelled) {
                const event: Omit<Event, 'id'> = {
                  title: `Transporte - ${sub.childName}`,
                  start: Timestamp.fromDate(new Date(`${dateString}T${schedule.pickupTime}`)),
                  end: Timestamp.fromDate(new Date(`${dateString}T${schedule.pickupTime}`)), // Adjust end time as needed
                  type: 'transport',
                  transportType: 'subscription',
                  bookingId: sub.id,
                  status: 'confirmed',
                };
                createCalendarEvent(batch, eventId, event);
                dailyTransportEvents.push({ ...event, id: eventId });
                eventCount++;
              } else if (eventExists && !isCancelled && existingEvent) {
                // Event exists and not cancelled - include for expense calculation
                // Don't recreate (preserve original event - Event Sourcing)
                dailyTransportEvents.push(existingEvent);
              }
              // If cancelled: preserve existing event (if exists), don't create new one
            }
          });
        }
      });

      if (dailyTransportEvents.length > 0) {
        const forecastEventId = `forecast_expense_${dateString}`;
        const startTime = new Date(Math.min(...dailyTransportEvents.map(e => (e.start as Timestamp).toDate().getTime())));
        const endTime = new Date(Math.max(...dailyTransportEvents.map(e => (e.end as Timestamp).toDate().getTime())));
        const totalHours = Math.max(1, (endTime.getTime() - startTime.getTime()) / 3600000);

        const eventPayload: Partial<FinancialEvent> = {
          label: `Driver Wage for ${dateString}`,
          amount: driverHourlyRate * totalHours,
          type: 'expense',
          date: Timestamp.fromDate(day),
          accountId: 'driver-wage',
          startTime: Timestamp.fromDate(startTime),
          endTime: Timestamp.fromDate(endTime),
          totalHours,
        };

        if (driver) {
          eventPayload.workerId = driver.uid;
          eventPayload.workerName = `${driver.name} ${driver.name}`;
        }

        createFinancialEvent(batch, forecastEventId, eventPayload);
        eventCount++;
      }

      if (dailyStudyEvents.length > 0) {
        const forecastEventId = `forecast_teacher_wage_${dateString}`;

        const studyRoomTransportEvents = dailyTransportEvents.filter(e => e.transportType === 'study');
        const allTeacherEvents = [...dailyStudyEvents, ...studyRoomTransportEvents];

        const startTime = new Date(Math.min(...allTeacherEvents.map(e => (e.start as Timestamp).toDate().getTime())));
        const endTime = new Date(Math.max(...dailyStudyEvents.map(e => (e.end as Timestamp).toDate().getTime())));
        const totalHours = Math.max(1, (endTime.getTime() - startTime.getTime()) / 3600000);

        const eventPayload: Partial<FinancialEvent> = {
          label: `Teacher Wage for ${dateString}`,
          amount: teacherHourlyRate * totalHours,
          type: 'expense',
          date: Timestamp.fromDate(day),
          accountId: 'teacher-wage',
          startTime: Timestamp.fromDate(startTime),
          endTime: Timestamp.fromDate(endTime),
          totalHours,
        };

        if (teacher) {
          eventPayload.workerId = teacher.uid;
          eventPayload.workerName = `${teacher.name} ${teacher.name}`;
        }

        createFinancialEvent(batch, forecastEventId, eventPayload);
        eventCount++;
      }
    }

    await batch.commit();
    return eventCount;
  },
};
//</editor-fold>
