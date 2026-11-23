import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { aiDailyCap } from "./params";

/** finhub_usage/{yyyy-mm-dd}: { aiCalls } — written only here (Admin SDK). */
export const USAGE_COLLECTION = "finhub_usage";

export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whether one more call fits under the cap, given today's count. Pure, for tests. */
export function underCap(callsSoFar: number, cap: number): boolean {
  return Number.isFinite(cap) && cap > 0 && callsSoFar < cap;
}

/**
 * Counts one Gemini call, or refuses it when today's cap is reached. The count
 * is taken in a transaction before the call, so parallel requests can't both
 * squeeze past the last slot.
 */
export async function countAiCall(now = new Date()): Promise<void> {
  const ref = admin.firestore().collection(USAGE_COLLECTION).doc(usageDay(now));
  const cap = aiDailyCap.value();
  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const calls = (snap.get("aiCalls") as number | undefined) ?? 0;
    if (!underCap(calls, cap)) {
      throw new HttpsError(
        "resource-exhausted",
        `FinHub reached today's limit of ${cap} AI calls. It resets at midnight UTC.`,
      );
    }
    tx.set(
      ref,
      { aiCalls: calls + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
  });
}
