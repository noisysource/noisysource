import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * The E13 guard, as the app sees it: its settings (on/off, and its early
 * warning, stored in `domotics_config/guard`, owner-only) and the status the
 * bridge reports with its state. Mirrors `domotics-bridge/src/guard.ts` and
 * `src/preempt.ts`, which have the rules.
 */

/** The early warning: switches the pump off just before an E13 (bridge from 2026-10-27). */
export interface PreemptStatus {
  /** On in the app, with the guard on. */
  enabled: boolean;
  /** Enabled, and not switched off after two trips anyway. */
  active: boolean;
  stopsToday: number;
  lastStop: { at: number; reason: string } | null;
  /** Switched off after two trips anyway, until then. */
  offUntil: number | null;
  /** One line, written by the bridge. */
  note: string;
}

export interface GuardStatus {
  enabled: boolean;
  mode: 'off' | 'watch' | 'rest' | 'lockout';
  restUntil: number | null;
  /** What it's doing, in Portuguese, written by the bridge. */
  note: string;
  lastAction: { at: number; what: 'on' | 'off'; reason: string } | null;
  /** Switched off from outside: when the guard switches it back on (null = not waiting; absent on an older bridge). */
  reonAt?: number | null;
  /** A person's pause ("Pausar" on the automation): the guard switches nothing on until then. */
  pausedUntil?: number | null;
  /** The heating automation is running live: it, not the guard, undoes an off from outside. */
  automationOwns?: boolean;
  /** Absent on a bridge older than 2026-10-27. */
  preempt?: PreemptStatus;
  evaluatedAt: number;
}

export interface GuardSettings {
  enabled: boolean;
  /** The early warning; a document without the field means on. */
  preempt: boolean;
}

const REF = () => doc(db, 'domotics_config', 'guard');

/** Owner only (firestore.rules). A missing document means off; the bridge reads it the same way (parseGuardConfig). */
export async function loadGuardSettings(): Promise<GuardSettings> {
  const snap = await getDoc(REF());
  const d = snap.exists() ? snap.data() : {};
  return { enabled: d.enabled === true, preempt: d.preempt !== false };
}

/** One setting at a time; merged, so the other one is left as it is. */
export async function saveGuardSetting(change: Partial<GuardSettings>) {
  await setDoc(REF(), change, { merge: true });
}
