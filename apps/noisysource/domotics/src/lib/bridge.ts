import {
  addDoc, collection, doc, getDoc, serverTimestamp,
} from 'firebase/firestore';
import type { TuyaDevice } from '../data/tuyaData';
import type { EnergyReading } from '../data/energy';
import type { AutomationStatus } from '../data/automation';
import { db } from './firebase';
import { isLanOrigin } from './origin';

/**
 * Client for the local domotics bridge.
 *
 * The bridge runs on the same network as the devices and answers over plain
 * HTTP, so nothing here touches a cloud — a thermostat command is a LAN round
 * trip measured in milliseconds.
 *
 * Away from home the bridge is unreachable — it sits behind NAT on the house
 * LAN — so we fall back to the Firestore relay, which the bridge publishes to
 * outbound. The same applies to the hosted build: browsers block http:// calls
 * to a private address from an https:// page as mixed content. Note the one
 * exception, which cost some confusion — http://localhost is a trustworthy
 * origin in Chrome and is *not* blocked, so a hosted page will happily dial it
 * and get ERR_CONNECTION_REFUSED instead. Hence DIRECT_ENABLED below.
 *
 * The direct path is preferred whenever it works: it is roughly an order of
 * magnitude faster than a round trip through a datacentre, and it keeps working
 * when the internet doesn't.
 */

const BRIDGE_URL =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'http://localhost:8787';

/**
 * Whether the direct LAN path is worth attempting at all.
 *
 * Served from anywhere but the LAN it never is. The bridge sits on a private
 * address behind NAT, and the one host a browser would still dial —
 * http://localhost — is treated by Chrome as a trustworthy origin, so the
 * request is not blocked as mixed content but simply refused, once per poll,
 * loudly, in the console. Off the LAN the relay is the only route, so ask for
 * it directly.
 */
const DIRECT_ENABLED = BRIDGE_URL !== '' && isLanOrigin();

/** Fail fast: an unreachable bridge should show as offline, not hang the UI. */
const TIMEOUT_MS = 4000;

export interface BridgeState {
  devices: TuyaDevice[];
  /** Absent if the bridge could not reach the inverter. */
  inverter?: EnergyReading;
  /** What the heating automation decided last; absent on a bridge that predates it. */
  automation?: AutomationStatus;
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
let directWorks = DIRECT_ENABLED;

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
  // simply back on the home network. Off the LAN there is nothing to retry, and
  // throwing the LAN error here would report the house offline for what is
  // really a missing sign-in.
  if (!DIRECT_ENABLED) throw new Error('bridge unreachable: no relayed state');
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

/** Whether the bridge publishing the relay understands `{watch: true}`. */
let relayWatchable = false;

async function fetchRelayState(): Promise<BridgeState | null> {
  try {
    const snap = await getDoc(doc(db, 'domotics_state', 'tuya'));
    if (!snap.exists()) return null;
    const data = snap.data() as {
      devices?: TuyaDevice[]; inverter?: EnergyReading; updatedAt?: { toMillis(): number };
      watchable?: boolean;
      automation?: AutomationStatus | null;
    };
    relayWatchable = data.watchable === true;
    const updatedAt = data.updatedAt?.toMillis?.() ?? 0;
    // A bridge that stopped days ago should read as offline, not as a house
    // frozen at whatever it last saw.
    if (!data.devices || Date.now() - updatedAt > RELAY_MAX_AGE_MS) return null;
    return {
      devices: data.devices, inverter: data.inverter,
      automation: data.automation ?? undefined, updatedAt,
    };
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

/** How often an app away from home tells the bridge it's open. */
const WATCH_EVERY_MS = 90_000;
let lastWatchAt = 0;

/**
 * Away from home, tell the bridge someone is looking.
 *
 * The bridge polls the devices every 30s while watched and every 5 min
 * otherwise, and "watched" used to mean a LAN request — so a phone outside the
 * house always saw readings up to five minutes old. This queues a no-op
 * `{watch: true}` message on the existing command relay, which the bridge
 * already checks every 10s, at most once per 90s while the app is open.
 *
 * Sent only when the bridge has said it understands the message: an older
 * bridge would record it as a failed command and keep it, and every kept
 * document is re-read on each of its polls.
 */
export async function announceWatching() {
  if (directWorks || !relayWatchable || Date.now() - lastWatchAt < WATCH_EVERY_MS) return;
  lastWatchAt = Date.now();
  try {
    await addDoc(collection(db, 'domotics_commands'), { watch: true, createdAt: serverTimestamp() });
  } catch {
    // Signed out or offline: nothing to announce, and nothing to retry.
  }
}
