/// <reference types="vite/client" />
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getFirestore } from 'firebase/firestore';
import { isFirebaseHosting, isInstalledApp } from './origin';

/**
 * Where Google sign-in completes.
 *
 * Normally `<project>.firebaseapp.com`. Inside an app installed on an iPhone's
 * home screen that fails: Safari partitions storage by site, so a sign-in that
 * finishes on firebaseapp.com is invisible to the app on its own .web.app
 * domain and it comes back signed out. Every Hosting site of the project serves
 * the same /__/auth/handler, so the installed app uses its own host instead and
 * the whole flow stays first-party.
 *
 * Only for the installed app, deliberately: that host must also be listed as a
 * redirect URI on the project's Google OAuth client
 * (https://<host>/__/auth/handler), and until it is Google answers
 * redirect_uri_mismatch. Browser tabs keep the configured domain and so keep
 * working either way.
 */
function authDomain(): string {
  return isInstalledApp() && isFirebaseHosting()
    ? window.location.hostname
    : import.meta.env.VITE_FIREBASE_AUTH_DOMAIN!;
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY!,
  authDomain: authDomain(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID!,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID!,
  appId: import.meta.env.VITE_FIREBASE_APP_ID!,
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const fns = getFunctions(app, 'europe-west3');

export const db = getFirestore(app);

export const getStatusFn = httpsCallable(fns, 'legrandGetStatus');
export const setStateFn = httpsCallable<{
  // `bridge` is required by Netatmo's /setstate — omitting it returns 400.
  modules: Array<{
    id: string; bridge?: string; on?: boolean; target_position?: number;
    /** Dimmers (NLFN) only, 0–100. */
    brightness?: number;
  }>;
}>(fns, 'legrandSetState');

/** The heating automation's one-off "warm by HH:MM" (functions/src/domotics/warmBy.ts). Owner only. */
export const warmByFn = httpsCallable<
  { time?: string; target?: number | null; clear?: boolean; source?: 'app' | 'chat' },
  { cleared: boolean; at?: string; target?: number | null; local?: string; day?: string }
>(fns, 'domoticsWarmBy');

/** Tesla (functions/src/domotics/tesla.ts). Owner only. */
export interface TeslaCar {
  vin: string; id: string; name: string; model?: string; state: string;
  soc?: number; rangeKm?: number; chargeLimit?: number; chargingState?: string;
  chargeAmps?: number; chargeAmpsMax?: number; chargerPowerKw?: number; energyAddedKwh?: number; minutesToFull?: number;
  locked?: boolean; sentry?: boolean; insideC?: number; outsideC?: number; climateOn?: boolean;
  odometerKm?: number; lat?: number; lon?: number; shiftState?: string | null; speedKmh?: number; software?: string;
  readAt?: number;
}
export const teslaAuthStartFn = httpsCallable<{ redirectUri: string }, { url: string }>(fns, 'teslaAuthStart');
export const teslaAuthFinishFn = httpsCallable<{ code: string; state: string }, { ok: boolean }>(fns, 'teslaAuthFinish');
export const teslaRegisterPartnerFn = httpsCallable<void, { ok: boolean }>(fns, 'teslaRegisterPartner');
export const teslaVehiclesFn = httpsCallable<
  { refresh?: boolean },
  { connected: boolean; cars: TeslaCar[]; callsToday?: number; callCap?: number }
>(fns, 'teslaVehicles');
