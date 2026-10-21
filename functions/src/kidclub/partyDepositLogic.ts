// Mirrors packages/shared/models/partyPricing.ts (partyVatBreakdown). functions/
// can't import @shared at runtime, see the note at the top of billing.ts.
// partyPricingParity.test.ts checks both give the same deposit to the cent.
import { grossFromNet } from "../lib/vat";

/** Booking.total and every party config price are before IVA. */
export const PARTY_VAT_CODE = 23; // KIDCLUB_VAT.party in packages/shared/models/kidclubVat.ts
export const PARTY_VAT_RATE = PARTY_VAT_CODE / 100;
export const PARTY_DEPOSIT_RATE = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A party's price from its pre-IVA Booking.total: subtotal (sem IVA), IVA,
 * total (com IVA) and the 50% deposit (com IVA). Same numbers as the shared
 * partyVatBreakdown the client pages show.
 */
export function partyPriceBreakdown(bookingTotalBeforeVat: unknown): { subtotal: number; vat: number; total: number; deposit: number } {
  const net = round2(Number(bookingTotalBeforeVat) || 0);
  const split = grossFromNet(Math.round(net * 100), PARTY_VAT_CODE)!;
  const total = split.grossCents / 100;
  return { subtotal: net, vat: split.vatCents / 100, total, deposit: round2(total * PARTY_DEPOSIT_RATE) };
}

/**
 * Deposit for a party booking, IVA included. Vendus treats a line amount as
 * gross (IVA-inclusive), so the deposit must be taken from the gross total,
 * not from the stored pre-IVA Booking.total.
 */
export function partyDepositAmount(bookingTotalBeforeVat: unknown): number {
  return partyPriceBreakdown(bookingTotalBeforeVat).deposit;
}

// ── Deposit bill ─────────────────────────────────────────────────────────────

/**
 * Billing doc id of a booking's deposit bill. Deterministic, so the
 * confirmation trigger (at-least-once delivery) and the createPartyDeposit
 * callable can never create two bills for one booking. Deposits created by
 * the callable before 2026-10-20 have random ids; ensurePartyDeposit finds
 * those by bookingId + type first.
 * (Firestore booking ids are alphanumeric, so this never looks like a
 * monthly `<familyId>_YYYY-MM` id.)
 */
export const partyDepositBillingId = (bookingId: string) => `partyDeposit_${bookingId}`;

/**
 * Who owns (sees and pays) the deposit bill. The family's primaryContact.userId,
 * like every other bill (see familyBillingInfo in familyBilling.ts): rules and
 * the pay callables match on billing.userId. The booking's userId only when the
 * family has no owner yet (or the booking has no family).
 */
export function partyDepositOwner(familyOwnerUid: unknown, bookingUserId: unknown): string {
  if (typeof familyOwnerUid === "string" && familyOwnerUid) return familyOwnerUid;
  return typeof bookingUserId === "string" ? bookingUserId : "";
}

const DEPOSIT_DUE_DAYS = 7;

/** "YYYY-MM-DD" (Booking.date) as a UTC-midnight Date, or null if missing/invalid. */
export function partyDate(dateStr: unknown): Date | null {
  if (typeof dateStr !== "string" || !dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

export interface PartyDepositInput {
  bookingId: string;
  booking: FirebaseFirestore.DocumentData;
  /** The family's primaryContact.userId ('' when none or no family). */
  familyOwnerUid: string;
  /** The family's chosen payment method, if any (familyPaymentMethod). */
  familyPaymentMethod?: string;
  /** The family's primaryContact email/name: fallbacks when the booking has none. */
  familyContactEmail?: string;
  familyContactName?: string;
  /** What created it, for the record ("onPartyBookingStatusNotify" / "createPartyDeposit"). */
  createdVia: string;
  now: Date;
}

/**
 * The deposit billing record for a confirmed booking, with plain Dates (the
 * caller converts them to Timestamps). Same shape createPartyDeposit has
 * written since parties were billed, plus `createdVia`; the payment method
 * now follows the family's choice (it was always "mbway").
 */
export function buildPartyDepositRecord(input: PartyDepositInput) {
  const { bookingId, booking, now } = input;
  const amount = partyDepositAmount(booking.total);
  const date = partyDate(booking.date);
  const dateStr = date ? date.toLocaleDateString("pt-PT", { timeZone: "UTC" }) : "";
  const childName = String(booking.childName ?? "").trim();
  const label = ["Sinal", `Festa${childName ? ` de ${childName}` : ""}`, dateStr].filter(Boolean).join(" — ");
  return {
    familyId: String(booking.familyId ?? ""),
    userId: partyDepositOwner(input.familyOwnerUid, booking.userId),
    bookingId,
    type: "party_deposit" as const,
    periodLabel: label,
    periodStart: now,
    periodEnd: date ?? now,
    dueDate: new Date(now.getTime() + DEPOSIT_DUE_DAYS * 24 * 60 * 60 * 1000),
    total: amount,
    lineItems: [
      { title: `Sinal 50% — ${booking.partyType || "Festa"}`, amount },
    ],
    billingName: String(booking.parentName || input.familyContactName || ""),
    billingEmail: String(booking.email || input.familyContactEmail || ""),
    paymentMethod: input.familyPaymentMethod ?? "mbway",
    status: "pending" as const,
    createdVia: input.createdVia,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Booking status transitions ───────────────────────────────────────────────

/**
 * What a booking update means for the party triggers:
 * - "confirmed": the status became `confirmed` (create the deposit bill, email the parent)
 * - "rejected":  `pending` → `rejected` (email the parent the reason)
 * - null:        anything else, including an edit that leaves the status as it was.
 * A booking with no status counts as `pending` (partyService reads it that way).
 */
export function partyStatusEvent(beforeStatus: unknown, afterStatus: unknown): "confirmed" | "rejected" | null {
  const before = beforeStatus ?? "pending";
  const after = afterStatus ?? "pending";
  if (before === after) return null;
  if (after === "confirmed") return "confirmed";
  if (before === "pending" && after === "rejected") return "rejected";
  return null;
}
