export interface PartyType {
  id: string;
  name: string;
  description: string;
  basePrice: number;
  includedKids: number;
  pricePerExtraChild: number;
}

export interface ExtraItem {
  id: string;
  name: string;
  /** Price before IVA. For a per-unit extra this is the price of one unit. */
  price: number;
  description?: string;
  themes?: string[];
  /** When true the family picks a quantity (e.g. 10 hot dogs) instead of a yes/no toggle. */
  perUnit?: boolean;
  /** What one unit is, shown next to the price: "unidade", "prato", "pack de 6". */
  unitLabel?: string;
}

export interface PartyConfig {
  partyTypes: PartyType[];
  extras: ExtraItem[];
}

/**
 * IVA rate on party prices. Every price in PartyConfig, and Booking.total, is
 * before IVA (the price sheet says "aos valores apresentados acresce IVA").
 * Party deposits are invoiced in Vendus as a 23% (NOR) product.
 * functions/src/kidclub/partyDepositLogic.ts mirrors this constant.
 */
export const PARTY_VAT_RATE = 0.23;

/** Share of the IVA-inclusive total paid up front to secure the booking. */
export const PARTY_DEPOSIT_RATE = 0.5;
