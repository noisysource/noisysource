import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirestoreRest } from './firestore-rest';
import { isAdminAction, runAdminAction } from './admin';
import { readAll, sendCommands, type DeviceConfig, type DeviceState, type DpValue } from './tuya';
import { dpForCode } from './dpmap';
import { startHttp } from './http';
import { readInverter, type InverterReading } from './inverter';

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
 * It also relays state and commands through Firestore, which is what makes the
 * house reachable from outside it. That path is outbound-only — the bridge
 * publishes and subscribes, never listens — so it needs no port forwarding and
 * works behind CGNAT. On the LAN the app prefers the direct HTTP API, which is
 * an order of magnitude faster; the relay is the fallback when away.
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
/** Set RELAY=0 to keep everything on the LAN and publish nothing. */
const RELAY = process.env.RELAY !== '0';
/**
 * Relay writes are throttled independently of polling: Firestore is billed per
 * write and the free tier is finite, whereas LAN reads are free. State only
 * goes up when it has actually changed, and never more often than this.
 */
const RELAY_MIN_INTERVAL_MS = 20_000;
/**
 * The REST API cannot watch a collection, so remote commands are polled.
 *
 * This is the one cost the move off firebase-admin introduces. An empty query
 * still bills one read, so at 10s that is ~8.6k reads/day against a 50k free
 * tier — comfortable, and the ceiling on remote command latency is 10s, which
 * for heating nobody will notice.
 */
const COMMAND_POLL_MS = Number(process.env.COMMAND_POLL_MS ?? 10_000);

const CONFIG_DOC = 'domotics_config/tuya_devices';
const STATE_DOC = 'domotics_state/tuya';
const COMMANDS = 'domotics_commands';
/**
 * Administration requests. Kept apart from device commands because they are a
 * different kind of thing with a different blast radius, and mixing them would
 * make the security rules harder to read than the extra polled collection is
 * worth.
 */
const ADMIN = 'domotics_admin';

/**
 * Absent when credentials are not configured. Everything Firestore-related is
 * then skipped and the bridge runs purely on the LAN off its cached device
 * list, which is the behaviour that matters: the house must not stop working
 * because a password is missing.
 */
const db = process.env.FIREBASE_API_KEY && process.env.BRIDGE_EMAIL && process.env.BRIDGE_PASSWORD
  ? new FirestoreRest({
      projectId: PROJECT_ID,
      apiKey: process.env.FIREBASE_API_KEY,
      email: process.env.BRIDGE_EMAIL,
      password: process.env.BRIDGE_PASSWORD,
    })
  : undefined;

let devices: DeviceConfig[] = [];
/** Last time a client asked for state — drives the polling rate. */
let lastClientAt = 0;
/** Guards against overlapping polls, which would compete for device sockets. */
let polling = false;
/**
 * Consecutive polls in which *every* device failed.
 *
 * Observed after ~2h uptime: every connect returned EHOSTUNREACH while a fresh
 * Node process on the same machine connected to the same devices instantly, and
 * netcat did too. Restarting the bridge cured it immediately. The cause is
 * something process-level rather than the network or our socket handling (fd
 * count was 25, nowhere near any limit), and it is not something this process
 * can reason its way out of.
 *
 * Since the whole point is to run unattended for months, a wedged process that
 * quietly reports every thermostat asleep is worse than one that exits and is
 * restarted. Total failure across several polls is treated as "we are broken"
 * rather than "the house vanished".
 */
let lastRelayFingerprint = '';
let lastRelayAt = 0;
let totalFailureStreak = 0;
const TOTAL_FAILURE_LIMIT = Number(process.env.TOTAL_FAILURE_LIMIT ?? 5);
let state: {
  devices: DeviceState[];
  inverter?: InverterReading;
  updatedAt: number;
} = { devices: [], updatedAt: 0 };
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
    if (!db) throw new Error('no Firestore credentials configured');
    const doc = await db.getDoc(CONFIG_DOC);
    const list = (doc?.devices ?? []) as DeviceConfig[];
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

/**
 * Mirror state to Firestore so the app can read it from outside the house.
 *
 * Change-driven and rate-limited, because this is the one part of the system
 * that costs money: LAN polling is free, Firestore writes are not. A quiet
 * house should produce almost no writes at all.
 */
async function publish() {
  if (!db) return;
  // The inverter belongs in the fingerprint, not just the payload: solar and
  // battery figures are the part of this that actually moves minute to minute,
  // and keying only on the thermostats meant a quiet house never republished,
  // leaving the relayed energy numbers frozen wherever they happened to be.
  //
  // That does make a write likely on every poll, since watts are never quite
  // still. It stays cheap because the poll rate is the real limit — 30s while
  // someone is watching, 300s otherwise — so this is a few hundred writes on a
  // normal day and a few thousand on a heavily watched one, against a free tier
  // of twenty thousand.
  const fingerprint = JSON.stringify({ devices: state.devices, inverter: state.inverter });
  if (fingerprint === lastRelayFingerprint) return;
  if (Date.now() - lastRelayAt < RELAY_MIN_INTERVAL_MS) return;
  try {
    await db.setDoc(STATE_DOC, {
      devices: state.devices,
      // Explicitly null rather than omitted: an absent field is left untouched
      // by the update mask, so a failed inverter read would otherwise leave the
      // last good figures on display as though they were current.
      inverter: state.inverter ?? null,
      updatedAt: new Date(),
    });
    lastRelayFingerprint = fingerprint;
    lastRelayAt = Date.now();
  } catch (err) {
    // Losing the relay must never affect LAN control, so this is only logged.
    console.warn('[relay] publish failed:', (err as Error).message);
  }
}

/**
 * Commands queued remotely. Executed exactly like a local POST, then deleted.
 *
 * Anything older than a couple of minutes is discarded rather than run: after a
 * restart or a network gap, replaying a stale queue could set the heating from
 * decisions someone made long ago.
 */
const COMMAND_TTL_MS = 2 * 60_000;

/** Requests older than this are discarded unanswered rather than executed. */
const ADMIN_TTL_MS = 5 * 60_000;
/** How long an answered request is left in place for the app to read. */
const ADMIN_KEEP_MS = 10 * 60_000;

async function pollCommands() {
  if (!db) return;
  try {
    const docs = await db.listDocs(COMMANDS);
    // Sequential on purpose: each command ends in a device write, and these
    // devices have very few connection slots.
    for (const doc of docs) {
      // A command that failed keeps its error for the app to display. Under a
      // listener that document was "added" once and never seen again; under
      // polling it comes back every cycle, so without this guard a broken
      // command would be retried against the hardware forever.
      if (doc.data.error) continue;
      await handleRelayCommand(doc.id, doc.data);
    }
  } catch (err) {
    console.warn('[relay] command poll failed:', (err as Error).message);
  }
}

/**
 * Administration requests, answered in place.
 *
 * The result is written back onto the same document rather than deleted, so the
 * app can show it. Whoever asked is responsible for clearing it up; anything
 * left behind is swept once it ages out, below.
 */
async function pollAdmin() {
  if (!db) return;
  try {
    const docs = await db.listDocs(ADMIN);
    for (const doc of docs) {
      // Already answered.
      if (doc.data.result !== undefined || doc.data.error !== undefined) {
        const done = doc.data.completedAt;
        if (done instanceof Date && Date.now() - done.getTime() > ADMIN_KEEP_MS) {
          await db.deleteDoc(`${ADMIN}/${doc.id}`).catch(() => {});
        }
        continue;
      }
      await handleAdmin(doc.id, doc.data);
    }
  } catch (err) {
    console.warn('[admin] poll failed:', (err as Error).message);
  }
}

async function handleAdmin(docId: string, data: Record<string, unknown>) {
  const path = `${ADMIN}/${docId}`;
  const action = data.action;
  const createdAt = data.createdAt;
  const age = createdAt instanceof Date ? Date.now() - createdAt.getTime() : 0;

  // A request that has been sitting around is not worth acting on — nobody is
  // still watching for the answer, and restarting the bridge because of
  // something asked for an hour ago would be surprising.
  if (age > ADMIN_TTL_MS) {
    console.warn(`[admin] dropping stale request (${Math.round(age / 1000)}s old)`);
    await db!.deleteDoc(path).catch(() => {});
    return;
  }

  if (!isAdminAction(action)) {
    await db!.setDoc(path, {
      error: `unknown action ${JSON.stringify(action)}`,
      completedAt: new Date(),
    }).catch(() => {});
    return;
  }

  console.log(`[admin] ${action}`);
  try {
    const lines = typeof data.lines === 'number' ? data.lines : undefined;
    const result = await runAdminAction(action, { lines }, {
      getState: () => state,
      refresh: () => poll(true),
      requestRestart: () => {
        // Answer first, then go. Exiting before the write lands would leave the
        // caller watching a request that is never answered.
        setTimeout(() => {
          console.log('[admin] exiting for restart');
          process.exit(0);
        }, 2000);
      },
    });
    await db!.setDoc(path, { result, completedAt: new Date() });
  } catch (err) {
    await db!.setDoc(path, {
      error: (err as Error).message,
      completedAt: new Date(),
    }).catch(() => {});
  }
}

async function commandLoop() {
  await pollCommands();
  await pollAdmin();
  setTimeout(() => void commandLoop(), COMMAND_POLL_MS);
}

async function handleRelayCommand(docId: string, data: Record<string, unknown>) {
  const path = `${COMMANDS}/${docId}`;
  const createdAt = data.createdAt;
  const age = createdAt instanceof Date ? Date.now() - createdAt.getTime() : 0;
  if (age > COMMAND_TTL_MS) {
    console.warn(`[relay] dropping stale command (${Math.round(age / 1000)}s old)`);
    await db!.deleteDoc(path).catch(() => {});
    return;
  }
  try {
    await runCommand(
      data.deviceId as string,
      (data.commands ?? []) as Array<{ code: string; value: unknown }>,
    );
    await db!.deleteDoc(path);
    await poll(true);
    await publish();
  } catch (err) {
    console.error('[relay] command failed:', (err as Error).message);
    await db!.setDoc(path, { error: (err as Error).message }).catch(() => {});
  }
}

/**
 * `force` bypasses backoff. Used when a client turns up after an idle period:
 * a person opening the app is a strong enough signal to be worth one immediate
 * attempt on everything, rather than making them wait out a 5-minute cool-off.
 */
async function poll(force = false) {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    const due = force
      ? devices
      : devices.filter(d => (backoff.get(d.id)?.nextAt ?? 0) <= now);
    const results = await readAll(due);
    for (const r of results) noteResult(r.id, r.online);

    if (results.length > 0) {
      totalFailureStreak = results.every(r => !r.online) ? totalFailureStreak + 1 : 0;
      if (totalFailureStreak >= TOTAL_FAILURE_LIMIT) {
        console.error(
          `[bridge] every device failed ${totalFailureStreak} polls running — exiting so a ` +
          'supervisor can restart. If this recurs without a network outage, suspect the ' +
          'process-level wedge described above.',
        );
        process.exit(1);
      }
    }
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

    // The inverter is mains-powered, on ethernet, and answers in milliseconds —
    // so unlike the sleepy valve heads it can simply be read every cycle.
    const inverter = await readInverter();

    const changed = JSON.stringify(next) !== JSON.stringify(state.devices);
    state = { devices: next, inverter, updatedAt: Date.now() };
    if (changed) {
      const online = next.filter(d => d.online).length;
      console.log(`[state] ${online}/${next.length} online (changed)`);
    }
    if (RELAY) void publish();
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
      const age = Date.now() - state.updatedAt;
      // Waking from a long idle also bypasses backoff; a routine refresh does
      // not, so genuinely dead devices keep their cool-off.
      if (age > ACTIVE_POLL_MS) void poll(age > ACTIVE_WINDOW_MS);
      return state;
    },
    sendCommand: runCommand,
    refresh: poll,
  });

  if (RELAY && db) {
    void commandLoop();
    console.log(
      `[relay] publishing state, polling for remote commands every ${COMMAND_POLL_MS / 1000}s`,
    );
  } else if (RELAY) {
    console.warn(
      '[relay] disabled — set FIREBASE_API_KEY, BRIDGE_EMAIL and BRIDGE_PASSWORD to reach the ' +
      'house from outside it. LAN control is unaffected.',
    );
  }

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
