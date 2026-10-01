import { SubStatus } from '../../../lib/utils';
import { AppliedDiscount } from '@shared/models/Discount';
import { BillLine } from '../../../lib/billingLines';

export interface SubItem {
  id: string;
  _type: 'study' | 'transport';
  childName: string;
  childId?: string;
  familyId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  source?: string;
  // Study + Transport (school name lives on the children doc)
  schoolName?: string;
  schoolYear?: string;
  days?: any[];
  monthlyPrice?: number;
  // Transport
  schedule?: any[];
  monthlyFee?: number;
  // Operational tracking only — never gates status. Transport's old "planned"
  // status used to double as "awaiting route assignment"; now that's this
  // independent boolean instead of a hidden third status axis.
  routeAssigned?: boolean;
  // Returning student discount (legacy)
  returningStudent?: boolean;
  originalFee?: number;    // transport: fee before discount
  basePrice?: number;      // study: fee before discount
  // Central discount system
  appliedDiscounts?: AppliedDiscount[];
  /** Admin overrides of the automatic discounts, by rule id. See DiscountOverrides. */
  discountOverrides?: Record<string, boolean>;
  weekPattern?: 'all' | 'odd' | 'even';
  // Common
  status: SubStatus;
  statusReason?: string;
  note?: string;
  createdAt: Date;
  // Old pricing switch (see isLegacyPricing). undefined = decided by createdAt.
  legacyPricing?: boolean;
  cancelRequested?: boolean;
  feeReviewRequired?: boolean;
  // Two-way in-app review flags (no email for this). clientReviewPending: set
  // whenever admin changes a subscription (status or details) that's already
  // linked to a family/child — surfaced as a review prompt on the parent's
  // dashboard, cleared once they act. adminReviewPending: set whenever a
  // client-initiated change happens (e.g. a cancel request) — surfaced here,
  // cleared once admin views/acts on it. lastClientAction records *what* the
  // client did last, so the adminReviewPending badge can say what to do next
  // instead of a single generic "review needed" for every case.
  clientReviewPending?: boolean;
  adminReviewPending?: boolean;
  lastClientAction?: LastClientAction;
}

export type LastClientAction = 'confirmed' | 'cancelRequested' | 'edited' | 'rejected';

export const toDate = (v: any): Date => v?.toDate?.() ?? new Date(v ?? 0);

/**
 * The parent did something the admin has to act on. A parent confirming an
 * admin change to a subscription that is already active (or cancelled) also
 * sets adminReviewPending — older parent pages did that for every
 * confirmation — but there is nothing to do, so it doesn't count.
 */
export const needsAdminReview = (i: Pick<SubItem, 'adminReviewPending' | 'lastClientAction' | 'status'>) =>
  !!i.adminReviewPending && !(i.lastClientAction === 'confirmed' && i.status !== 'pending');

/** Not yet tied to a family account, or to a child record inside one. */
export const isUnlinked = (i: Pick<SubItem, 'source' | 'familyId' | 'childId'>) =>
  (i.source === 'manual' && !i.familyId) || (!!i.familyId && !i.childId);

/** Firestore collection a subscription lives in. */
export const subCollection = (item: Pick<SubItem, '_type'>) =>
  item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';

/**
 * Which family a subscription belongs to on this page. A linked subscription
 * uses its familyId; an admin-created one nobody has claimed yet falls back to
 * the guardian email it was created with, so a family's unclaimed transport +
 * study pair still shows up together. This is also the `?family=` URL value.
 */
export const familyKeyOf = (item: Pick<SubItem, 'id' | 'familyId' | 'contactEmail'>) =>
  item.familyId || item.contactEmail || item.id;

/** The families/{id} fields this page shows or edits. */
export interface FamilyDoc {
  id: string;
  primaryContact?: { name?: string; email?: string; phone?: string; userId?: string };
  nif?: string;
  billingAddress?: { street?: string; city?: string; postalCode?: string; country?: string };
  status?: string;
  paymentMethod?: string;
  profileComplete?: boolean;
  notes?: string;
}

/** The children/{id} fields this page needs beyond what a SubItem carries. */
export interface ChildDoc {
  id: string;
  familyId?: string;
  firstName?: string;
  lastName?: string;
  schoolName?: string;
  schoolYear?: string;
  status?: string;
  homeAddress?: { street?: string; city?: string; postalCode?: string };
}

/** One billing/{id} record, reduced to what the family panel shows. */
export interface BillRow {
  id: string;
  familyId: string;
  status: string;
  total: number;
  periodLabel: string;
  /** yyyy-mm, for ordering; periodLabel is display text. */
  periodKey: string;
  dueDate?: Date;
  invoiceError?: string;
  invoiceNumber?: string;
  /** Current Easypay payment id, if an attempt was started. */
  easypayId?: string;
  /** Easypay payments that landed on an already-paid bill — need a refund. */
  duplicatePaymentEasypayIds?: string[];
  /** The engine's line items — the real per-subscription amounts. */
  lines: BillLine[];
}

/**
 * Not paid yet. Bills exist in advance for every month of the school year
 * (each due on the 8th), so most unpaid bills are simply not due yet.
 */
export const isUnpaid = (b: BillRow) => ['pending', 'processing', 'failed'].includes(b.status);
/** Unpaid and past its due date — same rule as the parent's Payments page. */
export const isOverdue = (b: BillRow, now = new Date()) => isUnpaid(b) && !!b.dueDate && b.dueDate < now;
export const locationStr = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.address || `${v.lat ?? ''},${v.lng ?? ''}`;
};

// ─── Family model ─────────────────────────────────────────────────────────────
// The side panel shows one family as family → child → subscriptions. Personal data belongs to the
// first two levels and is edited there, exactly once; a subscription row below
// carries only what is genuinely per-subscription. Before this, every
// subscription card repeated (and separately edited) the child's name, school
// and guardian contact — which is how one child's transport and study
// documents ended up naming two different schools.
export interface ChildGroup {
  key: string;
  childId?: string;
  familyId?: string;
  childName: string;
  schoolName?: string;
  schoolYear?: string;
  items: SubItem[];
}

export interface FamilyGroup {
  key: string;
  label: string | null;
  familyId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  children: ChildGroup[];
  count: number;
  /** The families/{id} record, when the family has one. */
  family?: FamilyDoc;
  bills: BillRow[];
}

// Old pricing (grandfathered, Renato 2026-10-01): subscriptions created before
// this cutoff are billed on the flat model their card shows, for the rest of
// the school year. Must match LEGACY_PRICING_CUTOFF in functions/src/kidclub/billing.ts.
export const LEGACY_PRICING_CUTOFF = new Date('2026-10-01T00:00:00+01:00');
export const isLegacyPricing = (item: Pick<SubItem, 'legacyPricing' | 'createdAt'>): boolean =>
  item.legacyPricing ?? item.createdAt < LEGACY_PRICING_CUTOFF;
