import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signOut, onAuthStateChanged,
} from 'firebase/auth';
import type { User } from 'firebase/auth';
import { app } from './firebase';
import { isInstalledApp, isLanOrigin, SIGNED_IN_HOST } from './origin';

/**
 * Sign-in for the domotics app.
 *
 * Needed only because of the relay: while everything ran on the LAN there was
 * nothing to protect, but `domotics_commands` is reachable from the public
 * internet and turns the heating on and off. The Firestore rules do the real
 * enforcement — this only obtains the identity they check.
 *
 * The LAN path still works signed out. Losing sign-in should not stop you
 * controlling your own house from inside it.
 */

export const auth = getAuth(app);

/**
 * Whether this page must be gated behind sign-in.
 *
 * Served from the LAN the app talks to the bridge directly and there is nothing
 * to protect from — requiring Google to turn on a radiator in your own house is
 * exactly what this system exists to avoid, and it would break during an
 * internet outage. Served from anywhere else the page is on the public
 * internet, so it is gated.
 *
 * A UI gate only. `firestore.rules` is what actually protects the heating, and
 * it does not care where the page was served from.
 */
export function requiresSignIn(): boolean {
  return !isLanOrigin();
}

export function watchAuth(cb: (user: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}

/**
 * Google sign-in. A popup in a browser tab, as before; a full-page redirect in
 * the installed app, where a popup opens in a separate sheet that can't hand
 * the result back reliably. The redirect leaves the page — the result arrives
 * through `watchAuth` when the app reloads, and any error through
 * `redirectSignInError`.
 */
export async function signIn() {
  const provider = new GoogleAuthProvider();
  if (isInstalledApp()) await signInWithRedirect(auth, provider);
  else await signInWithPopup(auth, provider);
}

/** Why a redirect sign-in failed, once back in the app; null if it didn't. */
export async function redirectSignInError(): Promise<unknown> {
  try {
    await getRedirectResult(auth);
    return null;
  } catch (err) {
    return err;
  }
}

/**
 * Firebase Auth only accepts sign-in from its authorized domains, and no LAN
 * address is one (localhost included) — so on the LAN, sign-in always fails.
 */
export const LAN_NO_SIGN_IN =
  `Na rede local não é possível iniciar sessão. Use a app (${SIGNED_IN_HOST}).`;

/** Sign-in failures in words, for the person holding the phone. */
export function describeSignInError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'auth/unauthorized-domain') {
    // Not something the person did: the page's host isn't one Firebase Auth
    // accepts. On the LAN that's every address — localhost included.
    return isLanOrigin()
      ? LAN_NO_SIGN_IN
      : `${window.location.hostname} não está nos domínios autorizados do Firebase Auth.`;
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sessão cancelada.';
  if (code === 'auth/popup-blocked') return 'O navegador bloqueou a janela de início de sessão.';
  if (code === 'auth/network-request-failed') return 'Sem ligação à internet.';
  return (err as Error)?.message ?? 'Não foi possível iniciar sessão.';
}

export async function signOutUser() {
  await signOut(auth);
}
