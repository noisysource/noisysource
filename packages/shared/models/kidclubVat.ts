// KidClub's VAT per service, and the euro wrappers its pages use around lib/vat.ts.
//
// Every KidClub subscription price (transport, study room, enrollment fee, insurance) is
// VAT-inclusive: it is what the family pays. Billing sends each line to Vendus as gross_price and
// Vendus applies the VAT rate of the line's product (functions/src/kidclub/vendus.ts), so the rate
// is set in Vendus, not here. These codes mirror those products, checked on a real invoice
// (FR 01P2026/202, 2026-10-12): change a Vendus product's rate and this file together.
//
// Party prices are the exception: Booking.total and config/party are before VAT (partyPricing.ts).
import { VatCode, VatSplit, splitGross, vatCodeLabel } from '../lib/vat';

export type KidclubVatService = 'study' | 'transport' | 'enrollment' | 'insurance' | 'party';

export const KIDCLUB_VAT: Record<KidclubVatService, VatCode> = {
  study: 23,       // PRODUCT_STUDY, also used for camps
  transport: 6,    // PRODUCT_TRANSPORT
  enrollment: 23,  // PRODUCT_ENROLLMENT_FEE
  insurance: 23,   // PRODUCT_INSURANCE
  party: 23,       // party deposits are billed as PRODUCT_STUDY
};

export interface EuroVatSplit {
  gross: number;
  net: number;
  vat: number;
}

const toCents = (eur: number) => Math.round((Number(eur) || 0) * 100);

function centsSplit(grossEur: number, service: KidclubVatService): VatSplit {
  // KIDCLUB_VAT holds rates only, never 'por_confirmar', so splitGross can't return null.
  return splitGross(toCents(grossEur), KIDCLUB_VAT[service])!;
}

/** Splits a VAT-inclusive euro amount for a KidClub service. */
export function kidclubVatSplit(grossEur: number, service: KidclubVatService): EuroVatSplit {
  const s = centsSplit(grossEur, service);
  return { gross: s.grossCents / 100, net: s.netCents / 100, vat: s.vatCents / 100 };
}

/** The text next to a VAT-inclusive price, in KidClub's € format: "sem IVA €94.34 · IVA 6% €5.66". */
export function kidclubVatNote(grossEur: number, service: KidclubVatService): string {
  const s = kidclubVatSplit(grossEur, service);
  return `sem IVA €${s.net.toFixed(2)} · ${vatCodeLabel(KIDCLUB_VAT[service])} €${s.vat.toFixed(2)}`;
}

/**
 * Same for a total made of services at different rates (study 23% + transport 6%):
 * "sem IVA €73.95 · IVA €16.05". Like a Vendus invoice, the parts are added up per rate first
 * and each rate's total is split once, so this matches the invoice to the cent.
 */
export function kidclubVatNoteMixed(parts: { grossEur: number; service: KidclubVatService }[]): string {
  const grossByCode = new Map<VatCode, number>();
  for (const p of parts) {
    const code = KIDCLUB_VAT[p.service];
    grossByCode.set(code, (grossByCode.get(code) ?? 0) + toCents(p.grossEur));
  }
  let net = 0;
  let vat = 0;
  for (const [code, grossCents] of grossByCode) {
    const s = splitGross(grossCents, code)!;
    net += s.netCents;
    vat += s.vatCents;
  }
  return `sem IVA €${(net / 100).toFixed(2)} · IVA €${(vat / 100).toFixed(2)}`;
}
