import { getDocs, query, where, getDoc, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { col, docRef } from '../lib/db';
import { Family, Child, StudyRoomEntry, TransportationSubscription, Booking } from '@shared/models';
import { calculateAge, normalizeName, normalizeSubStatus } from '../lib/utils';
import type { ImpersonationState } from '../contexts/ImpersonationContext';

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

// Set by ImpersonationContext — when non-null, getOrCreateFamily returns this family directly.
let _impersonation: ImpersonationState | null = null;
export function setFamilyServiceImpersonation(state: ImpersonationState | null) {
  _impersonation = state;
}

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
    if (_impersonation) {
      const snap = await getDoc(docRef('families', _impersonation.familyId));
      if (snap.exists()) return mapFamily(snap.id, snap.data());
    }

    const q = query(col('families'), where('primaryContact.userId', '==', userId));
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
    const ref = await addDoc(col('families'), newFamily);
    return { ...newFamily, id: ref.id };
  },

  async updateFamily(familyId: string, updates: Partial<Omit<Family, 'id' | 'createdAt'>>): Promise<void> {
    const clean: any = { ...updates, updatedAt: new Date() };
    Object.keys(clean).forEach(k => clean[k] === undefined && delete clean[k]);
    await updateDoc(docRef('families', familyId), clean);
  },

  async getFamilyChildren(familyId: string, includeInactive = false, userId?: string): Promise<Child[]> {
    // When impersonating, always query by familyId (admin has full read access; userId would be the wrong user)
    const q = (userId && !_impersonation)
      ? query(col('children'), where('userId', '==', userId))
      : query(col('children'), where('familyId', '==', familyId));
    const snapshot = await getDocs(q);
    const all = snapshot.docs.map(d => mapChild(d.id, d.data()));
    return includeInactive ? all : all.filter(c => c.status !== 'inactive');
  },

  async getChild(childId: string): Promise<Child | null> {
    const snap = await getDoc(docRef('children', childId));
    if (!snap.exists()) return null;
    return mapChild(snap.id, snap.data());
  },

  /**
   * Find existing children that could plausibly already be this one — by normalized
   * name, and/or via the family matched by contactEmail. Used before creating a new
   * subscription so admins link to a real, existing child instead of creating a
   * duplicate. Not exhaustive/fuzzy beyond exact normalized-name matching; it's a
   * candidate list for a human to confirm, not an automatic merge.
   */
  async findMatchingChildren(firstName: string, lastName: string, contactEmail?: string): Promise<Child[]> {
    const target = normalizeName(`${firstName} ${lastName}`);
    const matches = new Map<string, Child>();

    if (contactEmail) {
      const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', contactEmail)));
      for (const famDoc of famSnap.docs) {
        const childSnap = await getDocs(query(col('children'), where('familyId', '==', famDoc.id)));
        for (const d of childSnap.docs) matches.set(d.id, mapChild(d.id, d.data()));
      }
    }

    if (target) {
      const allSnap = await getDocs(col('children'));
      for (const d of allSnap.docs) {
        const data = d.data();
        if (normalizeName(`${data.firstName ?? ''} ${data.lastName ?? ''}`) === target) {
          matches.set(d.id, mapChild(d.id, data));
        }
      }
    }

    return [...matches.values()];
  },

  /**
   * True if this email has any subscription (transport or study room) that isn't yet
   * linked to a family and isn't cancelled. Study-room docs inconsistently use `email`
   * or `contactEmail` depending on which admin flow created them, so both are queried
   * and deduped by doc id — this is the single source of truth for that check; don't
   * reimplement it at call sites (see ClientLayout.tsx, ClaimSubscriptionsPage.tsx).
   */
  async hasUnclaimedSubscriptions(email: string): Promise<boolean> {
    const [transportSnap, studyByEmailSnap, studyByContactEmailSnap] = await Promise.all([
      getDocs(query(col('transportationSubscriptions'), where('contactEmail', '==', email))),
      getDocs(query(col('studyroom'), where('email', '==', email))),
      getDocs(query(col('studyroom'), where('contactEmail', '==', email))),
    ]);
    const isUnclaimed = (d: any) => !d.data().familyId && !CANCELLED_STATUSES.has(d.data().status);
    if (transportSnap.docs.some(isUnclaimed)) return true;
    const studyDocsById = new Map(
      [...studyByEmailSnap.docs, ...studyByContactEmailSnap.docs].map(d => [d.id, d])
    );
    return [...studyDocsById.values()].some(isUnclaimed);
  },

  async addChild(familyId: string, userId: string, data: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>): Promise<string> {
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
    if (data.homeAddress) clean.homeAddress = data.homeAddress;
    if (data.homeAddressSource) clean.homeAddressSource = data.homeAddressSource;
    if (data.contactPhone) clean.contactPhone = data.contactPhone;
    if (data.contactEmail) clean.contactEmail = data.contactEmail;
    if (data.medicalNotes) clean.medicalNotes = data.medicalNotes;
    if (data.allergies?.length) clean.allergies = data.allergies;
    if (data.notes) clean.notes = data.notes;
    const ref = await addDoc(col('children'), clean);
    return ref.id;
  },

  async updateChild(childId: string, updates: Partial<Child>): Promise<void> {
    const clean: any = { ...updates, updatedAt: new Date() };
    Object.keys(clean).forEach(k => clean[k] === undefined && delete clean[k]);
    await updateDoc(docRef('children', childId), clean);
  },

  async deactivateChild(childId: string): Promise<void> {
    await updateDoc(docRef('children', childId), { status: 'inactive', updatedAt: new Date() });
  },

  async deleteChild(childId: string): Promise<void> {
    await deleteDoc(docRef('children', childId));
  },

  async getChildSubscriptionCounts(childId: string): Promise<number> {
    const [study, transport, bookings] = await Promise.all([
      getDocs(query(col('studyroom'), where('childId', '==', childId))),
      getDocs(query(col('transportationSubscriptions'), where('childId', '==', childId))),
      getDocs(query(col('bookings'), where('childId', '==', childId))),
    ]);
    const isActive = (d: any) => d.data().status === 'active';
    return study.docs.filter(isActive).length + transport.docs.filter(isActive).length + bookings.docs.length;
  },

  async getChildSubscriptions(childId: string, userId?: string): Promise<{
    study: StudyRoomEntry[];
    transport: TransportationSubscription[];
    parties: Booking[];
  }> {
    // When userId is provided (and not impersonating), query by userId (rule-compatible) and filter client-side
    const useUserId = !!userId && !_impersonation;
    const studyQ = useUserId
      ? query(col('studyroom'), where('userId', '==', userId))
      : query(col('studyroom'), where('childId', '==', childId));
    const transportQ = useUserId
      ? query(col('transportationSubscriptions'), where('userId', '==', userId))
      : query(col('transportationSubscriptions'), where('childId', '==', childId));
    const bookingsQ = useUserId
      ? query(col('bookings'), where('userId', '==', userId))
      : query(col('bookings'), where('childId', '==', childId));

    const [studySnap, transportSnap, bookingsSnap] = await Promise.all([
      getDocs(studyQ),
      getDocs(transportQ),
      getDocs(bookingsQ),
    ]);

    const filterByChild = (d: any) => !useUserId || d.data().childId === childId;

    return {
      study: studySnap.docs.filter(filterByChild).map(d => ({
        ...d.data(), id: d.id,
        status: normalizeSubStatus(d.data().status),
        startDate: toDate(d.data().startDate),
        endDate: toDate(d.data().endDate),
        createdAt: toDate(d.data().createdAt),
        updatedAt: toDate(d.data().updatedAt),
      } as StudyRoomEntry)),
      transport: transportSnap.docs.filter(filterByChild).map(d => ({
        ...d.data(), id: d.id,
        status: normalizeSubStatus(d.data().status),
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
    const useUserId = !!userId && !_impersonation;
    const [studySnap, transportSnap, bookingsSnap] = await Promise.all([
      getDocs(useUserId
        ? query(col('studyroom'), where('userId', '==', userId))
        : query(col('studyroom'), where('familyId', '==', familyId))),
      getDocs(useUserId
        ? query(col('transportationSubscriptions'), where('userId', '==', userId))
        : query(col('transportationSubscriptions'), where('familyId', '==', familyId))),
      getDocs(useUserId
        ? query(col('bookings'), where('userId', '==', userId))
        : query(col('bookings'), where('familyId', '==', familyId))),
    ]);

    return {
      study: studySnap.docs.map(d => ({
        ...d.data(), id: d.id,
        status: normalizeSubStatus(d.data().status),
        startDate: toDate(d.data().startDate),
        endDate: toDate(d.data().endDate),
        createdAt: toDate(d.data().createdAt),
        updatedAt: toDate(d.data().updatedAt),
      } as StudyRoomEntry)),
      transport: transportSnap.docs.map(d => ({
        ...d.data(), id: d.id,
        status: normalizeSubStatus(d.data().status),
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
