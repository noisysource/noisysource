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

export function watchAuth(cb: (user: User | null) => void) {
  return onAuthStateChanged(auth, cb);
}

export async function signIn() {
  await signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signOutUser() {
  await signOut(auth);
}
