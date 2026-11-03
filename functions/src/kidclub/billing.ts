import * as admin from "firebase-admin";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { createInvoice, createOrUpdateClient, findOrCreateClientByNif, VendusDocument, VendusLineItem, VendusClient, PRODUCT_STUDY, PRODUCT_TRANSPORT, PRODUCT_ENROLLMENT_FEE, PRODUCT_INSURANCE, PAYMENT_METHOD_MULTIBANCO, PAYMENT_METHOD_TRANSFERENCIA } from "./vendus";
import { createMbwayPayment, createMultibancoPayment, createCardPayment, EasypayWebhookPayload } from "./easypay";
import { appCol } from "./db";
import { reconcileService, studyPerDayRate, resolveSchoolName, contractCoversPeriod, buildReconciliationConfig, manualDiscountPctFor, ReservationEventLite, SubscriptionForReconciliation, ReconciliationConfig } from "./reconciliation";
import { FAMILY_PAYMENT_METHODS, familyPaymentMethod, familyBillingInfo } from "./familyBilling";
import { ensurePartyDeposit } from "./partyDeposit";
import { familyInvoiceNif, realNif } from "./vendusClientLogic";
import { retryInvoiceRefusal } from "./retryInvoiceLogic";
import { eventLineId } from "./adhocEventLogic";
import { CLOSED_STATUSES, CarriedAbsenceCredit, CarryApplier, MonthEvents, LedgerBill, createCarryApplier, isServiceLine, outstandingCarryOver, periodLabelPt } from "./absenceCarryOver";

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

// FAMILY_PAYMENT_METHODS, familyPaymentMethod and familyBillingInfo (who owns a
// family's billing records: families/{id}.primaryContact.userId) live in
// familyBilling.ts, shared with partyDeposit.ts. Re-exported for existing importers.
export { FAMILY_PAYMENT_METHODS, familyPaymentMethod };

// Same self-heal as ownerUpdate, for the payment method: a still-pending bill
// follows the family's current choice. Empty when the family never chose one.
function methodUpdate(paymentMethod: string | undefined): { paymentMethod?: string } {
  return paymentMethod ? { paymentMethod } : {};
}

// Fields to merge into an update of an existing billing record so its owner
// self-heals on every recompute. Empty when the family has no owner yet, so an
// owner-less family never blanks out a record's existing userId.
function ownerUpdate(ownerUid: string): { userId?: string } {
  return ownerUid ? { userId: ownerUid } : {};
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

// Atomic claim before any Vendus call: EasyPay sends two webhook calls per
// payment, concurrently, and both used to reach Vendus — one real Fatura-Recibo
// each. Only the call that sets `invoiceClaimedAt` goes on. A Vendus error
// releases the claim (with `invoiceError`) so a retry can run. A claim left
// behind by a run that died mid-way is never auto-expired: Vendus may already
// have issued the invoice, so it blocks retries until an admin uses
// retryVendusInvoice, which clears it on purpose.
export async function createVendusInvoiceForBilling(billingId: string): Promise<void> {
  console.log(`[Vendus] start billingId=${billingId}`);

  const billingRef = appCol("billing").doc(billingId);
  const billing = await db.runTransaction(async (tx) => {
    const data = (await tx.get(billingRef)).data();
    if (!data) throw new Error(`Billing record ${billingId} not found`);
    if (data.status === "invoiced") {
      console.log(`[Vendus] billing ${billingId} already invoiced, skipping`);
      return null;
    }
    if (data.invoiceClaimedAt) {
      console.log(`[Vendus] billing ${billingId} already claimed by another invoice run, skipping`);
      return null;
    }
    tx.update(billingRef, {
      invoiceClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
      invoiceError: admin.firestore.FieldValue.delete(),
    });
    return data;
  });
  if (!billing) return;

  let vendusDoc: VendusDocument;
  let consumidorFinal: boolean;
  try {
    ({ vendusDoc, consumidorFinal } = await issueVendusInvoice(billing));
  } catch (err: any) {
    // Vendus did not issue it: release the claim so a retry can run.
    await billingRef.update({
      invoiceError: err.message,
      invoiceClaimedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    throw err;
  }

  try {
    // Also clears invoiceError: an invoiced bill must never keep one, or the
    // admin is offered "Tentar faturar novamente" for a bill that already has
    // its invoice (prod, oK6GHA7D0f4cRVM3RNZW_2026-09, before the claim existed).
    await billingRef.update({
      status: "invoiced",
      invoiceNumber: vendusDoc.number,
      vendusId: vendusDoc.id,
      atcud: vendusDoc.atcud ?? null,
      invoiceError: admin.firestore.FieldValue.delete(),
      invoiceClaimedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err: any) {
    // Vendus issued the invoice but recording it failed: keep the claim so
    // nothing retries into a duplicate.
    console.error(`[Vendus] invoice ${vendusDoc.number} (id=${vendusDoc.id}) CREATED but not recorded on billing ${billingId}:`, err.message);
    await billingRef.update({
      invoiceError: `Fatura Vendus ${vendusDoc.number} (id ${vendusDoc.id}) criada mas não registada — confirmar no Vendus antes de repetir. (${err.message})`,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    throw err;
  }

  // Every recorded invoice gets one "Fatura disponível" email (Renato,
  // 2026-10-14): Vendus emails none (the prod clients sampled all have
  // send_email "no", and a Consumidor final invoice has no client at all).
  // Only the run that issued and recorded this invoice gets here (the claim
  // and status checks above), and the outbox doc id is keyed on the invoice,
  // so the same invoice can never be queued twice.
  await queueInvoiceReadyEmail(billingId, billing, vendusDoc, consumidorFinal);
}

// Exported for billing.test.ts only.
export async function issueVendusInvoice(billing: FirebaseFirestore.DocumentData): Promise<{ vendusDoc: VendusDocument; consumidorFinal: boolean }> {
  const currentProject = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  if (DEV_PROJECTS_WITHOUT_VENDUS_SANDBOX.has(currentProject)) {
    throw new Error(
      `Vendus invoicing is disabled on ${currentProject}: this project has no Vendus sandbox, ` +
      `only the real production account, so creating an invoice here would generate a real fiscal document.`
    );
  }

  const { familyId, total, billingName, billingEmail, periodLabel } = billing;
  console.log(`[Vendus] billing ok — family=${familyId || "none"} total=${total} period=${periodLabel}`);

  // A one-off event's guest has no family (adhocEvents.ts): the NIF they gave,
  // if any, is on the bill itself, and their client is found or created by
  // that NIF without touching an existing one (findOrCreateClientByNif).
  // Event bills only: any other bill without a family still fails loudly below.
  if (billing.type === "event" && !familyId) {
    const guestNif = realNif(billing.guestNif);
    let guestClient: VendusClient | null = null;
    if (guestNif) {
      const id = await findOrCreateClientByNif({ name: billingName, email: billingEmail, fiscal_id: guestNif }, `event-guest:${billing.eventRegistrationId ?? "?"}`);
      guestClient = { id };
    }
    console.log(`[Vendus] guest bill (no family) — ${guestClient ? `client ${guestClient.id}` : "Consumidor final"}`);
    return createAndCheckInvoice(billing, guestClient);
  }

  const famSnap = await appCol("families").doc(familyId).get();
  const fam = famSnap.data() ?? {};

  // With a NIF: the family's Vendus client, created/linked on first use.
  // Without one: no client at all, so Vendus issues it to "Consumidor final".
  // That includes families still holding an old NIF-less vendusClientId: it's
  // no longer used (Renato, option B, 2026-10-13). Nothing is created or
  // updated in Vendus for them.
  const nif = familyInvoiceNif(fam);
  let vendusClient: VendusClient | null = null;
  if (nif) {
    let vendusClientId: number | null = fam.vendusClientId ?? null;
    console.log(`[Vendus] vendusClientId=${vendusClientId ?? "none"} nif=${nif}`);
    if (!vendusClientId) {
      // No send_email: Vendus's own invoice emails stay off, the app sends
      // "Fatura disponível" instead (Renato, 2026-10-14; no double email).
      vendusClientId = await createOrUpdateClient(familyId, {
        name: billingName,
        email: billingEmail,
        fiscal_id: nif,
      }, null); // only reached when the family has no vendusClientId yet
      await appCol("families").doc(familyId).update({ vendusClientId });
      console.log(`[Vendus] client created/synced vendusClientId=${vendusClientId}`);
    }
    vendusClient = { id: vendusClientId };
  } else {
    console.log(`[Vendus] family ${familyId} has no NIF — invoicing Consumidor final, no client (ignoring vendusClientId=${fam.vendusClientId ?? "none"})`);
  }
  return createAndCheckInvoice(billing, vendusClient);
}

async function createAndCheckInvoice(billing: FirebaseFirestore.DocumentData, vendusClient: VendusClient | null): Promise<{ vendusDoc: VendusDocument; consumidorFinal: boolean }> {
  const { lineItems, total, periodLabel } = billing;
  const isCampBilling = billing.type === "camp_deposit" || billing.type === "camp_balance" || billing.type === "event";
  // One-off event lines (type "event") are PRODUCT_STUDY (23%) like camps,
  // whatever the event is called — even a name starting with "Transporte".
  const vendusProductId = (li: { title: string; type?: string }): number => {
    if (isCampBilling || li.type === "event") return PRODUCT_STUDY;
    if (li.title.startsWith("Transporte")) return PRODUCT_TRANSPORT;
    if (li.title.startsWith("Taxa de Inscrição")) return PRODUCT_ENROLLMENT_FEE;
    if (li.title.startsWith("Seguro")) return PRODUCT_INSURANCE;
    return PRODUCT_STUDY;
  };
  const items: VendusLineItem[] = lineItems.map((li: any) => ({
    id: vendusProductId(li),
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

  console.log(`[Vendus] invoice created — number=${vendusDoc.number} id=${vendusDoc.id} atcud=${vendusDoc.atcud} client=${vendusClient ? vendusClient.id : "Consumidor final"}`);
  return { vendusDoc, consumidorFinal: !vendusClient };
}

/** emailOutbox doc id of an invoice's "Fatura disponível" email: one per
 *  Vendus document. (A bill deliberately re-invoiced with retryVendusInvoice
 *  `force` gets a new document, so its new invoice is emailed too.) */
export const invoiceReadyEmailId = (vendusId: number) => `invoiceReady_${vendusId}`;

// "Fatura disponível" email (see the caller). create() fails if the doc already
// exists, so a second attempt for the same invoice queues nothing. Never
// throws: the invoice is already issued and recorded.
async function queueInvoiceReadyEmail(billingId: string, billing: FirebaseFirestore.DocumentData, vendusDoc: VendusDocument, consumidorFinal: boolean): Promise<void> {
  if (!billing.billingEmail) return;
  try {
    // A one-off event's guest has no client area: their link is the
    // registration's own page, where the invoice can be downloaded.
    const guestLink = !billing.familyId && billing.eventRegistrationId
      ? await adhocRegistrationLink(billing.eventRegistrationId)
      : null;
    await appCol("emailOutbox").doc(invoiceReadyEmailId(vendusDoc.id)).create({
      to: billing.billingEmail,
      subject: `Fatura disponível — ${COMPANY_NAME} — ${billing.periodLabel}`,
      html: buildInvoiceReadyEmail({
        clientName: billing.billingName ?? "",
        periodLabel: billing.periodLabel ?? "",
        total: Number(billing.total ?? 0),
        invoiceNumber: vendusDoc.number,
        consumidorFinal,
        guestLink,
      }),
      status: "queued",
      billingId,
      familyId: billing.familyId ?? null,
      tags: ["invoice"],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err: any) {
    if (err?.code === 6 || /already exists/i.test(err?.message ?? "")) {
      console.log(`[Vendus] "fatura disponível" email for invoice ${vendusDoc.number} (id ${vendusDoc.id}) already queued, not queuing again`);
      return;
    }
    console.error(`[Vendus] invoice ${vendusDoc.number} issued for billing ${billingId}, but the "fatura disponível" email could not be queued:`, err?.message ?? err);
  }
}

// ── Compute line items for a group ────────────────────────────────────────────

export interface BillingLineItem {
  title: string;
  amount: number;               // net, after discounts AND absence credit
  grossAmount: number;          // before discounts — the flat monthly price (scheduleLength x rate x activeWeeksInPattern), not a count of this period's occurrences
  subscriptionId: string;           // event lines: eventLineId(registrationId, childIndex)
  type: "study" | "transport" | "enrollment" | "event";
  appliedDiscounts: AppliedDiscount[]; // kept for type compatibility; study/transport line items no longer populate this — see multiTripDiscountAmount etc. below
  scheduleDays?: string[];      // weekday names this line item is actually billed for — lets the admin UI show real service days
  legacyPricing?: boolean;       // billed on the grandfathered flat model (institutionalDiscountPct = sum of the sub's discounts)
  tripsByDay?: Record<string, ("pickup" | "dropoff" | "both")[]>; // transport only — which trip(s) run on each scheduled weekday
  multiTripDiscountAmount?: number;    // marginal — only trip #2+ on a multi-trip day
  siblingDiscountAmount?: number;      // marginal — only applies if this isn't the family's highest-value subscription for this service
  institutionalDiscountAmount?: number; // school + returning-student + manual, summed, on the post-sibling subtotal
  institutionalDiscountPct?: number;
  absenceCount?: number;         // CANCELLED ReservationEvents this period, this subscription
  absenceDates?: string[];       // ISO yyyy-mm-dd — every CANCELLED date, credited or not
  absenceCreditAmount?: number;
  absenceCreditDates?: string[]; // ISO yyyy-mm-dd — every CANCELLED date credited once the 3-absence threshold was reached (uncapped, not just the first 3)
  notionalOccurrences?: number;  // scheduleLength x activeWeeks behind gross; lets a later carry-over price this month's absences on this line's own terms
  // Credit (or charge) carried in from a closed month of the SAME subscription
  // (absenceCarryOver.ts). Already included in `amount`; the title is never
  // changed, because Vendus products are mapped by title.
  carriedAbsenceCredits?: CarriedAbsenceCredit[];
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
// See legacyFlatPctFor in computeLineItems. Midnight Lisbon time.
const LEGACY_PRICING_CUTOFF = new Date("2026-10-01T00:00:00+01:00");

// One-off events a family chose to put on its monthly bill (adhocEvents.ts).
// Their lines were priced and frozen at signup, so they're copied as they are;
// a registration cancelled later simply stops matching, and the next recompute
// drops its lines from a bill that can still change.
async function fetchEventLines(familyId: string | undefined, period: ReturnType<typeof periodForDate>): Promise<BillingLineItem[]> {
  if (!familyId) return [];
  const snap = await appCol("adhocEventRegistrations")
    .where("familyId", "==", familyId)
    .where("billingPeriod", "==", period.isoDate.slice(0, 7))
    .get();
  const regs = snap.docs
    .filter(d => d.data().payment === "monthly" && d.data().status === "confirmed")
    .sort((a, b) => (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0) || a.id.localeCompare(b.id));
  const out: BillingLineItem[] = [];
  for (const d of regs) {
    (d.data().lines ?? []).forEach((l: { title: string; amount: number }, i: number) => {
      const amount = Math.round(Number(l.amount ?? 0) * 100) / 100;
      out.push({ title: l.title, amount, grossAmount: amount, subscriptionId: eventLineId(d.id, i), type: "event", appliedDiscounts: [] });
    });
  }
  return out;
}

async function computeLineItems(
  group: { familyId?: string; study: any[]; transport: any[] },
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

  // Old pricing (grandfathered, Renato 2026-10-01): subscriptions created
  // before the cutoff keep the flat model their card and monthlyFee show
  // (gross minus the sum of appliedDiscounts) for the rest of the school year
  // — next year's enrollments are new subscription docs. An explicit
  // `legacyPricing` on the subscription (admin switch on the card) wins over
  // the date, in either direction.
  const legacyFlatPctFor = (sub: any): number | undefined => {
    const legacy: boolean = sub.legacyPricing ?? enrollmentDateOf(sub) < LEGACY_PRICING_CUTOFF;
    if (!legacy) return undefined;
    return Math.min((sub.appliedDiscounts ?? []).reduce((n: number, d: any) => n + (d.percentage ?? 0), 0), 1);
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
      legacyFlatPct: legacyFlatPctFor(sub),
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
        ...(legacyFlatPctFor(sub) !== undefined ? { legacyPricing: true } : {}),
        absenceCount: r.absenceCount,
        ...(r.absenceDates.length ? { absenceDates: r.absenceDates } : {}),
        absenceCreditAmount: r.absenceCreditCents / 100,
        ...(r.absenceCreditDates.length ? { absenceCreditDates: r.absenceCreditDates } : {}),
        notionalOccurrences: r.notionalOccurrences,
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
      legacyFlatPct: legacyFlatPctFor(sub),
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
        ...(legacyFlatPctFor(sub) !== undefined ? { legacyPricing: true } : {}),
        absenceCount: r.absenceCount,
        ...(r.absenceDates.length ? { absenceDates: r.absenceDates } : {}),
        absenceCreditAmount: r.absenceCreditCents / 100,
        ...(r.absenceCreditDates.length ? { absenceCreditDates: r.absenceCreditDates } : {}),
        notionalOccurrences: r.notionalOccurrences,
      });
      total += amount;
      maybeAddEnrollmentFee(sub);
    }
  }

  for (const li of await fetchEventLines(group.familyId, period)) {
    lineItems.push(li);
    total += li.amount;
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
  opts: { docId?: string; sendEmail?: boolean; precomputed?: Awaited<ReturnType<typeof computeLineItems>> } = {},
): Promise<{ id: string; newlyBilledEnrollmentFeeSubs: { collection: "studyroom" | "transportationSubscriptions"; id: string }[] } | undefined> {
  const { familyId } = group;
  const { docId, sendEmail = !dryRun } = opts;

  const famSnap = await appCol("families").doc(familyId).get();
  if (!famSnap.exists) { console.warn(`Family ${familyId} not found`); return; }
  const fam = famSnap.data()!;
  const contact = fam.primaryContact ?? {};
  // Owner comes from the family, never from group.userId (a subscription's
  // possibly-empty userId) — see familyBillingInfo().
  const userId: string = contact.userId ?? "";
  const billingName: string = contact.name ?? "Família";
  const billingEmail: string = contact.email ?? "";
  const paymentMethod: string = familyPaymentMethod(fam) ?? "mbway";

  // The recompute loops pass their own lines, already carrying any absence
  // credit from a closed month (absenceCarryOver.ts); computing again here
  // would drop it.
  const { lineItems, total, newlyBilledEnrollmentFeeSubs } = opts.precomputed
    ?? await computeLineItems(group, period, configs, []);
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
// A record the parent can (still) pay. `failed` is an attempt that didn't
// complete (e.g. an MB WAY request not approved in time); the parent retries it.
const UNPAID_STATUSES = new Set(["pending", "failed"]);

// Card and Multibanco are off until the Easypay account has a card POS (#53
// hid the buttons; this stops a page loaded before that from starting one).
// Flip together with re-adding the buttons in PaymentsPage.tsx.
const CARD_AND_MULTIBANCO_ENABLED = false;
const MBWAY_ONLY_MESSAGE = "Pagamento temporariamente disponível apenas por MB WAY";

// Starting a new Easypay payment replaces `easypayId`. The old id is kept in
// `previousEasypayIds` so a late webhook for that attempt still finds the bill
// (money arrived → it must be recorded, or flagged if the bill is already paid).
function replaceEasypayIdFields(billing: FirebaseFirestore.DocumentData): Record<string, unknown> {
  return billing.easypayId
    ? { previousEasypayIds: admin.firestore.FieldValue.arrayUnion(billing.easypayId) }
    : {};
}

// A monthly record (id `<familyId>_YYYY-MM`) cannot be paid while an earlier
// monthly record of the same family is still unpaid (`pending` or `failed`).
// `processing` (a payment already under way, e.g. an issued Multibanco
// reference) does not block, so paying several months together, oldest first,
// still works. Party/camp records are not monthly and are neither checked nor
// counted. Mirrors PaymentsPage.tsx.
const MONTHLY_BILLING_ID = /_\d{4}-\d{2}$/;

async function assertEarlierMonthsPaid(billingId: string, billing: FirebaseFirestore.DocumentData): Promise<void> {
  if (!MONTHLY_BILLING_ID.test(billingId) || !billing.familyId || !billing.periodStart) return;
  const snap = await appCol("billing").where("familyId", "==", billing.familyId).get();
  const earlier = snap.docs
    .filter(d => d.id !== billingId && MONTHLY_BILLING_ID.test(d.id)
      && UNPAID_STATUSES.has(d.data().status)
      && d.data().periodStart?.toMillis?.() < billing.periodStart.toMillis())
    .sort((a, b) => a.data().periodStart.toMillis() - b.data().periodStart.toMillis());
  if (earlier.length) {
    throw new HttpsError("failed-precondition",
      `As mensalidades são pagas por ordem. Poderá pagar este mês assim que ${earlier[0].data().periodLabel} estiver pago.`);
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

    const billing = (await appCol("billing").doc(billingId).get()).data();
    if (!billing) throw new HttpsError("not-found", "Billing record not found");
    if (billing.userId !== uid) throw new HttpsError("permission-denied", "Unauthorized");
    return startMbwayPayment(billingId, billing, phone);
  }
);

/**
 * Starts an MB WAY payment for a bill whose caller is already checked: the bill
 * must still be unpaid, earlier months paid, and at least €0.50. Used by
 * initiateMbwayPayment (signed-in parent), payPartyDepositByLink
 * (partyPublic.ts, a party deposit paid from its email link) and
 * payAdhocRegistration (adhocEvents.ts, a one-off event paid from its link).
 */
export async function startMbwayPayment(
  billingId: string,
  billing: FirebaseFirestore.DocumentData,
  phone: string,
): Promise<{ easypayId: string }> {
    const billingRef = appCol("billing").doc(billingId);
    if (!UNPAID_STATUSES.has(billing.status)) throw new HttpsError("failed-precondition", `Already processed (status=${billing.status})`);
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

    // Transaction: an admin may have marked the bill paid (bank transfer,
    // markBillingPaid) while this request was out at Easypay. Never move a paid
    // bill back to `processing`; keep the new id in previousEasypayIds so that
    // if the parent approves it anyway the webhook flags the duplicate.
    const stillOpen = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(billingRef)).data();
      if (!cur || !UNPAID_STATUSES.has(cur.status)) {
        tx.update(billingRef, {
          previousEasypayIds: admin.firestore.FieldValue.arrayUnion(res.id),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return false;
      }
      tx.update(billingRef, {
        ...replaceEasypayIdFields(cur),
        status: "processing",
        easypayId: res.id,
        mbwayPhone: phone,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (!stillOpen) {
      console.warn(`[MBWay] billing ${billingId} was paid meanwhile — easypayId=${res.id} kept only in previousEasypayIds`);
      throw new HttpsError("failed-precondition", "Esta mensalidade acabou de ser marcada como paga.");
    }

    console.log(`[MBWay] billing ${billingId} → processing easypayId=${res.id}`);
    return { easypayId: res.id };
}

// ── Client initiates Multibanco payment ──────────────────────────────────────

export const initiateMultibancoPayment = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "EASYPAY_WEBHOOK_URL"] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    if (!CARD_AND_MULTIBANCO_ENABLED) throw new HttpsError("failed-precondition", MBWAY_ONLY_MESSAGE);

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
    if (!CARD_AND_MULTIBANCO_ENABLED) throw new HttpsError("failed-precondition", MBWAY_ONLY_MESSAGE);

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

      // The bill's current attempt, or — after a retry or an admin reset — an
      // earlier one. Money for an earlier attempt still has to be recorded.
      let snap = await appCol("billing").where("easypayId", "==", paymentId).limit(1).get();
      if (snap.empty) {
        snap = await appCol("billing").where("previousEasypayIds", "array-contains", paymentId).limit(1).get();
      }

      if (snap.empty) {
        console.warn(`[Webhook] no billing record found for easypayId=${paymentId}`);
        res.status(200).send("ok");
        return;
      }

      // EasyPay's two calls for one payment arrive milliseconds apart and run
      // concurrently. Decide and mark paid inside a transaction, so only the
      // call that actually moves the bill to `paid` creates the invoice.
      const billingDoc = snap.docs[0];
      const outcome = await db.runTransaction(async (tx) => {
        const billingData = (await tx.get(billingDoc.ref)).data();
        if (!billingData) return "skip" as const;
        const currentStatus = billingData.status;
        const alreadyPaid = currentStatus === "paid" || currentStatus === "invoiced";

        // Paid, and by a different Easypay payment than this one: the parent paid
        // twice (an old attempt landed after a retry). Never invoice it again;
        // flag it for an admin to refund. Bills paid before `paidEasypayId`
        // existed have none, and are treated as paid by this payment.
        // Also paid twice: an admin marked it paid by bank transfer
        // (markBillingPaid → `manualPayment`, no paidEasypayId) and an Easypay
        // payment for it lands too (an MB WAY / Multibanco attempt the parent
        // also completed). Same flag, so it shows up in the same admin alerts.
        const paidByOther = billingData.paidEasypayId
          ? billingData.paidEasypayId !== paymentId
          : !!billingData.manualPayment;
        if (alreadyPaid && paidByOther) {
          const known: string[] = billingData.duplicatePaymentEasypayIds ?? [];
          if (!known.includes(paymentId)) {
            console.error(`[Webhook] DUPLICATE PAYMENT billing ${billingDoc.id}: easypayId=${paymentId}, already paid by ${billingData.paidEasypayId ?? "manual bank transfer (markBillingPaid)"}`);
            tx.update(billingDoc.ref, {
              duplicatePaymentEasypayIds: admin.firestore.FieldValue.arrayUnion(paymentId),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          return "skip" as const;
        }

        // Paid but the invoice failed previously. createVendusInvoiceForBilling's
        // claim decides which call retries (and clears invoiceError there).
        if (currentStatus === "paid" && billingData.invoiceError) return "retryInvoice" as const;

        // Idempotent: EasyPay sends two webhook calls per payment
        if (alreadyPaid || currentStatus === "cancelled") {
          if (currentStatus === "cancelled") console.error(`[Webhook] PAYMENT ON CANCELLED billing ${billingDoc.id}: easypayId=${paymentId} — needs a refund or reinstating`);
          else console.log(`[Webhook] billing ${billingDoc.id} already processed (status=${currentStatus})`);
          return "skip" as const;
        }

        // `processing` is the normal case. `pending`/`failed` happen when this is
        // an earlier attempt landing after a failure or an admin reset.
        tx.update(billingDoc.ref, {
          status: "paid",
          paidEasypayId: paymentId,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return "markedPaid" as const;
      });

      if (outcome === "skip") {
        res.status(200).send("ok");
        return;
      }

      if (outcome === "retryInvoice") console.log(`[Webhook] billing ${billingDoc.id} paid but invoice failed — retrying`);
      else console.log(`[Webhook] matched billing ${billingDoc.id} → marked paid by this call — starting Vendus invoice`);
      // createVendusInvoiceForBilling records invoiceError itself on failure.
      try {
        await createVendusInvoiceForBilling(billingDoc.id);
        console.log(`[Webhook] Vendus invoice step done for billing ${billingDoc.id}`);
      } catch (err: any) {
        console.error(`[Webhook] Vendus invoice failed for billing ${billingDoc.id}:`, err.message);
      }
    }

    if (isFailure) {
      console.log(`[Webhook] failure easypayId=${paymentId} status=${payload.status}`);

      // Only the current attempt: a failure for an earlier one must not mark a
      // newer attempt, still under way, as failed.
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
        console.warn(`[Webhook] no current billing for easypayId=${paymentId} (earlier attempt or unknown)`);
      }
    }

    res.status(200).send("ok");
  }
);

// ── Create party deposit billing record ──────────────────────────────────────
// Since 2026-10-20 the deposit bill is created when the admin confirms the
// booking (onPartyBookingStatusNotify, partyBookings.ts). This callable stays
// for bookings confirmed before that, and as the party page's fallback: it
// returns the existing bill, or creates it through the same helper (one bill
// per booking either way, see ensurePartyDeposit).

export const createPartyDeposit = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { bookingId } = request.data ?? {};
    if (!bookingId) throw new HttpsError("invalid-argument", "bookingId required");

    const bookingSnap = await appCol("bookings").doc(bookingId).get();
    if (!bookingSnap.exists) throw new HttpsError("not-found", "Reserva não encontrada.");
    const booking = bookingSnap.data()!;

    // The booking's parent, the family's owner, or an admin (impersonating a
    // family, the admin's own uid matches neither).
    if (booking.userId !== uid) {
      const famSnap = await appCol("families")
        .where("primaryContact.userId", "==", uid)
        .limit(1)
        .get();
      if (famSnap.empty || famSnap.docs[0].id !== booking.familyId) {
        const roles = (await db.collection("users").doc(uid).get()).data()?.roles ?? {};
        if (!roles.owner && !roles.rainbowAdmin) throw new HttpsError("permission-denied", "Unauthorized");
      }
    }

    if (booking.status !== "confirmed") {
      throw new HttpsError("failed-precondition", "A reserva ainda não foi confirmada.");
    }

    // Owner = the family's primaryContact.userId (not the caller), amount =
    // 50% of the IVA-inclusive total: see ensurePartyDeposit.
    const { billingId } = await ensurePartyDeposit(bookingId, booking, "createPartyDeposit");
    return { billingId };
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
    // Refuses any bill that already records an invoice (number or Vendus id),
    // even with a stale invoiceError on it, unless `force`: see retryInvoiceLogic.ts.
    const refusal = retryInvoiceRefusal(billing, !!force);
    if (refusal) {
      console.warn(`[retryVendusInvoice] refused billing ${billingId}: ${refusal.message}`);
      throw new HttpsError(refusal.code, refusal.message);
    }

    // Reset status to paid so createVendusInvoiceForBilling can re-run
    await billingRef.update({
      status: "paid",
      invoiceError: admin.firestore.FieldValue.delete(),
      invoiceClaimedAt: admin.firestore.FieldValue.delete(), // explicit admin override of a stale claim
      invoiceNumber: admin.firestore.FieldValue.delete(),
      vendusId: admin.firestore.FieldValue.delete(),
      atcud: admin.firestore.FieldValue.delete(),
    });

    await createVendusInvoiceForBilling(billingId);
    return { ok: true };
  }
);

// ── Admin: reset a payment stuck in `processing` ─────────────────────────────
// A card link or Multibanco reference that will never be used leaves the bill
// `processing`, and the parent has no way back. The admin checks in Easypay
// that the old payment was not paid, then resets the bill to `pending`. The old
// id moves to `previousEasypayIds`, so if it does land after all, the webhook
// still records it (or flags a duplicate). Transaction: never reset a bill the
// webhook has just marked paid.

export const resetStuckPayment = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new HttpsError("permission-denied", "Unauthorized");

    const { billingId } = request.data ?? {};
    if (!billingId) throw new HttpsError("invalid-argument", "billingId required");

    const billingRef = appCol("billing").doc(billingId);
    await db.runTransaction(async (tx) => {
      const billing = (await tx.get(billingRef)).data();
      if (!billing) throw new HttpsError("not-found", "Billing record not found");
      if (billing.status !== "processing") {
        throw new HttpsError("failed-precondition", `Only a bill in processing can be reset (status=${billing.status})`);
      }
      tx.update(billingRef, {
        ...replaceEasypayIdFields(billing),
        status: "pending",
        easypayId: admin.firestore.FieldValue.delete(),
        paymentLink: admin.firestore.FieldValue.delete(),
        multibancoEntity: admin.firestore.FieldValue.delete(),
        multibancoReference: admin.firestore.FieldValue.delete(),
        multibancoExpiry: admin.firestore.FieldValue.delete(),
        paymentResetAt: admin.firestore.FieldValue.serverTimestamp(),
        paymentResetBy: uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log(`[resetStuckPayment] billing ${billingId} → pending by ${uid}`);
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
    if (!(FAMILY_PAYMENT_METHODS as readonly string[]).includes(method)) {
      throw new Error("Invalid payment method");
    }

    // The owner link is primaryContact.userId (families have no top-level
    // userId — this looked that up before and always threw "Family not found").
    const familySnap = await appCol("families").where("primaryContact.userId", "==", uid).limit(1).get();
    if (familySnap.empty) throw new Error("Family not found");

    const update: Record<string, any> = { paymentMethod: method, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (method === "mbway" && mbwayPhone) update.mbwayPhone = mbwayPhone;

    await familySnap.docs[0].ref.update(update);

    // Bills not yet started follow the new choice right away (the recompute
    // triggers would also do it, but only on the next subscription change).
    const pending = await appCol("billing").where("familyId", "==", familySnap.docs[0].id).where("status", "==", "pending").get();
    await Promise.all(pending.docs.map(d => d.ref.update({ paymentMethod: method })));
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

// Months to recompute for a family: every month from the current one to the
// school-year end (as before), PLUS any earlier month whose bill is still
// recomputable. Without the earlier ones, from the 1st of a month every change
// to last month's still-unpaid bill (an absence marked late, a schedule fix)
// was silently ignored (found 2026-10-01: September absences never reached
// September's bill). Past months are only ever updated, never created — a past
// month with no bill had nothing billable — and paid/invoiced ones are left
// alone by isRecomputable.
async function periodsToRecompute(familyId: string) {
  const now = new Date();
  const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const open = await appCol("billing").where("familyId", "==", familyId).where("status", "in", ["pending", "cancelled"]).get();
  const pastMonths = new Map<string, Date>();
  for (const d of open.docs) {
    if (!isRecomputable(d.data())) continue;
    const start: Date | undefined = d.data().periodStart?.toDate?.();
    if (start && start < startOfCurrentMonth) pastMonths.set(d.id, start);
  }
  const past = [...pastMonths.values()].sort((a, b) => a.getTime() - b.getTime()).map(d => periodForDate(d));
  return { periods: [...past, ...periodsUntilSchoolYearEnd(now)], startOfCurrentMonth };
}

// A past month's bill may only be recomputed when the recompute still covers
// every subscription already on it. computeLineItems only sees subscriptions
// that are active NOW, so a family that cancelled in October would otherwise
// lose (or auto-cancel) September charges it really owes.
function pastMonthSafe(existing: BillingLineItem[], next: BillingLineItem[]): boolean {
  const ids = (items: BillingLineItem[]) => new Set(items.filter(li => li.type === "study" || li.type === "transport").map(li => li.subscriptionId));
  const after = ids(next);
  return next.length > 0 && [...ids(existing)].every(id => after.has(id));
}

// ── Absence credit carried out of closed months ─────────────────────────────
// The ledger itself is absenceCarryOver.ts. Loaded once per family recompute
// and applied by both loops below (autoCreateBillingSchedule and the
// backfillBillingSchedules repair button), in ascending period order. Both
// must apply it: a recompute that left it out would strip every carried
// credit off the open bills it rewrites.
async function loadAbsenceCarryOver(familyId: string): Promise<CarryApplier> {
  const snap = await appCol("billing").where("familyId", "==", familyId).get();
  const bills: LedgerBill[] = [];
  for (const d of snap.docs) {
    const data = d.data();
    if (data.type || !MONTHLY_BILLING_ID.test(d.id)) continue; // party/camp bills aren't monthly
    bills.push({ period: d.id.slice(-7), status: data.status, lines: data.lineItems ?? [] });
  }
  // The current events of every closed month, for the subscriptions on it.
  const events = new Map<string, MonthEvents>();
  for (const b of bills) {
    if (!CLOSED_STATUSES.has(b.status)) continue;
    const subIds = [...new Set(b.lines.filter(isServiceLine).map(l => l.subscriptionId!))];
    if (!subIds.length) continue;
    const [y, m] = b.period.split("-").map(Number);
    const bySub = await fetchReservationEventsForPeriod(subIds, [], periodForDate(new Date(y, m - 1, 1)));
    for (const [subId, list] of bySub) {
      events.set(`${b.period}|${subId}`, {
        total: list.length,
        cancelled: list.filter(e => e.status === "CANCELLED").length,
        rateCents: list.find(e => e.basePriceCents > 0)?.basePriceCents,
      });
    }
  }
  const { outstanding, skipped } = outstandingCarryOver(bills, (period, subId) => events.get(`${period}|${subId}`));
  for (const x of skipped) {
    console.log(`[billing] ${familyId}: no absence carry-over from ${x.fromPeriod} for ${x.subscriptionId}: ${x.reason}`);
  }
  return createCarryApplier(outstanding);
}

function applyCarry(
  carry: CarryApplier,
  period: ReturnType<typeof periodForDate>,
  computed: Awaited<ReturnType<typeof computeLineItems>>,
): Awaited<ReturnType<typeof computeLineItems>> {
  const { lines, deltaCents } = carry.apply(period.isoDate.slice(0, 7), computed.lineItems);
  return { ...computed, lineItems: lines, total: Math.round(computed.total * 100 + deltaCents) / 100 };
}

function warnUnappliedCarry(familyId: string, carry: CarryApplier): void {
  for (const u of carry.unapplied()) {
    console.warn(
      `[billing] ${familyId}: absence ${u.cents > 0 ? "credit" : "charge"} of EUR ${(Math.abs(u.cents) / 100).toFixed(2)} `
      + `from ${u.fromPeriod} for subscription ${u.subscriptionId} has no open bill of that subscription to go on. `
      + `Left unapplied: settle it by hand (refund / credit note) if it should stand.`,
    );
  }
}

// Exported for reservationEvents.ts, which calls it once after writing a
// subscription's pre-start system absences: event CREATION never reaches
// onReservationEventBillingSync below, and the subscription's own billing
// trigger runs in parallel with event generation, so it can price the month
// before those absences exist. (billing.ts must not import reservationEvents.ts
// back, or the two modules become circular.)
export async function autoCreateBillingSchedule(familyId: string): Promise<void> {
  const [studySnap, transportSnap, configs, famInfo] = await Promise.all([
    appCol("studyroom").where("familyId", "==", familyId).where("status", "in", ["active", "confirmed"]).get(),
    appCol("transportationSubscriptions").where("familyId", "==", familyId).where("status", "==", "active").get(),
    loadBillingConfigs(),
    familyBillingInfo(familyId),
  ]);
  const userId = famInfo.ownerUid;

  const group: { familyId: string; userId: string; study: any[]; transport: any[] } = {
    familyId,
    userId,
    study: studySnap.docs.map(d => ({ id: d.id, ...d.data() })),
    transport: transportSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };

  const { periods, startOfCurrentMonth } = await periodsToRecompute(familyId);
  const carry = await loadAbsenceCarryOver(familyId);
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
    const computed = await computeLineItems(group, period, configs, existingLineItems);

    if (existing.exists) {
      if (period.start < startOfCurrentMonth && !pastMonthSafe(existingLineItems, computed.lineItems)) {
        // Left as it is, so whatever carry it already records stands.
        if (isRecomputable(existing.data())) carry.standing(existingLineItems);
        console.warn(`[billing] ${docId}: past month left as-is, a subscription on it is no longer active`);
        continue;
      }
      if (isRecomputable(existing.data())) {
        const { lineItems, total, newlyBilledEnrollmentFeeSubs } = applyCarry(carry, period, computed);
        if (lineItems.length === 0 || total === 0) {
          // All subscriptions for this family are now cancelled/inactive, or
          // the month is fully covered by credit. autoCancelled marks this as
          // OUR doing, not a deliberate admin cancellation — see
          // isRecomputable's comment for why that matters. With lines left,
          // they're stored too, so a month zeroed by carried credit shows why.
          if (existing.data()?.status !== "cancelled" || lineItems.length) {
            await appCol("billing").doc(docId).update({
              status: "cancelled", autoCancelled: true, ...ownerUpdate(userId),
              ...(lineItems.length ? { lineItems, total } : {}),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            if (existing.data()?.status !== "cancelled") cancelled++;
          }
        } else {
          await appCol("billing").doc(docId).update({
            status: "pending", autoCancelled: admin.firestore.FieldValue.delete(),
            lineItems, total, ...ownerUpdate(userId), ...methodUpdate(famInfo.paymentMethod),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          if (newlyBilledEnrollmentFeeSubs.length) { await markEnrollmentFeeBilled(newlyBilledEnrollmentFeeSubs); applyFeeFlags(newlyBilledEnrollmentFeeSubs); }
          updated++;
        }
      }
      continue;
    }

    if (period.start < startOfCurrentMonth) continue; // past months: update only, never create
    const withCarry = applyCarry(carry, period, computed);
    if (withCarry.lineItems.length > 0 && withCarry.total > 0) {
      const result = await buildBillingRecord(group, period, false, configs, { docId, sendEmail: false, precomputed: withCarry });
      if (result?.newlyBilledEnrollmentFeeSubs.length) applyFeeFlags(result.newlyBilledEnrollmentFeeSubs);
      created++;
    }
  }

  warnUnappliedCarry(familyId, carry);
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
      // A one-off event put on that month's bill (fetchEventLines) is billable
      // without any subscription: leave it to onAdhocRegistrationBillingSync.
      const hasEventLines = (data.lineItems ?? []).some((li: any) => li?.type === "event");
      if (!familiesWithActiveSubs.has(familyId) && isFuturePeriod && !hasEventLines) {
        await doc.ref.update({ status: "cancelled", autoCancelled: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        cancelled++;
      }
    }

    // Recalculate / create billing records for families with active subscriptions
    for (const group of groups) {
      try {
        // getActiveSubs() took userId off an arbitrary subscription; replace it
        // with the family's owner (see familyBillingInfo()).
        const famInfo = await familyBillingInfo(group.familyId);
        group.userId = famInfo.ownerUid;
        // Same in-memory-staleness guard as autoCreateBillingSchedule.
        const applyFeeFlags = (subs: { collection: string; id: string }[]) => {
          for (const s of [...group.study, ...group.transport]) if (subs.some(x => x.id === s.id)) s.enrollmentFeeBilled = true;
        };

        const { periods, startOfCurrentMonth: monthStart } = await periodsToRecompute(group.familyId);
        const carry = await loadAbsenceCarryOver(group.familyId);
        for (const period of periods) {
          const docId = `${group.familyId}_${period.isoDate.slice(0, 7)}`;
          const existing = await appCol("billing").doc(docId).get();
          const existingLineItems: BillingLineItem[] = existing.exists ? (existing.data()?.lineItems ?? []) : [];
          const computed = await computeLineItems(group, period, configs, existingLineItems);
          if (existing.exists) {
            if (period.start < monthStart && !pastMonthSafe(existingLineItems, computed.lineItems)) {
              if (isRecomputable(existing.data())) carry.standing(existingLineItems);
              console.warn(`[backfill] ${docId}: past month left as-is, a subscription on it is no longer active`);
              skipped++;
              continue;
            }
            if (isRecomputable(existing.data())) {
              const { lineItems, total, newlyBilledEnrollmentFeeSubs } = applyCarry(carry, period, computed);
              if (lineItems.length === 0 || total === 0) {
                if (existing.data()?.status !== "cancelled" || lineItems.length) {
                  await existing.ref.update({
                    status: "cancelled", autoCancelled: true, ...ownerUpdate(group.userId),
                    ...(lineItems.length ? { lineItems, total } : {}),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                  if (existing.data()?.status !== "cancelled") cancelled++; else skipped++;
                } else {
                  skipped++;
                }
              } else {
                await existing.ref.update({
                  status: "pending", autoCancelled: admin.firestore.FieldValue.delete(),
                  lineItems, total, ...ownerUpdate(group.userId), ...methodUpdate(famInfo.paymentMethod),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                if (newlyBilledEnrollmentFeeSubs.length) { await markEnrollmentFeeBilled(newlyBilledEnrollmentFeeSubs); applyFeeFlags(newlyBilledEnrollmentFeeSubs); }
                updated++;
              }
            } else {
              skipped++;
            }
            continue;
          }
          if (period.start < monthStart) continue; // past months: update only, never create
          const withCarry = applyCarry(carry, period, computed);
          if (withCarry.lineItems.length > 0 && withCarry.total > 0) {
            const result = await buildBillingRecord(group, period, false, configs, { docId, sendEmail: false, precomputed: withCarry });
            if (result?.newlyBilledEnrollmentFeeSubs.length) applyFeeFlags(result.newlyBilledEnrollmentFeeSubs);
            created++;
          }
        }
        warnUnappliedCarry(group.familyId, carry);
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
    await autoCreateBillingSchedule(familyId);
  }
);

export const onTransportBillingSync = onDocumentWritten(
  { document: "_apps/arcoiris/transportationSubscriptions/{subId}", region: "europe-west3" },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) return; // deleted
    const familyId: string = after.familyId;
    if (!familyId) return;
    await autoCreateBillingSchedule(familyId);
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
// The one creation that does move money — a subscription's pre-start system
// absences — is recomputed once by reservationEvents.ts itself, after it has
// written them (see regenerateFutureEvents there).
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
    await autoCreateBillingSchedule(familyId);
  }
);

// A one-off event put on the monthly bill (adhocEvents.ts) is a billing fact
// too: confirming or cancelling it, or moving it to another month, recomputes
// that family's bills, which pick its lines up in fetchEventLines. Pay-now
// registrations have their own bill and never touch the monthly ones.
export const onAdhocRegistrationBillingSync = onDocumentWritten(
  { document: "_apps/arcoiris/adhocEventRegistrations/{registrationId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    const monthly = (d: FirebaseFirestore.DocumentData | undefined) => d?.payment === "monthly" && !!d?.familyId;
    if (!monthly(before) && !monthly(after)) return;
    if (before && after && before.status === after.status && before.billingPeriod === after.billingPeriod) return;
    const familyId: string = after?.familyId ?? before?.familyId;
    await autoCreateBillingSchedule(familyId);
  }
);

// ── Email templates ───────────────────────────────────────────────────────────

function buildPaymentNoticeEmail(opts: {
  clientName: string;
  periodLabel: string;
  total: number;
  lineItems: { title: string; amount: number; carriedAbsenceCredits?: CarriedAbsenceCredit[] }[];
  billingId: string;
}): string {
  const { clientName, periodLabel, total, lineItems } = opts;
  const rows = lineItems.map(li =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${li.title}${carriedCreditsHtml(li.carriedAbsenceCredits)}</td>
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

// "Crédito de faltas de Outubro 2026: −€12.00" under the line it lowered (a
// charge for days restored after payment reads "Acerto de faltas", +€).
// Exported for billingCarryOver.test.ts.
export function carriedCreditText(c: CarriedAbsenceCredit): string {
  const label = periodLabelPt(c.fromPeriod);
  return c.amount >= 0
    ? `Crédito de faltas de ${label}: −€${c.amount.toFixed(2)}`
    : `Acerto de faltas de ${label}: +€${(-c.amount).toFixed(2)}`;
}

function carriedCreditsHtml(credits: CarriedAbsenceCredit[] | undefined): string {
  return (credits ?? []).map(c =>
    `<br><span style="font-size:12px;color:#6b7280;">${escapeHtml(carriedCreditText(c))}</span>`).join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

/** The page a one-off event registration is followed on, token included (adhocEvents.ts). */
export async function adhocRegistrationLink(registrationId: string): Promise<string | null> {
  const token = (await appCol("adhocEventRegistrations").doc(registrationId).get()).data()?.accessToken;
  const appUrl = process.env.APP_URL || "https://kidclub.pt"; // the dev site on kidclub-dev (functions/.env.kidclub-dev)
  return typeof token === "string" && token ? `${appUrl}/eventos/inscricao/${registrationId}?t=${encodeURIComponent(token)}` : null;
}

// Same layout as buildPaymentNoticeEmail. A Consumidor final invoice (no NIF)
// also asks for the NIF for next time.
function buildInvoiceReadyEmail(opts: {
  clientName: string;
  periodLabel: string;
  total: number;
  invoiceNumber: string;
  consumidorFinal: boolean;
  guestLink?: string | null; // one-off event guest: no client area, link to the registration
}): string {
  const clientName = escapeHtml(opts.clientName);
  const periodLabel = escapeHtml(opts.periodLabel);
  const invoiceNumber = escapeHtml(opts.invoiceNumber);
  return `<!DOCTYPE html><html lang="pt"><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:24px;">${COMPANY_NAME}</h1>
  <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">Pagamento recebido — ${periodLabel}</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="font-size:16px;color:#374151;">Olá${clientName ? `, <strong>${clientName}</strong>` : ""},</p>
  <p style="font-size:14px;color:#6b7280;">Recebemos o pagamento de <strong>${periodLabel}</strong> (€${opts.total.toFixed(2)}). A fatura <strong>${invoiceNumber}</strong> está disponível ${opts.guestLink ? "na página da sua inscrição" : "na sua área de cliente, em Pagamentos"}.</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${opts.guestLink ? escapeHtml(opts.guestLink) : "https://kidclub.pt/client/payments"}" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Ver fatura</a>
  </p>
  ${opts.consumidorFinal && !opts.guestLink ? `<p style="font-size:12px;color:#9ca3af;">Esta fatura foi emitida sem NIF (Consumidor final). Se quiser o seu NIF nas próximas faturas, adicione-o em <a href="https://kidclub.pt/client/account" style="color:#4f46e5;">A minha conta</a>.</p>` : ""}
</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;font-size:12px;color:#9ca3af;">${COMPANY_NAME} · NIF 518942120 · Avenida da Guarda Inglesa, Lote E, Coimbra</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
