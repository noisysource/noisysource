import * as admin from "firebase-admin";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { createInvoice, createOrUpdateClient, VendusLineItem, VendusClient, PRODUCT_STUDY, PRODUCT_TRANSPORT, PAYMENT_METHOD_MULTIBANCO, PAYMENT_METHOD_TRANSFERENCIA } from "./vendus";
import { createMbwayPayment, createMultibancoPayment, createCardPayment, EasypayWebhookPayload } from "./easypay";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// functions/ deploys as an isolated directory — Cloud Build's remote install
// only sees functions/package.json, with no monorepo/pnpm-workspace context,
// so a real "@shared" dependency can't be added here (confirmed the hard
// way: Cloud Build's npm rejects "@shared" outright as an invalid package
// name, since it's a scope prefix with no name after it — breaks EVERY
// function in the deploy, not just ones that import it). Duplicated from
// packages/shared/models/discountLogic.ts's applyDiscounts() instead of
// importing it; keep the two in sync if that one ever changes.
interface AppliedDiscount { ruleId: string; name: string; percentage: number; appliedAt: Date; appliedBy: "auto" | "admin" }
function applyDiscounts(gross: number, discounts: AppliedDiscount[]): number {
  const totalPct = Math.min(discounts.reduce((s, d) => s + d.percentage, 0), 1);
  return Math.round(gross * (1 - totalPct) * 100) / 100;
}

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

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const weekdayOfIsoDate = (isoDate: string): string => WEEKDAY_NAMES[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];

// Same per-occurrence rate used to price the subscription in the first place
// (StudyCenterConfig.pricePerDayPerWeek / TransportationConfig.flatRatePerTrip)
// — reused here rather than back-deriving a rate from the monthly total, so
// "one excluded day" always means the same euro amount everywhere in the app.
function studyPerDayRate(cfg: any): number {
  if (cfg?.pricePerDayPerWeek != null) return cfg.pricePerDayPerWeek;
  if (cfg?.monthlyPricePerWeekday != null) return cfg.monthlyPricePerWeekday / (cfg?.weeksPerMonth ?? 4);
  return 0;
}

// Gross (pre-discount) amount to remove for a set of excluded calendar dates.
// Discount is reapplied afterwards via applyDiscounts(), the same function
// that already computes every other discounted price in the app — so a
// subscription's discount rate is preserved on the days it IS billed for,
// instead of being partly eaten by the excluded days.
function computeExclusionDeduction(
  type: "study" | "transport",
  excludedDates: string[],
  sub: any,
  studyConfig: any,
  transportConfig: any,
): number {
  if (type === "study") {
    return excludedDates.length * studyPerDayRate(studyConfig);
  }
  const rate = transportConfig?.flatRatePerTrip ?? 0;
  let deduction = 0;
  for (const isoDate of excludedDates) {
    const weekday = weekdayOfIsoDate(isoDate);
    const tripsThatDay = (sub.schedule ?? []).filter((s: any) => s.dayOfWeek === weekday).length;
    deduction += tripsThatDay * rate;
  }
  return deduction;
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
    appCol("studyroom").where("status", "in", ["active", "confirmed"]).get(),
    appCol("transportationSubscriptions").where("status", "==", "active").get(),
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
  console.log(`[Vendus] start billingId=${billingId}`);

  const billingRef = appCol("billing").doc(billingId);
  const billing = (await billingRef.get()).data();
  if (!billing) throw new Error(`Billing record ${billingId} not found`);
  if (billing.status === "invoiced") {
    console.log(`[Vendus] billing ${billingId} already invoiced, skipping`);
    return;
  }

  const { familyId, userId, lineItems, total, billingName, billingEmail, periodLabel } = billing;
  console.log(`[Vendus] billing ok — family=${familyId} total=${total} period=${periodLabel}`);

  const famSnap = await appCol("families").doc(familyId).get();
  const fam = famSnap.data() ?? {};
  const clientNif: string = fam.nif ?? "999999990";

  let vendusClientId: number | null = fam.vendusClientId ?? null;
  console.log(`[Vendus] vendusClientId=${vendusClientId ?? "none"} nif=${clientNif}`);

  if (!vendusClientId) {
    vendusClientId = await createOrUpdateClient(familyId, {
      name: billingName,
      email: billingEmail,
      send_email: "yes",
      ...(clientNif !== "999999990" ? { fiscal_id: clientNif } : {}),
    });
    await appCol("families").doc(familyId).update({ vendusClientId });
    console.log(`[Vendus] client created/synced vendusClientId=${vendusClientId}`);
  }

  const vendusClient: VendusClient = { id: vendusClientId };
  const isCampBilling = billing.type === "camp_deposit" || billing.type === "camp_balance";
  const items: VendusLineItem[] = lineItems.map((li: any) => ({
    id: (!isCampBilling && li.title.startsWith("Transporte")) ? PRODUCT_TRANSPORT : PRODUCT_STUDY,
    title: li.title,
    qty: 1,
    gross_price: li.amount,
  }));

  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  console.log(`[Vendus] creating invoice — items=${items.length} date=${todayIso} (period=${periodLabel})`);

  const vendusPaymentMethodId = billing.paymentMethod === "multibanco"
    ? PAYMENT_METHOD_MULTIBANCO
    : PAYMENT_METHOD_TRANSFERENCIA;

  const vendusDoc = await createInvoice(vendusClient, items, todayIso, vendusPaymentMethodId, total, `Período: ${periodLabel}`);

  if (vendusDoc.errors?.length) {
    console.error(`[Vendus] API errors:`, JSON.stringify(vendusDoc.errors));
    throw new Error(vendusDoc.errors.map((e: any) => e.message).join("; "));
  }

  const invoiceNumber = vendusDoc.number;
  console.log(`[Vendus] invoice created — number=${invoiceNumber} id=${vendusDoc.id} atcud=${vendusDoc.atcud}`);

  await billingRef.update({
    status: "invoiced",
    invoiceNumber,
    vendusId: vendusDoc.id,
    atcud: vendusDoc.atcud ?? null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Compute line items for a group ────────────────────────────────────────────

export interface BillingLineItem {
  title: string;
  amount: number;               // net, after discounts AND excluded days
  grossAmount: number;          // before discounts and exclusions
  subscriptionId: string;
  type: "study" | "transport";
  appliedDiscounts: AppliedDiscount[];
  excludedDates?: string[];     // ISO yyyy-mm-dd, admin-marked "not provided" for THIS record only
}

interface BillingConfigs { studyConfig: any; transportConfig: any }

// existingLineItems (previous version of this specific billing record, if any)
// carries forward each subscription's excludedDates — admin's per-month
// adjustment must survive a recompute triggered by an unrelated subscription
// edit, not just get silently overwritten with the fresh gross amount.
function computeLineItems(
  group: { study: any[]; transport: any[] },
  period: ReturnType<typeof periodForDate>,
  configs: BillingConfigs,
  existingLineItems: BillingLineItem[] = [],
): { lineItems: BillingLineItem[]; total: number } {
  const lineItems: BillingLineItem[] = [];
  let total = 0;
  const priorFor = (subId: string) => existingLineItems.find(li => li.subscriptionId === subId);

  for (const sub of group.study) {
    const gross = sub.basePrice ?? sub.monthlyPrice ?? 0;
    const appliedDiscounts: AppliedDiscount[] = sub.appliedDiscounts ?? [];
    const excludedDates = priorFor(sub.id)?.excludedDates ?? [];
    const deduction = computeExclusionDeduction("study", excludedDates, sub, configs.studyConfig, configs.transportConfig);
    const amount = Math.round(applyDiscounts(Math.max(0, gross - deduction), appliedDiscounts) * 100) / 100;
    const daysStr = (sub.days ?? []).map((d: any) => dayLabel(d.day)).join(", ");
    lineItems.push({
      title: `Sala de Estudo — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`,
      amount, grossAmount: gross, subscriptionId: sub.id, type: "study", appliedDiscounts,
      ...(excludedDates.length ? { excludedDates } : {}),
    });
    total += amount;
  }
  for (const sub of group.transport) {
    const gross = sub.originalFee ?? sub.monthlyFee ?? 0;
    const appliedDiscounts: AppliedDiscount[] = sub.appliedDiscounts ?? [];
    const excludedDates = priorFor(sub.id)?.excludedDates ?? [];
    const deduction = computeExclusionDeduction("transport", excludedDates, sub, configs.studyConfig, configs.transportConfig);
    const amount = Math.round(applyDiscounts(Math.max(0, gross - deduction), appliedDiscounts) * 100) / 100;
    const daysStr = (sub.schedule ?? []).map((s: any) => dayLabel(s.dayOfWeek)).join(", ");
    lineItems.push({
      title: `Transporte Escolar — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`,
      amount, grossAmount: gross, subscriptionId: sub.id, type: "transport", appliedDiscounts,
      ...(excludedDates.length ? { excludedDates } : {}),
    });
    total += amount;
  }
  return { lineItems, total: Math.round(total * 100) / 100 };
}

async function loadBillingConfigs(): Promise<BillingConfigs> {
  const [studySnap, transportSnap] = await Promise.all([
    appCol("config").doc("studyCenter").get(),
    appCol("config").doc("transportation").get(),
  ]);
  return { studyConfig: studySnap.data() ?? {}, transportConfig: transportSnap.data() ?? {} };
}

// ── Send billing notices for a period ────────────────────────────────────────

async function buildBillingRecord(
  group: { familyId: string; userId: string; study: any[]; transport: any[] },
  period: ReturnType<typeof periodForDate>,
  dryRun: boolean,
  configs: BillingConfigs,
  opts: { docId?: string; sendEmail?: boolean } = {},
): Promise<string | undefined> {
  const { familyId, userId, study, transport } = group;
  const { docId, sendEmail = !dryRun } = opts;

  const famSnap = await appCol("families").doc(familyId).get();
  if (!famSnap.exists) { console.warn(`Family ${familyId} not found`); return; }
  const fam = famSnap.data()!;
  const contact = fam.primaryContact ?? {};
  const billingName: string = contact.name ?? "Família";
  const billingEmail: string = contact.email ?? "";
  const paymentMethod: string = fam.paymentMethod ?? "mbway";

  const { lineItems, total } = computeLineItems({ study, transport }, period, configs);
  if (lineItems.length === 0 || total === 0) { console.log(`No billable items for family ${familyId}`); return; }

  const dueDate = new Date(period.start);
  dueDate.setDate(8);

  const billingRef = docId
    ? appCol("billing").doc(docId)
    : appCol("billing").doc();

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
    await appCol("emailOutbox").add({
      to: billingEmail,
      subject: `Pagamento pendente — ${COMPANY_NAME} — ${period.label}`,
      html: buildPaymentNoticeEmail({ clientName: billingName, periodLabel: period.label, total, lineItems, billingId: billingRef.id }),
      status: "queued",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return billingRef.id;
}

export const sendBillingNotice = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new Error("Unauthorized");

    const { billingId } = request.data ?? {};
    if (!billingId) throw new Error("billingId required");

    const billingRef = appCol("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new Error("Billing record not found");
    if (!["pending", "failed"].includes(billing.status)) throw new Error("Record is not in a noticeable state");
    if (!billing.billingEmail) throw new Error("No billing email on record");

    await appCol("emailOutbox").add({
      to: billing.billingEmail,
      subject: `Pagamento pendente — ${COMPANY_NAME} — ${billing.periodLabel}`,
      html: buildPaymentNoticeEmail({
        clientName: billing.billingName,
        periodLabel: billing.periodLabel,
        total: billing.total,
        lineItems: billing.lineItems,
        billingId,
      }),
      status: "queued",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await billingRef.update({
      noticeSentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ok: true };
  }
);

// ── Client initiates MBWay payment ───────────────────────────────────────────

export const initiateMbwayPayment = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "EASYPAY_WEBHOOK_URL"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { billingId, phone } = request.data ?? {};
    if (!billingId || !phone) throw new HttpsError("invalid-argument", "billingId and phone required");

    console.log(`[MBWay] initiate uid=${uid} billingId=${billingId} phone=${String(phone).slice(0, 3)}***`);

    const billingRef = appCol("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new HttpsError("not-found", "Billing record not found");
    if (billing.userId !== uid) throw new HttpsError("permission-denied", "Unauthorized");
    if (billing.status !== "pending") throw new HttpsError("failed-precondition", `Already processed (status=${billing.status})`);
    if (!billing.total || billing.total < 0.5) throw new HttpsError("failed-precondition", `Billing total is €${(billing.total ?? 0).toFixed(2)} — minimum is €0.50`);

    console.log(`[MBWay] billing ok — total=${billing.total} period=${billing.periodLabel}`);

    let res;
    try {
      res = await createMbwayPayment(
        { name: billing.billingName, email: billing.billingEmail, phone },
        billing.total,
        `${COMPANY_NAME} — ${billing.periodLabel}`,
      );
      console.log(`[MBWay] EasyPay response — id=${res.id} status=${res.method?.status}`);
    } catch (err: any) {
      console.error(`[MBWay] EasyPay call failed:`, err.message);
      throw new HttpsError("internal", `EasyPay error: ${err.message}`);
    }

    await billingRef.update({
      status: "processing",
      easypayId: res.id,
      mbwayPhone: phone,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[MBWay] billing ${billingId} → processing easypayId=${res.id}`);
    return { easypayId: res.id };
  }
);

// ── Client initiates Multibanco payment ──────────────────────────────────────

export const initiateMultibancoPayment = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "EASYPAY_WEBHOOK_URL"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { billingId } = request.data ?? {};
    const billingRef = appCol("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new HttpsError("not-found", "Billing record not found");
    if (billing.userId !== uid) throw new HttpsError("permission-denied", "Unauthorized");
    if (billing.status !== "pending") throw new HttpsError("failed-precondition", `Already processed (status=${billing.status})`);

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
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "EASYPAY_WEBHOOK_URL"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { billingId } = request.data ?? {};
    const billingRef = appCol("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new HttpsError("not-found", "Billing record not found");
    if (billing.userId !== uid) throw new HttpsError("permission-denied", "Unauthorized");
    if (billing.status !== "pending") throw new HttpsError("failed-precondition", `Already processed (status=${billing.status})`);

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

    // EasyPay v2 sends two calls per payment:
    //   { id, type: "capture", status: "success"|"failed"|"expired" }
    //   { id, value, method, transaction: { type: "capture", values: { paid } } }
    const paymentId = payload.id;
    if (!paymentId) {
      res.status(200).send("ok");
      return;
    }

    const isSuccess =
      (payload.type === "capture" && payload.status === "success") ||
      (!!payload.transaction && Number(payload.transaction.values?.paid ?? 0) > 0);

    const isFailure =
      payload.type === "capture" &&
      (payload.status === "failed" || payload.status === "expired");

    if (isSuccess) {
      console.log(`[Webhook] success easypayId=${paymentId}`);

      const snap = await appCol("billing")
        .where("easypayId", "==", paymentId)
        .limit(1)
        .get();

      if (snap.empty) {
        console.warn(`[Webhook] no billing record found for easypayId=${paymentId}`);
        res.status(200).send("ok");
        return;
      }

      const billingDoc = snap.docs[0];
      const billingData = billingDoc.data();
      const currentStatus = billingData.status;

      // Retry invoice creation if paid but invoice failed previously
      if (currentStatus === "paid" && billingData.invoiceError) {
        console.log(`[Webhook] billing ${billingDoc.id} paid but invoice failed — retrying`);
        await billingDoc.ref.update({ invoiceError: admin.firestore.FieldValue.delete() });
        try {
          await createVendusInvoiceForBilling(billingDoc.id);
          console.log(`[Webhook] Vendus invoice created for billing ${billingDoc.id}`);
        } catch (err: any) {
          console.error(`[Webhook] Vendus invoice failed for billing ${billingDoc.id}:`, err.message);
          await billingDoc.ref.update({ invoiceError: err.message, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
        res.status(200).send("ok");
        return;
      }

      // Idempotent: EasyPay sends two webhook calls per payment
      if (currentStatus !== "processing") {
        console.log(`[Webhook] billing ${billingDoc.id} already processed (status=${currentStatus})`);
        res.status(200).send("ok");
        return;
      }

      console.log(`[Webhook] matched billing ${billingDoc.id} — marking paid`);
      await billingDoc.ref.update({
        status: "paid",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`[Webhook] billing ${billingDoc.id} → paid — starting Vendus invoice`);
      try {
        await createVendusInvoiceForBilling(billingDoc.id);
        console.log(`[Webhook] Vendus invoice created for billing ${billingDoc.id}`);
      } catch (err: any) {
        console.error(`[Webhook] Vendus invoice failed for billing ${billingDoc.id}:`, err.message);
        await billingDoc.ref.update({
          invoiceError: err.message,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    if (isFailure) {
      console.log(`[Webhook] failure easypayId=${paymentId} status=${payload.status}`);

      const snap = await appCol("billing")
        .where("easypayId", "==", paymentId)
        .limit(1)
        .get();

      if (!snap.empty) {
        const currentStatus = snap.docs[0].data().status;
        if (currentStatus === "processing") {
          await snap.docs[0].ref.update({
            status: "failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[Webhook] billing ${snap.docs[0].id} → failed`);
        }
      } else {
        console.warn(`[Webhook] no billing found for easypayId=${paymentId}`);
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

    const bookingSnap = await appCol("bookings").doc(bookingId).get();
    if (!bookingSnap.exists) throw new Error("Booking not found");
    const booking = bookingSnap.data()!;

    // Verify ownership — booking must have userId or familyId linked to caller
    if (booking.userId !== uid) {
      const famSnap = await appCol("families")
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
    const existing = await appCol("billing")
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

    const billingRef = await appCol("billing").add({
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

// ── Admin: retry Vendus invoice for a paid billing record ────────────────────

export const retryVendusInvoice = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["VENDUS_API_KEY", "VENDUS_REGISTER_ID"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new HttpsError("permission-denied", "Unauthorized");

    const { billingId, force } = request.data ?? {};
    if (!billingId) throw new HttpsError("invalid-argument", "billingId required");

    const billingRef = appCol("billing").doc(billingId);
    const billing = (await billingRef.get()).data();
    if (!billing) throw new HttpsError("not-found", "Billing record not found");
    if (!["paid", "invoiced"].includes(billing.status)) {
      throw new HttpsError("failed-precondition", `Cannot create invoice for status=${billing.status}`);
    }
    if (billing.status === "invoiced" && !billing.invoiceError && !force) {
      throw new HttpsError("already-exists", `Invoice already created: ${billing.invoiceNumber}`);
    }

    // Reset status to paid so createVendusInvoiceForBilling can re-run
    await billingRef.update({
      status: "paid",
      invoiceError: admin.firestore.FieldValue.delete(),
      invoiceNumber: admin.firestore.FieldValue.delete(),
      vendusId: admin.firestore.FieldValue.delete(),
      atcud: admin.firestore.FieldValue.delete(),
    });

    await createVendusInvoiceForBilling(billingId);
    return { ok: true };
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

    const familySnap = await appCol("families").where("userId", "==", uid).limit(1).get();
    if (familySnap.empty) throw new Error("Family not found");

    const update: Record<string, any> = { paymentMethod: method, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (method === "mbway" && mbwayPhone) update.mbwayPhone = mbwayPhone;

    await familySnap.docs[0].ref.update(update);
    return { ok: true };
  }
);

// ── Auto-billing on subscription confirmation ─────────────────────────────────

async function autoCreateBillingSchedule(familyId: string, userId: string): Promise<void> {
  const [studySnap, transportSnap, configs] = await Promise.all([
    appCol("studyroom").where("familyId", "==", familyId).where("status", "in", ["active", "confirmed"]).get(),
    appCol("transportationSubscriptions").where("familyId", "==", familyId).where("status", "==", "active").get(),
    loadBillingConfigs(),
  ]);

  const group = {
    familyId,
    userId,
    study: studySnap.docs.map(d => ({ id: d.id, ...d.data() })),
    transport: transportSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };

  const periods = periodsUntilSchoolYearEnd(new Date());
  let created = 0, updated = 0, cancelled = 0;

  for (const period of periods) {
    const docId = `${familyId}_${period.isoDate.slice(0, 7)}`;
    const existing = await appCol("billing").doc(docId).get();
    const existingLineItems: BillingLineItem[] = existing.exists ? (existing.data()?.lineItems ?? []) : [];
    const { lineItems, total } = computeLineItems(group, period, configs, existingLineItems);

    if (existing.exists) {
      if (existing.data()?.status === "pending") {
        if (lineItems.length === 0 || total === 0) {
          // All subscriptions for this family are now cancelled/inactive
          await appCol("billing").doc(docId).update({
            status: "cancelled",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          cancelled++;
        } else {
          await appCol("billing").doc(docId).update({ lineItems, total, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          updated++;
        }
      }
      continue;
    }

    if (lineItems.length > 0 && total > 0) {
      await buildBillingRecord(group, period, false, configs, { docId, sendEmail: false });
      created++;
    }
  }

  console.log(`Billing schedule for family ${familyId}: ${created} created, ${updated} updated, ${cancelled} cancelled`);
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

    const [groups, configs] = await Promise.all([getActiveSubs(), loadBillingConfigs()]);
    let created = 0, updated = 0, skipped = 0, cancelled = 0, failed = 0;
    const familiesWithActiveSubs = new Set(groups.map(g => g.familyId));

    // Cancel pending records for families that no longer have any active subscriptions
    const orphanSnap = await appCol("billing").where("status", "==", "pending").get();
    for (const doc of orphanSnap.docs) {
      const familyId = doc.data().familyId;
      if (!familiesWithActiveSubs.has(familyId)) {
        await doc.ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        cancelled++;
      }
    }

    // Recalculate / create billing records for families with active subscriptions
    for (const group of groups) {
      try {
        const periods = periodsUntilSchoolYearEnd(new Date());
        for (const period of periods) {
          const docId = `${group.familyId}_${period.isoDate.slice(0, 7)}`;
          const existing = await appCol("billing").doc(docId).get();
          const existingLineItems: BillingLineItem[] = existing.exists ? (existing.data()?.lineItems ?? []) : [];
          const { lineItems, total } = computeLineItems(group, period, configs, existingLineItems);
          if (existing.exists) {
            if (existing.data()?.status === "pending") {
              if (lineItems.length === 0 || total === 0) {
                await existing.ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                cancelled++;
              } else {
                await existing.ref.update({ lineItems, total, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                updated++;
              }
            } else {
              skipped++;
            }
            continue;
          }
          if (lineItems.length > 0 && total > 0) {
            await buildBillingRecord(group, period, false, configs, { docId, sendEmail: false });
            created++;
          }
        }
      } catch (err) {
        console.error(`Backfill failed for family ${group.familyId}:`, err);
        failed++;
      }
    }

    return { created, updated, skipped, cancelled, failed, families: groups.length };
  }
);

// ── Admin: exclude specific days from one billing record's line item ─────────
// For marking vacation/no-show days out of a single month's invoice, without
// touching the subscription itself (which keeps its normal recurring
// schedule for every other month). Only allowed while the record is still
// "pending" — same protection every other write in this file already has for
// paid/processing/invoiced/failed/cancelled records.

export const setBillingLineItemExcludedDays = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new HttpsError("permission-denied", "Unauthorized");

    const { billingId, subscriptionId, excludedDates } = request.data ?? {};
    if (!billingId || !subscriptionId || !Array.isArray(excludedDates)) {
      throw new HttpsError("invalid-argument", "billingId, subscriptionId, excludedDates[] required");
    }

    const billingRef = appCol("billing").doc(billingId);
    const billingSnap = await billingRef.get();
    const billing = billingSnap.data();
    if (!billing) throw new HttpsError("not-found", "Billing record not found");
    if (billing.status !== "pending") throw new HttpsError("failed-precondition", `Cannot edit a "${billing.status}" record`);

    const lineItems: BillingLineItem[] = billing.lineItems ?? [];
    const idx = lineItems.findIndex((li) => li.subscriptionId === subscriptionId);
    if (idx === -1) throw new HttpsError("not-found", "Line item not found on this billing record");
    const li = lineItems[idx];

    // Only dates within this record's own period are honoured — this is a
    // per-record adjustment, not a general-purpose date list.
    const periodStart: Date = billing.periodStart.toDate();
    const periodEnd: Date = billing.periodEnd.toDate();
    const validDates: string[] = excludedDates.filter((d: unknown) => {
      if (typeof d !== "string") return false;
      const dt = new Date(`${d}T12:00:00Z`);
      return !isNaN(dt.getTime()) && dt >= periodStart && dt <= periodEnd;
    });

    const colName = li.type === "study" ? "studyroom" : "transportationSubscriptions";
    const [subSnap, configs] = await Promise.all([
      appCol(colName).doc(subscriptionId).get(),
      loadBillingConfigs(),
    ]);
    const sub = subSnap.data() ?? {};

    // Anchored to this line item's own stored gross/discounts, not a fresh
    // read of the subscription's current price — keeps the math consistent
    // with the total already shown on this specific invoice.
    const gross = li.grossAmount ?? 0;
    const appliedDiscounts = li.appliedDiscounts ?? [];
    const deduction = computeExclusionDeduction(li.type, validDates, sub, configs.studyConfig, configs.transportConfig);
    const newAmount = Math.round(applyDiscounts(Math.max(0, gross - deduction), appliedDiscounts) * 100) / 100;

    const newLineItems = [...lineItems];
    newLineItems[idx] = { ...li, amount: newAmount, ...(validDates.length ? { excludedDates: validDates } : {}) };
    if (!validDates.length) delete (newLineItems[idx] as any).excludedDates;
    const newTotal = Math.round(newLineItems.reduce((s, x) => s + (x.amount ?? 0), 0) * 100) / 100;

    await billingRef.update({
      lineItems: newLineItems,
      total: newTotal,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { amount: newAmount, total: newTotal };
  }
);

// Re-runs the full billing recompute for the family on every create/update of
// a linked subscription — not just status transitions. Covers cases the old
// status-diffing triggers missed: a subscription created already active (no
// update event at all), and one that's already active but only gets familyId
// attached later when the client claims it (familyId changes, not status).
// autoCreateBillingSchedule() re-queries current subscription state itself,
// so it's naturally idempotent here — a create, an unrelated field edit, and
// a status change all converge on the same recomputed result.
export const onStudyroomBillingSync = onDocumentWritten(
  { document: "_apps/arcoiris/studyroom/{entryId}", region: "europe-west3" },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return; // deleted
    const familyId: string = after.familyId;
    if (!familyId) return;
    await autoCreateBillingSchedule(familyId, after.userId ?? "");
  }
);

export const onTransportBillingSync = onDocumentWritten(
  { document: "_apps/arcoiris/transportationSubscriptions/{subId}", region: "europe-west3" },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return; // deleted
    const familyId: string = after.familyId;
    if (!familyId) return;
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

