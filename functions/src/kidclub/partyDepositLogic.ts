// Mirrors packages/shared/models/partyPricing.ts (partyVatBreakdown). functions/
// can't import @shared at runtime, see the note at the top of billing.ts.

/** Booking.total and every party config price are before IVA. */
export const PARTY_VAT_RATE = 0.23;
export const PARTY_DEPOSIT_RATE = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Deposit for a party booking, IVA included. Vendus treats a line amount as
 * gross (IVA-inclusive), so the deposit must be taken from the gross total,
 * not from the stored pre-IVA Booking.total.
 */
export function partyDepositAmount(bookingTotalBeforeVat: unknown): number {
  const net = round2(Number(bookingTotalBeforeVat) || 0);
  const gross = round2(net + round2(net * PARTY_VAT_RATE));
  return round2(gross * PARTY_DEPOSIT_RATE);
}
