import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * Heating automation, as the app sees it: the settings (edited here, stored in
 * `domotics_config/automation`, owner-only) and the status the bridge reports
 * with its state (what it decided and why).
 *
 * Mirrors `domotics-bridge/src/automation.ts`. Kept as its own copy rather than
 * imported, like EnergyReading: the bridge is a separate deployable, and the
 * bridge clamps whatever it reads to its own hard limits anyway.
 */

export interface AutomationConfig {
  enabled: boolean;
  dryRun: boolean;
  comfort: number;
  preheat: { from: string; to: string; delta: number };
  evening: { from: string; to: string; delta: number };
  solarBoost: { enabled: boolean; delta: number; exportW: number };
  flow: { enabled: boolean; at15: number; slope: number; min: number; max: number };
  pumpFollowsZones: { enabled: boolean; idleMin: number; minOnMin: number; minOffMin: number };
  limits: { roomMin: number; roomMax: number };
}

export const DEFAULT_AUTOMATION: AutomationConfig = {
  enabled: false,
  dryRun: true,
  comfort: 24,
  preheat: { from: '05:00', to: '08:00', delta: 0.5 },
  evening: { from: '18:00', to: '22:00', delta: -0.5 },
  solarBoost: { enabled: true, delta: 0.5, exportW: 800 },
  flow: { enabled: true, at15: 30, slope: 0.8, min: 28, max: 38 },
  pumpFollowsZones: { enabled: true, idleMin: 20, minOnMin: 30, minOffMin: 15 },
  limits: { roomMin: 21, roomMax: 25 },
};

export interface AutomationAction {
  at: number;
  device: string;
  what: string;
  sent: boolean;
  error?: string;
}

export interface AutomationStatus {
  enabled: boolean;
  dryRun: boolean;
  state: 'off' | 'running' | 'dry-run';
  period?: 'preheat' | 'day' | 'evening' | 'night';
  periodLabel?: string;
  boost?: boolean;
  roomTarget?: number;
  outdoor?: number;
  flowTarget?: number;
  flowCorrection?: number;
  pumpHold?: string;
  zones: Array<{ id: string; name: string; note: string }>;
  reasons: string[];
  actions: AutomationAction[];
  evaluatedAt: number;
}

const REF = () => doc(db, 'domotics_config', 'automation');

/** Stored settings over the defaults, section by section, so a partial document still reads whole. */
function merge(stored: Partial<AutomationConfig> | undefined): AutomationConfig {
  const s = stored ?? {};
  const d = DEFAULT_AUTOMATION;
  return {
    ...d,
    ...s,
    preheat: { ...d.preheat, ...s.preheat },
    evening: { ...d.evening, ...s.evening },
    solarBoost: { ...d.solarBoost, ...s.solarBoost },
    flow: { ...d.flow, ...s.flow },
    pumpFollowsZones: { ...d.pumpFollowsZones, ...s.pumpFollowsZones },
    limits: { ...d.limits, ...s.limits },
  };
}

/** Owner only (firestore.rules): anyone else, and anything signed out, gets permission-denied. */
export async function loadAutomationConfig(): Promise<AutomationConfig> {
  const snap = await getDoc(REF());
  return merge(snap.exists() ? (snap.data() as Partial<AutomationConfig>) : undefined);
}

export async function saveAutomationConfig(cfg: AutomationConfig) {
  await setDoc(REF(), cfg);
}
