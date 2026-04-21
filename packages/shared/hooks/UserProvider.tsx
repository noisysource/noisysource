import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, Timestamp, Firestore } from 'firebase/firestore';
import type { Auth } from 'firebase/auth';
import type { AppUser } from '@shared/models';
import { UserContext } from './UserContext';

interface Props {
  children: ReactNode;
  auth: Auth;
  db: Firestore;
}

export function UserProvider({ children, auth, db }: Props) {
  const [user, setUser] = useState<AppUser | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const userSnap = await getDoc(userRef);

        const defaultUser: AppUser = {
          uid: firebaseUser.uid,
          email: firebaseUser.email || '',
          name: firebaseUser.displayName || '',
          roles: {},
          createdAt: Timestamp.now(),
          lastLogin: Timestamp.now(),
          active: true,
        };

        if (userSnap.exists()) {
          setUser({ ...defaultUser, ...userSnap.data() });
        } else {
          setUser(defaultUser);
        }
      } else {
        setUser(null);
      }
    });

    return () => unsubscribe();
  }, [auth, db]);

  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

export const useUser = (): AppUser | null | undefined => {
  return useContext(UserContext);
}