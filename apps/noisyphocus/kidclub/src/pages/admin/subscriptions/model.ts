import { SubStatus } from '../../../lib/utils';
import { AppliedDiscount } from '@shared/models/Discount';

export type TypeFilter = 'all' | 'transport' | 'study' | 'unlinked';

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
export const locationStr = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.address || `${v.lat ?? ''},${v.lng ?? ''}`;
};

// ─── Grouping model ───────────────────────────────────────────────────────────
// The list is family → child → subscriptions. Personal data belongs to the
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
}
