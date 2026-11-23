import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { appCol } from "./db";
import {
  alreadySignedUpDays, campAmounts, firmPerDay, fmtDatePt, holdExpiry, incompleteWeeks, isWeekType, planSignup, reminderDue,
  takenPerDay, waitingPerDay, waitlistOfferChanges, PlanDay, SeatSub,
} from "./campLogic";

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

// ── Shared helpers ────────────────────────────────────────────────────────────

const PAID = new Set(["paid", "invoiced"]);
const UNPAID = new Set(["pending", "failed"]);

type Tx = FirebaseFirestore.Transaction;
type Doc = FirebaseFirestore.DocumentData;
type Ts = FirebaseFirestore.Timestamp;

interface LoadedSub extends SeatSub {
  id: string;
  offerOpen: boolean;
  familyId?: string;
  childName?: string;
  data: Doc;
}

const toSub = (id: string, d: Doc): LoadedSub => ({
  id,
  status: String(d.status ?? ""),
  selectedDays: Array.isArray(d.selectedDays) ? d.selectedDays.map(String) : [],
  holdExpiresAtMs: d.holdExpiresAt?.toMillis?.() ?? null,
  subscriptionType: d.subscriptionType,
  createdAtMs: (d.holdStartedAt ?? d.createdAt)?.toMillis?.() ?? 0,
  offerOpen: d.offerOpen === true,
  familyId: d.familyId,
  childName: d.childName,
  data: d,
});

/** Every sign-up of a camp (a camp has tens of them, not thousands). */
async function campSubs(campId: string, tx?: Tx): Promise<LoadedSub[]> {
  const q = appCol("campSubscriptions").where("campId", "==", campId);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.map((d) => toSub(d.id, d.data()));
}

interface LoadedDays { plan: Record<string, PlanDay>; price: Record<string, number> }

async function campDaysOf(campId: string, tx?: Tx): Promise<LoadedDays> {
  const q = appCol("campDays").where("campId", "==", campId);
  const snap = tx ? await tx.get(q) : await q.get();
  const out: LoadedDays = { plan: {}, price: {} };
  for (const d of snap.docs) {
    const day = d.data();
    out.plan[d.id] = { date: String(day.date ?? ""), capacity: Number(day.capacity ?? 0), active: day.active !== false };
    out.price[d.id] = Number(day.price ?? 0);
  }
  return out;
}

function queueEmail(to: string, subject: string, headerSub: string, body: string, write?: Tx | FirebaseFirestore.WriteBatch): Promise<unknown> {
  const ref = appCol("emailOutbox").doc();
  const data = { to, subject, html: emailWrapper(headerSub, body), status: "queued", createdAt: admin.firestore.Timestamp.now() };
  if (!write) return ref.set(data);
  (write as FirebaseFirestore.WriteBatch).set(ref, data);
  return Promise.resolve();
}

const p = (html: string) => `<p style="font-size:15px;color:#374151;line-height:1.5;">${html}</p>`;
const button = (label: string, path: string) => `
  <p style="text-align:center;margin-top:24px;">
    <a href="${APP_URL}${path}" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">${label}</a>
  </p>`;
const eur = (n: unknown) => `€${Number(n ?? 0).toFixed(2)}`;
const fmtTs = (ts: Ts) =>
  ts.toDate().toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric" });
const datesOf = (ids: string[], days: Record<string, PlanDay>) => ids.map((id) => days[id]?.date ?? id).sort().map(fmtDatePt);
const sumPrices = (ids: string[], price: Record<string, number>) => ids.reduce((sum, id) => sum + (price[id] ?? 0), 0);

function depositBilling(sub: Doc, subId: string, campName: string, now: Ts, dueDate: Ts) {
  const title = `Sinal Campo — ${campName} — ${sub.childName}`;
  return {
    familyId: sub.familyId,
    userId: sub.userId,
    campSubscriptionId: subId,
    campId: sub.campId,
    type: "camp_deposit",
    periodLabel: title,
    periodStart: now,
    periodEnd: now,
    dueDate,
    total: sub.depositAmount,
    lineItems: [{ title, amount: sub.depositAmount }],
    billingName: sub.parentName,
    billingEmail: sub.parentEmail,
    paymentMethod: "mbway",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

/** The fields a new sign-up copies from the one it was split from. */
const personFields = (sub: Doc) => ({
  campId: sub.campId,
  familyId: sub.familyId,
  userId: sub.userId,
  childName: sub.childName,
  ...(sub.childAge != null ? { childAge: sub.childAge } : {}),
  parentName: sub.parentName,
  parentEmail: sub.parentEmail,
  ...(sub.parentPhone ? { parentPhone: sub.parentPhone } : {}),
  ...(sub.notes ? { notes: sub.notes } : {}),
});

// ── Waiting list: first to pay gets the seat ──────────────────────────────────

/**
 * Brings a camp's waiting-list offers in line with its free seats. A waiting
 * sign-up whose days all have a free seat gets a deposit bill and an email:
 * everyone waiting is offered at once and the first to pay is confirmed
 * (onCampDepositPaid). When a day fills up again, the others' unpaid bills are
 * cancelled and they're told. Safe to run at any time; it only acts on a
 * difference. Never throws: the caller's own work is already done.
 */
async function syncWaitlistOffers(campId: string): Promise<void> {
  try {
    await db.runTransaction(async (tx) => {
      const campName: string = (await tx.get(appCol("camps").doc(campId))).data()?.name ?? "";
      const days = await campDaysOf(campId, tx);
      const subs = await campSubs(campId, tx);
      const nowMs = Date.now();
      const { open, close } = waitlistOfferChanges(subs, days.plan, nowMs);
      if (!open.length && !close.length) return;
      const byId = new Map(subs.map((s) => [s.id, s]));

      const closing: { sub: LoadedSub; billRef: FirebaseFirestore.DocumentReference | null; billStatus?: string }[] = [];
      for (const id of close) {
        const sub = byId.get(id)!;
        const billRef = sub.data.depositBillingId ? appCol("billing").doc(sub.data.depositBillingId) : null;
        closing.push({ sub, billRef, billStatus: billRef ? (await tx.get(billRef)).data()?.status : undefined });
      }

      const now = admin.firestore.Timestamp.fromMillis(nowMs);
      for (const id of open) {
        const sub = byId.get(id)!;
        const billRef = appCol("billing").doc();
        tx.set(billRef, depositBilling(sub.data, id, campName, now, admin.firestore.Timestamp.fromMillis(holdExpiry(nowMs))));
        tx.update(appCol("campSubscriptions").doc(id), { offerOpen: true, offeredAt: now, depositBillingId: billRef.id, updatedAt: now });
        queueEmail(
          sub.data.parentEmail,
          `Há vaga — ${campName} — ${sub.data.childName}`,
          `Há vaga — ${campName}`,
          p(`Há vaga para <strong>${sub.data.childName}</strong> no campo <strong>${campName}</strong>: ${datesOf(sub.selectedDays, days.plan).join(", ")}.`) +
            p(`A vaga é de quem pagar primeiro o sinal de <strong>${eur(sub.data.depositAmount)}</strong>: este aviso foi enviado a todas as famílias em lista de espera para estes dias. Com o pagamento, a inscrição fica confirmada.`) +
            button("Pagar sinal", "/client/payments"),
          tx,
        );
      }
      for (const { sub, billRef, billStatus } of closing) {
        // A payment in flight (or already in): leave it, onCampDepositPaid confirms it.
        if (billStatus && !UNPAID.has(billStatus) && billStatus !== "cancelled") continue;
        if (billRef && billStatus && UNPAID.has(billStatus)) tx.update(billRef, { status: "cancelled", updatedAt: now });
        tx.update(appCol("campSubscriptions").doc(sub.id), { offerOpen: false, updatedAt: now });
        queueEmail(
          sub.data.parentEmail,
          `Vaga já ocupada — ${campName} — ${sub.data.childName}`,
          `Lista de espera — ${campName}`,
          p(`A vaga que tinha surgido no campo <strong>${campName}</strong> (${datesOf(sub.selectedDays, days.plan).join(", ")}) já foi ocupada, por isso o pedido de pagamento do sinal foi anulado.`) +
            p(`A inscrição de <strong>${sub.data.childName}</strong> continua em lista de espera e voltamos a avisar se surgir outra vaga.`),
          tx,
        );
      }
    });
  } catch (err: any) {
    console.error(`[camp] waiting-list offers not synced for camp ${campId}:`, err?.message ?? err);
  }
}

// ── createCampSubscription ────────────────────────────────────────────────────

/**
 * A parent signs a child up, for single days or whole weeks. See campLogic.ts
 * for the rules. One request can produce up to three sign-ups: a whole-week one
 * and a single-day one, each "pending" with a deposit bill and a hold, and a
 * "waitlisted" one for the days without a seat.
 */
export const createCampSubscription = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { campId, childName, childAge, parentName, parentEmail, parentPhone, notes } = request.data ?? {};
    const subscriptionType = String(request.data?.subscriptionType ?? "");
    const selectedDays: string[] = Array.isArray(request.data?.selectedDays) ? [...new Set<string>(request.data.selectedDays.map(String))] : [];

    if (!campId || !childName || !parentName || !parentEmail || !selectedDays.length || !["day", "week", "full"].includes(subscriptionType)) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    const campSnap = await appCol("camps").doc(campId).get();
    if (!campSnap.exists) throw new HttpsError("not-found", "Campo não encontrado");
    const camp = campSnap.data()!;
    if (camp.active === false) throw new HttpsError("failed-precondition", "As inscrições neste campo estão fechadas.");
    const campName: string = camp.name ?? "";

    const famSnap = await appCol("families").where("primaryContact.userId", "==", uid).limit(1).get();
    if (famSnap.empty) throw new HttpsError("not-found", "Família não encontrada");
    const familyId = famSnap.docs[0].id;

    const result = await db.runTransaction(async (tx) => {
      const days = await campDaysOf(campId, tx);
      for (const id of selectedDays) {
        if (!days.plan[id]) throw new HttpsError("not-found", "Um dos dias escolhidos não pertence a este campo.");
        if (!days.plan[id].active) throw new HttpsError("failed-precondition", `O dia ${fmtDatePt(days.plan[id].date)} não está aberto a inscrições.`);
      }
      // A week has precedence over single days, so it has to be a real one.
      if (isWeekType(subscriptionType) && incompleteWeeks(days.plan, selectedDays).length) {
        throw new HttpsError("invalid-argument", "Uma inscrição por semana tem de incluir todos os dias da semana.");
      }

      const existing = await campSubs(campId, tx);
      const clash = alreadySignedUpDays(existing, familyId, childName, selectedDays);
      if (clash.length) throw new HttpsError("already-exists", `${childName} já tem inscrição para: ${datesOf(clash, days.plan).join(", ")}.`);

      // Unpaid single-day holds can lose their seat to a week, unless a payment is in flight.
      const nowMs = Date.now();
      const bills = new Map<string, { ref: FirebaseFirestore.DocumentReference; status?: string }>();
      const unbumpable = new Set<string>();
      if (isWeekType(subscriptionType)) {
        for (const s of existing) {
          if (s.status !== "pending" || isWeekType(s.subscriptionType) || !s.selectedDays.some((id) => selectedDays.includes(id))) continue;
          if (!s.data.depositBillingId) continue;
          const ref = appCol("billing").doc(s.data.depositBillingId);
          const status = (await tx.get(ref)).data()?.status;
          bills.set(s.id, { ref, status });
          if (status && !UNPAID.has(status) && status !== "cancelled") unbumpable.add(s.id);
        }
      }

      const plan = planSignup({ type: subscriptionType, selected: selectedDays, days: days.plan, subs: existing, nowMs, unbumpable });
      const now = admin.firestore.Timestamp.fromMillis(nowMs);
      const holdExpiresAt = admin.firestore.Timestamp.fromMillis(holdExpiry(nowMs));
      const person = personFields({ campId, familyId, userId: uid, childName, childAge: childAge != null ? Number(childAge) : null, parentName, parentEmail, parentPhone, notes });

      // ── writes ──
      const created: { subscriptionId: string; depositBillingId: string; depositAmount: number }[] = [];
      const hold = (ids: string[], type: string) => {
        if (!ids.length) return;
        const subRef = appCol("campSubscriptions").doc();
        const billingRef = appCol("billing").doc();
        const sub = { ...person, subscriptionType: type, selectedDays: ids, ...campAmounts(sumPrices(ids, days.price)), status: "pending", holdExpiresAt, depositBillingId: billingRef.id, createdAt: now, updatedAt: now };
        tx.set(subRef, sub);
        tx.set(billingRef, depositBilling(sub, subRef.id, campName, now, holdExpiresAt));
        created.push({ subscriptionId: subRef.id, depositBillingId: billingRef.id, depositAmount: sub.depositAmount });
      };
      hold(plan.weekDays, "week");
      hold(plan.dayDays, "day");

      let waitlistSubscriptionId: string | null = null;
      if (plan.waitDays.length) {
        const waitRef = appCol("campSubscriptions").doc();
        tx.set(waitRef, { ...person, subscriptionType: "day", selectedDays: plan.waitDays, ...campAmounts(sumPrices(plan.waitDays, days.price)), status: "waitlisted", waitlistReason: "full", waitlistedAt: now, createdAt: now, updatedAt: now });
        waitlistSubscriptionId = waitRef.id;
      }

      // Single-day sign-ups that lose a held seat to this week.
      const lostDays = new Map<string, string[]>();
      for (const b of plan.bumps) lostDays.set(b.subId, [...(lostDays.get(b.subId) ?? []), b.dayId]);
      for (const [subId, lost] of lostDays) {
        const other = existing.find((s) => s.id === subId)!;
        const otherRef = appCol("campSubscriptions").doc(subId);
        const bill = bills.get(subId);
        const kept = other.selectedDays.filter((id) => !lost.includes(id));
        if (kept.length) {
          const amounts = campAmounts(sumPrices(kept, days.price));
          tx.update(otherRef, { selectedDays: kept, ...amounts, updatedAt: now });
          if (bill?.status && UNPAID.has(bill.status)) {
            const title = `Sinal Campo — ${campName} — ${other.data.childName}`;
            tx.update(bill.ref, { total: amounts.depositAmount, lineItems: [{ title, amount: amounts.depositAmount }], updatedAt: now });
          }
          tx.set(appCol("campSubscriptions").doc(), { ...personFields(other.data), subscriptionType: "day", selectedDays: lost, ...campAmounts(sumPrices(lost, days.price)), status: "waitlisted", waitlistReason: "bumped", waitlistedAt: now, createdAt: other.data.createdAt ?? now, updatedAt: now });
        } else {
          tx.update(otherRef, { status: "waitlisted", waitlistReason: "bumped", waitlistedAt: now, updatedAt: now });
          if (bill?.status && UNPAID.has(bill.status)) tx.update(bill.ref, { status: "cancelled", updatedAt: now });
        }
        queueEmail(
          other.data.parentEmail,
          `Inscrição em lista de espera — ${campName} — ${other.data.childName}`,
          `Lista de espera — ${campName}`,
          p(`A inscrição de <strong>${other.data.childName}</strong> no campo <strong>${campName}</strong> para ${datesOf(lost, days.plan).join(", ")} ainda não tinha o sinal pago, e a vaga foi ocupada por uma inscrição de semana completa, que tem prioridade.`) +
            p(`${lost.length > 1 ? "Estes dias passaram" : "Este dia passou"} para a <strong>lista de espera</strong>; avisamos por email se surgir uma vaga.` +
              (kept.length ? ` Os restantes dias (${datesOf(kept, days.plan).join(", ")}) mantêm-se, com o sinal atualizado para <strong>${eur(campAmounts(sumPrices(kept, days.price)).depositAmount)}</strong>.` : "")),
          tx,
        );
      }

      const reserved = datesOf([...plan.weekDays, ...plan.dayDays], days.plan);
      const waiting = datesOf(plan.waitDays, days.plan);
      const depositTotal = Math.round(created.reduce((sum, c) => sum + c.depositAmount, 0) * 100) / 100;
      const body =
        p(`Recebemos a inscrição de <strong>${childName}</strong> no campo <strong>${campName}</strong>.`) +
        (plan.downgradedWeeks.length
          ? p(`A semana pedida já tem dias completos, por isso a inscrição foi feita dia a dia.`)
          : "") +
        (reserved.length
          ? p(`<strong>Dias com vaga:</strong> ${reserved.join(", ")}.<br>A vaga fica reservada com o pagamento do sinal de <strong>${eur(depositTotal)}</strong>, até <strong>${fmtTs(holdExpiresAt)}</strong>. Sem pagamento até essa data, a inscrição passa para a lista de espera.`) +
            button("Pagar sinal", "/client/payments")
          : "") +
        (waiting.length
          ? p(`<strong>Em lista de espera</strong> (dias sem vaga): ${waiting.join(", ")}.<br>Avisamos por email se surgir uma vaga. Não há nada a pagar por estes dias para já.`)
          : "");
      queueEmail(parentEmail, `Inscrição recebida — ${campName} — ${childName}`, `Inscrição recebida — ${campName}`, body, tx);

      return {
        subscriptionId: created[0]?.subscriptionId ?? null,
        depositBillingId: created[0]?.depositBillingId ?? null,
        subscriptionIds: created.map((c) => c.subscriptionId),
        waitlistSubscriptionId,
        reservedDays: reserved,
        waitlistedDays: waiting,
        weekBookedAsDays: plan.downgradedWeeks.length > 0,
        holdExpiresAt: holdExpiresAt.toMillis(),
      };
    });

    console.log(`[createCampSubscription] family=${familyId} subs=${result.subscriptionIds.join(",")} waitlist=${result.waitlistSubscriptionId}`);
    await syncWaitlistOffers(campId);
    return result;
  }
);

// ── getCampAvailability ───────────────────────────────────────────────────────

/**
 * Per day of a camp, for the parents' page (they can't read other families'
 * sign-ups): seats taken, seats a whole week can't take, and people waiting.
 */
export const getCampAvailability = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const campId = String(request.data?.campId ?? "");
    if (!campId) throw new HttpsError("invalid-argument", "campId required");
    const subs = await campSubs(campId);
    const nowMs = Date.now();
    return { taken: takenPerDay(subs, nowMs), firm: firmPerDay(subs, nowMs), waiting: waitingPerDay(subs) };
  }
);

// ── Deposit paid → confirmed ──────────────────────────────────────────────────

/**
 * A camp deposit was paid (EasyPay webhook, or an admin marking it paid):
 * payment always confirms. That covers a sign-up within its hold, one on the
 * waiting list paying its offer (first to pay gets the seat), and a late
 * payment; if a day was already full, it's confirmed anyway (the money is in)
 * and flagged overCapacity for the admin. Paid on a cancelled sign-up: flagged
 * for a refund.
 */
export const onCampDepositPaid = onDocumentUpdated(
  { document: "_apps/arcoiris/billing/{billingId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (after?.type !== "camp_deposit" || !after.campSubscriptionId) return;
    if (PAID.has(before?.status) || !PAID.has(after.status)) return;

    const subRef = appCol("campSubscriptions").doc(after.campSubscriptionId);
    const confirmed = await db.runTransaction(async (tx) => {
      const sub = (await tx.get(subRef)).data();
      if (!sub || sub.status === "confirmed") return null;
      const now = admin.firestore.Timestamp.now();
      if (sub.status === "cancelled") {
        console.error(`[camp] PAYMENT ON CANCELLED sign-up ${subRef.id} (billing ${event.params.billingId}) — refund needed`);
        tx.update(subRef, { depositRefundPending: true, updatedAt: now });
        return null;
      }
      const update: Doc = { status: "confirmed", confirmedAt: now, updatedAt: now, depositBillingId: event.params.billingId, offerOpen: false };
      const nowMs = Date.now();
      const holding = sub.status === "pending" && sub.holdExpiresAt?.toMillis?.() > nowMs;
      if (!holding) {
        const days = await campDaysOf(sub.campId, tx);
        const taken = takenPerDay(await campSubs(sub.campId, tx), nowMs);
        if ((sub.selectedDays as string[]).some((id) => (taken[id] ?? 0) >= (days.plan[id]?.capacity ?? 0))) {
          update.overCapacity = true;
          console.error(`[camp] payment confirmed sign-up ${subRef.id} over capacity`);
        }
      }
      tx.update(subRef, update);
      return sub;
    });
    if (!confirmed) return;

    const campName: string = (await appCol("camps").doc(confirmed.campId).get()).data()?.name ?? "";
    const days = await campDaysOf(confirmed.campId);
    await queueEmail(
      confirmed.parentEmail,
      `Vaga confirmada — ${campName} — ${confirmed.childName}`,
      `Vaga confirmada — ${campName}`,
      p(`Recebemos o sinal. A vaga de <strong>${confirmed.childName}</strong> no campo <strong>${campName}</strong> está confirmada.`) +
        p(`<strong>Dias:</strong> ${datesOf(confirmed.selectedDays ?? [], days.plan).join(", ")}.<br><strong>Total:</strong> ${eur(confirmed.totalAmount)} · <strong>Sinal pago:</strong> ${eur(confirmed.depositAmount)} · <strong>Saldo após o campo:</strong> ${eur(confirmed.balanceAmount)}`),
    );
    await syncWaitlistOffers(confirmed.campId);
  }
);

// ── Unpaid sign-ups: reminders, then the waiting list ─────────────────────────

/**
 * Daily, for each unpaid ("pending") sign-up with a hold: a reminder on day 3
 * and day 5, and once the hold is over, the waiting list (seats freed, unpaid
 * deposit bill cancelled, parent emailed). Sign-ups from before holds existed
 * have no holdExpiresAt and are left alone. Each step writes the sign-up and
 * its email in one batch, so a re-run never emails twice. Then the waiting-list
 * offers of every camp with someone waiting are brought up to date.
 */
async function processUnpaidCampSignups(): Promise<void> {
  const snap = await appCol("campSubscriptions").where("status", "==", "pending").get();
  const camps = new Map<string, { name: string; days: LoadedDays }>();
  const campOf = async (campId: string) => {
    if (!camps.has(campId)) {
      camps.set(campId, { name: (await appCol("camps").doc(campId).get()).data()?.name ?? "", days: await campDaysOf(campId) });
    }
    return camps.get(campId)!;
  };
  let reminded = 0;
  let waitlisted = 0;

  for (const doc of snap.docs) {
    try {
      const sub = doc.data();
      const holdExpiresAt: Ts | undefined = sub.holdExpiresAt;
      if (!holdExpiresAt) continue;
      const nowMs = Date.now();
      const now = admin.firestore.Timestamp.fromMillis(nowMs);
      const camp = await campOf(sub.campId);
      const billRef = sub.depositBillingId ? appCol("billing").doc(sub.depositBillingId) : null;
      const billStatus: string | undefined = billRef ? (await billRef.get()).data()?.status : undefined;
      // Paid: onCampDepositPaid confirms it. Processing: a payment is in flight, wait for it.
      if (billStatus && !UNPAID.has(billStatus) && billStatus !== "cancelled") continue;

      if (holdExpiresAt.toMillis() <= nowMs) {
        const batch = db.batch();
        batch.update(doc.ref, { status: "waitlisted", waitlistReason: "unpaid", waitlistedAt: now, offerOpen: false, updatedAt: now });
        if (billRef && billStatus && UNPAID.has(billStatus)) batch.update(billRef, { status: "cancelled", updatedAt: now });
        queueEmail(
          sub.parentEmail,
          `Inscrição em lista de espera — ${camp.name} — ${sub.childName}`,
          `Lista de espera — ${camp.name}`,
          p(`O sinal da inscrição de <strong>${sub.childName}</strong> no campo <strong>${camp.name}</strong> (${datesOf(sub.selectedDays ?? [], camp.days.plan).join(", ")}) não foi pago dentro do prazo, por isso a vaga deixou de estar reservada e a inscrição passou para a <strong>lista de espera</strong>.`) +
            p(`Enquanto houver vaga, pode ficar com ela pagando o sinal: enviamos um email com o pedido de pagamento sempre que houver lugar. A vaga é de quem pagar primeiro.`),
          batch,
        );
        await batch.commit();
        waitlisted++;
        continue;
      }

      const startMs = (sub.holdStartedAt ?? sub.createdAt)?.toMillis?.() ?? nowMs;
      const due = reminderDue(startMs, nowMs, sub.lastReminderDay);
      if (!due) continue;
      const batch = db.batch();
      batch.update(doc.ref, { lastReminderDay: due, updatedAt: now });
      queueEmail(
        sub.parentEmail,
        `Lembrete: sinal por pagar — ${camp.name} — ${sub.childName}`,
        `Sinal por pagar — ${camp.name}`,
        p(`A inscrição de <strong>${sub.childName}</strong> no campo <strong>${camp.name}</strong> ainda tem o sinal de <strong>${eur(sub.depositAmount)}</strong> por pagar.`) +
          p(`A vaga está reservada até <strong>${fmtTs(holdExpiresAt)}</strong>. Sem pagamento até essa data, a inscrição passa para a lista de espera.`) +
          button("Pagar sinal", "/client/payments"),
        batch,
      );
      await batch.commit();
      reminded++;
    } catch (err: any) {
      console.error(`[camp] unpaid sign-up ${doc.id} not processed:`, err?.message ?? err);
    }
  }
  console.log(`[camp] unpaid sign-ups: ${snap.size} pending, reminded=${reminded}, waitlisted=${waitlisted}`);

  const waiting = await appCol("campSubscriptions").where("status", "==", "waitlisted").get();
  for (const campId of new Set(waiting.docs.map((d) => String(d.data().campId)))) await syncWaitlistOffers(campId);
}

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

    // An admin can confirm by hand (payment made outside the app), from the waiting list too.
    if (sub.status !== "pending" && sub.status !== "waitlisted") {
      throw new HttpsError("failed-precondition", `Subscription status is '${sub.status}', expected 'pending' or 'waitlisted'`);
    }

    const now = admin.firestore.Timestamp.now();
    await subRef.update({ status: "confirmed", confirmedAt: now, offerOpen: false, updatedAt: now });
    await syncWaitlistOffers(sub.campId);

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

    updates.offerOpen = false;
    await subRef.update(updates);
    // A freed seat goes to whoever on the waiting list pays first.
    await syncWaitlistOffers(sub.campId);
    return { ok: true };
  }
);

// ── createCampBalanceBillings (scheduled) ─────────────────────────────────────

export const createCampBalanceBillings = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Europe/Lisbon", region: "europe-west3" },
  async () => {
    // Same daily run (no second Cloud Scheduler job): reminders and the waiting list for unpaid sign-ups.
    try {
      await processUnpaidCampSignups();
    } catch (err: any) {
      console.error("[camp] processUnpaidCampSignups failed:", err?.message ?? err);
    }

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
