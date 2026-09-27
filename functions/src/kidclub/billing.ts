import * as admin from "firebase-admin";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { createInvoice, createOrUpdateClient, VendusLineItem, VendusClient, PRODUCT_STUDY, PRODUCT_TRANSPORT, PRODUCT_ENROLLMENT_FEE, PRODUCT_INSURANCE, PAYMENT_METHOD_MULTIBANCO, PAYMENT_METHOD_TRANSFERENCIA } from "./vendus";
import { createMbwayPayment, createMultibancoPayment, createCardPayment, EasypayWebhookPayload } from "./easypay";
import { appCol } from "./db";
import { reconcileService, studyPerDayRate, resolveSchoolName, contractCoversPeriod, buildReconciliationConfig, manualDiscountPctFor, ReservationEventLite, SubscriptionForReconciliation, ReconciliationConfig } from "./reconciliation";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Kept only for BillingLineItem.appliedDiscounts' type and the enrollment-fee
// line items — actual discount math for study/transport now lives in
// reconciliation.ts's reconcileService(), not here.
interface AppliedDiscount { ruleId: string; name: string; percentage: number; appliedAt: Date; appliedBy: "auto" | "admin" }

const COMPANY_NAME = "Arco-Íris da Pequenada";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// Firestore 'in' queries accept at most 30 comparison values.
function chunk<T>(arr: T[], size = 30): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Every occurrence actually scheduled this period, for a set of
// subscriptions, read from the materialized ReservationEvents collection.
// These drive the absence count (CANCELLED only) and the "did this
// subscription run at all this period" test (all-VOIDED = no). They do NOT
// drive gross: gross is the flat monthly price derived from the schedule
// pattern in reconcileService(), so a five-Monday month costs the same as a
// four-Monday one.
async function fetchReservationEventsForPeriod(
  studyIds: string[],
  transportIds: string[],
  period: ReturnType<typeof periodForDate>,
): Promise<Map<string, ReservationEventLite[]>> {
  const bySub = new Map<string, ReservationEventLite[]>();
  const allIds = [...studyIds, ...transportIds];
  if (allIds.length === 0) return bySub;

  const startIso = period.isoDate;
  const endIso = `${period.end.getFullYear()}-${String(period.end.getMonth() + 1).padStart(2, "0")}-${String(period.end.getDate()).padStart(2, "0")}`;

  const snaps = await Promise.all(
    chunk(allIds).map(ids => appCol("reservationEvents")
      .where("subscriptionId", "in", ids)
      .where("date", ">=", startIso)
      .where("date", "<=", endIso)
      .get())
  );
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const data = doc.data();
      const list = bySub.get(data.subscriptionId) ?? [];
      list.push({ date: data.date, basePriceCents: data.basePriceCents, status: data.status });
      bySub.set(data.subscriptionId, list);
    }
  }
  return bySub;
}

// Children's birthdates, for the sibling-discount ordering tie-break
// (older child -> position 1 / full price, once value and enrollment date
// are both tied).
interface ChildRecord { birthDate?: Date; schoolName?: string }

// The child document is the canonical source for a child's personal data.
// Subscriptions carry their own copies of schoolName/childName, and those
// copies have drifted: of the 10 children holding both a transport and a study
// subscription in prod, 5 store two different schoolName values across their
// two documents, and 2 of those values are street addresses rather than
// schools. Since schoolName decides the 20% Colegio Bissaya Barreto transport
// discount, billing must not read the drifted copy.
//
// Measured before switching: 0 of 21 active transport subscriptions change
// their Bissaya match when sourced from the child record instead of the
// subscription, so this corrects the source without moving anyone's fee.
//
// The subscription copy stays as a per-field fallback - see resolveSchoolName
// in reconciliation.ts for why it is per FIELD and not per record. It covers
// two cases, only the first of which is transitional: a subscription with no
// childId at all (4 active transport subs today, closed by the Phase 0
// backfill), and a linked child record that has no schoolName of its own. The
// second is permanently reachable, because ClaimSubscriptionsPage does not
// require a school and writes null when it is blank.
async function fetchChildRecords(childIds: string[]): Promise<Map<string, ChildRecord>> {
  const out = new Map<string, ChildRecord>();
  const ids = [...new Set(childIds)].filter(Boolean);
  if (!ids.length) return out;
  const snaps = await Promise.all(chunk(ids).map(batch =>
    appCol("children").where(admin.firestore.FieldPath.documentId(), "in", batch).get()
  ));
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const d = doc.data() ?? {};
      out.set(doc.id, {
        birthDate: d.dateOfBirth ? (d.dateOfBirth.toDate ? d.dateOfBirth.toDate() : new Date(d.dateOfBirth)) : undefined,
        schoolName: d.schoolName ?? undefined,
      });
    }
  }
  return out;
}

// ── Build Vendus invoice for a billing record ─────────────────────────────────

// dev and prod currently share the exact same live Vendus account, API key
// and register — there is no sandbox. Every invoice created from here is a
// real Fatura-Recibo, reported to the tax authority, under the real company.
// Until a genuine Vendus sandbox exists for dev, refuse to create real
// fiscal documents from test billing records. Remove this guard once dev
// has its own sandbox VENDUS_API_KEY/VENDUS_REGISTER_ID.
const DEV_PROJECTS_WITHOUT_VENDUS_SANDBOX = new Set(["kidclub-dev"]);

async function createVendusInvoiceForBilling(billingId: string): Promise<void> {
  console.log(`[Vendus] start billingId=${billingId}`);

  const currentProject = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  if (DEV_PROJECTS_WITHOUT_VENDUS_SANDBOX.has(currentProject)) {
    throw new Error(
      `Vendus invoicing is disabled on ${currentProject}: this project has no Vendus sandbox, ` +
      `only the real production account, so creating an invoice here would generate a real fiscal document.`
    );
  }

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
  const vendusProductId = (title: string): number => {
    if (isCampBilling) return PRODUCT_STUDY;
    if (title.startsWith("Transporte")) return PRODUCT_TRANSPORT;
    if (title.startsWith("Taxa de Inscrição")) return PRODUCT_ENROLLMENT_FEE;
    if (title.startsWith("Seguro")) return PRODUCT_INSURANCE;
    return PRODUCT_STUDY;
  };
  const items: VendusLineItem[] = lineItems.map((li: any) => ({
    id: vendusProductId(li.title),
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
  amount: number;               // net, after discounts AND absence credit
  grossAmount: number;          // before discounts — the flat monthly price (scheduleLength x rate x activeWeeksInPattern), not a count of this period's occurrences
  subscriptionId: string;
  type: "study" | "transport" | "enrollment";
  appliedDiscounts: AppliedDiscount[]; // kept for type compatibility; study/transport line items no longer populate this — see multiTripDiscountAmount etc. below
  scheduleDays?: string[];      // weekday names this line item is actually billed for — lets the admin UI show real service days
  tripsByDay?: Record<string, ("pickup" | "dropoff" | "both")[]>; // transport only — which trip(s) run on each scheduled weekday
  multiTripDiscountAmount?: number;    // marginal — only trip #2+ on a multi-trip day
  siblingDiscountAmount?: number;      // marginal — only applies if this isn't the family's highest-value subscription for this service
  institutionalDiscountAmount?: number; // school + returning-student + manual, summed, on the post-sibling subtotal
  institutionalDiscountPct?: number;
  absenceCount?: number;         // CANCELLED ReservationEvents this period, this subscription
  absenceDates?: string[];       // ISO yyyy-mm-dd — every CANCELLED date, credited or not
  absenceCreditAmount?: number;
  absenceCreditDates?: string[]; // ISO yyyy-mm-dd — every CANCELLED date credited once the 3-absence threshold was reached (uncapped, not just the first 3)
}

interface BillingConfigs { studyConfig: any; transportConfig: any; discountRules: any[] }

// existingLineItems (previous version of this specific billing record, if any)
// carries forward each subscription's registration/insurance enrollment fee
// line items — those are billed once per child, not re-derived every call.
// Everything else is now recomputed fresh every time from ReservationEvents,
// which already carry their own frozen price and VOIDED/CANCELLED status —
// there's nothing left to "carry forward" for the study/transport lines
// themselves (the old frozenMidPeriodCancellation patch is no longer
// needed: a mid-month cancellation voids future events, not past ones, so
// this period's already-elapsed events are billed correctly without any
// special-casing here).
async function computeLineItems(
  group: { study: any[]; transport: any[] },
  period: ReturnType<typeof periodForDate>,
  configs: BillingConfigs,
  existingLineItems: BillingLineItem[] = [],
): Promise<{ lineItems: BillingLineItem[]; total: number; newlyBilledEnrollmentFeeSubs: { collection: "studyroom" | "transportationSubscriptions"; id: string }[] }> {
  const lineItems: BillingLineItem[] = [];
  let total = 0;
  const newlyBilledEnrollmentFeeSubs: { collection: "studyroom" | "transportationSubscriptions"; id: string }[] = [];
  const billedThisCall = new Set<string>();
  const priorFor = (subId: string) => existingLineItems.find(li => li.subscriptionId === subId);

  // "Already billed" is read straight off the currently active subscription
  // docs themselves — sub.enrollmentFeeBilled — rather than a persistent
  // child-level record, deliberately: a Child document outlives the school
  // year, but this fee must NOT (per the original ask — paid again whenever
  // a family starts a fresh subscription next year). A subscription doc IS
  // scoped to one enrollment, so checking it resets automatically: next
  // year's subscription is a brand new doc with no flag.
  const childFeeBilled = new Set<string>();
  for (const sub of [...group.study, ...group.transport]) if (sub.childId && sub.enrollmentFeeBilled) childFeeBilled.add(sub.childId);

  // One-time enrollment fees (registration + insurance) — billed once per
  // CHILD, on whichever service (study or transport) they first appear in,
  // never discounted, so a transport-only family pays it too, not just
  // study-room families. Kept as two separate line items, not one combined
  // one — Vendus has two distinct products for these ("Taxa de Inscrição",
  // "Seguro"), each with its own price/VAT, and createVendusInvoiceForBilling
  // maps by title, so a combined line couldn't invoice correctly under
  // either product. A child with both services is only charged once,
  // guarded here by billedThisCall. When actually billed, every one of that
  // child's currently active subscriptions (both collections) gets flagged
  // — not just the one being processed — so the fee can't be missed if the
  // family later drops one service and keeps only the other, within the
  // same school year. Prior fee line items on THIS specific billing record
  // are carried forward untouched (same pattern as excludedDates) so a
  // later recompute can't silently drop or duplicate them.
  const maybeAddEnrollmentFee = (sub: any) => {
    if (!sub.childId) return;
    const priorReg = priorFor(`${sub.childId}:registration`);
    const priorIns = priorFor(`${sub.childId}:insurance`);
    if (priorReg || priorIns) {
      if (billedThisCall.has(sub.childId)) return;
      if (priorReg) { lineItems.push(priorReg); total += priorReg.amount; }
      if (priorIns) { lineItems.push(priorIns); total += priorIns.amount; }
      billedThisCall.add(sub.childId);
      return;
    }
    const registrationFee = Math.round((configs.studyConfig?.registrationFee ?? 0) * 100) / 100;
    const insuranceFee = Math.round((configs.studyConfig?.insuranceFee ?? 0) * 100) / 100;
    // One-time migration: an existing record from before the combined
    // "Taxa de Inscrição e Seguro" line item was split in two. It was never
    // discounted or partially excluded, so re-deriving the two amounts from
    // this period's configured fees is exact, not a guess.
    const priorCombined = priorFor(`${sub.childId}:enrollment`);
    if (priorCombined) {
      if (billedThisCall.has(sub.childId)) return;
      if (registrationFee > 0) {
        lineItems.push({ title: `Taxa de Inscrição — ${sub.childName}`, amount: registrationFee, grossAmount: registrationFee, subscriptionId: `${sub.childId}:registration`, type: "enrollment", appliedDiscounts: [] });
        total += registrationFee;
      }
      if (insuranceFee > 0) {
        lineItems.push({ title: `Seguro — ${sub.childName}`, amount: insuranceFee, grossAmount: insuranceFee, subscriptionId: `${sub.childId}:insurance`, type: "enrollment", appliedDiscounts: [] });
        total += insuranceFee;
      }
      billedThisCall.add(sub.childId);
      return;
    }
    if (billedThisCall.has(sub.childId) || childFeeBilled.has(sub.childId)) return;
    if (registrationFee <= 0 && insuranceFee <= 0) return;
    if (registrationFee > 0) {
      lineItems.push({
        title: `Taxa de Inscrição — ${sub.childName}`,
        amount: registrationFee, grossAmount: registrationFee, subscriptionId: `${sub.childId}:registration`, type: "enrollment", appliedDiscounts: [],
      });
      total += registrationFee;
    }
    if (insuranceFee > 0) {
      lineItems.push({
        title: `Seguro — ${sub.childName}`,
        amount: insuranceFee, grossAmount: insuranceFee, subscriptionId: `${sub.childId}:insurance`, type: "enrollment", appliedDiscounts: [],
      });
      total += insuranceFee;
    }
    billedThisCall.add(sub.childId);
    for (const s of group.study) if (s.childId === sub.childId) newlyBilledEnrollmentFeeSubs.push({ collection: "studyroom", id: s.id });
    for (const s of group.transport) if (s.childId === sub.childId) newlyBilledEnrollmentFeeSubs.push({ collection: "transportationSubscriptions", id: s.id });
  };

  const studyIds = group.study.map(s => s.id);
  const transportIds = group.transport.map(s => s.id);
  const [eventsBySub, childRecords] = await Promise.all([
    fetchReservationEventsForPeriod(studyIds, transportIds, period),
    fetchChildRecords([...group.study, ...group.transport].map(s => s.childId)),
  ]);

  const enrollmentDateOf = (sub: any): Date => {
    const raw = sub.createdAt ?? sub.startDate;
    if (raw?.toDate) return raw.toDate();
    return raw ? new Date(raw) : new Date(0);
  };

  const asDate = (raw: any): Date | null => {
    if (!raw) return null;
    const d = raw.toDate ? raw.toDate() : new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  };
  // Whether the flat monthly price applies at all this period. Contract dates
  // only — a month outside the school year is still a month of the 12-month
  // spread. See contractCoversPeriod.
  const coversPeriodOf = (sub: any): boolean =>
    contractCoversPeriod(asDate(sub.startDate), asDate(sub.endDate), period.start, period.end);

  if (group.study.length) {
    const cfg = buildReconciliationConfig("study", configs.discountRules, configs.studyConfig);
    const studyRate = studyPerDayRate(configs.studyConfig);
    const subsForRecon: SubscriptionForReconciliation[] = group.study.map(sub => ({
      id: sub.id, childId: sub.childId,
      schoolName: resolveSchoolName(childRecords.get(sub.childId)?.schoolName, sub.schoolName),
      returningStudent: sub.returningStudent,
      manualDiscountPct: manualDiscountPctFor(sub, configs.discountRules),
      enrollmentDate: enrollmentDateOf(sub),
      childBirthDate: childRecords.get(sub.childId)?.birthDate,
      scheduleWeekdays: (sub.days ?? []).map((d: any) => d.day),
      weekPattern: sub.weekPattern,
      ratePerOccurrenceCents: Math.round(studyRate * 100),
      discountOverrides: sub.discountOverrides,
      coversPeriod: coversPeriodOf(sub),
    }));
    for (const r of reconcileService(subsForRecon, eventsBySub, cfg)) {
      const sub = group.study.find(s => s.id === r.subscriptionId)!;
      const scheduleDays: string[] = [...new Set((sub.days ?? []).map((d: any) => d.day))] as string[];
      const daysStr = (sub.days ?? []).map((d: any) => dayLabel(d.day)).join(", ");
      const amount = Math.round(r.finalCents) / 100;
      lineItems.push({
        title: `Sala de Estudo — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`,
        amount, grossAmount: r.grossCents / 100, subscriptionId: sub.id, type: "study", appliedDiscounts: [], scheduleDays,
        multiTripDiscountAmount: r.multiTripDiscountCents / 100,
        siblingDiscountAmount: r.siblingDiscountCents / 100,
        institutionalDiscountAmount: r.institutionalDiscountCents / 100,
        institutionalDiscountPct: r.institutionalDiscountPct,
        absenceCount: r.absenceCount,
        ...(r.absenceDates.length ? { absenceDates: r.absenceDates } : {}),
        absenceCreditAmount: r.absenceCreditCents / 100,
        ...(r.absenceCreditDates.length ? { absenceCreditDates: r.absenceCreditDates } : {}),
      });
      total += amount;
      maybeAddEnrollmentFee(sub);
    }
  }

  if (group.transport.length) {
    const cfg = buildReconciliationConfig("transport", configs.discountRules, configs.transportConfig);
    const tripRate: number = configs.transportConfig?.flatRatePerTrip ?? 0;
    const subsForRecon: SubscriptionForReconciliation[] = group.transport.map(sub => ({
      id: sub.id, childId: sub.childId,
      schoolName: resolveSchoolName(childRecords.get(sub.childId)?.schoolName, sub.schoolName),
      returningStudent: sub.returningStudent,
      manualDiscountPct: manualDiscountPctFor(sub, configs.discountRules),
      enrollmentDate: enrollmentDateOf(sub),
      childBirthDate: childRecords.get(sub.childId)?.birthDate,
      scheduleWeekdays: (sub.schedule ?? []).map((sl: any) => sl.dayOfWeek),
      weekPattern: sub.weekPattern,
      ratePerOccurrenceCents: Math.round(tripRate * 100),
      discountOverrides: sub.discountOverrides,
      coversPeriod: coversPeriodOf(sub),
    }));
    for (const r of reconcileService(subsForRecon, eventsBySub, cfg)) {
      const sub = group.transport.find(s => s.id === r.subscriptionId)!;
      const scheduleDays: string[] = [...new Set((sub.schedule ?? []).map((s: any) => s.dayOfWeek))] as string[];
      const tripsByDay: Record<string, ("pickup" | "dropoff" | "both")[]> = {};
      for (const s of sub.schedule ?? []) (tripsByDay[s.dayOfWeek] ??= []).push(s.direction ?? "both");
      const daysStr = (sub.schedule ?? []).map((s: any) => dayLabel(s.dayOfWeek)).join(", ");
      const amount = Math.round(r.finalCents) / 100;
      lineItems.push({
        title: `Transporte Escolar — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`,
        amount, grossAmount: r.grossCents / 100, subscriptionId: sub.id, type: "transport", appliedDiscounts: [], scheduleDays, tripsByDay,
        multiTripDiscountAmount: r.multiTripDiscountCents / 100,
        siblingDiscountAmount: r.siblingDiscountCents / 100,
        institutionalDiscountAmount: r.institutionalDiscountCents / 100,
        institutionalDiscountPct: r.institutionalDiscountPct,
        absenceCount: r.absenceCount,
        ...(r.absenceDates.length ? { absenceDates: r.absenceDates } : {}),
        absenceCreditAmount: r.absenceCreditCents / 100,
        ...(r.absenceCreditDates.length ? { absenceCreditDates: r.absenceCreditDates } : {}),
      });
      total += amount;
      maybeAddEnrollmentFee(sub);
    }
  }

  return { lineItems, total: Math.round(total * 100) / 100, newlyBilledEnrollmentFeeSubs };
}

// Marks each given subscription's enrollment fee as billed, permanently,
// right after the billing record carrying it has actually been written —
// this is the guard that stops the fee from being added on every subsequent
// recompute of the same or a later period. Written on the subscription docs
// themselves (both collections, every currently active sub for the billed
// child), not a persistent child-level record — see computeLineItems for why.
async function markEnrollmentFeeBilled(subs: { collection: "studyroom" | "transportationSubscriptions"; id: string }[]): Promise<void> {
  await Promise.all(subs.map(s => appCol(s.collection).doc(s.id).update({ enrollmentFeeBilled: true })));
}

async function loadBillingConfigs(): Promise<BillingConfigs> {
  const [studySnap, transportSnap, discountsSnap] = await Promise.all([
    appCol("config").doc("studyCenter").get(),
    appCol("config").doc("transportation").get(),
    appCol("config").doc("discounts").get(),
  ]);
  return {
    studyConfig: studySnap.data() ?? {},
    transportConfig: transportSnap.data() ?? {},
    discountRules: discountsSnap.data()?.rules ?? [],
  };
}

// ── Send billing notices for a period ────────────────────────────────────────

async function buildBillingRecord(
  group: { familyId: string; userId: string; study: any[]; transport: any[] },
  period: ReturnType<typeof periodForDate>,
  dryRun: boolean,
  configs: BillingConfigs,
  opts: { docId?: string; sendEmail?: boolean } = {},
): Promise<{ id: string; newlyBilledEnrollmentFeeSubs: { collection: "studyroom" | "transportationSubscriptions"; id: string }[] } | undefined> {
  const { familyId, userId, study, transport } = group;
  const { docId, sendEmail = !dryRun } = opts;

  const famSnap = await appCol("families").doc(familyId).get();
  if (!famSnap.exists) { console.warn(`Family ${familyId} not found`); return; }
  const fam = famSnap.data()!;
  const contact = fam.primaryContact ?? {};
  const billingName: string = contact.name ?? "Família";
  const billingEmail: string = contact.email ?? "";
  const paymentMethod: string = fam.paymentMethod ?? "mbway";

  const { lineItems, total, newlyBilledEnrollmentFeeSubs } = await computeLineItems({ study, transport }, period, configs, []);
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
  if (!dryRun && newlyBilledEnrollmentFeeSubs.length) await markEnrollmentFeeBilled(newlyBilledEnrollmentFeeSubs);

  if (sendEmail && billingEmail) {
    await appCol("emailOutbox").add({
      to: billingEmail,
      subject: `Pagamento pendente — ${COMPANY_NAME} — ${period.label}`,
      html: buildPaymentNoticeEmail({ clientName: billingName, periodLabel: period.label, total, lineItems, billingId: billingRef.id }),
      status: "queued",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return { id: billingRef.id, newlyBilledEnrollmentFeeSubs: dryRun ? [] : newlyBilledEnrollmentFeeSubs };
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

// ── Months are paid in order ─────────────────────────────────────────────────
// A monthly record (id `<familyId>_YYYY-MM`) cannot be paid while an earlier
// monthly record of the same family is still `pending`. `processing` (a payment
// already under way, e.g. an issued Multibanco reference) does not block, so
// paying several months together, oldest first, still works. `failed` does not
// block either: a parent cannot pay a failed record, so blocking on it would
// lock them out until an admin intervened. Party/camp records are not monthly
// and are neither checked nor counted. Mirrors PaymentsPage.tsx.
const MONTHLY_BILLING_ID = /_\d{4}-\d{2}$/;

async function assertEarlierMonthsPaid(billingId: string, billing: FirebaseFirestore.DocumentData): Promise<void> {
  if (!MONTHLY_BILLING_ID.test(billingId) || !billing.familyId || !billing.periodStart) return;
  const snap = await appCol("billing").where("familyId", "==", billing.familyId).get();
  const earlier = snap.docs
    .filter(d => d.id !== billingId && MONTHLY_BILLING_ID.test(d.id)
      && d.data().status === "pending"
      && d.data().periodStart?.toMillis?.() < billing.periodStart.toMillis())
    .sort((a, b) => a.data().periodStart.toMillis() - b.data().periodStart.toMillis());
  if (earlier.length) {
    throw new HttpsError("failed-precondition", `Pague primeiro ${earlier[0].data().periodLabel}.`);
  }
}

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
    await assertEarlierMonthsPaid(billingId, billing);
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
    await assertEarlierMonthsPaid(billingId, billing);

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
    await assertEarlierMonthsPaid(billingId, billing);

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

// A billing record is eligible for recompute if it's still "pending", or if
// it was cancelled by THIS logic itself (autoCancelled: true) because the
// family had zero billable subscriptions that period — not a deliberate
// admin cancellation of a specific invoice. Without this, reactivating a
// subscription after a stretch with none active would leave every affected
// period's record stuck "cancelled" forever, since nothing else ever
// revisits a non-pending record.
function isRecomputable(data: any): boolean {
  return data?.status === "pending" || (data?.status === "cancelled" && data?.autoCancelled === true);
}

async function autoCreateBillingSchedule(familyId: string, userId: string): Promise<void> {
  const [studySnap, transportSnap, configs] = await Promise.all([
    appCol("studyroom").where("familyId", "==", familyId).where("status", "in", ["active", "confirmed"]).get(),
    appCol("transportationSubscriptions").where("familyId", "==", familyId).where("status", "==", "active").get(),
    loadBillingConfigs(),
  ]);

  const group: { familyId: string; userId: string; study: any[]; transport: any[] } = {
    familyId,
    userId,
    study: studySnap.docs.map(d => ({ id: d.id, ...d.data() })),
    transport: transportSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };

  const periods = periodsUntilSchoolYearEnd(new Date());
  let created = 0, updated = 0, cancelled = 0;

  // group.study/group.transport are fetched once and reused across every
  // period below — computeLineItems reads enrollmentFeeBilled straight off
  // these in-memory sub objects, so once the fee is billed on one period,
  // that flag must be reflected here too before the next period in this
  // same loop is computed, or it would see the same stale "not yet billed"
  // objects and add the fee again.
  const applyFeeFlags = (subs: { collection: string; id: string }[]) => {
    for (const s of [...group.study, ...group.transport]) if (subs.some(x => x.id === s.id)) s.enrollmentFeeBilled = true;
  };

  for (const period of periods) {
    const docId = `${familyId}_${period.isoDate.slice(0, 7)}`;
    const existing = await appCol("billing").doc(docId).get();
    const existingLineItems: BillingLineItem[] = existing.exists ? (existing.data()?.lineItems ?? []) : [];
    const { lineItems, total, newlyBilledEnrollmentFeeSubs } = await computeLineItems(group, period, configs, existingLineItems);

    if (existing.exists) {
      if (isRecomputable(existing.data())) {
        if (lineItems.length === 0 || total === 0) {
          // All subscriptions for this family are now cancelled/inactive.
          // autoCancelled marks this as OUR doing, not a deliberate admin
          // cancellation — see isRecomputable's comment for why that matters.
          if (existing.data()?.status !== "cancelled") {
            await appCol("billing").doc(docId).update({
              status: "cancelled", autoCancelled: true,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            cancelled++;
          }
        } else {
          await appCol("billing").doc(docId).update({
            status: "pending", autoCancelled: admin.firestore.FieldValue.delete(),
            lineItems, total, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          if (newlyBilledEnrollmentFeeSubs.length) { await markEnrollmentFeeBilled(newlyBilledEnrollmentFeeSubs); applyFeeFlags(newlyBilledEnrollmentFeeSubs); }
          updated++;
        }
      }
      continue;
    }

    if (lineItems.length > 0 && total > 0) {
      const result = await buildBillingRecord(group, period, false, configs, { docId, sendEmail: false });
      if (result?.newlyBilledEnrollmentFeeSubs.length) applyFeeFlags(result.newlyBilledEnrollmentFeeSubs);
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

    // Cancel pending records for families that no longer have any active
    // subscriptions — but ONLY for periods strictly after the current month.
    // A family that cancels its only subscription mid-month was still
    // active for part of THIS month (and every prior month), so those
    // records represent real, already-earned charges. This loop bypasses
    // computeLineItems entirely, so it can't rely on ReservationEvents'
    // EXPECTED/CANCELLED/VOIDED split (which now handles the mid-month case
    // correctly on its own) — only a period that hasn't started yet can
    // safely be assumed here to have zero billable service.
    const startOfCurrentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const orphanSnap = await appCol("billing").where("status", "==", "pending").get();
    for (const doc of orphanSnap.docs) {
      const data = doc.data();
      const familyId = data.familyId;
      const periodStart: Date | undefined = data.periodStart?.toDate?.();
      const isFuturePeriod = !!periodStart && periodStart > startOfCurrentMonth;
      if (!familiesWithActiveSubs.has(familyId) && isFuturePeriod) {
        await doc.ref.update({ status: "cancelled", autoCancelled: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        cancelled++;
      }
    }

    // Recalculate / create billing records for families with active subscriptions
    for (const group of groups) {
      try {
        // Same in-memory-staleness guard as autoCreateBillingSchedule.
        const applyFeeFlags = (subs: { collection: string; id: string }[]) => {
          for (const s of [...group.study, ...group.transport]) if (subs.some(x => x.id === s.id)) s.enrollmentFeeBilled = true;
        };

        const periods = periodsUntilSchoolYearEnd(new Date());
        for (const period of periods) {
          const docId = `${group.familyId}_${period.isoDate.slice(0, 7)}`;
          const existing = await appCol("billing").doc(docId).get();
          const existingLineItems: BillingLineItem[] = existing.exists ? (existing.data()?.lineItems ?? []) : [];
          const { lineItems, total, newlyBilledEnrollmentFeeSubs } = await computeLineItems(group, period, configs, existingLineItems);
          if (existing.exists) {
            if (isRecomputable(existing.data())) {
              if (lineItems.length === 0 || total === 0) {
                if (existing.data()?.status !== "cancelled") {
                  await existing.ref.update({ status: "cancelled", autoCancelled: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                  cancelled++;
                } else {
                  skipped++;
                }
              } else {
                await existing.ref.update({
                  status: "pending", autoCancelled: admin.firestore.FieldValue.delete(),
                  lineItems, total, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                if (newlyBilledEnrollmentFeeSubs.length) { await markEnrollmentFeeBilled(newlyBilledEnrollmentFeeSubs); applyFeeFlags(newlyBilledEnrollmentFeeSubs); }
                updated++;
              }
            } else {
              skipped++;
            }
            continue;
          }
          if (lineItems.length > 0 && total > 0) {
            const result = await buildBillingRecord(group, period, false, configs, { docId, sendEmail: false });
            if (result?.newlyBilledEnrollmentFeeSubs.length) applyFeeFlags(result.newlyBilledEnrollmentFeeSubs);
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

// setBillingLineItemExcludedDays (the "Dias sem serviço" admin day-picker)
// was removed here — marking a day absent now goes through
// setReservationEventStatus in reservationEvents.ts, the same path parents
// use, so it's counted by the absence threshold and visible on both sides
// instead of being a disconnected, admin-only adjustment.

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

// Absences are billing-relevant facts, exactly like a subscription edit —
// the manual "gerar calendário de cobranças" backfill button existed
// largely to cover this gap by brute-forcing a recompute for everyone. This
// closes it properly: a status change on a ReservationEvent (EXPECTED <->
// CANCELLED via setReservationEventStatus, or -> VOIDED from the
// subscription triggers) recomputes just that one family. Deliberately
// scoped to STATUS CHANGES only (before.status !== after.status), not every
// write — the initial bulk generation of a subscription's full school-year
// event set (up to ~150 docs) would otherwise fire this once per document.
// familyId comes straight off the event doc itself, which the generator in
// reservationEvents.ts always sets correctly — unlike the old
// eventModifications collection, whose four separate client write sites
// didn't all populate familyId consistently.
export const onReservationEventBillingSync = onDocumentWritten(
  { document: "_apps/arcoiris/reservationEvents/{eventId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after || !before) return; // creation and deletion aren't status transitions
    if (before.status === after.status) return;
    const familyId: string = after.familyId;
    if (!familyId) return;
    await autoCreateBillingSchedule(familyId, after.changedBy ?? "");
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

