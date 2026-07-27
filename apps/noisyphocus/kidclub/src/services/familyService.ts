import { collection, getDocs, query, where, doc, getDoc, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Family, Child, StudyRoomEntry, TransportationSubscription, Booking } from '@shared/models';
import { calculateAge } from '../lib/utils';

const toDate = (value: any): Date =>
  value?.toDate?.() ?? new Date(value);

const mapChild = (id: string, data: any): Child => ({
  ...data,
  id,
  dateOfBirth: toDate(data.dateOfBirth),
  createdAt: toDate(data.createdAt),
  updatedAt: toDate(data.updatedAt),
  age: data.age || calculateAge(toDate(data.dateOfBirth)),
});

const mapFamily = (id: string, data: any): Family => ({
  ...data,
  id,
  createdAt: toDate(data.createdAt),
  updatedAt: toDate(data.updatedAt),
});

export const familyService = {
  async getOrCreateFamily(userId: string, userName: string, userEmail: string): Promise<Family> {
    const q = query(collection(db, 'families'), where('primaryContact.userId', '==', userId));
    const snapshot = await getDocs(q);

    if (!snapshot.empty) {
      // Sort client-side so we always pick the same (oldest) family if duplicates exist
      const sorted = snapshot.docs.sort((a, b) => {
        const aT = a.data().createdAt?.toDate?.()?.getTime() ?? 0;
        const bT = b.data().createdAt?.toDate?.()?.getTime() ?? 0;
        return aT - bT;
      });
      return mapFamily(sorted[0].id, sorted[0].data());
    }

    const newFamily: Omit<Family, 'id'> = {
      primaryContact: { name: userName, email: userEmail, phone: '', userId },
      status: 'active',
      profileComplete: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const ref = await addDoc(collection(db, 'families'), newFamily);
    return { ...newFamily, id: ref.id };
  },

  async updateFamily(familyId: string, updates: Partial<Omit<Family, 'id' | 'createdAt'>>): Promise<void> {
    const clean: any = { ...updates, updatedAt: new Date() };
    Object.keys(clean).forEach(k => clean[k] === undefined && delete clean[k]);
    await updateDoc(doc(db, 'families', familyId), clean);
  },

  async getFamilyChildren(familyId: string, includeInactive = false, userId?: string): Promise<Child[]> {
    // When userId is provided, query by userId so Firestore rules (resource.data.userId == auth.uid) are satisfied
    const q = userId
      ? query(collection(db, 'children'), where('userId', '==', userId))
      : query(collection(db, 'children'), where('familyId', '==', familyId));
    const snapshot = await getDocs(q);
    const all = snapshot.docs.map(d => mapChild(d.id, d.data()));
    return includeInactive ? all : all.filter(c => c.status !== 'inactive');
  },

  async getChild(childId: string): Promise<Child | null> {
    const snap = await getDoc(doc(db, 'children', childId));
    if (!snap.exists()) return null;
    return mapChild(snap.id, snap.data());
  },

  async addChild(familyId: string, userId: string, data: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>): Promise<void> {
    const clean: any = {
      firstName: data.firstName,
      lastName: data.lastName,
      dateOfBirth: data.dateOfBirth,
      age: data.age,
      familyId,
      userId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (data.schoolName) clean.schoolName = data.schoolName;
    if (data.schoolYear) clean.schoolYear = data.schoolYear;
    if (data.schoolGrade) clean.schoolGrade = data.schoolGrade;
    if (data.contactPhone) clean.contactPhone = data.contactPhone;
    if (data.contactEmail) clean.contactEmail = data.contactEmail;
    if (data.medicalNotes) clean.medicalNotes = data.medicalNotes;
    if (data.allergies?.length) clean.allergies = data.allergies;
    if (data.notes) clean.notes = data.notes;
    await addDoc(collection(db, 'children'), clean);
  },

  async updateChild(childId: string, updates: Partial<Child>): Promise<void> {
    const clean: any = { ...updates, updatedAt: new Date() };
    Object.keys(clean).forEach(k => clean[k] === undefined && delete clean[k]);
    await updateDoc(doc(db, 'children', childId), clean);
  },

  async deactivateChild(childId: string): Promise<void> {
    await updateDoc(doc(db, 'children', childId), { status: 'inactive', updatedAt: new Date() });
  },

  async deleteChild(childId: string): Promise<void> {
    await deleteDoc(doc(db, 'children', childId));
  },

  async getChildSubscriptionCounts(childId: string): Promise<number> {
    const [study, transport, bookings] = await Promise.all([
      getDocs(query(collection(db, 'studyroom'), where('childId', '==', childId))),
      getDocs(query(collection(db, 'transportationSubscriptions'), where('childId', '==', childId))),
      getDocs(query(collection(db, 'bookings'), where('childId', '==', childId))),
    ]);
    const isActive = (d: any) => d.data().status === 'active';
    return study.docs.filter(isActive).length + transport.docs.filter(isActive).length + bookings.docs.length;
  },

  async getChildSubscriptions(childId: string, userId?: string): Promise<{
    study: StudyRoomEntry[];
    transport: TransportationSubscription[];
    parties: Booking[];
  }> {
    // When userId is provided, query by userId (rule-compatible) and filter client-side by childId
    const studyQ = userId
      ? query(collection(db, 'studyroom'), where('userId', '==', userId))
      : query(collection(db, 'studyroom'), where('childId', '==', childId));
    const transportQ = userId
      ? query(collection(db, 'transportationSubscriptions'), where('userId', '==', userId))
      : query(collection(db, 'transportationSubscriptions'), where('childId', '==', childId));
    const bookingsQ = userId
      ? query(collection(db, 'bookings'), where('userId', '==', userId))
      : query(collection(db, 'bookings'), where('childId', '==', childId));

    const [studySnap, transportSnap, bookingsSnap] = await Promise.all([
      getDocs(studyQ),
      getDocs(transportQ),
      getDocs(bookingsQ),
    ]);

    const filterByChild = (d: any) => !userId || d.data().childId === childId;

    return {
      study: studySnap.docs.filter(filterByChild).map(d => ({
        ...d.data(), id: d.id,
        startDate: toDate(d.data().startDate),
        endDate: toDate(d.data().endDate),
        createdAt: toDate(d.data().createdAt),
        updatedAt: toDate(d.data().updatedAt),
      } as StudyRoomEntry)),
      transport: transportSnap.docs.filter(filterByChild).map(d => ({
        ...d.data(), id: d.id,
        createdAt: toDate(d.data().createdAt),
        updatedAt: toDate(d.data().updatedAt),
      } as TransportationSubscription)),
      parties: bookingsSnap.docs.filter(filterByChild).map(d => ({
        ...d.data(), id: d.id,
        createdAt: toDate(d.data().createdAt),
      } as Booking)),
    };
  },

  async getFamilySubscriptions(familyId: string, userId?: string): Promise<{
    study: StudyRoomEntry[];
    transport: TransportationSubscription[];
    parties: Booking[];
  }> {
    const [studySnap, transportSnap, bookingsSnap] = await Promise.all([
      getDocs(userId
        ? query(collection(db, 'studyroom'), where('userId', '==', userId))
        : query(collection(db, 'studyroom'), where('familyId', '==', familyId))),
      getDocs(userId
        ? query(collection(db, 'transportationSubscriptions'), where('userId', '==', userId))
        : query(collection(db, 'transportationSubscriptions'), where('familyId', '==', familyId))),
      getDocs(userId
        ? query(collection(db, 'bookings'), where('userId', '==', userId))
        : query(collection(db, 'bookings'), where('familyId', '==', familyId))),
    ]);

    return {
      study: studySnap.docs.map(d => ({
        ...d.data(), id: d.id,
        startDate: toDate(d.data().startDate),
        endDate: toDate(d.data().endDate),
        createdAt: toDate(d.data().createdAt),
        updatedAt: toDate(d.data().updatedAt),
      } as StudyRoomEntry)),
      transport: transportSnap.docs.map(d => ({
        ...d.data(), id: d.id,
        createdAt: toDate(d.data().createdAt),
        updatedAt: toDate(d.data().updatedAt),
      } as TransportationSubscription)),
      parties: bookingsSnap.docs.map(d => ({
        ...d.data(), id: d.id,
        createdAt: toDate(d.data().createdAt),
      } as Booking)),
    };
  },
};
