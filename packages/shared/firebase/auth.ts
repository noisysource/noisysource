import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, Firestore } from 'firebase/firestore';
import { Auth, UserCredential } from 'firebase/auth';

export const loginWithGoogle = async (auth: Auth, db: Firestore) => {
  const provider = new GoogleAuthProvider();
  const result: UserCredential = await signInWithPopup(auth, provider);
  const user = result.user;

  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email,
      name: user.displayName,
      roles: {
        rainbowAdmin: false,
        finhubAdmin: false,
      },
      createdAt: new Date(),
    });
  }

  const data = (await getDoc(userRef)).data();
  return { user, roles: data?.roles || {} };
};

export const logout = async (auth: Auth) => {
  await signOut(auth);
};