import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readAll, sendCommands, type DeviceConfig, type DeviceState, type DpValue } from './tuya';
import { dpForCode } from './dpmap';
import { startHttp } from './http';

/**
 * Domotics bridge.
 *
 * Talks to Tuya devices over the LAN and serves their state on a small local
 * HTTP API. While the app runs on the same network, that is the whole story:
 * no cloud is in the path of a light switch or a thermostat.
 *
 * Firestore is used for exactly one thing — reading the device list and local
 * keys once at startup, because they are secrets and belong somewhere sealed
 * rather than in the repo. Relaying state and commands through Firestore is a
 * separate concern that only matters for reaching the house from outside it,
 * and is deliberately not wired up yet.
 */

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'kidclub-dev';
const POLL_MS = Number(process.env.POLL_MS ?? 15_000);
/**
 * These devices allow only a couple of local connections and get *worse* the
 * harder you push. Polling a failing device every 15s with retries was enough
 * to keep two thermostats permanently unreachable — stop the bridge and they
 * answer first time. So a device that fails is backed off exponentially and
 * left alone to recover, rather than hammered on every cycle.
 */
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const HTTP_PORT = Number(process.env.PORT ?? 8787);

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();
const CONFIG_DOC = db.doc('domotics_config/tuya_devices');

let devices: DeviceConfig[] = [];
let state: { devices: DeviceState[]; updatedAt: number } = { devices: [], updatedAt: 0 };
/** Per-device cool-off after failures. Absent means "due now". */
const backoff = new Map<string, { failures: number; nextAt: number }>();

function noteResult(id: string, ok: boolean) {
  if (ok) {
    if (backoff.delete(id)) console.log(`[tuya] ${id} recovered`);
    return;
  }
  const failures = (backoff.get(id)?.failures ?? 0) + 1;
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
  backoff.set(id, { failures, nextAt: Date.now() + delay });
  console.warn(`[tuya] backing off ${id} for ${Math.round(delay / 1000)}s (${failures} failures)`);
}

async function loadConfig(): Promise<DeviceConfig[]> {
  const snap = await CONFIG_DOC.get();
  if (!snap.exists) throw new Error('domotics_config/tuya_devices missing — run key sync');
  const list = (snap.data()?.devices ?? []) as DeviceConfig[];
  if (list.length === 0) throw new Error('no devices in config');
  return list;
}

async function poll() {
  try {
    const now = Date.now();
    const due = devices.filter(d => (backoff.get(d.id)?.nextAt ?? 0) <= now);
    const results = await readAll(due);
    for (const r of results) noteResult(r.id, r.online);
    const byId = new Map(results.map(r => [r.id, r]));

    // Devices that are sleeping, backed off, or simply not due keep their last
    // reading rather than blanking. Discarding it would leave the UI with
    // nothing to show for a thermostat that is working perfectly well, so it is
    // carried forward and flagged; consumers dim it instead of presenting it as
    // live.
    const next: DeviceState[] = devices.map(cfg => {
      const fresh = byId.get(cfg.id);
      if (fresh?.online) return fresh;
      const prev = state.devices.find(p => p.id === cfg.id);
      if (prev && prev.status.length > 0) {
        return { ...prev, online: false, lastSeen: prev.lastSeen ?? state.updatedAt };
      }
      return fresh ?? prev ?? {
        id: cfg.id, name: cfg.name, category: cfg.category, online: false, status: [],
      };
    });

    const changed = JSON.stringify(next) !== JSON.stringify(state.devices);
    state = { devices: next, updatedAt: Date.now() };
    if (changed) {
      const online = next.filter(d => d.online).length;
      console.log(`[state] ${online}/${next.length} online (changed)`);
    }
  } catch (err) {
    console.error('[poll] failed:', (err as Error).message);
  }
}

/**
 * Commands arrive in the same `{code, value}` shape the Tuya cloud accepted,
 * so the app speaks one language regardless of what is behind it. Translation
 * back into datapoint numbers happens here.
 */
async function runCommand(
  deviceId: string,
  commands: Array<{ code: string; value: unknown }>,
) {
  const config = devices.find(d => d.id === deviceId);
  if (!config) throw new Error(`unknown device ${deviceId}`);

  // Values arrive as JSON; anything that isn't a datapoint primitive is dropped
  // rather than sent to the device.
  const dps: Record<string, DpValue> = {};
  for (const { code, value } of commands) {
    const dp = dpForCode(config.category, code);
    if (!dp) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      dps[dp] = value;
    }
  }
  if (Object.keys(dps).length === 0) throw new Error('no known datapoints in command');

  await sendCommands(config, dps);
  console.log(`[command] ${config.name} <- ${JSON.stringify(dps)}`);
}

async function main() {
  devices = await loadConfig();
  console.log(`[bridge] ${devices.length} devices, polling every ${POLL_MS / 1000}s`);
  for (const d of devices) console.log(`         ${d.name} @ ${d.ip} v${d.version}`);

  await poll();
  setInterval(() => void poll(), POLL_MS);

  startHttp(HTTP_PORT, {
    getState: () => state,
    sendCommand: runCommand,
    refresh: poll,
  });
}

/**
 * Last resort, not a substitute for handling errors properly.
 *
 * Every known source of stray async errors is dealt with at source (see the
 * `error` listener in tuya.ts). But this process is meant to run unattended for
 * months controlling heating, and staying up in a degraded state beats dying
 * silently overnight because one socket misbehaved in a way we did not predict.
 * Anything landing here is a bug worth reading the log for.
 */
process.on('uncaughtException', err => {
  console.error('[bridge] uncaught exception (continuing):', err);
});
process.on('unhandledRejection', err => {
  console.error('[bridge] unhandled rejection (continuing):', err);
});

main().catch(err => {
  console.error('[bridge] fatal during startup:', err);
  process.exit(1);
});
