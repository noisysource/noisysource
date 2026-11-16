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
