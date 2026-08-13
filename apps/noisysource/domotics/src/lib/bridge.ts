import {
  addDoc, collection, doc, getDoc, serverTimestamp,
} from 'firebase/firestore';
import type { TuyaDevice } from '../data/tuyaData';
import type { EnergyReading } from '../data/energy';
import { db } from './firebase';

/**
 * Client for the local domotics bridge.
 *
 * The bridge runs on the same network as the devices and answers over plain
 * HTTP, so nothing here touches a cloud — a thermostat command is a LAN round
 * trip measured in milliseconds.
 *
 * Away from home the bridge is unreachable — it sits behind NAT on the house
 * LAN — so these calls fail and we fall back to the Firestore relay, which the
 * bridge publishes to outbound. Same for an HTTPS-served app, where browsers
 * block http:// calls to the LAN as mixed content.
 *
 * The direct path is preferred whenever it works: it is roughly an order of
 * magnitude faster than a round trip through a datacentre, and it keeps working
 * when the internet doesn't.
 */

const BRIDGE_URL =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'http://localhost:8787';

/** Fail fast: an unreachable bridge should show as offline, not hang the UI. */
const TIMEOUT_MS = 4000;

export interface BridgeState {
  devices: TuyaDevice[];
  /** Absent if the bridge could not reach the inverter. */
  inverter?: EnergyReading;
  updatedAt: number;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BRIDGE_URL}${path}`, { ...init, signal: controller.signal });
    if (!resp.ok) throw new Error(`bridge responded ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remembers whether the direct bridge answered last time.
 *
 * Without this, every poll from abroad would wait out the LAN timeout before
 * falling back — four seconds of dead air on each refresh. One failure is
 * enough to switch to the relay; a later success switches back.
 */
let directWorks = true;

export async function fetchBridgeState(): Promise<BridgeState> {
  if (directWorks) {
    try {
      return await request('/state') as BridgeState;
    } catch {
      directWorks = false;
    }
  }
  const relayed = await fetchRelayState();
  if (relayed) return relayed;

  // Relay empty or unreachable too: retry the direct path once, in case we are
  // simply back on the home network.
  const direct = await request('/state') as BridgeState;
  directWorks = true;
  return direct;
}

/**
 * Commands use the same `{code, value}` vocabulary the Tuya cloud used, so the
 * app is unchanged by what sits behind the bridge. The response carries freshly
 * read state, which replaces the optimistic guess immediately.
 */
export async function sendBridgeCommand(
  deviceId: string,
  commands: Array<{ code: string; value: unknown }>,
): Promise<BridgeState | null> {
  if (directWorks) {
    try {
      const result = await request('/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, commands }),
      }) as BridgeState & { ok?: boolean };
      return result?.devices ? result : null;
    } catch {
      directWorks = false;
    }
  }
  // Queued for the bridge to pick up. No fresh state comes back this way — the
  // optimistic update stands until the next poll reflects reality.
  await queueRelayCommand(deviceId, commands);
  return null;
}

/** How stale relayed state may be before it is treated as no answer at all. */
const RELAY_MAX_AGE_MS = 15 * 60_000;

async function fetchRelayState(): Promise<BridgeState | null> {
  try {
    const snap = await getDoc(doc(db, 'domotics_state', 'tuya'));
    if (!snap.exists()) return null;
    const data = snap.data() as {
      devices?: TuyaDevice[]; inverter?: EnergyReading; updatedAt?: { toMillis(): number };
    };
    const updatedAt = data.updatedAt?.toMillis?.() ?? 0;
    // A bridge that stopped days ago should read as offline, not as a house
    // frozen at whatever it last saw.
    if (!data.devices || Date.now() - updatedAt > RELAY_MAX_AGE_MS) return null;
    return { devices: data.devices, inverter: data.inverter, updatedAt };
  } catch {
    return null;
  }
}

async function queueRelayCommand(
  deviceId: string,
  commands: Array<{ code: string; value: unknown }>,
) {
  await addDoc(collection(db, 'domotics_commands'), {
    deviceId,
    commands,
    createdAt: serverTimestamp(),
  });
}
