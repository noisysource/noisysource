import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The E13 guard, as the app sees it: its one setting (on/off, stored in
 * `domotics_config/guard`, owner-only) and the status the bridge reports with
 * its state. Mirrors `domotics-bridge/src/guard.ts`, which has the rules.
 */

export interface GuardStatus {
  enabled: boolean;
  mode: 'off' | 'watch' | 'rest' | 'lockout';
  restUntil: number | null;
  /** What it's doing, in Portuguese, written by the bridge. */
  note: string;
  lastAction: { at: number; what: 'on' | 'off'; reason: string } | null;
  evaluatedAt: number;
}

const REF = () => doc(db, 'domotics_config', 'guard');

/** Owner only (firestore.rules). A missing document means off. */
export async function loadGuardEnabled(): Promise<boolean> {
  const snap = await getDoc(REF());
  return snap.exists() && snap.data().enabled === true;
}

export async function saveGuardEnabled(enabled: boolean) {
  await setDoc(REF(), { enabled });
}
