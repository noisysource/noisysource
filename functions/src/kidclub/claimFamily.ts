import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { appCol } from "./db";

// ── Claim an owner-less family by verified email ─────────────────────────────
//
// A family can exist with primaryContact.userId == "" — created by the Phase 0
// migration (identity.mjs) or by an admin — until its parent first logs in.
// getOrCreateFamily() on the client used to look families up by uid only, so
// that first login silently created a second, empty family and the parent saw
// none of their children, subscriptions or bills.
//
// The client calls this when no family matches its uid. It links every
// owner-less family whose primaryContact.email equals the caller's VERIFIED
// email to the caller, then backfills `userId` on that family's children,
// subscriptions and billing records wherever it is missing or "" (the portal
// queries and the Firestore rules match on userId, not familyId).
//
// Done server-side with the Admin SDK rather than via new client rules because
// it has to write billing (functions-only today), and because it keeps the
// family/children/subscription rules exactly as narrow as they are now.
//
// Never overwrites a non-empty userId: a family or doc already owned by
// someone else is left alone, and so is a family owned by a different account
// of the same parent (that needs a human decision, not an automatic merge).

const LINKED_COLLECTIONS = ["children", "studyroom", "transportationSubscriptions", "billing"] as const;

// Firestore batches cap at 500 writes; stay well under.
const BATCH_SIZE = 400;

export const claimFamilyByEmail = onCall(
  { region: "europe-west3", invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");

    const token = request.auth!.token;
    const rawEmail = typeof token.email === "string" ? token.email.trim() : "";
    // An unverified email proves nothing: without this, anyone could register
    // a password account with a parent's address and take over their family.
    // (Parents sign in with Google or an email link, both verified.)
    if (!rawEmail || token.email_verified !== true) return { familyId: null, claimed: 0 };

    // Firestore equality is case-sensitive. Emails are stored lowercased
    // (normalizeEmail / normalize-emails.mjs), but try the raw form too.
    const emails = [...new Set([rawEmail, rawEmail.toLowerCase()])];
    const snap = await appCol("families").where("primaryContact.email", "in", emails).get();

    const byAge = (a: FirebaseFirestore.QueryDocumentSnapshot, b: FirebaseFirestore.QueryDocumentSnapshot) =>
      (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0);

    // Already ours (e.g. a concurrent call from another page claimed it first).
    const owned = snap.docs.filter(d => d.data().primaryContact?.userId === uid).sort(byAge);
    const claimable = snap.docs.filter(d => !d.data().primaryContact?.userId).sort(byAge);
    if (!claimable.length) return { familyId: owned[0]?.id ?? null, claimed: 0 };

    if (claimable.length > 1) {
      console.warn(`[claimFamilyByEmail] ${claimable.length} owner-less families for ${rawEmail}: ${claimable.map(d => d.id).join(", ")} — claiming all`);
    }

    const claimedIds: string[] = [];
    for (const fam of claimable) {
      // Transaction so two concurrent logins (or a racing admin edit) can't
      // both think they claimed it; re-check ownership inside.
      const won = await admin.firestore().runTransaction(async (tx) => {
        const fresh = await tx.get(fam.ref);
        const current = fresh.data()?.primaryContact?.userId;
        if (current && current !== uid) return false;
        tx.update(fam.ref, {
          "primaryContact.userId": uid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (won) claimedIds.push(fam.id);
    }

    let backfilled = 0;
    for (const familyId of claimedIds) backfilled += await backfillUserId(familyId, uid);

    console.log(`[claimFamilyByEmail] uid=${uid} claimed families=[${claimedIds.join(", ")}] docs backfilled=${backfilled}`);
    const familyId = owned[0]?.id ?? claimedIds[0] ?? null;
    return { familyId, claimed: claimedIds.length };
  }
);

async function backfillUserId(familyId: string, uid: string): Promise<number> {
  const refs: FirebaseFirestore.DocumentReference[] = [];
  for (const name of LINKED_COLLECTIONS) {
    const snap = await appCol(name).where("familyId", "==", familyId).get();
    for (const d of snap.docs) if (!d.data().userId) refs.push(d.ref);
  }
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = admin.firestore().batch();
    for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.update(ref, { userId: uid });
    await batch.commit();
  }
  return refs.length;
}
