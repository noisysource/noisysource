// Pure decision for retryVendusInvoice (billing.ts), split out so it can be
// unit-tested without firebase-admin.

type BillData = Record<string, any> | null | undefined;

/** Why a retry is refused; the HttpsError code and message to throw. */
export interface RetryInvoiceRefusal {
  code: "failed-precondition" | "already-exists";
  message: string;
}

/**
 * May "Tentar faturar novamente" issue a Vendus invoice for this bill?
 * Returns null when it may, else the refusal.
 *
 * A retry resets the bill to `paid`, deletes `invoiceNumber`/`vendusId`/
 * `atcud` and issues a new Fatura-Recibo. Prod Vendus has no sandbox and a
 * certified invoice can't be deleted, so a bill that already records an
 * invoice is refused, whatever its status and whether or not it also carries
 * an `invoiceError`. That combination happened in prod: before the invoice
 * claim (#74), EasyPay's two concurrent webhook calls both invoiced
 * `oK6GHA7D0f4cRVM3RNZW_2026-09`. One got Vendus's "A001 ... too many
 * documents simultaneously" and wrote `invoiceError`; the other issued
 * FR 01P2026/226 and set `invoiced` without clearing it. The old check
 * (`invoiced && !invoiceError`) let that bill through to a second invoice.
 *
 * `force` is the explicit override (no client sends it today). The
 * "Fatura Vendus X criada mas não registada" error is not affected: there the
 * number is not on the bill, so the retry is allowed and the admin is told to
 * check Vendus first.
 */
export function retryInvoiceRefusal(bill: BillData, force = false): RetryInvoiceRefusal | null {
  const status = bill?.status;
  if (status !== "paid" && status !== "invoiced") {
    return { code: "failed-precondition", message: `Cannot create invoice for status=${status}` };
  }
  if (force) return null;

  const invoiceNumber = bill?.invoiceNumber;
  const vendusId = bill?.vendusId;
  if (invoiceNumber || vendusId) {
    const ref = invoiceNumber
      ? `${invoiceNumber}${vendusId ? ` (Vendus id ${vendusId})` : ""}`
      : `Vendus id ${vendusId}`;
    return { code: "already-exists", message: `Invoice already created: ${ref}` };
  }
  if (status === "invoiced" && !bill?.invoiceError) {
    return { code: "already-exists", message: "Invoice already created (bill is invoiced)" };
  }
  return null;
}
