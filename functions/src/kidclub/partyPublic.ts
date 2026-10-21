import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { appCol } from "./db";
import { ensurePartyDeposit } from "./partyDeposit";
import { startMbwayPayment } from "./billing";
import { newPartyLinkToken, partyLinkRef as linkRef } from "./partyLinks";
import {
  checkPartyRequest,
  MAX_LINK_PAYMENTS_PER_HOUR,
  MAX_PUBLIC_REQUESTS_PER_DAY,
  MAX_REQUESTS_PER_EMAIL_PER_DAY,
  PartyConfigLike,
  publicBookingView,
  recentAttempts,
  tokenMatches,
} from "./partyRequestLogic";

// Parties without an account (2026-10-20). Anyone can ask for a party from the
// public site (/festas), and every party email links to the booking's secret
// link (partyLinks.ts), where the parent follows the request and pays the
// deposit by MB WAY, signed in or not.
//
// Calls out: EasyPay only, through startMbwayPayment (billing.ts), sandboxed off
// prod by externalGuard, and capped per link (MAX_LINK_PAYMENTS_PER_HOUR).

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** ms of a stored date: a Timestamp, or a Date. 0 when missing. */
const millis = (v: any): number =>
  typeof v?.toMillis === "function" ? v.toMillis() : v instanceof Date ? v.getTime() : 0;

/** The booking behind a link, or a not-found error. Same error whether the id
 *  or the token is wrong, so a guess learns nothing. */
async function bookingFromLink(data: any): Promise<{ bookingId: string; booking: FirebaseFirestore.DocumentData }> {
  const bookingId = typeof data?.bookingId === "string" ? data.bookingId : "";
  const token = typeof data?.token === "string" ? data.token : "";
  const notFound = new HttpsError("not-found", "Não encontrámos esta reserva. Confirme que abriu o link completo do email.");
  if (!bookingId || !token || bookingId.length > 64 || bookingId.includes("/")) throw notFound;
  const [link, booking] = await Promise.all([linkRef(bookingId).get(), appCol("bookings").doc(bookingId).get()]);
  if (!link.exists || !booking.exists || !tokenMatches(token, link.get("token"))) throw notFound;
  return { bookingId, booking: booking.data()! };
}

/** The booking's deposit bill, if there is one (any id: old ones are random). */
async function findDeposit(bookingId: string) {
  const snap = await appCol("billing")
    .where("bookingId", "==", bookingId)
    .where("type", "==", "party_deposit")
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

/** The family a public request belongs to: the existing one with this email,
 *  else a new one with just the contact details from the form. */
async function familyForRequest(req: { parentName: string; email: string; phone: string; nif: string }) {
  const found = await appCol("families").where("primaryContact.email", "==", req.email).get();
  if (!found.empty) {
    // Oldest first, like getOrCreateFamily; prefer one with an owner.
    const docs = found.docs.sort((a, b) => millis(a.get("createdAt")) - millis(b.get("createdAt")));
    const fam = docs.find(d => d.get("primaryContact.userId")) ?? docs[0];
    return { familyId: fam.id, ownerUid: String(fam.get("primaryContact.userId") ?? ""), created: false };
  }
  const now = admin.firestore.Timestamp.now();
  const ref = await appCol("families").add({
    // No userId: claimFamilyByEmail links it to the parent if they ever sign
    // in with this email, with its party bookings and bills.
    primaryContact: { name: req.parentName, email: req.email, phone: req.phone, userId: "" },
    ...(req.nif ? { nif: req.nif } : {}),
    status: "active",
    profileComplete: false,
    source: "party_request",
    createdAt: now,
    updatedAt: now,
  });
  return { familyId: ref.id, ownerUid: "", created: true };
}

// ── Public request ───────────────────────────────────────────────────────────

export const requestPartyBooking = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const data = request.data ?? {};
    // Honeypot: a field people never see. A bot that fills it gets a normal
    // looking answer and nothing is saved or emailed.
    if (typeof data.website === "string" && data.website.trim()) {
      console.warn("[partyRequest] honeypot filled, dropped");
      return { ok: true };
    }

    const config = (await appCol("config").doc("party").get()).data() as PartyConfigLike | undefined;
    if (!config?.partyTypes?.length) throw new HttpsError("failed-precondition", "As reservas de festas não estão disponíveis de momento.");

    const check = checkPartyRequest(data, { partyTypes: config.partyTypes, extras: config.extras ?? [] }, new Date());
    if ("error" in check) throw new HttpsError("invalid-argument", check.error);
    const req = check.value;

    // Limits (see partyRequestLogic.ts). Single-field queries only: no index.
    const sinceMs = Date.now() - DAY_MS;
    const [sameEmail, lastDay] = await Promise.all([
      appCol("bookings").where("email", "==", req.email).get(),
      appCol("bookings").where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(sinceMs)).get(),
    ]);
    const sameEmailToday = sameEmail.docs.filter(d => millis(d.get("createdAt")) >= sinceMs).length;
    const publicToday = lastDay.docs.filter(d => d.get("source") === "public").length;
    if (sameEmailToday >= MAX_REQUESTS_PER_EMAIL_PER_DAY) {
      throw new HttpsError("resource-exhausted", "Já recebemos vários pedidos deste email hoje. Responderemos em breve; se precisar, contacte-nos por email ou telefone.");
    }
    if (publicToday >= MAX_PUBLIC_REQUESTS_PER_DAY) {
      console.error(`[partyRequest] daily cap of ${MAX_PUBLIC_REQUESTS_PER_DAY} public requests reached; refusing`);
      throw new HttpsError("resource-exhausted", "Não foi possível receber o pedido agora. Tente mais tarde ou contacte-nos por email.");
    }

    const fam = await familyForRequest(req);
    const bookingRef = appCol("bookings").doc();
    const token = newPartyLinkToken();
    const now = admin.firestore.Timestamp.now();

    // Booking and link together: the creation trigger (partyBookings.ts) emails
    // the parent a link, so the token has to exist by then.
    const batch = db.batch();
    batch.set(linkRef(bookingRef.id), { token, bookingId: bookingRef.id, createdAt: now });
    batch.set(bookingRef, {
      familyId: fam.familyId,
      childId: "",
      // The family's owner when the email belongs to a parent with an account,
      // so the party shows in their area too; '' otherwise.
      userId: fam.ownerUid,
      parentName: req.parentName,
      email: req.email,
      phone: req.phone,
      childName: req.childName,
      childAge: req.childAge,
      partyType: req.partyType,
      date: req.date,
      time: req.time,
      numKids: req.numKids,
      extras: req.extras,
      extrasDetail: req.extrasDetail,
      ...(req.notes ? { notes: req.notes } : {}),
      total: req.total, // before IVA, priced here from config/party
      status: "pending",
      source: "public",
      createdAt: now,
    });
    await batch.commit();

    console.log(`[partyRequest] booking ${bookingRef.id} from the public form: family=${fam.familyId}${fam.created ? " (new)" : ""} owner=${fam.ownerUid || "(none)"} total=${req.total}`);
    return { ok: true, bookingId: bookingRef.id, token };
  },
);

// ── Booking page behind the link ─────────────────────────────────────────────

export const getPartyBookingByLink = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const { bookingId, booking } = await bookingFromLink(request.data);
    const dep = await findDeposit(bookingId);
    return publicBookingView(booking, dep ? { total: Number(dep.get("total") ?? 0), status: String(dep.get("status") ?? "") } : null);
  },
);

export const payPartyDepositByLink = onCall(
  { region: "europe-west3", invoker: "public", secrets: ["EASYPAY_ACCOUNT_ID", "EASYPAY_API_KEY", "EASYPAY_WEBHOOK_URL"] },
  async (request) => {
    const { bookingId, booking } = await bookingFromLink(request.data);
    const phone = typeof request.data?.phone === "string" ? request.data.phone.trim() : "";
    if (phone.replace(/\D/g, "").length < 9) throw new HttpsError("invalid-argument", "Indique o número de telemóvel associado ao MB WAY.");
    if (booking.status !== "confirmed") throw new HttpsError("failed-precondition", "A reserva ainda não foi confirmada.");

    // At most MAX_LINK_PAYMENTS_PER_HOUR MB WAY requests per link: each one is a
    // real EasyPay call and a notification on someone's phone.
    const now = Date.now();
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(linkRef(bookingId));
      const recent = recentAttempts(snap.get("payAttempts"), now, HOUR_MS);
      if (recent.length >= MAX_LINK_PAYMENTS_PER_HOUR) return false;
      tx.update(linkRef(bookingId), { payAttempts: [...recent, now] });
      return true;
    });
    if (!allowed) {
      throw new HttpsError("resource-exhausted", "Já pediu vários pagamentos na última hora. Aguarde um pouco e tente de novo.");
    }

    // Bookings confirmed before the bill was automatic (or whose bill failed
    // at confirmation) get it now: same helper, so never twice.
    const { billingId } = await ensurePartyDeposit(bookingId, booking, "payPartyDepositByLink");
    const billing = (await appCol("billing").doc(billingId).get()).data();
    if (!billing) throw new HttpsError("internal", "Não foi possível preparar o pagamento.");
    if (billing.status === "paid" || billing.status === "invoiced") {
      throw new HttpsError("failed-precondition", "O sinal desta festa já está pago.");
    }
    console.log(`[partyLink] MB WAY for booking ${bookingId} billing ${billingId} phone=${phone.slice(0, 3)}***`);
    await startMbwayPayment(billingId, billing, phone);
    return { ok: true };
  },
);
