import { SubStatus } from '../../../lib/utils';
import { AppliedDiscount } from '@shared/models/Discount';

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
}

/** Unpaid = still owed by the parent. `processing` is a payment already in flight. */
export const isUnpaid = (b: BillRow) => b.status === 'pending' || b.status === 'failed';
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
