import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { app } from './firebase';

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
  const { hostname } = window.location;
  const onLan =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.local') ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  return !onLan;
}

export function watchAuth(cb: (user: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}

export async function signIn() {
  await signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signOutUser() {
  await signOut(auth);
}
