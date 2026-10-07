import * as admin from "firebase-admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { appCol } from "./db";
import { createVendusInvoiceForBilling } from "./billing";
import { ADMIN_EMAIL } from "./notifications";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const COMPANY_NAME = "Arco-Íris da Pequenada";
const APP_URL = "https://kidclub.pt";

// ── Bank transfers ───────────────────────────────────────────────────────────
// A bank transfer never reaches Easypay, so nothing moves the bill to `paid`
// on its own. The parent pays by transfer (optionally uploading the proof),
// the admin sees the money in the bank and confirms it here, and the bill then
// follows the same path as an Easypay payment: `paid` → Vendus invoice →
// `invoiced`.

// Statuses a payment can still be recorded on. `failed` is an Easypay attempt
// that didn't complete — the bill is as unpaid as a `pending` one, and the
// money may well have arrived by transfer instead.
const OPEN_STATUSES = new Set(["pending", "processing", "failed"]);

// Proofs: Storage path, size and types. storage.rules enforces the same on
// upload; checked again here because the callable is what makes a file count.
export const PROOF_PATH_PREFIX = (billingId: string) => `_apps/arcoiris/billing/${billingId}/proofs/`;
const PROOF_MAX_BYTES = 10 * 1024 * 1024;
const PROOF_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif"]);
const MAX_PROOFS_PER_BILL = 20;

async function isKidclubAdmin(uid: string): Promise<boolean> {
  const roles = (await db.collection("users").doc(uid).get()).data()?.roles ?? {};
  return !!(roles.owner || roles.rainbowAdmin);
}

function todayInLisbon(): string {
  // formatToParts, not a locale's pattern: "en-CA" is yyyy-mm-dd on some ICU
  // versions and m/d/yyyy on others.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function proofBucket() {
  const name = admin.app().options.storageBucket || `${process.env.GCLOUD_PROJECT}.firebasestorage.app`;
  return admin.storage().bucket(name);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

// ── Admin: mark a bill paid (bank transfer received) ────────────────────────

export const markBillingPaid = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["VENDUS_API_KEY", "VENDUS_REGISTER_ID"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    if (!(await isKidclubAdmin(uid))) throw new HttpsError("permission-denied", "Unauthorized");

    const { billingId, paidAt, method, note } = request.data ?? {};
    if (!billingId || typeof billingId !== "string") throw new HttpsError("invalid-argument", "billingId required");
    if (method !== "bank_transfer") throw new HttpsError("invalid-argument", "method must be bank_transfer");
    if (typeof paidAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(paidAt) || isNaN(Date.parse(`${paidAt}T12:00:00Z`))) {
      throw new HttpsError("invalid-argument", "paidAt must be a yyyy-mm-dd date");
    }
    if (paidAt > todayInLisbon()) throw new HttpsError("invalid-argument", "A data de receção não pode ser no futuro.");
    if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
      throw new HttpsError("invalid-argument", "note must be a string up to 500 characters");
    }

    // Noon UTC: the same calendar day in Lisbon, summer or winter.
    const paidAtTs = Timestamp.fromDate(new Date(`${paidAt}T12:00:00Z`));
    const billingRef = appCol("billing").doc(billingId);

    // Double-click / two-admin safe: only the call that moves the bill out of
    // an open status goes on to invoice. A Portuguese invoice can't be deleted,
    // so two calls must never both reach Vendus. (createVendusInvoiceForBilling
    // also claims the bill atomically — this is the first of two locks.)
    await db.runTransaction(async (tx) => {
      const billing = (await tx.get(billingRef)).data();
      if (!billing) throw new HttpsError("not-found", "Billing record not found");
      if (!OPEN_STATUSES.has(billing.status)) {
        throw new HttpsError("failed-precondition", `Só é possível marcar como paga uma cobrança por pagar (estado atual: ${billing.status}).`);
      }
      tx.update(billingRef, {
        status: "paid",
        paidAt: paidAtTs,
        paymentMethod: method,
        manualPayment: {
          by: uid,
          at: FieldValue.serverTimestamp(),
          ...(note?.trim() ? { note: note.trim() } : {}),
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    console.log(`[markBillingPaid] billing ${billingId} → paid (bank transfer received ${paidAt}) by ${uid}`);

    // Same as the Easypay webhook: createVendusInvoiceForBilling stores
    // `invoiceError` itself on failure, and the existing "Tentar faturar
    // novamente" (retryVendusInvoice) covers it from there.
    try {
      await createVendusInvoiceForBilling(billingId);
    } catch (err: any) {
      console.error(`[markBillingPaid] Vendus invoice failed for billing ${billingId}:`, err.message);
    }

    const after = (await billingRef.get()).data() ?? {};
    return {
      ok: true,
      status: after.status as string,
      invoiceNumber: (after.invoiceNumber as string | undefined) ?? null,
      invoiceError: (after.invoiceError as string | undefined) ?? null,
    };
  }
);

// ── Parent or admin: attach an uploaded proof of payment ────────────────────
// The file itself is uploaded straight to Storage by the client (storage.rules
// decides who may upload where). This records it on the bill — billing docs
// are not client-writable — after checking ownership and that the object
// really exists. It never changes the bill's status: a parent's proof keeps the
// bill `pending` (with `proofSubmittedAt`) until an admin marks it paid.

export const attachPaymentProof = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { billingId, path, fileName } = request.data ?? {};
    if (!billingId || typeof billingId !== "string") throw new HttpsError("invalid-argument", "billingId required");
    if (typeof path !== "string" || !path.startsWith(PROOF_PATH_PREFIX(billingId)) || path.includes("..")
      || path.slice(PROOF_PATH_PREFIX(billingId).length).includes("/")) {
      throw new HttpsError("invalid-argument", "Invalid proof path");
    }
    const displayName = (typeof fileName === "string" && fileName.trim() ? fileName.trim() : path.split("/").pop()!).slice(0, 200);

    const billingRef = appCol("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new HttpsError("not-found", "Billing record not found");

    const isAdmin = await isKidclubAdmin(uid);
    if (!isAdmin) {
      if (billing.userId !== uid) throw new HttpsError("permission-denied", "Unauthorized");
      if (!OPEN_STATUSES.has(billing.status)) {
        throw new HttpsError("failed-precondition", "Esta mensalidade já não está por pagar.");
      }
    }

    // The object must exist and match what storage.rules allows.
    const file = proofBucket().file(path);
    const [exists] = await file.exists();
    if (!exists) throw new HttpsError("not-found", "O ficheiro não foi encontrado. Tente enviar de novo.");
    const [meta] = await file.getMetadata();
    if (Number(meta.size ?? 0) > PROOF_MAX_BYTES) throw new HttpsError("invalid-argument", "Ficheiro demasiado grande (máx. 10 MB).");
    if (!PROOF_CONTENT_TYPES.has(String(meta.contentType ?? ""))) {
      throw new HttpsError("invalid-argument", "Tipo de ficheiro não suportado (PDF, JPEG, PNG ou HEIC).");
    }

    const entry = {
      path,
      fileName: displayName,
      uploadedBy: uid,
      uploaderRole: isAdmin ? "admin" : "parent",
      // serverTimestamp() is not allowed inside an array element.
      uploadedAt: Timestamp.now(),
    };

    const added = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(billingRef)).data();
      if (!cur) throw new HttpsError("not-found", "Billing record not found");
      const proofs: any[] = cur.paymentProofs ?? [];
      if (proofs.some(p => p.path === path)) return false; // retried call
      if (proofs.length >= MAX_PROOFS_PER_BILL) throw new HttpsError("resource-exhausted", "Demasiados comprovativos nesta mensalidade.");
      tx.update(billingRef, {
        paymentProofs: [...proofs, entry],
        proofSubmittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });

    if (added && !isAdmin) {
      console.log(`[attachPaymentProof] parent ${uid} attached proof to billing ${billingId}`);
      await appCol("emailOutbox").add({
        to: ADMIN_EMAIL,
        subject: `Comprovativo de pagamento — ${billing.billingName ?? "Família"} — ${billing.periodLabel ?? ""}`,
        html: buildProofReceivedEmail({
          billingName: billing.billingName ?? "Família",
          periodLabel: billing.periodLabel ?? "",
          total: Number(billing.total ?? 0),
          fileName: displayName,
        }),
        status: "queued",
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    return { ok: true, added };
  }
);

function buildProofReceivedEmail(opts: { billingName: string; periodLabel: string; total: number; fileName: string }): string {
  const { billingName, periodLabel, total, fileName } = opts;
  return `<!DOCTYPE html><html lang="pt"><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:20px;">${COMPANY_NAME}</h1>
  <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">Comprovativo de pagamento recebido</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="font-size:15px;color:#374151;"><strong>${escapeHtml(billingName)}</strong> enviou um comprovativo de pagamento.</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;font-size:14px;color:#374151;">
    <tr><td style="padding:4px 0;color:#6b7280;">Mensalidade</td><td style="padding:4px 0;text-align:right;">${escapeHtml(periodLabel)}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Valor</td><td style="padding:4px 0;text-align:right;font-weight:700;">€${total.toFixed(2)}</td></tr>
    <tr><td style="padding:4px 0;color:#6b7280;">Ficheiro</td><td style="padding:4px 0;text-align:right;">${escapeHtml(fileName)}</td></tr>
  </table>
  <p style="font-size:14px;color:#6b7280;">Confirme a transferência no banco e marque a mensalidade como paga em Cobranças. A fatura é emitida nesse momento.</p>
  <p style="text-align:center;margin-top:24px;">
    <a href="${APP_URL}/admin/billing" style="background:#4f46e5;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Abrir Cobranças</a>
  </p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
