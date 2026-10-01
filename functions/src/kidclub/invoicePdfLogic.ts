// Pure helpers for getInvoicePdf (invoicePdf.ts), split out so they can be
// unit-tested without firebase-admin.

/** Hard ceiling on Vendus PDF downloads per UTC day, across all users. Each
 *  invoice is cached after its first download, so real use is roughly one
 *  call per new invoice (~40/month today); this only bites if something
 *  loops or the cache is broken. */
export const DAILY_VENDUS_PDF_CAP = 100;

/** Firestore docs max out at 1 MiB; leave room for the other fields. PDFs
 *  bigger than this are served but not cached. */
export const MAX_CACHEABLE_PDF_BYTES = 900 * 1024;

export interface AccessInput {
  uid: string;
  billingUserId?: string | null;
  familyPrimaryUserId?: string | null;
  roles?: Record<string, unknown> | null;
}

/** The bill's own user, the family's primary contact, or staff (owner /
 *  rainbowAdmin — covers admin impersonation, where the caller's uid is the
 *  admin's, not the family's). */
export function canAccessBilling({ uid, billingUserId, familyPrimaryUserId, roles }: AccessInput): boolean {
  if (!uid) return false;
  if (billingUserId && billingUserId === uid) return true;
  if (familyPrimaryUserId && familyPrimaryUserId === uid) return true;
  return !!(roles?.owner || roles?.rainbowAdmin);
}

/** "FR 01P2026/12" -> "Fatura-FR-01P2026-12.pdf". */
export function invoicePdfFilename(invoiceNumber: string | undefined | null, vendusId: number): string {
  const base = (invoiceNumber ?? "").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Fatura-${base || vendusId}.pdf`;
}

/** UTC day key for the daily call counter, e.g. "2026-09-29". */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
