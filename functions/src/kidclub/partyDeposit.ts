import * as admin from "firebase-admin";
import { appCol } from "./db";
import { familyBillingInfo, FamilyBillingInfo } from "./familyBilling";
import { buildPartyDepositRecord, partyDepositBillingId } from "./partyDepositLogic";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

export interface PartyDepositResult {
  billingId: string;
  /** false when the booking already had a deposit bill (this call created nothing). */
  created: boolean;
  /** The bill's total (com IVA) and status, as stored. */
  total: number;
  status: string;
}

const isAlreadyExists = (err: any) => err?.code === 6 || /already exists/i.test(err?.message ?? "");

const resultOf = (snap: FirebaseFirestore.DocumentSnapshot, created: boolean): PartyDepositResult => ({
  billingId: snap.id,
  created,
  total: Number(snap.get("total") ?? 0),
  status: String(snap.get("status") ?? ""),
});

const ts = (d: Date) => admin.firestore.Timestamp.fromDate(d);

/**
 * The 50% deposit bill of a confirmed party booking: returns the existing one,
 * or creates it. Used by the confirmation trigger (onPartyBookingStatusNotify)
 * and the createPartyDeposit callable.
 *
 * Never creates a second bill for one booking:
 * - an existing deposit (bookingId + type `party_deposit`) is returned as is,
 *   including one the callable created before 2026-10-20 under a random id;
 * - new ones get a deterministic id (partyDepositBillingId), written with
 *   create() inside a transaction, so a redelivered trigger event, or the
 *   trigger and the callable at once, can't both write one: the loser gets
 *   ALREADY_EXISTS (or a transaction retry that sees the doc) and returns it.
 *
 * Doesn't check the booking's status or the caller: the callers do.
 */
export async function ensurePartyDeposit(
  bookingId: string,
  booking: FirebaseFirestore.DocumentData,
  createdVia: string,
): Promise<PartyDepositResult> {
  const fam: FamilyBillingInfo | null = booking.familyId ? await familyBillingInfo(String(booking.familyId)) : null;
  const ref = appCol("billing").doc(partyDepositBillingId(bookingId));
  const existingQuery = appCol("billing")
    .where("bookingId", "==", bookingId)
    .where("type", "==", "party_deposit")
    .limit(1);

  try {
    return await db.runTransaction(async (tx) => {
      const existing = await tx.get(existingQuery);
      if (!existing.empty) return resultOf(existing.docs[0], false);
      const own = await tx.get(ref);
      if (own.exists) return resultOf(own, false);

      const record = buildPartyDepositRecord({
        bookingId,
        booking,
        familyOwnerUid: fam?.ownerUid ?? "",
        familyPaymentMethod: fam?.paymentMethod,
        familyContactEmail: fam?.contactEmail,
        familyContactName: fam?.contactName,
        createdVia,
        now: new Date(),
      });
      if (!record.userId) {
        console.warn(`[partyDeposit] booking ${bookingId}: neither the family nor the booking has an owner uid; no parent will see this bill until one is set`);
      }
      tx.create(ref, {
        ...record,
        periodStart: ts(record.periodStart),
        periodEnd: ts(record.periodEnd),
        dueDate: ts(record.dueDate),
        createdAt: ts(record.createdAt),
        updatedAt: ts(record.updatedAt),
      });
      console.log(`[partyDeposit] created ${ref.id} for booking ${bookingId}: total=${record.total} owner=${record.userId || "(none)"} method=${record.paymentMethod} via=${createdVia}`);
      return { billingId: ref.id, created: true, total: record.total, status: record.status };
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // A concurrent call created the same deterministic doc first.
    const snap = await ref.get();
    console.log(`[partyDeposit] ${ref.id} for booking ${bookingId} was created concurrently, returning it`);
    return resultOf(snap, false);
  }
}
