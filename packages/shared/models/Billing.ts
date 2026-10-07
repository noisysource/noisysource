import { Timestamp } from 'firebase/firestore';
import type { AppliedDiscount } from './Discount';

export type BillingPaymentMethod = 'mbway' | 'multibanco' | 'card' | 'subscription' | 'bank_transfer';

/** A file a parent or admin uploaded as proof of a (bank transfer) payment.
 *  Stored in Firebase Storage at `path`; attached via the attachPaymentProof callable. */
export interface PaymentProof {
  path: string;
  fileName: string;
  uploadedBy: string;
  uploaderRole: 'parent' | 'admin';
  uploadedAt: Timestamp;
}

export type BillingStatus =
  | 'pending'     // billing record created, payment not yet initiated
  | 'processing'  // payment initiated with Easypay, awaiting confirmation
  | 'paid'        // Easypay confirmed payment
  | 'invoiced'    // Vendus invoice created and emailed
  | 'failed'      // payment failed or expired
  | 'cancelled'   // subscription was cancelled before payment
  | 'dry-run';    // test record, no real payment

export interface BillingLineItem {
  title: string;
  amount: number;                    // net, after discounts and absence credit
  subscriptionId?: string;
  type?: 'study' | 'transport' | 'enrollment'; // 'enrollment' = one-time registration+insurance fee
  grossAmount?: number;               // sum of this period's EXPECTED+CANCELLED ReservationEvents, before any discount
  /** @deprecated study/transport line items no longer populate this — see the breakdown fields below. Still used by one-time enrollment fee line items (always empty array there). */
  appliedDiscounts?: AppliedDiscount[];
  scheduleDays?: string[];            // weekday names (english, lowercase) this line item is actually billed for
  tripsByDay?: Record<string, ('pickup' | 'dropoff' | 'both')[]>; // transport only — trip(s) scheduled per weekday
  multiTripDiscountAmount?: number;     // marginal — only trip #2+ on a multi-trip day
  siblingDiscountAmount?: number;       // marginal — 0 if this is the family's highest-value subscription for this service
  institutionalDiscountAmount?: number; // school + returning-student + manual admin overrides, summed
  institutionalDiscountPct?: number;
  /** Billed on the grandfathered flat model: institutionalDiscountPct is then the sum of all the subscription's discounts. */
  legacyPricing?: boolean;
  absenceCount?: number;                // CANCELLED ReservationEvents this period, this subscription
  absenceCreditAmount?: number;
  absenceDates?: string[];              // "yyyy-mm-dd" — every CANCELLED date this period, credited or not
  absenceCreditDates?: string[];        // "yyyy-mm-dd" — every CANCELLED date credited once the 3-absence threshold was reached (uncapped)
}

export interface BillingRecord {
  id: string;
  familyId: string;
  userId: string;

  periodLabel: string;
  periodStart: Timestamp;
  periodEnd: Timestamp;
  dueDate: Timestamp;

  total: number;
  lineItems: BillingLineItem[];

  billingName: string;
  billingEmail: string;

  paymentMethod: BillingPaymentMethod;

  status: BillingStatus;
  // Set alongside status: 'cancelled' only when the billing sync itself
  // cancelled this period because the family had zero billable subscriptions
  // — never for a deliberate admin cancellation of one invoice. Lets a later
  // reactivation revive this specific record instead of it staying cancelled
  // forever; a manually-cancelled record has no such flag and is left alone.
  autoCancelled?: boolean;

  // Easypay
  easypayId?: string;

  // Multibanco
  multibancoEntity?: string;
  multibancoReference?: string;
  multibancoExpiry?: Timestamp;

  // Card / pay-by-link
  paymentLink?: string;

  // Admin actions
  noticeSentAt?: Timestamp;

  // Easypay payments that landed on an already-paid bill (paid by another
  // Easypay payment, or marked paid manually by an admin) — need a refund.
  duplicatePaymentEasypayIds?: string[];

  // Proof of payment (optional). Never changes `status` by itself: a parent
  // upload keeps the record pending; only an admin marks it paid.
  paymentProofs?: PaymentProof[];
  proofSubmittedAt?: Timestamp;

  // Set by markBillingPaid (admin confirmed a bank transfer by hand).
  manualPayment?: { by: string; at: Timestamp; note?: string };

  // Outcome
  paidAt?: Timestamp;
  invoiceError?: string;
  invoiceNumber?: string;
  vendusId?: number;
  atcud?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
