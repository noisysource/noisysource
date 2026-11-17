import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { appCol } from "./db";
import { alreadySignedUpDays, campAmounts, fmtDatePt, holdExpiry, reminderDue, splitByAvailability, takenPerDay } from "./campLogic";

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

const toSeatSub = (d: Doc) => ({
  status: String(d.status ?? ""),
  selectedDays: Array.isArray(d.selectedDays) ? d.selectedDays.map(String) : [],
  holdExpiresAtMs: d.holdExpiresAt?.toMillis?.() ?? null,
  familyId: d.familyId as string | undefined,
  childName: d.childName as string | undefined,
});

/** Every sign-up of a camp (a camp has tens of them, not thousands). */
async function campSubs(campId: string, tx?: Tx) {
  const q = appCol("campSubscriptions").where("campId", "==", campId);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...toSeatSub(d.data()) }));
}

function queueEmail(to: string, subject: string, headerSub: string, body: string, write?: Tx | FirebaseFirestore.WriteBatch) {
  const ref = appCol("emailOutbox").doc();
  const data = { to, subject, html: emailWrapper(headerSub, body), status: "queued", createdAt: admin.firestore.Timestamp.now() };
  if (write) (write as any).set(ref, data);
  else return ref.set(data);
  return Promise.resolve();
}

const p = (html: string) => `<p style="font-size:15px;color:#374151;line-height:1.5;">${html}</p>`;
const button = (label: string, path: string) => `
  <p style="text-align:center;margin-top:24px;">
    <a href="${APP_URL}${path}" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">${label}</a>
  </p>`;
const eur = (n: unknown) => `€${Number(n ?? 0).toFixed(2)}`;
const fmtTs = (ts: FirebaseFirestore.Timestamp) =>
  ts.toDate().toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric" });

async function dayDates(dayIds: string[]): Promise<string[]> {
  const snaps = await Promise.all(dayIds.map((id) => appCol("campDays").doc(id).get()));
  return snaps.map((s) => String(s.data()?.date ?? s.id)).sort().map(fmtDatePt);
}

function depositBilling(sub: Doc, subId: string, campName: string, now: FirebaseFirestore.Timestamp, dueDate: FirebaseFirestore.Timestamp) {
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

// ── createCampSubscription ────────────────────────────────────────────────────

/**
 * A parent signs a child up. Days with a free seat become a "pending" sign-up
 * that holds those seats for HOLD_DAYS while the deposit is unpaid (paying it
 * confirms: onCampDepositPaid). Days already full become a separate
 * "waitlisted" sign-up, with no bill.
 */
export const createCampSubscription = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const { campId, childName, childAge, parentName, parentEmail, parentPhone, subscriptionType, notes } = request.data ?? {};
    const selectedDays: string[] = Array.isArray(request.data?.selectedDays) ? [...new Set<string>(request.data.selectedDays.map(String))] : [];

    if (!campId || !childName || !parentName || !parentEmail || !subscriptionType || !selectedDays.length) {
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
      const daySnaps = await Promise.all(selectedDays.map((id) => tx.get(appCol("campDays").doc(id))));
      const capacity: Record<string, number> = {};
      const price: Record<string, number> = {};
      const date: Record<string, string> = {};
      for (const snap of daySnaps) {
        const day = snap.data();
        if (!snap.exists || !day || day.campId !== campId) throw new HttpsError("not-found", "Um dos dias escolhidos não pertence a este campo.");
        if (!day.active) throw new HttpsError("failed-precondition", `O dia ${fmtDatePt(day.date ?? snap.id)} não está aberto a inscrições.`);
        capacity[snap.id] = Number(day.capacity ?? 0);
        price[snap.id] = Number(day.price ?? 0);
        date[snap.id] = String(day.date ?? snap.id);
      }

      const existing = await campSubs(campId, tx);
      const clash = alreadySignedUpDays(existing, familyId, childName, selectedDays);
      if (clash.length) {
        throw new HttpsError("already-exists", `${childName} já tem inscrição para: ${clash.map((id) => fmtDatePt(date[id])).sort().join(", ")}.`);
      }

      const nowMs = Date.now();
      const { available, full } = splitByAvailability(selectedDays, capacity, takenPerDay(existing, nowMs));
      const now = admin.firestore.Timestamp.fromMillis(nowMs);
      const holdExpiresAt = admin.firestore.Timestamp.fromMillis(holdExpiry(nowMs));

      const base = (days: string[]) => ({
        campId,
        familyId,
        userId: uid,
        childName,
        ...(childAge != null ? { childAge: Number(childAge) } : {}),
        parentName,
        parentEmail,
        ...(parentPhone ? { parentPhone } : {}),
        subscriptionType,
        selectedDays: days,
        ...campAmounts(days.reduce((sum, id) => sum + price[id], 0)),
        ...(notes ? { notes } : {}),
        createdAt: now,
        updatedAt: now,
      });

      let subscriptionId: string | null = null;
      let depositBillingId: string | null = null;
      let depositAmount = 0;
      if (available.length) {
        const subRef = appCol("campSubscriptions").doc();
        const billingRef = appCol("billing").doc();
        const sub = { ...base(available), status: "pending", holdExpiresAt, depositBillingId: billingRef.id };
        tx.set(subRef, sub);
        tx.set(billingRef, depositBilling(sub, subRef.id, campName, now, holdExpiresAt));
        subscriptionId = subRef.id;
        depositBillingId = billingRef.id;
        depositAmount = sub.depositAmount;
      }

      let waitlistSubscriptionId: string | null = null;
      if (full.length) {
        const waitRef = appCol("campSubscriptions").doc();
        tx.set(waitRef, { ...base(full), status: "waitlisted", waitlistReason: "full", waitlistedAt: now });
        waitlistSubscriptionId = waitRef.id;
      }

      const dates = (ids: string[]) => ids.map((id) => date[id]).sort().map(fmtDatePt);
      const reserved = dates(available);
      const waiting = dates(full);
      const body =
        p(`Recebemos a inscrição de <strong>${childName}</strong> no campo <strong>${campName}</strong>.`) +
        (reserved.length
          ? p(`<strong>Dias com vaga:</strong> ${reserved.join(", ")}.<br>A vaga fica reservada com o pagamento do sinal de <strong>${eur(depositAmount)}</strong>, até <strong>${fmtTs(holdExpiresAt)}</strong>. Sem pagamento até essa data, a inscrição passa para a lista de espera.`) +
            button("Pagar sinal", "/client/payments")
          : "") +
        (waiting.length
          ? p(`<strong>Em lista de espera</strong> (dias já completos): ${waiting.join(", ")}.<br>Avisamos por email se surgir uma vaga. Não há nada a pagar por estes dias para já.`)
          : "");
      queueEmail(parentEmail, `Inscrição recebida — ${campName} — ${childName}`, `Inscrição recebida — ${campName}`, body, tx);

      return { subscriptionId, depositBillingId, waitlistSubscriptionId, reservedDays: reserved, waitlistedDays: waiting, holdExpiresAt: holdExpiresAt.toMillis() };
    });

    console.log(`[createCampSubscription] family=${familyId} sub=${result.subscriptionId} deposit=${result.depositBillingId} waitlist=${result.waitlistSubscriptionId}`);
    return result;
  }
);

// ── getCampAvailability ───────────────────────────────────────────────────────

/** Seats taken per day of a camp, for the parents' page (they can't read other families' sign-ups). */
export const getCampAvailability = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const campId = String(request.data?.campId ?? "");
    if (!campId) throw new HttpsError("invalid-argument", "campId required");
    return { taken: takenPerDay(await campSubs(campId), Date.now()) };
  }
);

// ── Deposit paid → confirmed ──────────────────────────────────────────────────

/**
 * A camp deposit was paid (EasyPay webhook, or an admin marking it paid): the
 * seat is reserved, so the sign-up is confirmed. A late payment on a sign-up
 * that had gone to the waiting list is confirmed too (the money is in) and
 * flagged overCapacity if a day is now over its capacity. Paid on a cancelled
 * sign-up: flagged for a refund.
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
      const update: Doc = { status: "confirmed", confirmedAt: now, updatedAt: now, depositBillingId: event.params.billingId };
      if (sub.status === "waitlisted") {
        const taken = takenPerDay(await campSubs(sub.campId, tx), Date.now());
        const daySnaps = await Promise.all((sub.selectedDays as string[]).map((id) => tx.get(appCol("campDays").doc(id))));
        if (daySnaps.some((s) => (taken[s.id] ?? 0) >= Number(s.data()?.capacity ?? 0))) {
          update.overCapacity = true;
          console.error(`[camp] late payment confirmed sign-up ${subRef.id} over capacity`);
        }
      }
      tx.update(subRef, update);
      return sub;
    });
    if (!confirmed) return;

    const campName: string = (await appCol("camps").doc(confirmed.campId).get()).data()?.name ?? "";
    const dates = await dayDates(confirmed.selectedDays ?? []);
    await queueEmail(
      confirmed.parentEmail,
      `Vaga confirmada — ${campName} — ${confirmed.childName}`,
      `Vaga confirmada — ${campName}`,
      p(`Recebemos o sinal. A vaga de <strong>${confirmed.childName}</strong> no campo <strong>${campName}</strong> está confirmada.`) +
        p(`<strong>Dias:</strong> ${dates.join(", ")}.<br><strong>Total:</strong> ${eur(confirmed.totalAmount)} · <strong>Sinal pago:</strong> ${eur(confirmed.depositAmount)} · <strong>Saldo após o campo:</strong> ${eur(confirmed.balanceAmount)}`),
    );
  }
);

// ── Waiting list → offered a seat (admin) ─────────────────────────────────────

/**
 * An admin gives a waitlisted sign-up a seat: it becomes "pending" again with
 * a fresh hold and a new deposit bill, and the parent is emailed. Refused if
 * any of its days is full.
 */
export const offerCampSeat = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    if (!(await isAdmin(uid))) throw new HttpsError("permission-denied", "Unauthorized");
    const subscriptionId = String(request.data?.subscriptionId ?? "");
    if (!subscriptionId) throw new HttpsError("invalid-argument", "subscriptionId required");

    const subRef = appCol("campSubscriptions").doc(subscriptionId);
    const holdExpiresAtMs = await db.runTransaction(async (tx) => {
      const sub = (await tx.get(subRef)).data();
      if (!sub) throw new HttpsError("not-found", "Subscription not found");
      if (sub.status !== "waitlisted") throw new HttpsError("failed-precondition", "Esta inscrição não está em lista de espera.");

      const campName: string = (await tx.get(appCol("camps").doc(sub.campId))).data()?.name ?? "";
      const daySnaps = await Promise.all((sub.selectedDays as string[]).map((id) => tx.get(appCol("campDays").doc(id))));
      const nowMs = Date.now();
      const taken = takenPerDay(await campSubs(sub.campId, tx), nowMs);
      const fullDays = daySnaps.filter((s) => (taken[s.id] ?? 0) >= Number(s.data()?.capacity ?? 0));
      if (fullDays.length) {
        throw new HttpsError("failed-precondition", `Sem vaga em: ${fullDays.map((s) => fmtDatePt(String(s.data()?.date ?? s.id))).sort().join(", ")}.`);
      }

      const now = admin.firestore.Timestamp.fromMillis(nowMs);
      const holdExpiresAt = admin.firestore.Timestamp.fromMillis(holdExpiry(nowMs));
      const billingRef = appCol("billing").doc();
      tx.set(billingRef, depositBilling(sub, subRef.id, campName, now, holdExpiresAt));
      tx.update(subRef, {
        status: "pending",
        holdExpiresAt,
        holdStartedAt: now,
        depositBillingId: billingRef.id,
        lastReminderDay: admin.firestore.FieldValue.delete(),
        waitlistReason: admin.firestore.FieldValue.delete(),
        updatedAt: now,
      });
      const dates = daySnaps.map((s) => String(s.data()?.date ?? s.id)).sort().map(fmtDatePt);
      queueEmail(
        sub.parentEmail,
        `Há vaga — ${campName} — ${sub.childName}`,
        `Há vaga — ${campName}`,
        p(`Surgiu uma vaga para <strong>${sub.childName}</strong> no campo <strong>${campName}</strong>: ${dates.join(", ")}.`) +
          p(`A vaga fica reservada com o pagamento do sinal de <strong>${eur(sub.depositAmount)}</strong>, até <strong>${fmtTs(holdExpiresAt)}</strong>. Sem pagamento até essa data, a inscrição volta para a lista de espera.`) +
          button("Pagar sinal", "/client/payments"),
        tx,
      );
      return holdExpiresAt.toMillis();
    });
    return { ok: true, holdExpiresAt: holdExpiresAtMs };
  }
);

// ── Unpaid sign-ups: reminders, then the waiting list ─────────────────────────

/**
 * Daily, for each unpaid ("pending") sign-up with a hold: a reminder on day 3
 * and day 5, and once the hold is over, the waiting list (seats freed, unpaid
 * deposit bill cancelled, parent emailed). Sign-ups from before holds existed
 * have no holdExpiresAt and are left alone. Each step writes the sign-up and
 * its email in one batch, so a re-run never emails twice.
 */
async function processUnpaidCampSignups(): Promise<void> {
  const snap = await appCol("campSubscriptions").where("status", "==", "pending").get();
  const campNames = new Map<string, string>();
  const campNameOf = async (campId: string) => {
    if (!campNames.has(campId)) campNames.set(campId, (await appCol("camps").doc(campId).get()).data()?.name ?? "");
    return campNames.get(campId)!;
  };
  let reminded = 0;
  let waitlisted = 0;

  for (const doc of snap.docs) {
    try {
      const sub = doc.data();
      const holdExpiresAt: FirebaseFirestore.Timestamp | undefined = sub.holdExpiresAt;
      if (!holdExpiresAt) continue;
      const nowMs = Date.now();
      const now = admin.firestore.Timestamp.fromMillis(nowMs);
      const campName = await campNameOf(sub.campId);
      const billRef = sub.depositBillingId ? appCol("billing").doc(sub.depositBillingId) : null;
      const billStatus: string | undefined = billRef ? (await billRef.get()).data()?.status : undefined;
      // Paid: onCampDepositPaid confirms it. Processing: a payment is in flight, wait for it.
      if (billStatus && !UNPAID.has(billStatus) && billStatus !== "cancelled") continue;

      if (holdExpiresAt.toMillis() <= nowMs) {
        const dates = await dayDates(sub.selectedDays ?? []);
        const batch = db.batch();
        batch.update(doc.ref, { status: "waitlisted", waitlistReason: "unpaid", waitlistedAt: now, updatedAt: now });
        if (billRef && billStatus && UNPAID.has(billStatus)) batch.update(billRef, { status: "cancelled", updatedAt: now });
        queueEmail(
          sub.parentEmail,
          `Inscrição em lista de espera — ${campName} — ${sub.childName}`,
          `Lista de espera — ${campName}`,
          p(`O sinal da inscrição de <strong>${sub.childName}</strong> no campo <strong>${campName}</strong> (${dates.join(", ")}) não foi pago dentro do prazo, por isso a vaga deixou de estar reservada e a inscrição passou para a <strong>lista de espera</strong>.`) +
            p(`Se ainda quiser a vaga, responda a este email ou contacte-nos: havendo lugar, voltamos a reservá-la e enviamos um novo pedido de pagamento do sinal.`),
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
        `Lembrete: sinal por pagar — ${campName} — ${sub.childName}`,
        `Sinal por pagar — ${campName}`,
        p(`A inscrição de <strong>${sub.childName}</strong> no campo <strong>${campName}</strong> ainda tem o sinal de <strong>${eur(sub.depositAmount)}</strong> por pagar.`) +
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
