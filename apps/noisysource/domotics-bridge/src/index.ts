import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirestoreRest } from './firestore-rest';
import { isAdminAction, runAdminAction } from './admin';
import { readAll, sendCommands, type DeviceConfig, type DeviceState, type DpValue } from './tuya';
import { dpForCode } from './dpmap';
import { startHttp } from './http';
import { readInverter, type InverterReading } from './inverter';
import {
  createAutomation, parseConfig, pausedUntil,
  type AutomationConfig, type AutomationMemory, type AutomationStatus, type PumpReading, type ZoneReading,
} from './automation';
import { parseWarmBy, type WarmByRequest } from './warmby';
import { PUMP_FAULT_CODES, decodeFaults } from './faults';
import {
  createRecorder, type Incident, type PumpDps, type PumpSample, type RecorderSnapshot, type SwitchSource,
} from './incidents';
import {
  createGuard, parseGuardConfig, INITIAL_GUARD, type GuardConfig, type GuardState, type GuardStatus,
} from './guard';
import { createEnergyStore } from './energy-store';
import { createClimateStore } from './climate-store';
import { isControllerTimer } from './climate';

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
/**
 * The heat pump alone is read at this rate even while nobody is watching: an
 * incident needs the minutes before a trip, and the E13 guard has to catch the
 * compressor idling at the setpoint within a reading or two. It is one
 * mains-powered module, and the hand-run guard kept the whole bridge at the
 * active rate from 2026-10-23 without trouble. The thermostats keep their
 * idle rate.
 */
const PUMP_POLL_MS = Number(process.env.PUMP_POLL_MS ?? 30_000);
/** The heat pump's Tuya category (see dpmap.ts). */
const PUMP_CATEGORY = 'znrb';
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
/** Heating automation settings, edited in the app (see automation.ts). */
const AUTOMATION_DOC = 'domotics_config/automation';
/** Settings change rarely; re-reading every couple of minutes is plenty and costs ~700 reads a day. */
const AUTOMATION_SETTINGS_EVERY_MS = 2 * 60_000;
/**
 * The one-off "warm by HH:MM" request (warmby.ts), written by the
 * `domoticsWarmBy` callable. Read with the settings: another ~700 reads a day.
 */
const WARM_BY_DOC = 'domotics_config/warm_by';
const COMMANDS = 'domotics_commands';
/** E13 guard on/off and its early warning (`preempt`), set in the app (see guard.ts). Read on the automation's cadence. */
const GUARD_DOC = 'domotics_config/guard';
/** Heat pump faults and on/off transitions (see incidents.ts), for the Reports page. */
const INCIDENTS = 'domotics_incidents';
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

/** kWh history (energy.ts, energy-store.ts). Written only with the relay on, like everything else. */
const energy = createEnergyStore(RELAY ? db : undefined, join(__dirname, '..', 'energy-state.json'));
/** Room and pump temperatures per 15-min slot, and people's interventions (climate.ts). Like the energy history. */
const climate = createClimateStore(RELAY ? db : undefined, join(__dirname, '..', 'climate-state.json'));

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
  /** What the heating automation decided last, and why — shown in the app. */
  automation?: AutomationStatus;
  /** What the E13 guard is doing — shown in the app. */
  guard?: GuardStatus;
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

/** Dates go to disk as ISO strings; these files hold no other strings shaped like one. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'), (_k, v) =>
      typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v) as T;
  } catch {
    return undefined;
  }
}
function writeJson(path: string, value: unknown) {
  try {
    writeFileSync(path, JSON.stringify(value));
  } catch (err) {
    console.warn(`[bridge] could not write ${path}:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Heating automation
// ---------------------------------------------------------------------------

const AUTOMATION_CACHE = join(__dirname, '..', 'automation-config.json');
const WARM_BY_CACHE = join(__dirname, '..', 'warm-by.json');
/** The warm-up model it has learned and the last water setpoint it sent. */
const AUTOMATION_MEMORY_FILE = join(__dirname, '..', 'automation-state.json');

/**
 * The settings, like the device list, are Firestore-first and cached on disk:
 * a cloud outage must not change how the house is heated, and a bridge
 * restarted without network carries on with the last settings it knew.
 */
let automationConfig: AutomationConfig = (() => {
  try {
    return parseConfig(JSON.parse(readFileSync(AUTOMATION_CACHE, 'utf8')));
  } catch {
    return parseConfig({});
  }
})();
let automationSettingsAt = 0;
/** Cached like the settings, so a restart without network still knows the request. */
let warmBy: WarmByRequest | null = parseWarmBy(readJson(WARM_BY_CACHE));

async function refreshAutomationSettings() {
  if (!db || Date.now() - automationSettingsAt < AUTOMATION_SETTINGS_EVERY_MS) return;
  automationSettingsAt = Date.now();
  try {
    // A missing document means no request. Read on its own, so a refusal
    // (rules not deployed yet) can't hold up the settings below.
    const next = parseWarmBy(await db.getDoc(WARM_BY_DOC));
    if (JSON.stringify(next) !== JSON.stringify(warmBy)) {
      console.log(`[automation] warm by: ${next ? `${new Date(next.at).toISOString()}${next.target !== null ? ` at ${next.target}°C` : ''}` : 'none'}`);
      warmBy = next;
      writeJson(WARM_BY_CACHE, next);
    }
  } catch (err) {
    console.warn('[automation] could not read the warm-by request, keeping the last one:', (err as Error).message);
  }
  try {
    // A missing document means defaults — which is automation off.
    const next = parseConfig((await db.getDoc(AUTOMATION_DOC)) ?? {});
    if (JSON.stringify(next) !== JSON.stringify(automationConfig)) {
      const pause = pausedUntil(next, Date.now());
      console.log(`[automation] settings changed: ${next.enabled ? (next.dryRun ? 'dry-run' : 'ON') : 'off'}` +
        `${pause ? `, paused until ${new Date(pause).toISOString()}` : ''}`);
      automationConfig = next;
      writeFileSync(AUTOMATION_CACHE, JSON.stringify(next, null, 2));
    }
  } catch (err) {
    console.warn('[automation] could not read settings, keeping the last ones:', (err as Error).message);
  }
}

const tenths = (v: unknown) => (typeof v === 'number' ? v / 10 : undefined);

const automate = createAutomation(async (deviceId, commands, reason, why) => {
  await runCommand(deviceId, commands, 'automation', reason ?? null, why);
}, readJson<AutomationMemory>(AUTOMATION_MEMORY_FILE));
let automating = false;
let savedMemory = JSON.stringify(automate.memory());

/** The thermostats and the pump, as the automation and the climate history read them. */
function heatingReadings() {
  const zones: ZoneReading[] = [];
  let pump: PumpReading | undefined;
  for (const d of state.devices) {
    const s = new Map(d.status.map(x => [x.code, x.value]));
    if (s.has('p02_heating')) {
      pump = {
        id: d.id,
        online: d.online,
        on: s.get('switch') === true,
        fault: PUMP_FAULT_CODES.some(c => Number(s.get(c) ?? 0) !== 0),
        // The pump's own outdoor sensor (`temp_top` — see README, "Heat pump").
        outdoor: tenths(s.get('temp_top')),
        flowSetpoint: typeof s.get('p02_heating') === 'number' ? (s.get('p02_heating') as number) : undefined,
        // Same datapoints as the incident samples (watchPump).
        hz: typeof s.get('temp_current') === 'number' ? (s.get('temp_current') as number) : undefined,
        waterOut: tenths(s.get('venting_temp')),
        waterIn: tenths(s.get('coiler_temp')),
      };
    } else if (s.has('temp_set')) {
      zones.push({
        id: d.id,
        name: d.name,
        online: d.online,
        current: tenths(s.get('temp_current')),
        target: tenths(s.get('temp_set')),
        mode: typeof s.get('mode') === 'string' ? (s.get('mode') as string) : undefined,
        valveOpen: s.get('valve_state') === 'open',
      });
    }
  }
  return { zones, pump };
}

/**
 * One automation step on the freshest state. Runs after every poll.
 * `switchedBy`: who switched the pump, if this poll saw it switch.
 */
async function runAutomation(switchedBy?: SwitchSource) {
  if (automating) return;
  automating = true;
  try {
    await refreshAutomationSettings();
    const { zones, pump } = heatingReadings();
    const now = Date.now();
    // A person's on or off is respected for a while (automation.ts); the
    // controller's nightly timer is not a person.
    const person = (switchedBy === 'app' || switchedBy === 'outside') && pump?.online
      && !(switchedBy === 'outside' && !pump.on && isControllerTimer(now));
    const inv = state.inverter;
    const status = await automate(automationConfig, {
      now: new Date(now),
      zones,
      pump,
      manualSwitch: person ? { on: pump!.on, at: now } : null,
      // Signs as the inverter gives them (inverter.ts, checked against the power
      // balance on 26/10): grid > 0 export / < 0 import, battery > 0 charging,
      // consumption = the whole house, the heat pump included.
      energy: inv?.online
        ? { pvW: inv.pvPowerW, loadW: inv.consumptionW, gridW: inv.gridPowerW, batteryW: inv.batteryPowerW, soc: inv.soc }
        : undefined,
      guard: state.guard,
      warmBy,
    });
    state = { ...state, automation: status };
    const memory = JSON.stringify(automate.memory());
    if (memory !== savedMemory) {
      writeJson(AUTOMATION_MEMORY_FILE, automate.memory());
      savedMemory = memory;
    }
  } catch (err) {
    console.error('[automation] step failed:', (err as Error).message);
  } finally {
    automating = false;
  }
}

// ---------------------------------------------------------------------------
// Heat pump incidents and the E13 guard
// ---------------------------------------------------------------------------

const GUARD_CONFIG_CACHE = join(__dirname, '..', 'guard-config.json');
const GUARD_STATE_FILE = join(__dirname, '..', 'guard-state.json');
const INCIDENTS_STATE_FILE = join(__dirname, '..', 'incidents-state.json');
const INCIDENTS_PENDING_FILE = join(__dirname, '..', 'incidents-pending.json');

/** Like the automation settings: Firestore-first, cached, and a cloud outage keeps the last ones. */
let guardConfig: GuardConfig = parseGuardConfig(readJson(GUARD_CONFIG_CACHE) ?? {});
let guardSettingsAt = 0;

async function refreshGuardSettings() {
  if (!db || Date.now() - guardSettingsAt < AUTOMATION_SETTINGS_EVERY_MS) return;
  guardSettingsAt = Date.now();
  try {
    // A missing document means off (and the early warning, once on, defaults to on).
    const next = parseGuardConfig((await db.getDoc(GUARD_DOC)) ?? {});
    if (next.enabled !== guardConfig.enabled || next.preempt !== guardConfig.preempt) {
      if (next.enabled !== guardConfig.enabled) console.log(`[guard] switched ${next.enabled ? 'on' : 'off'} in the app`);
      if (next.preempt !== guardConfig.preempt) console.log(`[guard] E13 early warning switched ${next.preempt ? 'on' : 'off'} in the app`);
      guardConfig = next;
      writeJson(GUARD_CONFIG_CACHE, next);
    }
  } catch (err) {
    console.warn('[guard] could not read settings, keeping the last ones:', (err as Error).message);
  }
}

/** Saved so a rest in progress survives a restart and still ends with the pump back on. */
const guard = createGuard({ ...INITIAL_GUARD, ...readJson<GuardState>(GUARD_STATE_FILE) });

/**
 * Incident documents waiting to be written, by id. Kept on disk too: a trip
 * during a network gap (or before the rules allow the write) must still reach
 * the Reports page. A later version of a document replaces the queued one.
 */
const pendingIncidents = new Map<string, Incident>(
  Object.entries(readJson<Record<string, Incident>>(INCIDENTS_PENDING_FILE) ?? {}),
);
const PENDING_MAX = 200;
let incidentFailures = 0;
let incidentRetryAt = 0;
let flushingIncidents = false;
let recorded = false;

const recorder = createRecorder((id, doc) => {
  // A copy: the recorder keeps changing its open incident.
  pendingIncidents.delete(id);
  pendingIncidents.set(id, structuredClone(doc));
  while (pendingIncidents.size > PENDING_MAX) pendingIncidents.delete(pendingIncidents.keys().next().value!);
  writeJson(INCIDENTS_PENDING_FILE, Object.fromEntries(pendingIncidents));
  recorded = true;
  console.log(`[incident] ${id}`);
}, { origin: 'bridge' }, readJson<RecorderSnapshot>(INCIDENTS_STATE_FILE));

/**
 * A few writes per incident, so the free tier never notices. Failures back off
 * up to half an hour: a 403 here means the rules don't allow it yet, and
 * retrying that every poll would only fill the log.
 */
async function flushIncidents() {
  if (!db || flushingIncidents || pendingIncidents.size === 0 || Date.now() < incidentRetryAt) return;
  flushingIncidents = true;
  try {
    for (const [id, doc] of [...pendingIncidents]) {
      await db.setDoc(`${INCIDENTS}/${id}`, doc as unknown as Record<string, unknown>);
      // A newer version may have been queued while this one was in flight.
      if (pendingIncidents.get(id) === doc) pendingIncidents.delete(id);
    }
    incidentFailures = 0;
  } catch (err) {
    incidentFailures++;
    const delay = Math.min(30 * 60_000, 30_000 * 2 ** (incidentFailures - 1));
    incidentRetryAt = Date.now() + delay;
    console.warn(`[incident] write failed, retrying in ${Math.round(delay / 1000)}s:`, (err as Error).message);
  } finally {
    writeJson(INCIDENTS_PENDING_FILE, Object.fromEntries(pendingIncidents));
    flushingIncidents = false;
  }
}

/** After every poll: record the pump's reading, then let the guard act on it. Returns who switched the pump, if this reading shows it switched. */
async function watchPump(pumpFresh: boolean): Promise<SwitchSource | undefined> {
  const pump = state.devices.find(d => d.category === PUMP_CATEGORY);
  if (!pump) return undefined;
  const now = Date.now();
  let sample: PumpSample | undefined;
  let switchedBy: SwitchSource | undefined;
  if (pumpFresh && pump.online) {
    const s = new Map(pump.status.map(x => [x.code, x.value]));
    const whole = (code: string) => (typeof s.get(code) === 'number' ? (s.get(code) as number) : undefined);
    const zones = state.devices.filter(d => d.category === 'wk' && d.online);
    sample = {
      t: now,
      on: s.get('switch') === true,
      hz: whole('temp_current') ?? 0,
      sp: whole('p02_heating'),
      out: tenths(s.get('venting_temp')),
      inn: tenths(s.get('coiler_temp')),
      dis: tenths(s.get('compressor_strength')),
      outdoor: tenths(s.get('temp_top')),
      coil: tenths(s.get('power_consumption')),
      suct: tenths(s.get('temp_bottom')),
      faults: decodeFaults(code => s.get(code)),
      valves: zones.filter(z => z.status.some(x => x.code === 'valve_state' && x.value === 'open')).length,
      zones: zones.length,
    };
    recorded = false;
    const dps: PumpDps = {};
    for (const { code, value } of pump.status) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') dps[code] = value;
    }
    switchedBy = recorder.observe({ id: pump.id, name: pump.name }, sample, dps);
    if (recorded) writeJson(INCIDENTS_STATE_FILE, recorder.snapshot());
  } else {
    recorder.gap();
  }

  await refreshGuardSettings();
  const before = JSON.stringify(guard.state());
  const offUntilBefore = guard.state().preemptOffUntil;
  // The automation's last step, if it is running live and recent: it decides
  // on/off (so the guard doesn't undo an outside off), and while its plan has
  // the pump off a rest carries on. A stale step (failing) hands both back to the guard.
  const a = state.automation;
  const automationOwns = automationConfig.enabled && !automationConfig.dryRun
    && a?.state === 'running' && now - a.evaluatedAt < 5 * 60_000;
  const holdRest = automationOwns && a?.holdRest === true;
  // A person's pause ("Pausar"): read straight from the settings, so it holds
  // whatever the automation is set to.
  const paused = pausedUntil(automationConfig, now);
  const d = guard.decide(guardConfig, { now, pump: sample, holdRest, switchedBy, pausedUntil: paused, automationOwns });
  let status = d.status;
  if (d.action) {
    const { on, reason, next } = d.action;
    try {
      await runCommand(pump.id, [{ code: 'switch', value: on }], 'guard', reason);
      guard.commit(next);
      console.log(`[guard] pump ${on ? 'ON' : 'OFF'}: ${reason}`);
    } catch (err) {
      console.warn(`[guard] could not switch the pump ${on ? 'on' : 'off'}, trying again next poll:`, (err as Error).message);
      status = { ...status, mode: guard.state().mode, restUntil: null, note: 'O comando à bomba falhou — volta a tentar na próxima leitura' };
    }
  }
  if (guard.state().preemptOffUntil && !offUntilBefore) {
    console.log(`[guard] two E13 trips with the early warning on: early warning off until ${new Date(guard.state().preemptOffUntil).toISOString()}`);
  }
  if (JSON.stringify(guard.state()) !== before) writeJson(GUARD_STATE_FILE, guard.state());
  state = { ...state, guard: status };
  return switchedBy;
}

/** What makes a publish worth sending straight away, even when nobody is watching. */
function pumpHeadline() {
  const pump = state.devices.find(d => d.category === PUMP_CATEGORY);
  const s = new Map((pump?.status ?? []).map(x => [x.code, x.value]));
  return JSON.stringify([s.get('switch'), ...PUMP_FAULT_CODES.map(c => s.get(c)), state.guard?.mode]);
}
let lastHeadline = '';

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
  // The automation's evaluation time changes every step; what it decided does not.
  const { evaluatedAt: _evaluatedAt, ...automation } = state.automation ?? ({} as Partial<AutomationStatus>);
  const { evaluatedAt: _guardAt, ...guardStatus } = state.guard ?? ({} as Partial<GuardStatus>);
  const fingerprint = JSON.stringify({ devices: state.devices, inverter: state.inverter, automation, guard: guardStatus });
  if (fingerprint === lastRelayFingerprint) return;
  // The pump is read every 30s even when nobody is looking (PUMP_POLL_MS), and
  // its readings always move. Unwatched, that would mean a write every poll
  // for nobody, so the idle rate applies, unless the pump switched, faulted
  // or the guard changed what it is doing.
  const headline = pumpHeadline();
  const minGap = isWatched() || headline !== lastHeadline ? RELAY_MIN_INTERVAL_MS : IDLE_POLL_MS;
  if (Date.now() - lastRelayAt < minGap) return;
  try {
    await db.setDoc(STATE_DOC, {
      devices: state.devices,
      // Explicitly null rather than omitted: an absent field is left untouched
      // by the update mask, so a failed inverter read would otherwise leave the
      // last good figures on display as though they were current.
      inverter: state.inverter ?? null,
      automation: state.automation ?? null,
      guard: state.guard ?? null,
      // Tells the app this bridge understands `{watch: true}` relay messages.
      // An older bridge treats one as a failed command, so the app only sends
      // them when it sees this.
      watchable: true,
      updatedAt: new Date(),
    });
    lastRelayFingerprint = fingerprint;
    lastHeadline = headline;
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
/**
 * How long a failed command keeps its error for the app before being deleted.
 * Without a limit they were never deleted at all, and every one is re-read on
 * every 10s poll — a slow but unbounded climb in Firestore reads.
 */
const FAILED_KEEP_MS = 10 * 60_000;

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
      if (doc.data.error) {
        const createdAt = doc.data.createdAt;
        if (createdAt instanceof Date && Date.now() - createdAt.getTime() > FAILED_KEEP_MS) {
          await db.deleteDoc(`${COMMANDS}/${doc.id}`).catch(() => {});
        }
        continue;
      }
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
  // Not a command: an app away from home saying it's open. Only LAN requests
  // reach getState, so without this a phone outside the house never counts as
  // watching and its climate readings lag by the idle interval (5 min). Treated
  // exactly like a LAN /state request.
  if (data.watch === true) {
    await db!.deleteDoc(path).catch(() => {});
    lastClientAt = Date.now();
    const stale = Date.now() - state.updatedAt;
    if (stale > ACTIVE_POLL_MS) {
      await poll(stale > ACTIVE_WINDOW_MS);
      await publish();
    }
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
let lastFullPollAt = 0;

async function poll(force = false) {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    // Between full polls, only the pump is read (see PUMP_POLL_MS).
    const full = force || isWatched() || now - lastFullPollAt >= IDLE_POLL_MS - 1000;
    const wanted = full ? devices : devices.filter(d => d.category === PUMP_CATEGORY);
    const due = force
      ? wanted
      : wanted.filter(d => (backoff.get(d.id)?.nextAt ?? 0) <= now);
    const results = await readAll(due);
    if (full) lastFullPollAt = now;
    for (const r of results) noteResult(r.id, r.online);

    // Only full polls count: the pump alone being unreachable (a breaker
    // reset) is not the process-level wedge this watches for.
    if (full && results.length > 0) {
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
      // Not asked this time (a pump-only poll): left exactly as it was.
      if (!full && !wanted.includes(cfg) && prev) return prev;
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
    // kWh history for the Energia page (energy.ts): one write per 15-min slot.
    void energy.observe(inverter);

    const changed = JSON.stringify(next) !== JSON.stringify(state.devices);
    state = { ...state, devices: next, inverter, updatedAt: Date.now() };
    if (changed) {
      const online = next.filter(d => d.online).length;
      console.log(`[state] ${online}/${next.length} online (changed)`);
    }
    // Record and guard the pump, decide on what was just read, then publish it all together.
    const switchedBy = await watchPump(results.some(r => r.category === PUMP_CATEGORY && r.online));
    await runAutomation(switchedBy);
    const { zones, pump } = heatingReadings();
    const a = state.automation;
    void climate.observe({
      t: Date.now(),
      zones,
      pump,
      soc: inverter.online ? inverter.soc : undefined,
      plan: !a ? undefined : a.state === 'off' ? 'off' : `${a.mode ?? '?'}${a.state === 'dry-run' ? ' (sim)' : ''}`,
      wantOn: a?.wantOn,
      guard: state.guard?.mode,
      switchedBy,
    });
    if (RELAY) {
      void publish();
      void flushIncidents();
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
  /** Who asked: the app (LAN or relay), the automation or the guard. Recorded with the switch it causes. */
  source: SwitchSource = 'app',
  reason: string | null = null,
  /** The automation's reason alone, for the switch incident. */
  why?: string,
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
  console.log(`[command] ${config.name} <- ${JSON.stringify(dps)}${source === 'app' ? '' : ` (${source})`}`);
  const sw = dps[dpForCode(config.category, 'switch') ?? ''];
  if (config.category === PUMP_CATEGORY && typeof sw === 'boolean') {
    recorder.noteCommand(sw, source, reason, Date.now(), why);
  }
  // A thermostat target, so the climate history can tell the bridge's own changes from a person's.
  const target = dps[dpForCode(config.category, 'temp_set') ?? ''];
  if (typeof target === 'number') climate.noteTarget(deviceId, target / 10, source);
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
  const pumpDue = devices.some(d => d.category === PUMP_CATEGORY) ? PUMP_POLL_MS : IDLE_POLL_MS;
  setTimeout(() => void loop(), isWatched() ? ACTIVE_POLL_MS : Math.min(pumpDue, IDLE_POLL_MS));
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
