import * as admin from "firebase-admin";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { createInvoice, createOrUpdateClient, VendusLineItem, VendusClient, PRODUCT_STUDY, PRODUCT_TRANSPORT } from "./vendus";
import { createMbwayPayment, createMultibancoPayment, createCardPayment, EasypayWebhookPayload } from "./easypay";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const COMPANY_NAME = "Arco-Íris da Pequenada";

// ── Helpers (shared with generateMonthlyInvoices) ─────────────────────────────

function periodForDate(date: Date) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 0);
  const months = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  return {
    label: `${months[m]} ${y}`,
    start,
    end,
    isoDate: `${y}-${String(m + 1).padStart(2, "0")}-01`,
  };
}

function dayLabel(day: string): string {
  const map: Record<string, string> = { monday:"2ª", tuesday:"3ª", wednesday:"4ª", thursday:"5ª", friday:"6ª" };
  return map[day] ?? day;
}

// Returns all months from fromDate through August of the following year
function periodsUntilSchoolYearEnd(fromDate: Date): ReturnType<typeof periodForDate>[] {
  const periods: ReturnType<typeof periodForDate>[] = [];
  const endYear = fromDate.getFullYear() + 1;
  const endDate = new Date(endYear, 7, 1); // August 1 of next year
  const cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
  while (cursor <= endDate) {
    periods.push(periodForDate(new Date(cursor)));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return periods;
}

async function getActiveSubs() {
  const [studySnap, transportSnap] = await Promise.all([
    db.collection("studyroom").where("status", "in", ["active", "confirmed"]).get(),
    db.collection("transportationSubscriptions").where("status", "==", "active").get(),
  ]);
  const byFamily: Record<string, { familyId: string; userId: string; study: any[]; transport: any[] }> = {};
  const ensure = (fid: string, uid: string) => {
    if (!byFamily[fid]) byFamily[fid] = { familyId: fid, userId: uid, study: [], transport: [] };
  };
  for (const d of studySnap.docs) { const x = d.data(); ensure(x.familyId, x.userId ?? ""); byFamily[x.familyId].study.push({ id: d.id, ...x }); }
  for (const d of transportSnap.docs) { const x = d.data(); ensure(x.familyId, x.userId ?? ""); byFamily[x.familyId].transport.push({ id: d.id, ...x }); }
  return Object.values(byFamily);
}

// ── Build Vendus invoice for a billing record ─────────────────────────────────

async function createVendusInvoiceForBilling(billingId: string): Promise<void> {
  const billingRef = db.collection("billing").doc(billingId);
  const billing = (await billingRef.get()).data();
  if (!billing) throw new Error(`Billing record ${billingId} not found`);

  const { familyId, userId, lineItems, total, billingName, billingEmail, periodLabel } = billing;

  const famSnap = await db.collection("families").doc(familyId).get();
  const fam = famSnap.data() ?? {};
  const clientNif: string = fam.nif ?? "999999990";

  let vendusClientId: number | null = fam.vendusClientId ?? null;
  if (!vendusClientId) {
    vendusClientId = await createOrUpdateClient(familyId, {
      name: billingName,
      email: billingEmail,
      ...(clientNif !== "999999990" ? { fiscal_id: clientNif } : {}),
    });
    await db.collection("families").doc(familyId).update({ vendusClientId });
  }

  const vendusClient: VendusClient = { id: vendusClientId };
  const items: VendusLineItem[] = lineItems.map((li: any) => ({
    id: li.title.startsWith("Transporte") ? PRODUCT_TRANSPORT : PRODUCT_STUDY,
    title: li.title,
    qty: 1,
    gross_price: li.amount,
  }));

  const period = periodForDate(new Date(billing.periodStart.toDate()));
  const vendusDoc = await createInvoice(vendusClient, items, period.isoDate, `Período: ${periodLabel}`);
  if (vendusDoc.errors?.length) throw new Error(vendusDoc.errors.map((e: any) => e.message).join("; "));

  const invoiceNumber = vendusDoc.number;

  await billingRef.update({
    status: "invoiced",
    invoiceNumber,
    vendusId: vendusDoc.id,
    atcud: vendusDoc.atcud ?? null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Queue invoice email
  if (billingEmail) {
    await db.collection("emailOutbox").add({
      to: billingEmail,
      subject: `Fatura ${invoiceNumber} — ${COMPANY_NAME} — ${periodLabel}`,
      html: buildInvoiceEmail({ clientName: billingName, invoiceNumber, periodLabel, total, lineItems }),
      status: "queued",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

// ── Compute line items for a group (pure, no DB access) ──────────────────────

function computeLineItems(
  group: { study: any[]; transport: any[] },
  period: ReturnType<typeof periodForDate>,
): { lineItems: { title: string; amount: number }[]; total: number } {
  const lineItems: { title: string; amount: number }[] = [];
  let total = 0;
  for (const sub of group.study) {
    const amount = sub.monthlyPrice ?? 0;
    const daysStr = (sub.days ?? []).map((d: any) => dayLabel(d.day)).join(", ");
    lineItems.push({ title: `Sala de Estudo — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`, amount });
    total += amount;
  }
  for (const sub of group.transport) {
    const amount = sub.monthlyFee ?? 0;
    const daysStr = (sub.schedule ?? []).map((s: any) => dayLabel(s.dayOfWeek)).join(", ");
    lineItems.push({ title: `Transporte Escolar — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`, amount });
    total += amount;
  }
  return { lineItems, total };
}

// ── Send billing notices for a period ────────────────────────────────────────

async function buildBillingRecord(
  group: { familyId: string; userId: string; study: any[]; transport: any[] },
  period: ReturnType<typeof periodForDate>,
  dryRun: boolean,
  opts: { docId?: string; sendEmail?: boolean } = {},
): Promise<string | undefined> {
  const { familyId, userId, study, transport } = group;
  const { docId, sendEmail = !dryRun } = opts;

  const famSnap = await db.collection("families").doc(familyId).get();
  if (!famSnap.exists) { console.warn(`Family ${familyId} not found`); return; }
  const fam = famSnap.data()!;
  const contact = fam.primaryContact ?? {};
  const billingName: string = contact.name ?? "Família";
  const billingEmail: string = contact.email ?? "";
  const paymentMethod: string = fam.paymentMethod ?? "mbway";

  const { lineItems, total } = computeLineItems({ study, transport }, period);
  if (lineItems.length === 0 || total === 0) { console.log(`No billable items for family ${familyId}`); return; }

  const dueDate = new Date(period.start);
  dueDate.setDate(8);

  const billingRef = docId
    ? db.collection("billing").doc(docId)
    : db.collection("billing").doc();

  await billingRef.set({
    familyId,
    userId,
    periodLabel: period.label,
    periodStart: admin.firestore.Timestamp.fromDate(period.start),
    periodEnd: admin.firestore.Timestamp.fromDate(period.end),
    dueDate: admin.firestore.Timestamp.fromDate(dueDate),
    total,
    lineItems,
    billingName,
    billingEmail,
    paymentMethod,
    status: dryRun ? "dry-run" : "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (sendEmail && billingEmail) {
    await db.collection("emailOutbox").add({
      to: billingEmail,
      subject: `Pagamento pendente — ${COMPANY_NAME} — ${period.label}`,
      html: buildPaymentNoticeEmail({ clientName: billingName, periodLabel: period.label, total, lineItems, billingId: billingRef.id }),
      status: "queued",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return billingRef.id;
}

export const sendBillingNotices = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new Error("Unauthorized");

    const { year, month, dryRun = false } = request.data ?? {};
    const date = year && month ? new Date(year, month - 1, 1) : new Date();
    const period = periodForDate(date);

    const groups = await getActiveSubs();
    let sent = 0, failed = 0;

    for (const g of groups) {
      try {
        const docId = `${g.familyId}_${period.isoDate.slice(0, 7)}`;
        const existing = await db.collection("billing").doc(docId).get();

        if (existing.exists && existing.data()?.status === "pending" && !dryRun) {
          // Record already created by trigger — just queue the email
          const d = existing.data()!;
          if (d.billingEmail) {
            await db.collection("emailOutbox").add({
              to: d.billingEmail,
              subject: `Pagamento pendente — ${COMPANY_NAME} — ${period.label}`,
              html: buildPaymentNoticeEmail({ clientName: d.billingName, periodLabel: period.label, total: d.total, lineItems: d.lineItems, billingId: existing.id }),
              status: "queued",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        } else if (!existing.exists) {
          await buildBillingRecord(g, period, dryRun, { docId, sendEmail: !dryRun });
        }
        sent++;
      } catch (err) {
        console.error(`Failed for family ${g.familyId}:`, err);
        failed++;
      }
    }

    return { sent, failed, period: period.label, dryRun };
  }
);

// ── Client initiates MBWay payment ───────────────────────────────────────────

export const initiateMbwayPayment = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");

    const { billingId, phone } = request.data ?? {};
    if (!billingId || !phone) throw new Error("billingId and phone required");

    const billingRef = db.collection("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new Error("Billing record not found");
    if (billing.userId !== uid) throw new Error("Unauthorized");
    if (billing.status !== "pending") throw new Error("Already processed");

    const res = await createMbwayPayment(
      { name: billing.billingName, email: billing.billingEmail, phone },
      billing.total,
      `${COMPANY_NAME} — ${billing.periodLabel}`,
    );

    await billingRef.update({
      status: "processing",
      easypayId: res.id,
      mbwayPhone: phone,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { easypayId: res.id };
  }
);

// ── Client initiates Multibanco payment ──────────────────────────────────────

export const initiateMultibancoPayment = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");

    const { billingId } = request.data ?? {};
    const billingRef = db.collection("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new Error("Billing record not found");
    if (billing.userId !== uid) throw new Error("Unauthorized");
    if (billing.status !== "pending") throw new Error("Already processed");

    const dueDate = billing.dueDate.toDate();
    const expiry = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, "0")}-${String(dueDate.getDate()).padStart(2, "0")} 23:59`;

    const res = await createMultibancoPayment(
      { name: billing.billingName, email: billing.billingEmail },
      billing.total,
      `${COMPANY_NAME} — ${billing.periodLabel}`,
      expiry,
    );

    await billingRef.update({
      status: "processing",
      easypayId: res.id,
      multibancoEntity: res.method?.entity,
      multibancoReference: res.method?.reference,
      multibancoExpiry: admin.firestore.Timestamp.fromDate(dueDate),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      entity: res.method?.entity,
      reference: res.method?.reference,
      expiry,
    };
  }
);

// ── Client initiates card payment ─────────────────────────────────────────────

export const initiateCardPayment = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");

    const { billingId } = request.data ?? {};
    const billingRef = db.collection("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new Error("Billing record not found");
    if (billing.userId !== uid) throw new Error("Unauthorized");
    if (billing.status !== "pending") throw new Error("Already processed");

    const res = await createCardPayment(
      { name: billing.billingName, email: billing.billingEmail },
      billing.total,
      `${COMPANY_NAME} — ${billing.periodLabel}`,
    );

    const paymentLink = res.method?.url ?? "";

    await billingRef.update({
      status: "processing",
      easypayId: res.id,
      paymentLink,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { paymentLink };
  }
);

// ── Easypay webhook ───────────────────────────────────────────────────────────

export const easypayWebhook = onRequest(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "VENDUS_API_KEY", "VENDUS_REGISTER_ID"] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    const payload = req.body as EasypayWebhookPayload;
    console.log("Easypay webhook:", JSON.stringify(payload));

    const { event, payment } = payload;

    if (event === "payment_success" && payment?.status === "paid") {
      const snap = await db.collection("billing")
        .where("easypayId", "==", payment.id)
        .limit(1)
        .get();

      if (snap.empty) {
        console.warn(`No billing record for easypayId ${payment.id}`);
        res.status(200).send("ok");
        return;
      }

      const billingDoc = snap.docs[0];
      await billingDoc.ref.update({
        status: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      try {
        await createVendusInvoiceForBilling(billingDoc.id);
      } catch (err) {
        console.error(`Vendus invoice failed for billing ${billingDoc.id}:`, err);
        // Don't fail the webhook — payment is confirmed, invoice can be retried
      }
    }

    if (event === "payment_failed" || event === "payment_expired") {
      const snap = await db.collection("billing")
        .where("easypayId", "==", payment?.id)
        .limit(1)
        .get();

      if (!snap.empty) {
        await snap.docs[0].ref.update({
          status: "failed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    res.status(200).send("ok");
  }
);

// ── Create party deposit billing record ──────────────────────────────────────

export const createPartyDeposit = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");

    const { bookingId } = request.data ?? {};
    if (!bookingId) throw new Error("bookingId required");

    const bookingSnap = await db.collection("bookings").doc(bookingId).get();
    if (!bookingSnap.exists) throw new Error("Booking not found");
    const booking = bookingSnap.data()!;

    // Verify ownership — booking must have userId or familyId linked to caller
    if (booking.userId !== uid) {
      const famSnap = await db.collection("families")
        .where("primaryContact.userId", "==", uid)
        .limit(1)
        .get();
      if (famSnap.empty || famSnap.docs[0].id !== booking.familyId) {
        throw new Error("Unauthorized");
      }
    }

    if (booking.status !== "confirmed") {
      throw new Error("A reserva ainda não foi confirmada.");
    }

    // Return existing deposit billing if already created
    const existing = await db.collection("billing")
      .where("bookingId", "==", bookingId)
      .where("type", "==", "party_deposit")
      .limit(1)
      .get();
    if (!existing.empty) {
      return { billingId: existing.docs[0].id };
    }

    const depositAmount = Math.round(booking.total * 0.5 * 100) / 100;
    const partyDate = new Date(booking.date);
    const dateStr = partyDate.toLocaleDateString("pt-PT");
    const now = admin.firestore.Timestamp.now();
    const dueDate = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    );

    const billingRef = await db.collection("billing").add({
      familyId: booking.familyId,
      userId: uid,
      bookingId,
      type: "party_deposit",
      periodLabel: `Sinal — Festa de ${booking.childName} — ${dateStr}`,
      periodStart: now,
      periodEnd: admin.firestore.Timestamp.fromDate(partyDate),
      dueDate,
      total: depositAmount,
      lineItems: [
        { title: `Sinal 50% — ${booking.partyType || "Festa"}`, amount: depositAmount },
      ],
      billingName: booking.parentName,
      billingEmail: booking.email,
      paymentMethod: "mbway",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    return { billingId: billingRef.id };
  }
);

// ── Set family payment method ─────────────────────────────────────────────────

export const setPaymentMethod = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");

    const { method, mbwayPhone } = request.data ?? {};
    if (!["mbway", "multibanco", "card", "subscription"].includes(method)) {
      throw new Error("Invalid payment method");
    }

    const familySnap = await db.collection("families").where("userId", "==", uid).limit(1).get();
    if (familySnap.empty) throw new Error("Family not found");

    const update: Record<string, any> = { paymentMethod: method, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (method === "mbway" && mbwayPhone) update.mbwayPhone = mbwayPhone;

    await familySnap.docs[0].ref.update(update);
    return { ok: true };
  }
);

// ── Auto-billing on subscription confirmation ─────────────────────────────────

async function autoCreateBillingSchedule(familyId: string, userId: string): Promise<void> {
  const [studySnap, transportSnap] = await Promise.all([
    db.collection("studyroom").where("familyId", "==", familyId).where("status", "in", ["active", "confirmed"]).get(),
    db.collection("transportationSubscriptions").where("familyId", "==", familyId).where("status", "==", "active").get(),
  ]);

  const group = {
    familyId,
    userId,
    study: studySnap.docs.map(d => ({ id: d.id, ...d.data() })),
    transport: transportSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };

  const periods = periodsUntilSchoolYearEnd(new Date());
  let created = 0, updated = 0;

  for (const period of periods) {
    const docId = `${familyId}_${period.isoDate.slice(0, 7)}`;
    const existing = await db.collection("billing").doc(docId).get();

    if (existing.exists) {
      // Only update records still pending — don't touch anything already being processed/paid
      if (existing.data()?.status === "pending") {
        const { lineItems, total } = computeLineItems(group, period);
        if (lineItems.length > 0 && total > 0) {
          await db.collection("billing").doc(docId).update({ lineItems, total, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          updated++;
        }
      }
      continue;
    }

    await buildBillingRecord(group, period, false, { docId, sendEmail: false });
    created++;
  }

  console.log(`Billing schedule for family ${familyId}: ${created} created, ${updated} updated`);
}

// ── Backfill billing schedules for all existing active subscriptions ──────────

export const backfillBillingSchedules = onCall(
  { region: "europe-west3", invoker: "public", timeoutSeconds: 120 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new Error("Unauthorized");

    const groups = await getActiveSubs();
    let created = 0, updated = 0, skipped = 0, failed = 0;

    for (const group of groups) {
      try {
        const periods = periodsUntilSchoolYearEnd(new Date());
        for (const period of periods) {
          const docId = `${group.familyId}_${period.isoDate.slice(0, 7)}`;
          const existing = await db.collection("billing").doc(docId).get();
          if (existing.exists) {
            if (existing.data()?.status === "pending") {
              const { lineItems, total } = computeLineItems(group, period);
              if (lineItems.length > 0 && total > 0) {
                await db.collection("billing").doc(docId).update({ lineItems, total, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                updated++;
              }
            } else {
              skipped++;
            }
            continue;
          }
          await buildBillingRecord(group, period, false, { docId, sendEmail: false });
          created++;
        }
      } catch (err) {
        console.error(`Backfill failed for family ${group.familyId}:`, err);
        failed++;
      }
    }

    return { created, updated, skipped, failed, families: groups.length };
  }
);

export const onStudyroomConfirmed = onDocumentUpdated(
  { document: "studyroom/{entryId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    if (before.status === after.status || !["active", "confirmed"].includes(after.status)) return;
    const familyId: string = after.familyId;
    if (!familyId) { console.warn("studyroom doc missing familyId"); return; }
    await autoCreateBillingSchedule(familyId, after.userId ?? "");
  }
);

export const onTransportConfirmed = onDocumentUpdated(
  { document: "transportationSubscriptions/{subId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    if (before.status === after.status || after.status !== "active") return;
    const familyId: string = after.familyId;
    if (!familyId) { console.warn("transportationSubscriptions doc missing familyId"); return; }
    await autoCreateBillingSchedule(familyId, after.userId ?? "");
  }
);

// ── Email templates ───────────────────────────────────────────────────────────

function buildPaymentNoticeEmail(opts: {
  clientName: string;
  periodLabel: string;
  total: number;
  lineItems: { title: string; amount: number }[];
  billingId: string;
}): string {
  const { clientName, periodLabel, total, lineItems } = opts;
  const rows = lineItems.map(li =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${li.title}</td>
     <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;text-align:right;color:#374151;">€${li.amount.toFixed(2)}</td></tr>`
  ).join("");

  return `<!DOCTYPE html><html lang="pt"><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:24px;">${COMPANY_NAME}</h1>
  <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">Pagamento pendente — ${periodLabel}</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="font-size:16px;color:#374151;">Olá, <strong>${clientName}</strong>,</p>
  <p style="font-size:14px;color:#6b7280;">O pagamento referente ao mês de <strong>${periodLabel}</strong> está disponível na sua área de cliente.</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">${rows}</table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
    <tr><td style="padding:16px;background:#4f46e5;border-radius:8px;">
      <table width="100%"><tr>
        <td style="color:#c4b5fd;font-size:14px;">Total a pagar</td>
        <td style="color:#fff;font-size:24px;font-weight:700;text-align:right;">€${total.toFixed(2)}</td>
      </tr></table>
    </td></tr>
  </table>
  <p style="text-align:center;">
    <a href="https://kidclub.pt/client/payments" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Pagar agora</a>
  </p>
  <p style="font-size:12px;color:#9ca3af;margin-top:24px;">Pode escolher pagar via MB WAY, Multibanco ou Cartão na sua área de cliente.</p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;font-size:12px;color:#9ca3af;">${COMPANY_NAME} · NIF 518942120 · Avenida da Guarda Inglesa, Lote E, Coimbra</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function buildInvoiceEmail(opts: {
  clientName: string;
  invoiceNumber: string;
  periodLabel: string;
  total: number;
  lineItems: { title: string; amount: number }[];
}): string {
  const { clientName, invoiceNumber, periodLabel, total, lineItems } = opts;
  const rows = lineItems.map(li =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${li.title}</td>
     <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;text-align:right;color:#374151;">€${li.amount.toFixed(2)}</td></tr>`
  ).join("");

  return `<!DOCTYPE html><html lang="pt"><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:24px;">${COMPANY_NAME}</h1>
  <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">Fatura ${invoiceNumber} — ${periodLabel}</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="font-size:16px;color:#374151;">Olá, <strong>${clientName}</strong>,</p>
  <p style="font-size:14px;color:#6b7280;">O seu pagamento foi confirmado. Segue a fatura referente ao mês de <strong>${periodLabel}</strong>.</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">${rows}</table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
    <tr><td style="padding:16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
      <table width="100%"><tr>
        <td style="color:#166534;font-size:14px;">✅ Pagamento recebido · Fatura ${invoiceNumber}</td>
        <td style="color:#15803d;font-size:20px;font-weight:700;text-align:right;">€${total.toFixed(2)}</td>
      </tr></table>
    </td></tr>
  </table>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;font-size:12px;color:#9ca3af;">${COMPANY_NAME} · NIF 518942120 · Avenida da Guarda Inglesa, Lote E, Coimbra</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
