import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import type { Auth } from 'firebase/auth';

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

// No-op kept for call-site compatibility — redirect flow removed
export const handleGoogleRedirectResult = async (_auth: Auth, _db: Firestore): Promise<boolean> => false;

export const logout = async (auth: Auth) => {
  await signOut(auth);
};