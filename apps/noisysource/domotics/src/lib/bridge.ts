import type { TuyaDevice } from '../data/tuyaData';

/**
 * Client for the local domotics bridge.
 *
 * The bridge runs on the same network as the devices and answers over plain
 * HTTP, so nothing here touches a cloud — a thermostat command is a LAN round
 * trip measured in milliseconds.
 *
 * Two consequences worth knowing:
 *  - Away from home, these calls simply fail and the app reports the bridge as
 *    offline. Remote access needs a relay, which is a separate piece of work.
 *  - Once the app is served over HTTPS, browsers will block these http:// calls
 *    as mixed content. That is the point at which a relay stops being optional.
 */

const BRIDGE_URL =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'http://localhost:8787';

/** Fail fast: an unreachable bridge should show as offline, not hang the UI. */
const TIMEOUT_MS = 4000;

export interface BridgeState {
  devices: TuyaDevice[];
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

export async function fetchBridgeState(): Promise<BridgeState> {
  return await request('/state') as BridgeState;
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
  const result = await request('/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, commands }),
  }) as BridgeState & { ok?: boolean };
  return result?.devices ? result : null;
}
