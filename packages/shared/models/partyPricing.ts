import { PartyConfig, PARTY_DEPOSIT_RATE } from './PartyConfig';
import { grossFromNet } from '../lib/vat';
import { KIDCLUB_VAT } from './kidclubVat';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PartyPriceLine {
  name: string;
  qty: number;
  unitPrice: number;
  unitLabel?: string;
  perUnit: boolean;
  amount: number;
}

export interface PartyPrice {
  basePrice: number;
  includedKids: number;
  extraKids: number;
  pricePerExtraChild: number;
  extraKidsAmount: number;
  extraLines: PartyPriceLine[];
  /** Before IVA. This is what Booking.total stores. */
  subtotal: number;
  vat: number;
  /** IVA included: what the family actually pays. */
  total: number;
  /** 50% of the IVA-inclusive total. */
  deposit: number;
}

export interface PartySelection {
  partyType: string;
  numKids: number;
  /** Names of the chosen extras. */
  extras?: string[];
  /** Quantity per extra name. A chosen extra without an entry counts as 1. */
  extrasDetail?: Record<string, number>;
}

/** Quantity of an extra in a booking. Old bookings have no extrasDetail, so a listed extra counts once. */
export function extraQty(sel: Pick<PartySelection, 'extras' | 'extrasDetail'>, name: string): number {
  if (!sel.extras?.includes(name)) return 0;
  const q = Number(sel.extrasDetail?.[name]);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}

/**
 * VAT split for a stored Booking.total (before IVA). The VAT comes from lib/vat.ts; the deposit
 * keeps its own rounding so no party price or deposit moves by a cent (pinned by
 * functions/src/kidclub/partyPricingParity.test.ts, mirrored in partyDepositLogic.ts).
 */
export function partyVatBreakdown(subtotal: number) {
  const net = round2(Number(subtotal) || 0);
  const split = grossFromNet(Math.round(net * 100), KIDCLUB_VAT.party)!;
  const vat = split.vatCents / 100;
  const total = split.grossCents / 100;
  return { subtotal: net, vat, total, deposit: round2(total * PARTY_DEPOSIT_RATE) };
}

/**
 * Single source of truth for a party's price. Used by the client booking page
 * and the admin booking form so both show and store the same numbers.
 * Config values are coerced with Number() because older admin saves stored
 * some prices as strings.
 */
export function computePartyPrice(config: PartyConfig, sel: PartySelection): PartyPrice | null {
  const pt = config.partyTypes.find(p => p.name === sel.partyType);
  if (!pt) return null;

  const basePrice = Number(pt.basePrice) || 0;
  const includedKids = Number(pt.includedKids) || 0;
  const pricePerExtraChild = Number(pt.pricePerExtraChild) || 0;
  const numKids = Number(sel.numKids) || 0;
  const extraKids = Math.max(0, numKids - includedKids);
  const extraKidsAmount = round2(extraKids * pricePerExtraChild);

  const extraLines: PartyPriceLine[] = [];
  for (const name of sel.extras ?? []) {
    const ex = config.extras.find(e => e.name === name);
    if (!ex) continue;
    const qty = extraQty(sel, name);
    const unitPrice = Number(ex.price) || 0;
    extraLines.push({
      name,
      qty,
      unitPrice,
      unitLabel: ex.unitLabel,
      perUnit: !!ex.perUnit,
      amount: round2(unitPrice * qty),
    });
  }

  const subtotal = round2(basePrice + extraKidsAmount + extraLines.reduce((s, l) => s + l.amount, 0));
  const { vat, total, deposit } = partyVatBreakdown(subtotal);

  return { basePrice, includedKids, extraKids, pricePerExtraChild, extraKidsAmount, extraLines, subtotal, vat, total, deposit };
}
