import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const COMPANY_NAME = "Arco-Íris da Pequenada";
const ADMIN_EMAIL = "admin@kidclub.pt";
const APP_URL = "https://kidclub.pt";

// ── Auth helpers ───────────────────────────────────────────────────────────────

async function isAdmin(uid: string): Promise<boolean> {
  const userDoc = await db.collection("users").doc(uid).get();
  const roles = userDoc.data()?.roles ?? {};
  return !!(roles.owner || roles.rainbowAdmin);
}

// ── Email template ─────────────────────────────────────────────────────────────

function emailWrapper(headerSub: string, body: string): string {
  return `<!DOCTYPE html><html lang="pt"><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:24px;">${COMPANY_NAME}</h1>
  <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">${headerSub}</p>
</td></tr>
<tr><td style="padding:32px 40px;">${body}</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;font-size:12px;color:#9ca3af;">${COMPANY_NAME} · NIF 518942120 · Avenida da Guarda Inglesa, Lote E, Coimbra</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

// ── createCampSubscription ────────────────────────────────────────────────────

export const createCampSubscription = onCall(
  {
    region: "europe-west3",
    invoker: "public",
    secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "EASYPAY_WEBHOOK_URL"],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const {
      campId,
      childName,
      childAge,
      parentName,
      parentEmail,
      parentPhone,
      subscriptionType,
      selectedDays,
      notes,
    } = request.data ?? {};

    if (!campId || !childName || !parentName || !parentEmail || !subscriptionType || !selectedDays?.length) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    // Get camp
    const campSnap = await appCol("camps").doc(campId).get();
    if (!campSnap.exists) throw new HttpsError("not-found", "Campo não encontrado");
    const camp = campSnap.data()!;
    const campName: string = camp.name ?? "";

    // Get family
    const famSnap = await appCol("families")
      .where("primaryContact.userId", "==", uid)
      .limit(1)
      .get();
    if (famSnap.empty) throw new HttpsError("not-found", "Família não encontrada");
    const familyId = famSnap.docs[0].id;

    // Capacity check + price calculation inside a transaction
    const { subscriptionId, depositBillingId } = await db.runTransaction(async (tx) => {
      // Read all campDay docs for selected days
      const dayRefs = (selectedDays as string[]).map((dayId: string) =>
        appCol("campDays").doc(dayId)
      );
      const daySnaps = await Promise.all(dayRefs.map((ref) => tx.get(ref)));

      let totalAmount = 0;

      for (const daySnap of daySnaps) {
        if (!daySnap.exists) throw new HttpsError("not-found", `Dia de campo não encontrado: ${daySnap.id}`);
        const dayData = daySnap.data()!;
        if (!dayData.active) throw new HttpsError("failed-precondition", `Dia ${daySnap.id} não está ativo`);

        // Count confirmed subscriptions for this day
        const confirmedSnap = await tx.get(
          appCol("campSubscriptions")
            .where("selectedDays", "array-contains", daySnap.id)
            .where("status", "==", "confirmed")
        );
        const confirmedCount = confirmedSnap.size;
        const capacity = Number(dayData.capacity ?? 0);

        if (confirmedCount >= capacity) {
          throw new HttpsError("resource-exhausted", `Capacidade esgotada para o dia ${dayData.date ?? daySnap.id}`);
        }

        totalAmount += Number(dayData.price ?? 0);
      }

      const depositAmount = Math.round(totalAmount * 0.25 * 100) / 100;
      const balanceAmount = Math.round((totalAmount - depositAmount) * 100) / 100;
      const now = admin.firestore.Timestamp.now();
      const dueDate = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      );

      // Create campSubscription
      const subRef = appCol("campSubscriptions").doc();
      tx.set(subRef, {
        campId,
        familyId,
        userId: uid,
        childName,
        ...(childAge != null ? { childAge: Number(childAge) } : {}),
        parentName,
        parentEmail,
        ...(parentPhone ? { parentPhone } : {}),
        subscriptionType,
        selectedDays,
        totalAmount,
        depositAmount,
        balanceAmount,
        status: "pending",
        ...(notes ? { notes } : {}),
        createdAt: now,
        updatedAt: now,
      });

      // Create deposit billing record
      const billingRef = appCol("billing").doc();
      tx.set(billingRef, {
        familyId,
        userId: uid,
        campSubscriptionId: subRef.id,
        campId,
        type: "camp_deposit",
        periodLabel: `Sinal Campo — ${campName} — ${childName}`,
        periodStart: now,
        periodEnd: now,
        dueDate,
        total: depositAmount,
        lineItems: [
          { title: `Sinal Campo — ${campName} — ${childName}`, amount: depositAmount },
        ],
        billingName: parentName,
        billingEmail: parentEmail,
        paymentMethod: "mbway",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });

      // Back-reference billing in subscription
      tx.update(subRef, { depositBillingId: billingRef.id });

      return { subscriptionId: subRef.id, depositBillingId: billingRef.id };
    });

    console.log(`[createCampSubscription] created sub=${subscriptionId} deposit=${depositBillingId} family=${familyId}`);
    return { subscriptionId, depositBillingId };
  }
);

// ── confirmCampSubscription ────────────────────────────────────────────────────

export const confirmCampSubscription = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    if (!(await isAdmin(uid))) throw new HttpsError("permission-denied", "Unauthorized");

    const { subscriptionId } = request.data ?? {};
    if (!subscriptionId) throw new HttpsError("invalid-argument", "subscriptionId required");

    const subRef = appCol("campSubscriptions").doc(subscriptionId);
    const subSnap = await subRef.get();
    if (!subSnap.exists) throw new HttpsError("not-found", "Subscription not found");
    const sub = subSnap.data()!;

    if (sub.status !== "pending") {
      throw new HttpsError("failed-precondition", `Subscription status is '${sub.status}', expected 'pending'`);
    }

    const now = admin.firestore.Timestamp.now();
    await subRef.update({ status: "confirmed", updatedAt: now });

    // Get camp name
    const campSnap = await appCol("camps").doc(sub.campId).get();
    const campName: string = campSnap.data()?.name ?? sub.campId;

    // Get selected day dates for email
    const daySnaps = await Promise.all(
      (sub.selectedDays as string[]).map((id: string) => appCol("campDays").doc(id).get())
    );
    const dayDates = daySnaps
      .filter((s) => s.exists)
      .map((s) => {
        const d = s.data()!;
        return d.date ? d.date : s.id;
      })
      .sort();

    const datesHtml = dayDates
      .map((d: string) => `<li style="font-size:13px;color:#374151;">${d}</li>`)
      .join("");

    const body = `
      <p style="font-size:16px;color:#374151;">A inscrição de <strong>${sub.childName}</strong> no campo <strong>${campName}</strong> foi confirmada!</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:24px 0;">
        <p style="margin:0 0 8px;font-size:14px;color:#166534;font-weight:600;">Detalhes da inscrição</p>
        <table style="font-size:13px;color:#374151;width:100%;border-collapse:collapse;">
          <tr><td style="padding:4px 0;color:#6b7280;width:140px;">Criança</td><td>${sub.childName}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Campo</td><td>${campName}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Tipo de inscrição</td><td>${sub.subscriptionType === "day" ? "Dia(s)" : sub.subscriptionType === "week" ? "Semana(s)" : "Campo Completo"}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Dias selecionados</td><td><ul style="margin:0;padding-left:16px;">${datesHtml}</ul></td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Total</td><td><strong>€${(sub.totalAmount ?? 0).toFixed(2)}</strong></td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Sinal a pagar</td><td><strong>€${(sub.depositAmount ?? 0).toFixed(2)}</strong></td></tr>
        </table>
      </div>
      <p style="text-align:center;margin-top:24px;">
        <a href="${APP_URL}/client/payments" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Pagar sinal</a>
      </p>`;

    await appCol("emailOutbox").add({
      to: sub.parentEmail,
      subject: `Inscrição confirmada — ${campName}`,
      html: emailWrapper(`Inscrição confirmada — ${campName}`, body),
      status: "queued",
      createdAt: now,
    });

    return { ok: true };
  }
);

// ── cancelCampSubscription ─────────────────────────────────────────────────────

export const cancelCampSubscription = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { subscriptionId, reason } = request.data ?? {};
    if (!subscriptionId) throw new HttpsError("invalid-argument", "subscriptionId required");

    const admin_ = await isAdmin(uid);

    const subRef = appCol("campSubscriptions").doc(subscriptionId);
    const subSnap = await subRef.get();
    if (!subSnap.exists) throw new HttpsError("not-found", "Subscription not found");
    const sub = subSnap.data()!;

    // Non-admin can only cancel their own subscription
    if (!admin_ && sub.userId !== uid) {
      throw new HttpsError("permission-denied", "Unauthorized");
    }

    if (sub.status === "cancelled") {
      return { ok: true }; // idempotent
    }

    const now = admin.firestore.Timestamp.now();
    const updates: Record<string, any> = { status: "cancelled", updatedAt: now };
    if (reason) updates.statusReason = reason;

    let depositRefundPending = false;

    // Cancel deposit billing if present and cancellable
    if (sub.depositBillingId) {
      const depositRef = appCol("billing").doc(sub.depositBillingId);
      const depositSnap = await depositRef.get();
      if (depositSnap.exists) {
        const depositStatus = depositSnap.data()!.status;
        if (depositStatus === "pending" || depositStatus === "processing") {
          await depositRef.update({ status: "cancelled", updatedAt: now });
        } else if (depositStatus === "paid" || depositStatus === "invoiced") {
          depositRefundPending = true;
        }
      }
    }

    if (depositRefundPending) {
      updates.depositRefundPending = true;
    }

    // Cancel balance billing if present and pending
    if (sub.balanceBillingId) {
      const balanceRef = appCol("billing").doc(sub.balanceBillingId);
      const balanceSnap = await balanceRef.get();
      if (balanceSnap.exists && balanceSnap.data()!.status === "pending") {
        await balanceRef.update({ status: "cancelled", updatedAt: now });
      }
    }

    await subRef.update(updates);
    return { ok: true };
  }
);

// ── createCampBalanceBillings (scheduled) ─────────────────────────────────────

export const createCampBalanceBillings = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Europe/Lisbon", region: "europe-west3" },
  async () => {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    console.log(`[createCampBalanceBillings] running for date=${today}`);

    const subsSnap = await appCol("campSubscriptions")
      .where("status", "==", "confirmed")
      .get();

    let created = 0;
    let skipped = 0;

    for (const subDoc of subsSnap.docs) {
      const sub = subDoc.data();

      // Skip if balance billing already exists
      if (sub.balanceBillingId) {
        skipped++;
        continue;
      }

      let shouldBill = false;

      if (sub.subscriptionType === "full") {
        // Bill after camp end date
        const campSnap = await appCol("camps").doc(sub.campId).get();
        if (!campSnap.exists) continue;
        const camp = campSnap.data()!;
        shouldBill = camp.endDate < today;
      } else {
        // For day and week: get the dates of selected days
        const daySnaps = await Promise.all(
          (sub.selectedDays as string[]).map((id: string) => appCol("campDays").doc(id).get())
        );
        const dates: string[] = daySnaps
          .filter((s) => s.exists)
          .map((s) => String(s.data()!.date ?? ""))
          .filter(Boolean);

        if (dates.length === 0) continue;
        const latestDate = dates.sort().pop()!;
        shouldBill = latestDate < today;
      }

      if (!shouldBill) {
        skipped++;
        continue;
      }

      // Get camp name
      const campSnap = await appCol("camps").doc(sub.campId).get();
      const campName: string = campSnap.data()?.name ?? sub.campId;

      const now = admin.firestore.Timestamp.now();
      const dueDate = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      );

      const billingRef = await appCol("billing").add({
        familyId: sub.familyId,
        userId: sub.userId,
        campSubscriptionId: subDoc.id,
        campId: sub.campId,
        type: "camp_balance",
        periodLabel: `Campo — ${campName} — ${sub.childName}`,
        periodStart: now,
        periodEnd: now,
        dueDate,
        total: sub.balanceAmount,
        lineItems: [
          { title: `Campo — ${campName} — ${sub.childName}`, amount: sub.balanceAmount },
        ],
        billingName: sub.parentName,
        billingEmail: sub.parentEmail,
        paymentMethod: "mbway",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });

      await appCol("campSubscriptions").doc(subDoc.id).update({
        balanceBillingId: billingRef.id,
        updatedAt: now,
      });

      // Notify client
      const body = `
        <p style="font-size:16px;color:#374151;">O saldo da inscrição de <strong>${sub.childName}</strong> no campo <strong>${campName}</strong> está agora disponível para pagamento.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:24px 0;">
          <table style="font-size:13px;color:#374151;width:100%;border-collapse:collapse;">
            <tr><td style="padding:4px 0;color:#6b7280;width:140px;">Criança</td><td>${sub.childName}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;">Campo</td><td>${campName}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;">Saldo a pagar</td><td><strong>€${(sub.balanceAmount ?? 0).toFixed(2)}</strong></td></tr>
          </table>
        </div>
        <p style="text-align:center;margin-top:24px;">
          <a href="${APP_URL}/client/payments" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Pagar agora</a>
        </p>`;

      await appCol("emailOutbox").add({
        to: sub.parentEmail,
        subject: `Saldo disponível — ${campName} — ${sub.childName}`,
        html: emailWrapper(`Saldo disponível — ${COMPANY_NAME}`, body),
        status: "queued",
        createdAt: now,
      });

      created++;
      console.log(`[createCampBalanceBillings] created balance billing for sub=${subDoc.id} billing=${billingRef.id}`);
    }

    console.log(`[createCampBalanceBillings] done — created=${created} skipped=${skipped}`);
  }
);
