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
 * Deposit for a party booking, IVA included. Vendus treats a line amount as
 * gross (IVA-inclusive), so the deposit must be taken from the gross total,
 * not from the stored pre-IVA Booking.total.
 */
export function partyDepositAmount(bookingTotalBeforeVat: unknown): number {
  const net = round2(Number(bookingTotalBeforeVat) || 0);
  const gross = grossFromNet(Math.round(net * 100), PARTY_VAT_CODE)!.grossCents / 100;
  return round2(gross * PARTY_DEPOSIT_RATE);
}
