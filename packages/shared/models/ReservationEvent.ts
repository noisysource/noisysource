/**
 * A single materialized occurrence generated from a subscription blueprint
 * (studyroom entry or transportationSubscription). One row per
 * (subscriptionId, date[, direction]) — created in full for the remaining
 * school year the moment the blueprint is created, not computed on read.
 *
 * Status is a simple in-place flip, not an append-only chain:
 * - EXPECTED  — default. Billed at basePriceCents. Does not count as an absence.
 * - CANCELLED — a parent or staff member marked this date as not happening.
 *   Still billed at basePriceCents UNLESS the subscription's CANCELLED count
 *   for this billing period reaches the absence threshold (3), in which case
 *   it contributes to the uncapped absence credit. Counts toward that threshold.
 * - VOIDED    — the underlying subscription ended (or its schedule changed)
 *   before this date arrived. Not billed at all, and does NOT count toward
 *   the absence threshold — this isn't an absence, the service stopped
 *   existing. Set automatically on subscription cancellation/schedule edits
 *   for events whose date hasn't happened yet; past events are never voided.
 */
export interface ReservationEvent {
  id: string;
  subscriptionId: string;
  subscriptionType: 'study' | 'transport';
  familyId: string;
  childId: string;
  /** ISO yyyy-mm-dd */
  date: string;
  /** Transport only — study has one occurrence per scheduled day */
  direction?: 'pickup' | 'dropoff' | 'both';
  /** Frozen at generation time from the blueprint's rate × schedule — never recomputed after creation */
  basePriceCents: number;
  status: 'EXPECTED' | 'CANCELLED' | 'VOIDED';
  /** Who/why the status last changed — unset while still EXPECTED */
  changedBy?: string;
  changedByRole?: 'parent' | 'staff' | 'system';
  changedAt?: Date;
  reason?: string;
  createdAt: Date;
}
