import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { appCol } from "./db";
import { getDocumentPdf } from "./vendus";
import { canAccessBilling, invoicePdfFilename, dayKey, DAILY_VENDUS_PDF_CAP, MAX_CACHEABLE_PDF_BYTES } from "./invoicePdfLogic";
import { tokenMatches } from "./adhocEventLogic";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Cache: _apps/arcoiris/invoicePdfs/{vendusId} = { pdf: Bytes, billingId, invoiceNumber, sizeBytes, cachedAt }.
// Keyed by the Vendus document id, not the billing id: an issued invoice
// never changes, and if a bill were ever re-invoiced it would get a new
// vendusId and so a fresh cache entry. No client rule matches this
// collection, so it is server-only (deny by default).
const cacheCol = () => appCol("invoicePdfs");
// Daily counter: _apps/arcoiris/rateLimits/invoicePdf_{YYYY-MM-DD} = { count }.
const counterDoc = (day: string) => appCol("rateLimits").doc(`invoicePdf_${day}`);

/** Reserve one Vendus call against today's cap; throws once the cap is hit. */
async function reserveVendusCall(): Promise<void> {
  const ref = counterDoc(dayKey(new Date()));
  await db.runTransaction(async (tx) => {
    const count = ((await tx.get(ref)).data()?.count as number | undefined) ?? 0;
    if (count >= DAILY_VENDUS_PDF_CAP) {
      throw new HttpsError("resource-exhausted", "Limite diário de descargas de faturas atingido. Tente novamente amanhã.");
    }
    tx.set(ref, { count: count + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
}

/**
 * Returns the Vendus invoice PDF for one billing record, base64-encoded.
 * Served from the Firestore cache when present; otherwise fetched from Vendus
 * once (single attempt, 15s timeout, daily cap) and cached.
 */
export const getInvoicePdf = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["VENDUS_API_KEY"] },
  async (request) => {
    const uid = request.auth?.uid ?? "";
    const { billingId, registrationId, token } = (request.data ?? {}) as { billingId?: string; registrationId?: string; token?: string };
    // A one-off event's guest has no account: the registration's link token is
    // their only key, and it opens that registration's own bill only.
    const viaToken = !!registrationId && !!token;
    if (!uid && !viaToken) throw new HttpsError("unauthenticated", "Unauthenticated");
    if (!billingId || typeof billingId !== "string") throw new HttpsError("invalid-argument", "billingId required");

    const billing = (await appCol("billing").doc(billingId).get()).data();
    if (!billing) throw new HttpsError("not-found", "Mensalidade não encontrada.");

    let allowed = false;
    if (viaToken) {
      const reg = (await appCol("adhocEventRegistrations").doc(String(registrationId)).get()).data();
      allowed = !!reg && reg.billingId === billingId && billing.eventRegistrationId === registrationId && tokenMatches(reg.accessToken, token);
    }
    // Cheapest checks first: only read the family / user docs when needed.
    if (!allowed && uid) allowed = canAccessBilling({ uid, billingUserId: billing.userId });
    if (!allowed && uid && billing.familyId) {
      const fam = (await appCol("families").doc(billing.familyId).get()).data();
      allowed = canAccessBilling({ uid, familyPrimaryUserId: fam?.primaryContact?.userId });
    }
    if (!allowed && uid) {
      const roles = (await db.collection("users").doc(uid).get()).data()?.roles;
      allowed = canAccessBilling({ uid, roles });
    }
    if (!allowed) throw new HttpsError("permission-denied", "Unauthorized");

    const vendusId = Number(billing.vendusId);
    if (!billing.vendusId || !Number.isFinite(vendusId)) {
      throw new HttpsError("failed-precondition", "Esta mensalidade ainda não tem fatura emitida.");
    }
    const filename = invoicePdfFilename(billing.invoiceNumber, vendusId);

    const cacheRef = cacheCol().doc(String(vendusId));
    const cached = (await cacheRef.get()).data();
    if (cached?.pdf) {
      const buf: Buffer = Buffer.from(cached.pdf as Uint8Array);
      console.log(`[invoicePdf] cache hit billingId=${billingId} vendusId=${vendusId} uid=${uid}`);
      return { filename, contentType: "application/pdf", base64: buf.toString("base64") };
    }

    await reserveVendusCall();
    let pdf: Buffer;
    try {
      pdf = await getDocumentPdf(vendusId);
    } catch (err: any) {
      console.error(`[invoicePdf] Vendus fetch failed billingId=${billingId} vendusId=${vendusId}:`, err?.message ?? err);
      throw new HttpsError("unavailable", "Não foi possível obter a fatura neste momento. Tente mais tarde.");
    }
    console.log(`[invoicePdf] fetched from Vendus billingId=${billingId} vendusId=${vendusId} bytes=${pdf.length} uid=${uid}`);

    if (pdf.length <= MAX_CACHEABLE_PDF_BYTES) {
      try {
        await cacheRef.set({
          pdf,
          billingId,
          invoiceNumber: billing.invoiceNumber ?? null,
          sizeBytes: pdf.length,
          cachedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err: any) {
        // Serving the PDF matters more than caching it; the daily cap still bounds Vendus calls.
        console.error(`[invoicePdf] cache write failed vendusId=${vendusId}:`, err?.message ?? err);
      }
    } else {
      console.warn(`[invoicePdf] not caching vendusId=${vendusId}: ${pdf.length} bytes exceeds ${MAX_CACHEABLE_PDF_BYTES}`);
    }

    return { filename, contentType: "application/pdf", base64: pdf.toString("base64") };
  }
);
