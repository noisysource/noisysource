import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { appCol } from "./db";

// The secret link of a party booking: /festas/reserva/<bookingId>?t=<token>
// (partyLinkUrl in partyRequestLogic.ts). The token lives in
// partyLinks/{bookingId}, which no client can read (firestore.rules); it only
// goes out in emails to the booking's own address, and to the browser that
// sent the public request.

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

export const partyLinkRef = (bookingId: string) => appCol("partyLinks").doc(bookingId);

export const newPartyLinkToken = () => randomBytes(24).toString("base64url");

/**
 * The booking link's token: the existing one, or a new one. In a transaction,
 * so a redelivered trigger (or two triggers at once) can't mint two tokens and
 * email a link that no longer works.
 */
export async function ensurePartyLinkToken(bookingId: string): Promise<string> {
  const ref = partyLinkRef(bookingId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.get("token");
    if (typeof existing === "string" && existing) return existing;
    const token = newPartyLinkToken();
    tx.set(ref, { token, bookingId, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return token;
  });
}
