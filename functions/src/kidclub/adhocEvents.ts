// One-off events (Halloween, a strike day, ...): anyone can sign children up,
// with or without a KidClub account. Model: packages/shared/models/AdhocEvent.ts.
// Pure logic and its tests: adhocEventLogic.ts.
//
// - Guests (no account) pay right away by MB WAY. Their seats are held for
//   ADHOC_HOLD_MINUTES; paying confirms them, otherwise expireAdhocHolds gives
//   the seats back. A guest never touches Firestore: everything goes through
//   these callables, keyed by the registration's link token.
// - KidClub families pay right away the same way (member price), or put it on
//   the monthly bill: confirmed at once, and the bill picks the lines up
//   (fetchEventLines / onAdhocRegistrationBillingSync in billing.ts).
// - Seats: each event day keeps `taken` (held + confirmed), changed only
//   inside transactions here.
// - Only an admin cancels. A paid one is flagged refundPending (by hand).
//
// Public endpoints reaching EasyPay and sending email fail closed: daily caps
// on guest signups and token MB WAY starts, MB WAY attempts per registration,
// and no email to a guest before they've paid (or for a free event).
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { appCol } from "./db";
import { startMbwayPayment } from "./billing";
import {
  ADHOC_HOLD_MINUTES, ADHOC_MBWAY_HOLD_MINUTES, ADHOC_MAX_MBWAY_ATTEMPTS, DAILY_GUEST_REGISTRATION_CAP, DAILY_TOKEN_MBWAY_CAP, MBWAY_MIN_TOTAL,
  EventDay, EventDoc, RegistrationChild, Tier,
  parseRegistrationInput, signupRefusal, takeSeats, releaseSeats, mergeDayEdits, periodCandidates, pickBillingPeriod,
  registrationLines, eventLineId, isEventLineOf, newAccessToken, tokenMatches, lisbonDate, normalizePhone, shortDate,
  buildConfirmationEmail, periodLabelPt,
} from "./adhocEventLogic";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

const REGION = "europe-west3";
const COMPANY_NAME = "Arco-Íris da Pequenada";
const APP_URL = "https://kidclub.pt";
const EASYPAY_SECRETS = ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "EASYPAY_WEBHOOK_URL"];

const eventsCol = () => appCol("adhocEvents");
const regsCol = () => appCol("adhocEventRegistrations");

const OPEN = new Set(["held", "confirmed"]);
const PAID = new Set(["paid", "invoiced"]);
const UNPAID = new Set(["pending", "failed"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function isKidclubAdmin(uid: string | undefined): Promise<boolean> {
  if (!uid) return false;
  const roles = (await db.collection("users").doc(uid).get()).data()?.roles ?? {};
  return !!(roles.owner || roles.rainbowAdmin);
}

async function requireAdmin(uid: string | undefined): Promise<string> {
  if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
  if (!(await isKidclubAdmin(uid))) throw new HttpsError("permission-denied", "Unauthorized");
  return uid;
}

/** One more use of a daily counter (Lisbon day), or resource-exhausted once it's spent. Fails closed. */
async function reserveDaily(key: string, cap: number, message: string): Promise<void> {
  const ref = appCol("rateLimits").doc(`${key}_${lisbonDate(new Date())}`);
  const ok = await db.runTransaction(async (tx) => {
    const count = ((await tx.get(ref)).data()?.count as number | undefined) ?? 0;
    if (count >= cap) return false;
    tx.set(ref, { count: count + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  if (!ok) {
    console.error(`[adhoc] daily cap reached: ${key} (${cap}/day) — refusing`);
    throw new HttpsError("resource-exhausted", message);
  }
}

/** The family a parent owns (the oldest, like familyService.getOrCreateFamily), or null. Never creates one. */
async function familyOfUser(uid: string): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const snap = await appCol("families").where("primaryContact.userId", "==", uid).get();
  if (snap.empty) return null;
  return snap.docs.sort((a, b) => (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0))[0];
}

const asIso = (raw: any): string | undefined => {
  const d = raw?.toDate ? raw.toDate() : raw ? new Date(raw) : null;
  return d && !isNaN(d.getTime()) ? lisbonDate(d) : undefined;
};

const childCount = (reg: FirebaseFirestore.DocumentData) => (reg.children ?? []).length;
const isRecomputable = (b: FirebaseFirestore.DocumentData | undefined) =>
  b?.status === "pending" || (b?.status === "cancelled" && b?.autoCancelled === true);

function registrationLink(registrationId: string, token: string): string {
  return `${APP_URL}/eventos/inscricao/${registrationId}?t=${encodeURIComponent(token)}`;
}

// ── Admin: create / edit an event ─────────────────────────────────────────────

export const saveAdhocEvent = onCall({ region: REGION, invoker: "public" }, async (request) => {
  const uid = await requireAdmin(request.auth?.uid);
  const d = request.data ?? {};
  const name = typeof d.name === "string" ? d.name.trim().slice(0, 120) : "";
  if (name.length < 2) throw new HttpsError("invalid-argument", "Indique o nome do evento.");
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const closesOn = typeof d.closesOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.closesOn) ? d.closesOn : null;

  const ref = d.eventId ? eventsCol().doc(String(d.eventId)) : eventsCol().doc();
  await db.runTransaction(async (tx) => {
    const current = d.eventId ? (await tx.get(ref)).data() : undefined;
    if (d.eventId && !current) throw new HttpsError("not-found", "Evento não encontrado.");
    const merged = mergeDayEdits((current?.days ?? []) as EventDay[], d.days);
    if ("error" in merged) throw new HttpsError("invalid-argument", merged.error);
    const fields = {
      name,
      description: text(d.description, 4000),
      location: text(d.location, 200),
      published: d.published === true,
      registrationOpen: d.registrationOpen === true,
      closesOn,
      days: merged.days,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    };
    if (current) tx.update(ref, fields);
    else tx.set(ref, { ...fields, createdAt: FieldValue.serverTimestamp(), createdBy: uid });
  });
  console.log(`[adhoc] event ${ref.id} saved by ${uid}`);
  return { eventId: ref.id };
});

/** Only an event nobody holds or has a seat on (every day's `taken` is 0). Otherwise unpublish it. */
export const deleteAdhocEvent = onCall({ region: REGION, invoker: "public" }, async (request) => {
  const uid = await requireAdmin(request.auth?.uid);
  const eventId = String(request.data?.eventId ?? "");
  if (!eventId) throw new HttpsError("invalid-argument", "eventId required");
  const ref = eventsCol().doc(eventId);
  await db.runTransaction(async (tx) => {
    const ev = (await tx.get(ref)).data();
    if (!ev) return;
    if ((ev.days ?? []).some((day: EventDay) => (day.taken ?? 0) > 0)) {
      throw new HttpsError("failed-precondition", "Este evento tem inscrições. Cancele-as, ou despublique o evento.");
    }
    tx.delete(ref);
  });
  console.log(`[adhoc] event ${eventId} deleted by ${uid}`);
  return { ok: true };
});

// ── Sign up ───────────────────────────────────────────────────────────────────

/**
 * Anyone, signed in or not. A signed-in parent with a family is a member
 * (member price, may choose the monthly bill); an admin passes `familyId` to
 * sign a family up (impersonating, or a walk-in with `adminEntry`). Everyone
 * else is a guest. `adminEntry` (admins only): a walk-in whose seats are held
 * until it's paid or cancelled, also on a closed or unpublished event.
 */
export const registerForAdhocEvent = onCall({ region: REGION, invoker: "public" }, async (request) => {
  const uid = request.auth?.uid;
  const data = request.data ?? {};
  const isAdmin = await isKidclubAdmin(uid);
  const adminEntry = isAdmin && data.adminEntry === true;

  let familyDoc: FirebaseFirestore.DocumentSnapshot | null = null;
  if (data.familyId) {
    if (!isAdmin) throw new HttpsError("permission-denied", "Unauthorized");
    familyDoc = await appCol("families").doc(String(data.familyId)).get();
    if (!familyDoc.exists) throw new HttpsError("not-found", "Família não encontrada.");
  } else if (uid && !adminEntry) {
    familyDoc = await familyOfUser(uid);
  }
  const member = !!familyDoc;

  const parsed = parseRegistrationInput(data, member);
  if ("error" in parsed) throw new HttpsError("invalid-argument", parsed.error);
  const input = parsed.input;

  if (!member && !adminEntry) {
    await reserveDaily("adhocGuestRegistration", DAILY_GUEST_REGISTRATION_CAP,
      "Não é possível fazer mais inscrições hoje. Tente amanhã ou contacte-nos.");
  }

  // Who and for whom.
  const fam = familyDoc?.data() ?? {};
  const contact = fam.primaryContact ?? {};
  const guardian = member
    ? { name: String(contact.name ?? "").trim(), email: String(contact.email ?? "").trim().toLowerCase(), phone: input.guardian.phone || normalizePhone(contact.phone) }
    : input.guardian;
  if (member && !guardian.email) throw new HttpsError("failed-precondition", "A família não tem email de contacto. Complete o perfil em A minha conta.");

  let children: RegistrationChild[];
  if (member) {
    const snaps = await Promise.all(input.memberChildren.map(c => appCol("children").doc(c.childId).get()));
    children = snaps.map((s, i) => {
      const c = s.data();
      if (!c || c.familyId !== familyDoc!.id) throw new HttpsError("permission-denied", "Criança inválida.");
      const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || String(c.name ?? "").trim() || "Criança";
      const healthNotes = input.memberChildren[i].healthNotes ?? (typeof c.medicalNotes === "string" && c.medicalNotes.trim() ? c.medicalNotes.trim() : undefined);
      const birthDate = asIso(c.dateOfBirth);
      return { name, childId: s.id, ...(birthDate ? { birthDate } : {}), ...(healthNotes ? { healthNotes } : {}) };
    });
  } else {
    children = input.guestChildren;
  }

  const tier: Tier = member ? "member" : "public";
  const today = lisbonDate(new Date());
  const eventRef = eventsCol().doc(input.eventId);
  const regRef = regsCol().doc();
  const token = newAccessToken();
  const n = children.length;
  const ownerUid: string = member ? String(contact.userId ?? "") : "";
  const monthlyRefs = input.payment === "monthly"
    ? periodCandidates(input.days[0]).map(p => ({ p, ref: appCol("billing").doc(`${familyDoc!.id}_${p}`) }))
    : [];

  const result = await db.runTransaction(async (tx) => {
    const ev = (await tx.get(eventRef)).data() as EventDoc | undefined;
    const refusal = signupRefusal(ev, input.days, today, adminEntry);
    if (refusal) throw new HttpsError("failed-precondition", refusal);

    // Same children, same days, still held or confirmed: almost always a double submit.
    const dupQuery = member
      ? regsCol().where("eventId", "==", input.eventId).where("familyId", "==", familyDoc!.id)
      : regsCol().where("eventId", "==", input.eventId).where("guardian.email", "==", guardian.email);
    const dups = (await tx.get(dupQuery)).docs.map(d => d.data()).filter(r => OPEN.has(r.status) && (r.days ?? []).some((x: string) => input.days.includes(x)));
    const key = (c: RegistrationChild) => c.childId ?? c.name.toLowerCase();
    const clash = children.find(c => dups.some(r => (r.children ?? []).some((rc: RegistrationChild) => key(rc) === key(c))));
    if (clash) throw new HttpsError("already-exists", `${clash.name} já está inscrito(a) num destes dias. Veja o email da inscrição anterior, ou contacte-nos.`);

    const bills = monthlyRefs.length ? await tx.getAll(...monthlyRefs.map(m => m.ref)) : [];

    const seats = takeSeats(ev!.days, input.days, n);
    if ("full" in seats) {
      throw new HttpsError("resource-exhausted", `Sem vagas suficientes para ${seats.full.map(shortDate).join(", ")}.`);
    }

    const lines = registrationLines(ev!.name, ev!.days, input.days, children, tier);
    const total = Math.round(lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)) / 100;
    const free = total === 0;
    if (input.payment === "now" && !free && total < MBWAY_MIN_TOTAL) {
      throw new HttpsError("failed-precondition", `O valor mínimo para pagamento MB WAY é €${MBWAY_MIN_TOTAL.toFixed(2)}.`);
    }

    let billingPeriod: string | null = null;
    if (input.payment === "monthly" && !free) {
      const byPeriod = new Map(monthlyRefs.map((m, i) => [m.p, bills[i].exists ? bills[i].data() : undefined]));
      billingPeriod = pickBillingPeriod(monthlyRefs.map(m => m.p), byPeriod);
      if (!billingPeriod) throw new HttpsError("failed-precondition", "Não foi possível juntar à mensalidade. Escolha pagar agora.");
    }

    const now = Timestamp.now();
    const confirmed = free || input.payment === "monthly";
    const holdExpiresAt = !confirmed && !adminEntry ? Timestamp.fromMillis(now.toMillis() + ADHOC_HOLD_MINUTES * 60_000) : null;
    const billRef = !confirmed ? appCol("billing").doc() : null;

    tx.update(eventRef, { days: seats.days, updatedAt: FieldValue.serverTimestamp() });
    tx.set(regRef, {
      eventId: input.eventId,
      eventName: ev!.name,
      kind: member ? "member" : "guest",
      ...(member ? { familyId: familyDoc!.id, userId: ownerUid } : {}),
      guardian: { name: guardian.name, email: guardian.email, phone: guardian.phone, ...(!member && input.guardian.nif ? { nif: input.guardian.nif } : {}) },
      children,
      days: input.days,
      ...(input.pickupNotes ? { pickupNotes: input.pickupNotes } : {}),
      photoConsent: input.photoConsent,
      priceTier: tier,
      lines,
      total,
      payment: free ? "now" : input.payment,
      ...(billRef ? { billingId: billRef.id } : {}),
      ...(billingPeriod ? { billingPeriod } : {}),
      status: confirmed ? "confirmed" : "held",
      ...(holdExpiresAt ? { holdExpiresAt } : {}),
      ...(confirmed ? { confirmedAt: now } : {}),
      mbwayAttempts: 0,
      accessToken: token,
      ...(adminEntry ? { adminEntry: true } : {}),
      createdBy: uid ?? null,
      createdAt: now,
      updatedAt: now,
    });

    if (billRef) {
      const sorted = [...input.days].sort();
      tx.set(billRef, {
        type: "event",
        eventRegistrationId: regRef.id,
        eventId: input.eventId,
        familyId: member ? familyDoc!.id : "",
        userId: ownerUid,
        periodLabel: `${ev!.name} — ${sorted.map(shortDate).join(", ")}`,
        periodStart: Timestamp.fromDate(new Date(`${sorted[0]}T12:00:00Z`)),
        periodEnd: Timestamp.fromDate(new Date(`${sorted[sorted.length - 1]}T12:00:00Z`)),
        dueDate: holdExpiresAt ?? Timestamp.fromDate(new Date(`${sorted[0]}T12:00:00Z`)),
        total,
        lineItems: lines.map((l, i) => ({ title: l.title, amount: l.amount, grossAmount: l.amount, subscriptionId: eventLineId(regRef.id, i), type: "event", appliedDiscounts: [] })),
        billingName: guardian.name,
        billingEmail: guardian.email,
        ...(!member && input.guardian.nif ? { guestNif: input.guardian.nif } : {}),
        paymentMethod: "mbway",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    return { confirmed, total, billingId: billRef?.id ?? null, billingPeriod, holdExpiresAt: holdExpiresAt?.toMillis() ?? null };
  });

  console.log(`[adhoc] registration ${regRef.id} event=${input.eventId} kind=${member ? "member" : "guest"}${adminEntry ? " (admin entry)" : ""} children=${n} days=${input.days.join(",")} payment=${input.payment} total=${result.total} → ${result.confirmed ? "confirmed" : "held"}`);
  if (result.confirmed) await queueConfirmationEmail(regRef.id);

  return { registrationId: regRef.id, token, status: result.confirmed ? "confirmed" : "held", ...result };
});

// ── Guest page: status, and pay by MB WAY ────────────────────────────────────

async function registrationByToken(registrationId: unknown, token: unknown) {
  if (typeof registrationId !== "string" || !registrationId) throw new HttpsError("invalid-argument", "registrationId required");
  const snap = await regsCol().doc(registrationId).get();
  const reg = snap.data();
  if (!reg || !tokenMatches(reg.accessToken, token)) throw new HttpsError("not-found", "Inscrição não encontrada.");
  return { ref: snap.ref, reg };
}

/** What the registration page shows. Gives back an expired hold's seats on the way. */
export const getAdhocRegistration = onCall({ region: REGION, invoker: "public" }, async (request) => {
  const { registrationId, token } = request.data ?? {};
  const { ref, reg: found } = await registrationByToken(registrationId, token);
  let reg = found;
  if (reg.status === "held" && reg.holdExpiresAt && reg.holdExpiresAt.toMillis() <= Date.now()) {
    await expireRegistration(ref.id);
    reg = (await ref.get()).data()!;
  }
  const [ev, bill] = await Promise.all([
    eventsCol().doc(reg.eventId).get().then(s => s.data()),
    reg.billingId ? appCol("billing").doc(reg.billingId).get().then(s => s.data()) : Promise.resolve(undefined),
  ]);
  const days = (reg.days as string[]).map(date => {
    const d = (ev?.days ?? []).find((x: EventDay) => x.date === date);
    return { date, startTime: d?.startTime ?? null, endTime: d?.endTime ?? null };
  });
  return {
    id: ref.id,
    eventId: reg.eventId,
    eventName: reg.eventName,
    location: ev?.location ?? null,
    kind: reg.kind,
    status: reg.status,
    payment: reg.payment,
    total: reg.total,
    lines: reg.lines ?? [],
    billingPeriod: reg.billingPeriod ?? null,
    billingPeriodLabel: reg.billingPeriod ? periodLabelPt(reg.billingPeriod) : null,
    days,
    children: (reg.children ?? []).map((c: RegistrationChild) => c.name),
    guardianName: reg.guardian?.name ?? "",
    guardianPhone: reg.guardian?.phone ?? "",
    holdExpiresAt: reg.holdExpiresAt?.toMillis?.() ?? null,
    mbwayAttemptsLeft: Math.max(0, ADHOC_MAX_MBWAY_ATTEMPTS - (reg.mbwayAttempts ?? 0)),
    bill: bill ? { id: reg.billingId, status: bill.status, invoiceNumber: bill.invoiceNumber ?? null, hasInvoice: !!bill.vendusId } : null,
    refundPending: !!reg.refundPending,
    cancelReason: reg.cancelReason ?? null,
  };
});

/** Starts an MB WAY payment for a held registration's bill, by its link token. */
export const payAdhocRegistration = onCall({ region: REGION, invoker: "public", secrets: EASYPAY_SECRETS }, async (request) => {
  const { registrationId, token, phone } = request.data ?? {};
  const { ref, reg } = await registrationByToken(registrationId, token);
  const mbwayPhone = normalizePhone(phone);
  if (!mbwayPhone) throw new HttpsError("invalid-argument", "Introduza o número de telemóvel MB WAY (9 dígitos).");

  if (reg.status === "confirmed") throw new HttpsError("failed-precondition", "Esta inscrição já está paga.");
  if (reg.status !== "held" || !reg.billingId) throw new HttpsError("failed-precondition", "Esta inscrição já não pode ser paga. Faça uma nova inscrição.");
  if (reg.holdExpiresAt && reg.holdExpiresAt.toMillis() <= Date.now()) {
    await expireRegistration(ref.id);
    throw new HttpsError("deadline-exceeded", "A reserva expirou. Faça uma nova inscrição.");
  }
  if ((reg.mbwayAttempts ?? 0) >= ADHOC_MAX_MBWAY_ATTEMPTS) {
    throw new HttpsError("resource-exhausted", "Atingiu o limite de tentativas MB WAY para esta inscrição. Contacte-nos.");
  }

  await reserveDaily("adhocTokenMbway", DAILY_TOKEN_MBWAY_CAP, "Pagamentos temporariamente indisponíveis. Tente mais tarde ou contacte-nos.");

  // Count the attempt and keep the seats while MB WAY is out, before calling EasyPay.
  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || cur.status !== "held") throw new HttpsError("failed-precondition", "Esta inscrição já não pode ser paga.");
    if ((cur.mbwayAttempts ?? 0) >= ADHOC_MAX_MBWAY_ATTEMPTS) throw new HttpsError("resource-exhausted", "Atingiu o limite de tentativas MB WAY para esta inscrição. Contacte-nos.");
    const keepUntil = Date.now() + ADHOC_MBWAY_HOLD_MINUTES * 60_000;
    tx.update(ref, {
      mbwayAttempts: FieldValue.increment(1),
      ...(cur.holdExpiresAt && cur.holdExpiresAt.toMillis() < keepUntil ? { holdExpiresAt: Timestamp.fromMillis(keepUntil) } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const bill = (await appCol("billing").doc(reg.billingId).get()).data();
  if (!bill) throw new HttpsError("not-found", "Pagamento não encontrado.");
  console.log(`[adhoc] MB WAY for registration ${ref.id} (attempt ${(reg.mbwayAttempts ?? 0) + 1}/${ADHOC_MAX_MBWAY_ATTEMPTS})`);
  return startMbwayPayment(reg.billingId, bill, mbwayPhone);
});

// ── Admin: cancel ─────────────────────────────────────────────────────────────

export const cancelAdhocRegistration = onCall({ region: REGION, invoker: "public" }, async (request) => {
  const uid = await requireAdmin(request.auth?.uid);
  const { registrationId } = request.data ?? {};
  const reason = typeof request.data?.reason === "string" ? request.data.reason.trim().slice(0, 300) : "";
  if (typeof registrationId !== "string" || !registrationId) throw new HttpsError("invalid-argument", "registrationId required");
  const ref = regsCol().doc(registrationId);

  const outcome = await db.runTransaction(async (tx) => {
    const reg = (await tx.get(ref)).data();
    if (!reg) throw new HttpsError("not-found", "Inscrição não encontrada.");
    if (!OPEN.has(reg.status)) return { already: true, refundPending: !!reg.refundPending };
    const eventRef = eventsCol().doc(reg.eventId);
    const ev = (await tx.get(eventRef)).data();
    const billRef = reg.billingId ? appCol("billing").doc(reg.billingId) : null;
    const bill = billRef ? (await tx.get(billRef)).data() : undefined;
    const monthlyRef = reg.payment === "monthly" && reg.familyId && reg.billingPeriod ? appCol("billing").doc(`${reg.familyId}_${reg.billingPeriod}`) : null;
    const monthly = monthlyRef ? (await tx.get(monthlyRef)).data() : undefined;

    if (bill?.status === "processing") {
      throw new HttpsError("failed-precondition", "Há um pagamento MB WAY em curso para esta inscrição. Aguarde uns minutos, ou reponha o pagamento em Faturação, e tente de novo.");
    }
    // Money already in: the bill was paid (pay now), or the monthly bill it's
    // on was paid or is being paid. Refund / credit note by hand.
    const refundPending = (!!bill && PAID.has(bill.status))
      || (!!monthly && !isRecomputable(monthly) && (monthly.lineItems ?? []).some((li: any) => isEventLineOf(li.subscriptionId, registrationId)));

    if (ev) tx.update(eventRef, { days: releaseSeats(ev.days ?? [], reg.days ?? [], childCount(reg)), updatedAt: FieldValue.serverTimestamp() });
    tx.update(ref, {
      status: "cancelled",
      ...(reason ? { cancelReason: reason } : {}),
      ...(refundPending ? { refundPending: true } : {}),
      cancelledBy: uid,
      cancelledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (billRef && bill && UNPAID.has(bill.status)) tx.update(billRef, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
    return { already: false, refundPending };
  });
  console.log(`[adhoc] registration ${registrationId} cancelled by ${uid}${outcome.refundPending ? " — refund pending" : ""}`);
  return { ok: true, ...outcome };
});

// ── Holds: expiry ─────────────────────────────────────────────────────────────

/**
 * Gives back an unpaid hold's seats once it's expired, and cancels its bill.
 * Never while a payment is out (`processing`: the webhook decides) or once
 * it's paid (onAdhocBillingPaid confirms it).
 */
async function expireRegistration(registrationId: string): Promise<boolean> {
  const ref = regsCol().doc(registrationId);
  return db.runTransaction(async (tx) => {
    const reg = (await tx.get(ref)).data();
    if (!reg || reg.status !== "held" || !reg.holdExpiresAt || reg.holdExpiresAt.toMillis() > Date.now()) return false;
    const billRef = reg.billingId ? appCol("billing").doc(reg.billingId) : null;
    const bill = billRef ? (await tx.get(billRef)).data() : undefined;
    if (bill && !UNPAID.has(bill.status) && bill.status !== "cancelled") return false;
    const eventRef = eventsCol().doc(reg.eventId);
    const ev = (await tx.get(eventRef)).data();
    if (ev) tx.update(eventRef, { days: releaseSeats(ev.days ?? [], reg.days ?? [], childCount(reg)), updatedAt: FieldValue.serverTimestamp() });
    tx.update(ref, { status: "expired", expiredAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    if (billRef && bill && UNPAID.has(bill.status)) tx.update(billRef, { status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

export const expireAdhocHolds = onSchedule({ schedule: "every 10 minutes", timeZone: "Europe/Lisbon", region: REGION }, async () => {
  const snap = await regsCol().where("status", "==", "held").where("holdExpiresAt", "<=", Timestamp.now()).limit(200).get();
  let expired = 0;
  for (const d of snap.docs) {
    try {
      if (await expireRegistration(d.id)) expired++;
    } catch (err: any) {
      console.error(`[adhoc] could not expire registration ${d.id}:`, err?.message ?? err);
    }
  }
  if (snap.size) console.log(`[adhoc] holds past expiry: ${snap.size}, expired now: ${expired}`);
});

// ── Paid → confirmed ──────────────────────────────────────────────────────────

/**
 * A one-off event bill was paid (EasyPay webhook, or an admin marking a bank
 * transfer): confirm its registration and email the guardian. If the hold had
 * expired meanwhile, the seats are taken again; past capacity, it's flagged
 * overCapacity for the admin rather than turned away (the money is in).
 */
export const onAdhocBillingPaid = onDocumentUpdated({ document: "_apps/arcoiris/billing/{billingId}", region: REGION }, async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (after?.type !== "event" || !after.eventRegistrationId) return;
  if (PAID.has(before?.status) || !PAID.has(after.status)) return;

  const ref = regsCol().doc(after.eventRegistrationId);
  const confirmedNow = await db.runTransaction(async (tx) => {
    const reg = (await tx.get(ref)).data();
    if (!reg || reg.status === "confirmed") return false;
    if (reg.status === "cancelled") {
      console.error(`[adhoc] PAYMENT ON CANCELLED registration ${ref.id} (billing ${event.params.billingId}) — refund needed`);
      tx.update(ref, { refundPending: true, updatedAt: FieldValue.serverTimestamp() });
      return false;
    }
    const update: Record<string, unknown> = { status: "confirmed", confirmedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    if (reg.status === "expired") {
      const eventRef = eventsCol().doc(reg.eventId);
      const ev = (await tx.get(eventRef)).data();
      if (ev) {
        const n = childCount(reg);
        const days = (ev.days ?? []).map((d: EventDay) => (reg.days ?? []).includes(d.date) ? { ...d, taken: (d.taken ?? 0) + n } : d);
        if (days.some((d: EventDay) => (reg.days ?? []).includes(d.date) && d.taken > d.capacity)) update.overCapacity = true;
        tx.update(eventRef, { days, updatedAt: FieldValue.serverTimestamp() });
      }
    }
    tx.update(ref, update);
    return true;
  });
  if (confirmedNow) {
    console.log(`[adhoc] registration ${ref.id} confirmed (billing ${event.params.billingId} ${after.status})`);
    await queueConfirmationEmail(ref.id);
  }
});

// ── Email ─────────────────────────────────────────────────────────────────────

/** "Inscrição confirmada". One per registration: the outbox doc id is keyed on it. Never throws. */
async function queueConfirmationEmail(registrationId: string): Promise<void> {
  try {
    const reg = (await regsCol().doc(registrationId).get()).data();
    if (!reg?.guardian?.email) return;
    const ev = (await eventsCol().doc(reg.eventId).get()).data();
    const days = (reg.days as string[]).map(date => (ev?.days ?? []).find((d: EventDay) => d.date === date) ?? { date });
    const paidNote = reg.total === 0 ? "" : reg.payment === "monthly" && reg.billingPeriod
      ? `Incluído na mensalidade de ${periodLabelPt(reg.billingPeriod)}.`
      : "Pagamento recebido.";
    const link = registrationLink(registrationId, reg.accessToken);
    await appCol("emailOutbox").doc(`adhocConfirmed_${registrationId}`).create({
      to: reg.guardian.email,
      subject: `Inscrição confirmada — ${reg.eventName}`,
      html: buildConfirmationEmail({
        companyName: COMPANY_NAME,
        guardianName: reg.guardian.name ?? "",
        eventName: reg.eventName,
        location: ev?.location || undefined,
        days,
        childNames: (reg.children ?? []).map((c: RegistrationChild) => c.name),
        total: Number(reg.total ?? 0),
        paidNote,
        link,
      }),
      status: "queued",
      familyId: reg.familyId ?? null,
      tags: ["event"],
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err: any) {
    if (err?.code === 6 || /already exists/i.test(err?.message ?? "")) return;
    console.error(`[adhoc] confirmation email for registration ${registrationId} could not be queued:`, err?.message ?? err);
  }
}
