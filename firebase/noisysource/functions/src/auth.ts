import { HttpsError } from "firebase-functions/v2/https";

/** The same address the Firestore rules know the owner by (../../firestore.rules). */
const OWNER_EMAIL = "admin@noisysource.com";

/**
 * Everything in this project is Renato's alone. `onCall` does not reject
 * anonymous callers by itself, and "any signed-in user" isn't a check either:
 * anyone can create an account. So every callable starts here.
 */
export function requireOwner(
  auth: { token?: { email?: string; email_verified?: boolean } } | undefined,
): void {
  if (!auth) throw new HttpsError("unauthenticated", "Sign-in required");
  if (auth.token?.email !== OWNER_EMAIL || auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Only the owner can use this");
  }
}

/**
 * Atlas, Renato's assistant (repo noisysource/Atlas, on his Mac). It signs in
 * with email and password as its own account, created verified by
 * apps/noisysource/domotics-bridge/deploy/create-agent-user.sh, and the
 * Firestore rules know it by the same address (isAtlas).
 */
export const AGENT_EMAIL = "atlas@kidclub.pt";

/**
 * For the few callables Atlas may use: the owner, as in requireOwner, or
 * Atlas. Both need a verified address. Returns who called, so a callable can
 * be stricter with Atlas than with the owner. Everything else keeps
 * requireOwner.
 */
export function requireOwnerOrAgent(
  auth: { token?: { email?: string; email_verified?: boolean } } | undefined,
): "owner" | "agent" {
  if (!auth) throw new HttpsError("unauthenticated", "Sign-in required");
  const email = auth.token?.email;
  if (auth.token?.email_verified === true) {
    if (email === OWNER_EMAIL) return "owner";
    if (email === AGENT_EMAIL) return "agent";
  }
  throw new HttpsError("permission-denied", "Only the owner or Atlas can use this");
}
