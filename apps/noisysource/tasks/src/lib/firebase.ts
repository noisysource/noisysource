/// <reference types="vite/client" />
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// The NoisySource project's web config (.env.nsdev / .env.nsprod), the same
// one Domotics uses. Public by design; the Firestore rules protect the data.
const app = getApps().length
  ? getApp()
  : initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY!,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN!,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID!,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET!,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID!,
      appId: import.meta.env.VITE_FIREBASE_APP_ID!,
    });

export const db = getFirestore(app);
export const auth = getAuth(app);
export const PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID as string;

/** The only account the rules let in (firebase/noisysource/firestore.rules). */
export const OWNER_EMAIL = 'admin@noisysource.com';
