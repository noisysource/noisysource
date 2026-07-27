import { getDocs, collection, doc, getDoc, setDoc, updateDoc, addDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Booking, PartyConfig } from '@shared/models';
import { safeDate } from '@shared/lib/dates';

type Status = "pending" | "confirmed" | "rejected";

export const partyService = {
  async getBookings(): Promise<Booking[]> {
    const bookingsSnap = await getDocs(collection(db, "bookings"));
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
      };
    });
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list;
  },

  async getPartyConfig(): Promise<PartyConfig> {
    const snap = await getDoc(doc(db, 'config', 'party'));
    if (snap.exists()) {
      return snap.data() as PartyConfig;
    }
    return {
      partyTypes: [],
      extras: [],
    };
  },

  async savePartyConfig(config: PartyConfig): Promise<void> {
    await setDoc(doc(db, 'config', 'party'), config);
  },

  async updateBookingStatus(id: string, status: Status): Promise<void> {
    await updateDoc(doc(db, 'bookings', id), { status });
  },

  async updateBooking(booking: Booking): Promise<void> {
    await updateDoc(doc(db, "bookings", booking.id), { ...booking });
  },

  async createBooking(booking: Omit<Booking, 'id'>): Promise<void> {
    await addDoc(collection(db, 'bookings'), booking);
  },
};