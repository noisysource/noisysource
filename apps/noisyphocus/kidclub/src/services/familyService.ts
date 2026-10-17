import { getDocs, query, where, getDoc, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { col, docRef } from '../lib/db';
import { Family, Child, StudyRoomEntry, TransportationSubscription, Booking } from '@shared/models';
import { calculateAge, normalizeName, normalizeSubStatus, normalizeEmail } from '../lib/utils';
import type { ImpersonationState } from '../contexts/ImpersonationContext';
import { callable } from '../lib/callable';

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

/**
 * Server-side claim (functions/src/kidclub/claimFamily.ts): links owner-less
 * families matching the caller's verified email to the caller and backfills
 * userId on their children/subscriptions/billing. Returns null when there was
 * nothing to claim. Fails open (null) on error so a broken function degrades
 * to the old create-a-family behaviour instead of blocking every first login.
 */
async function claimFamilyByEmail(userEmail: string): Promise<Family | null> {
  if (!userEmail) return null;
  try {
    const res = await callable<void, { familyId: string | null; claimed: number }>('claimFamilyByEmail')();
    const familyId = res.data?.familyId;
    if (!familyId) return null;
    const snap = await getDoc(docRef('families', familyId));
    return snap.exists() ? mapFamily(snap.id, snap.data()) : null;
  } catch (err) {
    console.error('claimFamilyByEmail failed; falling back to creating a family:', err);
    return null;
  }
}

export const familyService = {
  /**
   * Who a parent-side write (child, subscription) should belong to. Normally the
   * signed-in parent; while an admin impersonates a family it's that family's
   * parent, not the admin — Firestore accepts either (admins pass every rule),
   * so stamping the admin here silently hides the record from the real parent
   * and sends their emails to the admin.
   */
  owner(family: Family, user: { uid: string; email?: string | null; name?: string | null }): { userId: string; email: string; name: string } {
    if (_impersonation) {
      return {
        userId: family.primaryContact?.userId ?? '',
        email: family.primaryContact?.email ?? '',
        name: (family.primaryContact?.name ?? '').trim(),
      };
    }
    return { userId: user.uid, email: user.email ?? '', name: user.name ?? '' };
  },

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

    // No family owned by this uid. Before creating one, claim an owner-less
    // family with this (verified) email — created by the migration or an
    // admin, waiting for its parent's first login. Creating a new one here
    // is what left real parents with an empty duplicate family.
    const claimed = await claimFamilyByEmail(userEmail);
    if (claimed) return claimed;

    const newFamily: Omit<Family, 'id'> = {
      primaryContact: { name: userName, email: normalizeEmail(userEmail), phone: '', userId },
      status: 'active',
      profileComplete: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const ref = await addDoc(col('families'), newFamily);
    return { ...newFamily, id: ref.id };
  },

  /**
   * The Firebase Auth uid that owns a family ('' when nobody has claimed it yet).
   * Every child/subscription linked to a family must carry this as `userId`:
   * the client portal queries and the Firestore rules match on userId, not
   * familyId, so a doc linked by familyId alone is invisible to the parent.
   */
  async getFamilyOwnerUid(familyId: string): Promise<string> {
    if (!familyId) return '';
    const snap = await getDoc(docRef('families', familyId));
    return (snap.data()?.primaryContact?.userId as string | undefined) ?? '';
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
      const famSnap = await getDocs(query(col('families'), where('primaryContact.email', '==', normalizeEmail(contactEmail))));
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
      getDocs(query(col('transportationSubscriptions'), where('contactEmail', '==', normalizeEmail(email)))),
      getDocs(query(col('studyroom'), where('email', '==', normalizeEmail(email)))),
      getDocs(query(col('studyroom'), where('contactEmail', '==', normalizeEmail(email)))),
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
