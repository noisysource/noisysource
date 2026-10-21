import { getDocs, getDoc, setDoc, updateDoc, addDoc, query, where } from 'firebase/firestore';
import { col, docRef } from '../lib/db';
import { Booking, PartyConfig } from '@shared/models';
import { safeDate } from '@shared/lib/dates';

type Status = "pending" | "confirmed" | "rejected";

export const partyService = {
  async getBookings(): Promise<Booking[]> {
    const bookingsSnap = await getDocs(col("bookings"));
    const list: Booking[] = bookingsSnap.docs.map((d) => {
      const x: any = d.data();
      const s: Status = (x.status as Status) ?? "pending";

      return {
        id: d.id,
        familyId: String(x.familyId ?? ""),
        childId: String(x.childId ?? ""),
        parentName: String(x.parentName ?? ""),
        email: String(x.email ?? ""),
        phone: String(x.phone ?? ""),
        childName: String(x.childName ?? ""),
        childAge: Number(x.childAge ?? 0),
        partyType: String(x.partyType ?? ""),
        date: String(x.date ?? ""),
        time: String(x.time ?? ""),
        numKids: Number(x.numKids ?? 0),
        extras: x.extras || [],
        extrasDetail: x.extrasDetail || {},
        total: Number(x.total ?? 0),
        createdAt: safeDate(x.createdAt),
        status: s,
        statusReason: x.statusReason ? String(x.statusReason) : undefined,
        statusHistory: x.statusHistory || [],
        // Only when present: the admin edit saves the whole object back.
        ...(x.source ? { source: String(x.source) } : {}),
        ...(x.notes ? { notes: String(x.notes) } : {}),
      };
    });
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list;
  },

  async getPartyConfig(): Promise<PartyConfig> {
    const snap = await getDoc(docRef('config', 'party'));
    if (snap.exists()) {
      return snap.data() as PartyConfig;
    }
    return {
      partyTypes: [],
      extras: [],
    };
  },

  async savePartyConfig(config: PartyConfig): Promise<void> {
    await setDoc(docRef('config', 'party'), config);
  },

  /**
   * Confirming creates the deposit bill and emails the parent; rejecting emails
   * the parent `reason` (functions: onPartyBookingStatusNotify). The reason goes
   * in the same write so the trigger sees it.
   */
  async updateBookingStatus(id: string, status: Status, reason?: string): Promise<void> {
    await updateDoc(docRef('bookings', id), reason ? { status, statusReason: reason } : { status });
  },

  async updateBooking(booking: Booking): Promise<void> {
    await updateDoc(docRef('bookings', booking.id), { ...booking });
  },

  async createBooking(booking: Omit<Booking, 'id'>): Promise<void> {
    await addDoc(col('bookings'), booking);
  },

  async getBookingsByFamily(familyId: string, userId?: string): Promise<Booking[]> {
    const q = userId
      ? query(col('bookings'), where('userId', '==', userId))
      : query(col('bookings'), where('familyId', '==', familyId));
    const snap = await getDocs(q);
    const list: Booking[] = snap.docs.map((d) => {
      const x: any = d.data();
      return {
        id: d.id,
        familyId: String(x.familyId ?? ''),
        childId: String(x.childId ?? ''),
        parentName: String(x.parentName ?? ''),
        email: String(x.email ?? ''),
        phone: String(x.phone ?? ''),
        childName: String(x.childName ?? ''),
        childAge: Number(x.childAge ?? 0),
        partyType: String(x.partyType ?? ''),
        date: String(x.date ?? ''),
        time: String(x.time ?? ''),
        numKids: Number(x.numKids ?? 0),
        extras: x.extras || [],
        extrasDetail: x.extrasDetail || {},
        total: Number(x.total ?? 0),
        createdAt: x.createdAt?.toDate?.() ?? new Date(),
        status: (x.status as Status) ?? 'pending',
        statusReason: x.statusReason ?? undefined,
        statusHistory: x.statusHistory || [],
      };
    });
    return list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  },

  async getBookingById(id: string): Promise<Booking | null> {
    const snap = await getDoc(docRef('bookings', id));
    if (!snap.exists()) return null;
    const x: any = snap.data();
    return {
      id: snap.id,
      familyId: String(x.familyId ?? ''),
      childId: String(x.childId ?? ''),
      parentName: String(x.parentName ?? ''),
      email: String(x.email ?? ''),
      phone: String(x.phone ?? ''),
      childName: String(x.childName ?? ''),
      childAge: Number(x.childAge ?? 0),
      partyType: String(x.partyType ?? ''),
      date: String(x.date ?? ''),
      time: String(x.time ?? ''),
      numKids: Number(x.numKids ?? 0),
      extras: x.extras || [],
      extrasDetail: x.extrasDetail || {},
      total: Number(x.total ?? 0),
      createdAt: x.createdAt?.toDate?.() ?? new Date(),
      status: (x.status as Status) ?? 'pending',
      statusReason: x.statusReason ?? undefined,
      statusHistory: x.statusHistory || [],
    };
  },
};