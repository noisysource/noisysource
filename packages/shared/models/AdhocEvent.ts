/**
 * One-off KidClub events (Halloween, a strike day, ...): open to anyone, with or
 * without a KidClub account. Firestore: `_apps/arcoiris/adhocEvents/{id}` and
 * `_apps/arcoiris/adhocEventRegistrations/{id}`. (`events` is the calendar's.)
 *
 * Every write goes through Cloud Functions (functions/src/kidclub/adhocEvents.ts);
 * the pricing and seat maths below is mirrored in functions/src/kidclub/adhocEventLogic.ts
 * (adhocEventParity.test.ts keeps the two equal).
 *
 * Prices are per child per day and VAT-inclusive (com IVA), invoiced at 23%
 * (KIDCLUB_VAT.event, Vendus PRODUCT_STUDY like camps).
 */
import type { Timestamp } from 'firebase/firestore';

export interface AdhocEventDay {
  date: string;          // yyyy-mm-dd
  startTime?: string;    // "09:00"
  endTime?: string;      // "17:30"
  capacity: number;      // children
  price: number;         // € com IVA, per child — the public price
  memberPrice?: number;  // € com IVA, per child, for KidClub families; unset = price
  /** Seats held (awaiting payment) + confirmed. Server-maintained, never edited by hand. */
  taken: number;
}

export interface AdhocEvent {
  id: string;
  name: string;
  description?: string;
  location?: string;
  days: AdhocEventDay[];  // sorted by date
  /** Shown on the public page (/eventos). */
  published: boolean;
  /** Admin switch; signups also stop once `closesOn` has passed or a day has started. */
  registrationOpen: boolean;
  closesOn?: string;      // yyyy-mm-dd, last day signups are accepted
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type AdhocRegistrationStatus =
  | 'held'       // seats taken, waiting for payment (pay now); released at holdExpiresAt
  | 'confirmed'  // paid, or on the monthly bill
  | 'cancelled'  // by an admin
  | 'expired';   // not paid in time, seats released

export type AdhocPayment = 'now' | 'monthly';

export interface AdhocRegistrationChild {
  name: string;
  birthDate?: string;   // yyyy-mm-dd
  childId?: string;     // KidClub families only
  healthNotes?: string; // allergies, medication
}

export interface AdhocEventRegistration {
  id: string;
  eventId: string;
  eventName: string;
  kind: 'guest' | 'member';
  familyId?: string;
  userId?: string;      // the family's parent; unset for guests
  guardian: { name: string; email: string; phone: string; nif?: string };
  children: AdhocRegistrationChild[];
  days: string[];       // yyyy-mm-dd, the same for every child on the registration
  pickupNotes?: string; // who picks the children up
  photoConsent: boolean;
  priceTier: 'public' | 'member';
  /** One per child, priced and frozen at signup; copied onto the bill (type 'event'). */
  lines: { title: string; amount: number }[];
  total: number;        // € com IVA
  /** Secret in the registration's link (/eventos/inscricao/{id}?t=...): a guest's only key. */
  accessToken: string;
  payment: AdhocPayment;
  billingId?: string;     // payment 'now': its own bill (type 'event')
  billingPeriod?: string; // payment 'monthly': yyyy-mm of the monthly bill it's on
  status: AdhocRegistrationStatus;
  holdExpiresAt?: Timestamp;
  mbwayAttempts?: number;
  /** Paid (or on a bill already paid) and then cancelled: refund / credit note by hand. */
  refundPending?: boolean;
  /** Paid after its hold had expired and the seats had gone to someone else. */
  overCapacity?: boolean;
  adminEntry?: boolean;   // added by an admin (walk-in); its hold never expires
  cancelReason?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export const ADHOC_MAX_CHILDREN = 4;
export const ADHOC_HOLD_MINUTES = 30;
export const ADHOC_MAX_MBWAY_ATTEMPTS = 3;

/** The per-child price of one day, for a tier. */
export function adhocDayPrice(day: Pick<AdhocEventDay, 'price' | 'memberPrice'>, tier: 'public' | 'member'): number {
  if (tier === 'member' && typeof day.memberPrice === 'number' && day.memberPrice >= 0) return day.memberPrice;
  return day.price;
}

/** Total, in €, for `childCount` children on the chosen days. Rounded to the cent. */
export function adhocTotal(days: Pick<AdhocEventDay, 'date' | 'price' | 'memberPrice'>[], chosen: string[], childCount: number, tier: 'public' | 'member'): number {
  let cents = 0;
  for (const d of days) if (chosen.includes(d.date)) cents += Math.round(adhocDayPrice(d, tier) * 100) * childCount;
  return cents / 100;
}

/** Seats left on a day (never negative). */
export const adhocSeatsLeft = (day: Pick<AdhocEventDay, 'capacity' | 'taken'>) => Math.max(0, (day.capacity ?? 0) - (day.taken ?? 0));
