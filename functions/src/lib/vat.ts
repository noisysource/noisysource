// functions/src/lib/vat.ts
//
// Mirror of packages/shared/lib/vat.ts: functions/ can't import @shared at runtime (see the
// header of functions/src/kidclub/billing.ts). Everything below the marker line is a byte-for-byte
// copy; vat.test.ts in this folder fails if the two copies differ. Edit the shared file first,
// then copy the part below the marker here.
// ---- mirrored below: packages/shared/lib/vat.ts = functions/src/lib/vat.ts ----

/** VAT rates in Portugal, as percent integers. */
export type VatRateCode = 23 | 13 | 6 | 0;

/**
 * - a rate (23 | 13 | 6 | 0): VAT charged at that rate.
 * - 'isento': exempt (insurance, bank fees, EC contracts). No VAT on the invoice.
 * - 'autoliquidacao': reverse charge (foreign B2B such as Anthropic, Google). No PT VAT on the invoice.
 * - 'por_confirmar': unknown. Never treated as 0: split/convert return null for it.
 */
export type VatCode = VatRateCode | 'isento' | 'autoliquidacao' | 'por_confirmar';

export const VAT_CODES: readonly { code: VatCode; label: string }[] = [
  { code: 23, label: '23%' },
  { code: 13, label: '13%' },
  { code: 6, label: '6%' },
  { code: 0, label: '0%' },
  { code: 'isento', label: 'Isento' },
  { code: 'autoliquidacao', label: 'Autoliquidação' },
  { code: 'por_confirmar', label: 'Por confirmar' },
];

export function isVatCode(value: unknown): value is VatCode {
  return VAT_CODES.some(c => c.code === value);
}

/** Reads a stored VAT code; anything unrecognised (or absent) is undefined. */
export function parseVatCode(value: unknown): VatCode | undefined {
  return isVatCode(value) ? value : undefined;
}

/** Percent rate for a code: 0 for isento/autoliquidacao, null for por_confirmar. */
export function vatRatePct(code: VatCode): number | null {
  if (code === 'por_confirmar') return null;
  if (code === 'isento' || code === 'autoliquidacao') return 0;
  return code;
}

/** True when the code adds VAT (23, 13, 6): only then do "com IVA" and "sem IVA" differ. */
export function vatCodeChargesVat(code: VatCode): boolean {
  const rate = vatRatePct(code);
  return rate != null && rate > 0;
}

/** Rounds half away from zero, so a refund splits like the matching charge. */
function roundCents(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

export interface VatSplit {
  grossCents: number;
  netCents: number;
  vatCents: number;
}

/**
 * Splits a VAT-inclusive amount: vat = round(gross × r / (100 + r)), net = gross − vat.
 * Returns null for 'por_confirmar'.
 */
export function splitGross(grossCents: number, code: VatCode): VatSplit | null {
  const rate = vatRatePct(code);
  if (rate == null) return null;
  const vatCents = roundCents((grossCents * rate) / (100 + rate));
  return { grossCents, netCents: grossCents - vatCents, vatCents };
}

/**
 * Builds the VAT-inclusive amount from a net one: vat = round(net × r / 100).
 * splitGross(grossFromNet(n, c), c).netCents === n for every rate.
 * Returns null for 'por_confirmar'.
 */
export function grossFromNet(netCents: number, code: VatCode): VatSplit | null {
  const rate = vatRatePct(code);
  if (rate == null) return null;
  const vatCents = roundCents((netCents * rate) / 100);
  return { grossCents: netCents + vatCents, netCents, vatCents };
}

/** Short label: "IVA 23%", "Isento de IVA", "Autoliquidação", "IVA por confirmar". */
export function vatCodeLabel(code: VatCode): string {
  if (code === 'isento') return 'Isento de IVA';
  if (code === 'autoliquidacao') return 'Autoliquidação';
  if (code === 'por_confirmar') return 'IVA por confirmar';
  return `IVA ${code}%`;
}

function formatEurCents(cents: number): string {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

/**
 * The text shown next to a VAT-inclusive amount:
 * "sem IVA 100,00 € · IVA 23% 23,00 €", or "Isento de IVA", "Autoliquidação",
 * "IVA por confirmar".
 */
export function formatVatBreakdown(grossCents: number, code: VatCode): string {
  const split = splitGross(grossCents, code);
  if (!split || !vatCodeChargesVat(code)) return vatCodeLabel(code);
  return `sem IVA ${formatEurCents(split.netCents)} · ${vatCodeLabel(code)} ${formatEurCents(split.vatCents)}`;
}
