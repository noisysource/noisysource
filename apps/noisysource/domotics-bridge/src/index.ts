import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * Firestore is consulted for one thing only — the device list and local keys —
 * and even that is cached to disk, so a cloud outage or an expired credential
 * cannot stop the house being controlled. That is the entire point of this
 * service; depending on Google to turn on a radiator would defeat it.
 *
 * Relaying state and commands through Firestore is a separate concern that only
 * matters for reaching the house from outside it, and is deliberately not wired
 * up yet.
 */

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'kidclub-dev';
/**
 * Polling is demand-driven. These devices have very few connection slots and
 * degrade under pressure, and thermostats barely change minute to minute — so
 * there is nothing to gain from reading them constantly while nobody is
 * looking. A client fetching /state is taken as the signal that someone is
 * watching; otherwise the bridge idles at a slow keep-warm rate.
 *
 * This cuts device load roughly tenfold when the app is closed, which is the
 * bulk of the time.
 */
const ACTIVE_POLL_MS = Number(process.env.POLL_MS ?? 30_000);
const IDLE_POLL_MS = Number(process.env.IDLE_POLL_MS ?? 300_000);
/** How long after a request we still consider someone to be watching. */
const ACTIVE_WINDOW_MS = 120_000;
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
/** Last time a client asked for state — drives the polling rate. */
let lastClientAt = 0;
/** Guards against overlapping polls, which would compete for device sockets. */
let polling = false;
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

/** Local keys live here too, so it is gitignored alongside service-account keys. */
const CACHE_PATH = join(__dirname, '..', 'device-cache.json');

function readCache(): DeviceConfig[] | null {
  try {
    const list = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as DeviceConfig[];
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

/**
 * Firestore first (it is authoritative — keys rotate when a device is
 * re-paired), disk second. An expired credential or a dead network must not
 * prevent startup: the devices are on the LAN and perfectly reachable without
 * Google's involvement.
 */
async function loadConfig(): Promise<DeviceConfig[]> {
  try {
    const snap = await CONFIG_DOC.get();
    const list = (snap.data()?.devices ?? []) as DeviceConfig[];
    if (list.length === 0) throw new Error('config document is empty');
    writeFileSync(CACHE_PATH, JSON.stringify(list, null, 2));
    console.log('[config] loaded from Firestore and cached');
    return list;
  } catch (err) {
    const cached = readCache();
    if (!cached) {
      throw new Error(
        `cannot reach Firestore (${(err as Error).message}) and no local cache at ${CACHE_PATH}`,
      );
    }
    console.warn(`[config] Firestore unavailable (${(err as Error).message}) — using cached device list`);
    return cached;
  }
}

async function poll() {
  if (polling) return;
  polling = true;
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
  } finally {
    polling = false;
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

function isWatched() {
  return Date.now() - lastClientAt < ACTIVE_WINDOW_MS;
}

/**
 * Self-scheduling rather than setInterval, so the interval can change between
 * ticks and a slow poll can never overlap the next one.
 */
async function loop() {
  await poll();
  setTimeout(() => void loop(), isWatched() ? ACTIVE_POLL_MS : IDLE_POLL_MS);
}

async function main() {
  devices = await loadConfig();
  console.log(
    `[bridge] ${devices.length} devices, polling every ${ACTIVE_POLL_MS / 1000}s while watched, ` +
    `${IDLE_POLL_MS / 1000}s idle`,
  );
  for (const d of devices) console.log(`         ${d.name} @ ${d.ip} v${d.version}`);

  startHttp(HTTP_PORT, {
    getState: () => {
      lastClientAt = Date.now();
      // Waking from idle, the next poll may be minutes away — the interval is
      // fixed when the previous one finishes. So a request for stale data
      // triggers a refresh straight away. Deliberately not awaited: /state
      // always answers instantly from cache, and the fresh values arrive on the
      // caller's next tick.
      if (Date.now() - state.updatedAt > ACTIVE_POLL_MS) void poll();
      return state;
    },
    sendCommand: runCommand,
    refresh: poll,
  });

  void loop();
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
