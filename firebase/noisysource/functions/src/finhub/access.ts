import { HttpsError } from "firebase-functions/v2/https";

/**
 * Who may use FinHub: the same addresses as isFinhubUser() in
 * ../../../firestore.rules. Renato's Noisy Source account for now; Marisa
 * joins when the household part is built. Verified addresses only: anyone
 * can create an account, and only a verified address proves who it is.
 */
export const FINHUB_USERS = ["admin@noisysource.com"];

export function requireFinhubUser(
  auth: { token?: { email?: string; email_verified?: boolean } } | undefined,
): void {
  if (!auth) throw new HttpsError("unauthenticated", "Sign-in required");
  const email = auth.token?.email;
  if (auth.token?.email_verified !== true || !email || !FINHUB_USERS.includes(email)) {
    throw new HttpsError("permission-denied", "FinHub is private");
  }
}
