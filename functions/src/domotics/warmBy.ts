import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { describeLocal, parseWarmByInput, type WarmByInput } from "./warmByLogic";

/**
 * "Have the house warm by HH:MM": the heating automation's one-off target
 * (apps/noisysource/domotics-bridge/src/warmby.ts). Called by the app's
 * automation card, and later by the chat after the user's confirm tap
 * (HANDOFF-reports-and-chat.md, section 2).
 *
 * It only stores the request in `domotics_config/warm_by`. The bridge on the
 * Pi reads it within two minutes, works out when to start from how the house
 * warms up, and reports the plan with its state (`automation.warmBy`). This is
 * the only way that document gets written: the rules let the owner and the
 * bridge read it and nobody write it from a client, so every request is
 * checked here.
 *
 * No external API, no device command: one Firestore write per request.
 */

const DOC = "domotics_config/warm_by";

/**
 * Renato only, for now (decided 2026-10-24). Stricter than legrand.ts/tuya.ts,
 * which still accept any signed-in user (STATUS.md, plan 3).
 */
const OWNER_EMAIL = "admin@kidclub.pt";

function requireDomoticsOwner(auth: { token?: { email?: string; email_verified?: boolean } } | undefined) {
  if (!auth) throw new HttpsError("unauthenticated", "Sign-in required");
  if (auth.token?.email !== OWNER_EMAIL || auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Only the house owner can set this");
  }
}

export const domoticsWarmBy = onCall<WarmByInput>({ region: "europe-west3" }, async ({ auth, data }) => {
  requireDomoticsOwner(auth);
  const now = Date.now();
  const parsed = parseWarmByInput(data, now);
  if ("error" in parsed) throw new HttpsError("invalid-argument", parsed.error);

  const ref = admin.firestore().doc(DOC);
  if (!("at" in parsed)) {
    await ref.delete();
    return { cleared: true };
  }
  await ref.set({
    at: admin.firestore.Timestamp.fromMillis(parsed.at),
    target: parsed.target,
    setAt: admin.firestore.FieldValue.serverTimestamp(),
    setBy: auth!.token.email,
    source: parsed.source,
  });
  return {
    cleared: false,
    at: new Date(parsed.at).toISOString(),
    target: parsed.target,
    ...describeLocal(parsed.at, now),
  };
});
