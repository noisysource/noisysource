import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { auth } from './firebase';

export const watchAuth = (cb: (u: User | null) => void) => onAuthStateChanged(auth, cb);
export const signIn = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOutUser = () => signOut(auth);

export function describeSignInError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'auth/unauthorized-domain') {
    return `${window.location.hostname} isn't an authorized domain in Firebase Auth yet.`;
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in cancelled.';
  if (code === 'auth/popup-blocked') return 'The browser blocked the sign-in window.';
  return (err as Error)?.message ?? 'Could not sign in.';
}
