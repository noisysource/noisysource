/**
 * Heat pump incidents, for the app's Reports page (`domotics_incidents`):
 * - a fault: when it started, the readings before and after, how it ended
 *   (cleared by itself, or locked out until someone reset it), and what was
 *   done to the pump meanwhile;
 * - an on/off transition, with who caused it where that is known.
 * Design: apps/noisysource/domotics/HANDOFF-reports-and-chat.md, section 1.
 *
 * Pure, like automation.ts: it is fed one pump reading per poll and hands back
 * documents to write; index.ts does the writing. The backfill script
 * (deploy/backfill-incidents.cjs) replays the hand-run logger's files through
 * this same code, so the history and the live incidents follow one set of rules.
 */

/** One pump reading. Temperatures in °C. Compact on purpose: dozens go into each document. */
export interface PumpSample {
  /** ms since the epoch */
  t: number;
  on: boolean;
  /** Compressor, Hz. */
  hz: number;
  /** Heating water setpoint. */
  sp?: number;
  /** Water out / in. */
  out?: number;
  inn?: number;
  /** C01 discharge. */
  dis?: number;
  outdoor?: number;
  /** C00 coil, C03 suction. */
  coil?: number;
  suct?: number;
  /** Active fault codes (E13, ...); empty when none. */
  faults: string[];
  /** The pump didn't report (all of) its fault bitmaps: `faults` empty means "none seen", not "none". Absent otherwise. */
  faultsUnknown?: true;
  /** Zone valves open, of `zones` reachable. */
  valves?: number;
  zones?: number;
}

/**
 * Who switched the pump. 'outside' = not this bridge: SmartLife, the panel, the
 * technicians, a timer. 'guard' = the E13 guard, removed 2026-11-22: the bridge
 * no longer produces it, but the incidents up to then have it (and the backfill
 * script writes it for the hand-run guard of 23–24/10).
 */
export type SwitchSource = 'app' | 'automation' | 'guard' | 'outside' | 'unknown';
/** 'log' = replayed from the hand-run logger; 'notes' = written down from STATUS.md, no readings. */
export type IncidentOrigin = 'bridge' | 'log' | 'notes';

export interface IncidentAction {
  at: number;
  by: SwitchSource;
  what: 'on' | 'off';
  reason: string | null;
}

export interface FaultIncident {
  kind: 'fault';
  device: string;
  deviceName: string;
  /** The first code seen; what the page groups by. */
  code: string;
  codes: string[];
  /** Start. */
  at: Date;
  /** 'unknown' = the record stops before the fault ended (no data). */
  status: 'active' | 'ended' | 'unknown';
  lockout: boolean;
  lockoutAt: Date | null;
  lockoutWhy: string | null;
  endedAt: Date | null;
  /** 'self' = cleared by itself; 'reset' = cleared after a lockout or a power cut. */
  endedHow: 'self' | 'reset' | 'unknown' | null;
  /** When the compressor ran again after the fault cleared. */
  restartedAt: Date | null;
  /** The pump stopped answering during the fault (a breaker cycle, or the network). */
  offlineDuring: boolean;
  previousId: string | null;
  minutesSincePrevious: number | null;
  before: PumpSample[];
  after: PumpSample[];
  /** On/off switches during the fault. */
  actions: IncidentAction[];
  note: string | null;
  origin: IncidentOrigin;
  updatedAt: Date;
}

export interface SwitchEvent {
  kind: 'switch';
  device: string;
  deviceName: string;
  at: Date;
  on: boolean;
  source: SwitchSource;
  reason: string | null;
  /** Faults active at the time. */
  faults: string[];
  /** The last few minutes, ending with the reading that showed the change. */
  before: PumpSample[];
  /**
   * Every raw datapoint (Tuya codes, values as read) in the reading before the
   * change and the one that showed it — so whatever else an off from outside
   * changes (mode, a setpoint, a fault bit) is on record. Bridge only.
   */
  dps?: { before: PumpDps; at: PumpDps };
  note: string | null;
  origin: IncidentOrigin;
  updatedAt: Date;
}

export type PumpDps = Record<string, string | number | boolean>;

export type Incident = FaultIncident | SwitchEvent;

export interface RecorderOptions {
  origin: IncidentOrigin;
  /** Readings kept from before a trip. */
  beforeMs?: number;
  /** Readings kept after it starts. */
  afterMs?: number;
  /** A single trip clears itself in ~1.5 min; one still on after this is a lockout. */
  lockoutAfterMs?: number;
  /** Two trips this close lock the pump out (seen at 14 and 16 min apart). */
  repeatMs?: number;
}

/** What survives a bridge restart. The reading buffer doesn't need to. */
export interface RecorderSnapshot {
  open: { id: string; doc: FaultIncident; afterDone: boolean } | null;
  /** Ended, waiting for the compressor to run again. */
  closing: { id: string; doc: FaultIncident } | null;
  lastTrip: { id: string; at: number } | null;
  lastOn: boolean | null;
}

const MIN = 60_000;
/** A switch this long after our command is taken to be that command. */
const COMMAND_MATCH_MS = 3 * MIN;
const SWITCH_BEFORE_MS = 5 * MIN;
/** Stop waiting for a restart after this. */
const RESTART_WAIT_MS = 60 * MIN;

/** Stable ids, so a retried write or a re-run backfill overwrites rather than duplicates. */
export function incidentId(kind: 'fault' | 'switch', t: number, suffix: string): string {
  return `${kind}-${new Date(t).toISOString().slice(0, 19).replace(/:/g, '-')}Z-${suffix}`;
}

export function createRecorder(
  write: (id: string, doc: Incident) => void,
  opts: RecorderOptions,
  initial?: RecorderSnapshot,
) {
  const beforeMs = opts.beforeMs ?? 30 * MIN;
  const afterMs = opts.afterMs ?? 5 * MIN;
  const lockoutAfterMs = opts.lockoutAfterMs ?? 10 * MIN;
  const repeatMs = opts.repeatMs ?? 20 * MIN;
  const buffer: PumpSample[] = [];
  let lastDps: PumpDps | undefined;
  const commands: Array<{ on: boolean; by: SwitchSource; reason: string | null; t: number }> = [];
  let s: RecorderSnapshot = initial ?? { open: null, closing: null, lastTrip: null, lastOn: null };

  /** The bridge's own switch command, if this transition is it. Used up once matched. */
  function matchCommand(on: boolean, t: number) {
    for (let i = commands.length - 1; i >= 0; i--) {
      const c = commands[i];
      if (c.on === on && c.t <= t && t - c.t <= COMMAND_MATCH_MS) {
        commands.splice(i, 1);
        return c;
      }
    }
    return undefined;
  }

  /** Returns who caused the on/off this reading shows, if it shows one. */
  function observe(device: { id: string; name: string }, sample: PumpSample, dps?: PumpDps): SwitchSource | undefined {
    const t = sample.t;
    let dirty = false;
    let switchedBy: SwitchSource | undefined;

    // --- On/off ------------------------------------------------------------
    if (s.lastOn !== null && sample.on !== s.lastOn) {
      const cmd = matchCommand(sample.on, t);
      const by: SwitchSource = cmd?.by ?? (opts.origin === 'bridge' ? 'outside' : 'unknown');
      const ev: SwitchEvent = {
        kind: 'switch',
        device: device.id,
        deviceName: device.name,
        at: new Date(t),
        on: sample.on,
        source: by,
        reason: cmd?.reason ?? null,
        faults: sample.faults,
        before: [...buffer.filter(x => x.t >= t - SWITCH_BEFORE_MS), sample],
        ...(dps && lastDps ? { dps: { before: lastDps, at: dps } } : {}),
        note: null,
        origin: opts.origin,
        updatedAt: new Date(),
      };
      write(incidentId('switch', t, sample.on ? 'on' : 'off'), ev);
      switchedBy = by;
      if (s.open) {
        s.open.doc.actions.push({ at: t, by, what: sample.on ? 'on' : 'off', reason: cmd?.reason ?? null });
        dirty = true;
      }
    }
    s.lastOn = sample.on;

    // --- Restart after a fault --------------------------------------------
    if (s.closing) {
      const c = s.closing;
      if (sample.hz > 0) {
        c.doc.restartedAt = new Date(t);
        c.doc.updatedAt = new Date();
        write(c.id, c.doc);
        s.closing = null;
      } else if (c.doc.endedAt && t - c.doc.endedAt.getTime() > RESTART_WAIT_MS) {
        s.closing = null;
      }
    }

    // --- Faults ------------------------------------------------------------
    const active = sample.faults;
    if (!s.open) {
      if (active.length > 0) {
        s.closing = null;
        const prev = s.lastTrip && t - s.lastTrip.at <= repeatMs ? s.lastTrip : null;
        const since = prev ? Math.round((t - prev.at) / MIN) : null;
        const id = incidentId('fault', t, active[0]);
        const doc: FaultIncident = {
          kind: 'fault',
          device: device.id,
          deviceName: device.name,
          code: active[0],
          codes: [...active],
          at: new Date(t),
          status: 'active',
          lockout: !!prev,
          lockoutAt: prev ? new Date(t) : null,
          lockoutWhy: prev ? `segundo disparo, ${since} min depois do anterior` : null,
          endedAt: null,
          endedHow: null,
          restartedAt: null,
          offlineDuring: false,
          previousId: prev?.id ?? null,
          minutesSincePrevious: since,
          before: buffer.filter(x => x.t >= t - beforeMs && x.t < t),
          after: [sample],
          actions: [],
          note: null,
          origin: opts.origin,
          updatedAt: new Date(),
        };
        s.open = { id, doc, afterDone: false };
        s.lastTrip = { id, at: t };
        write(id, doc);
      }
    } else {
      const o = s.open;
      const doc = o.doc;
      const start = doc.at.getTime();
      if (t - start <= afterMs) doc.after.push(sample);
      else if (!o.afterDone) { o.afterDone = true; dirty = true; }
      if (active.length > 0) {
        for (const c of active) if (!doc.codes.includes(c)) { doc.codes.push(c); dirty = true; }
        if (!doc.lockout && t - start >= lockoutAfterMs) {
          doc.lockout = true;
          doc.lockoutAt = new Date(t);
          doc.lockoutWhy = `avaria ainda ativa ao fim de ${Math.round(lockoutAfterMs / MIN)} min`;
          dirty = true;
        }
      } else if (sample.faultsUnknown) {
        // The pump stopped reporting its fault bitmaps mid-fault: that is not
        // the fault clearing. The record stops here, its end not known.
        doc.status = 'unknown';
        doc.endedHow = 'unknown';
        doc.note = 'A bomba deixou de reportar avarias durante esta: não se sabe quando acabou.';
        s.open = null;
        dirty = true;
      } else {
        doc.status = 'ended';
        doc.endedAt = new Date(t);
        doc.endedHow = doc.lockout || doc.offlineDuring ? 'reset' : 'self';
        if (sample.hz > 0) doc.restartedAt = new Date(t);
        else s.closing = { id: o.id, doc };
        s.open = null;
        dirty = true;
      }
      if (dirty) {
        doc.updatedAt = new Date();
        write(o.id, doc);
      }
    }

    buffer.push(sample);
    while (buffer.length > 0 && buffer[0].t < t - beforeMs) buffer.shift();
    if (dps) lastDps = dps;
    return switchedBy;
  }

  return {
    observe,
    /** No reading this poll. Written with the incident's next change. */
    gap() {
      if (s.open) s.open.doc.offlineDuring = true;
    },
    /** Called for every switch command the bridge sends to the pump, so the transition it causes is attributed. */
    noteCommand(on: boolean, by: SwitchSource, reason: string | null, t: number) {
      commands.push({ on, by, reason, t });
      while (commands.length > 10) commands.shift();
    },
    snapshot: (): RecorderSnapshot => s,
  };
}
