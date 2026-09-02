import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
} from 'firebase/auth';
import { doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import type { Auth } from 'firebase/auth';

const LS_EMAIL_KEY = 'kidclub_magic_link_email';

const ensureUserDoc = async (db: Firestore, firebaseUser: { uid: string; email: string | null; displayName: string | null }) => {
  const userRef = doc(db, 'users', firebaseUser.uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    await setDoc(userRef, {
      uid: firebaseUser.uid,
      email: firebaseUser.email,
      name: firebaseUser.displayName,
      roles: { rainbowAdmin: false, finhubAdmin: false },
      createdAt: new Date(),
    });
  }
};

export const loginWithGoogle = async (auth: Auth, db: Firestore) => {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  await ensureUserDoc(db, result.user);
};

export const sendMagicLink = async (auth: Auth, email: string, redirectUrl: string) => {
  await sendSignInLinkToEmail(auth, email, {
    url: redirectUrl,
    handleCodeInApp: true,
  });
  localStorage.setItem(LS_EMAIL_KEY, email);
};

// Returns true if sign-in was completed, false if current URL is not a magic link.
// Throws if the link is invalid or the email is missing.
export const completeMagicLinkSignIn = async (
  auth: Auth,
  db: Firestore,
  href: string,
  emailHint?: string
): Promise<{ completed: boolean; needsEmail: boolean }> => {
  if (!isSignInWithEmailLink(auth, href)) return { completed: false, needsEmail: false };

  const email = emailHint ?? localStorage.getItem(LS_EMAIL_KEY);
  if (!email) return { completed: false, needsEmail: true };

  const result = await signInWithEmailLink(auth, email, href);
  localStorage.removeItem(LS_EMAIL_KEY);
  await ensureUserDoc(db, result.user);
  return { completed: true, needsEmail: false };
};

// No-op — redirect flow not used; kept for call-site compatibility
export const handleGoogleRedirectResult = async (_auth: Auth, _db: Firestore): Promise<boolean> => false;

export const logout = async (auth: Auth) => {
  await signOut(auth);
};