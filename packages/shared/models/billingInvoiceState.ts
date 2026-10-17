// Kept free of imports so functions' tests can import it directly
// (functions/src/kidclub/retryInvoiceLogic.test.ts pins it against the
// backend's retry decision).

/** The billing fields that say whether a bill's invoice is still owed. */
export interface InvoiceStateFields {
  invoiceError?: string | null;
  invoiceNumber?: string | null;
  vendusId?: number | string | null;
}

/**
 * The bill has an invoice error AND no invoice recorded: the invoice is
 * genuinely still owed ("Fatura por emitir"), so "Tentar faturar novamente"
 * may be offered.
 *
 * A bill with an `invoiceNumber`/`vendusId` already has its invoice. An
 * `invoiceError` left on it is stale (prod, oK6GHA7D0f4cRVM3RNZW_2026-09:
 * invoiced as FR 01P2026/226 while a concurrent webhook call wrote the error),
 * and a retry would issue a second, real Fatura-Recibo. retryVendusInvoice
 * refuses it too. Use this for every invoice-error badge, count, filter and
 * retry button, rather than checking `invoiceError` alone.
 */
export function hasOpenInvoiceError(b: InvoiceStateFields | null | undefined): boolean {
  return !!b?.invoiceError && !b.invoiceNumber && !b.vendusId;
}
