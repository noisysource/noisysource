import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FirestoreRest } from './firestore-rest';
import { lastCounterCandidates, type InverterReading } from './inverter';
import { createEnergyRecorder, INITIAL_ENERGY, SLOT_MS, dayStart, slotField, type EnergySnapshot } from './energy';

/**
 * The energy recorder (energy.ts) wired to the disk and to Firestore. Kept out
 * of index.ts so the bridge's main loop gains one call, not a subsystem.
 *
 * - State (the open slot, the last reading, unconfirmed writes) is saved when a
 *   slot closes, at least every 5 minutes, and on exit: a restart costs at most
 *   the minutes since the last save, and those show as a gap.
 * - Writes: one PATCH per closed slot (~96 a day), only that slot's fields. A
 *   failure backs off from 30 s to 30 min, and there is a hard daily cap well
 *   above normal use, so a fault here can never turn into a write loop.
 */

const COLLECTION = 'domotics_energy';
const SAVE_EVERY_MS = 5 * 60_000;
/** ~100 a day in normal use; this is the ceiling, not a target. */
export const MAX_WRITES_PER_DAY = 300;
/**
 * The counter-candidate log (inverter.ts, COUNTER_CANDIDATES) stops growing
 * past this: ~150 bytes a slot, so about a year. It is there to be compared
 * once with the integrated slots, then removed.
 */
const COUNTER_LOG_MAX_BYTES = 5_000_000;

function load(path: string): EnergySnapshot {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as EnergySnapshot;
    return { ...INITIAL_ENERGY, ...s, closedUntil: s.closedUntil ?? 0, pending: s.pending ?? {} };
  } catch {
    return INITIAL_ENERGY;
  }
}

/** Only `setDoc` is used; a fake stands in for it in the tests. */
type Db = Pick<FirestoreRest, 'setDoc'>;

export function createEnergyStore(
  db: Db | undefined,
  statePath: string,
  /** For the tests: their clock, and a cap small enough to reach. */
  {
    clock = Date.now,
    maxWritesPerDay = MAX_WRITES_PER_DAY,
    counterLog = join(dirname(statePath), 'energy-registers.jsonl'),
    counters = lastCounterCandidates,
  }: {
    clock?: () => number;
    maxWritesPerDay?: number;
    counterLog?: string;
    counters?: typeof lastCounterCandidates;
  } = {},
) {
  const rec = createEnergyRecorder(load(statePath));
  let savedAt = 0;
  let lastPending = rec.pendingCount();
  let failures = 0;
  let retryAt = 0;
  let flushing = false;
  let capDay = '';
  let writesToday = 0;

  function save() {
    try {
      writeFileSync(statePath, JSON.stringify(rec.snapshot()));
      savedAt = clock();
    } catch (err) {
      console.warn('[energy] could not save state:', (err as Error).message);
    }
  }
  // Synchronous, so it runs on process.exit() too (the wedge exit, an admin restart).
  process.on('exit', save);

  /** One line per closed slot: what was integrated, and the counter candidates at that moment. */
  let logged: unknown = null;
  function logCounters() {
    const closed = rec.lastClosed();
    const c = counters();
    if (!closed || closed === logged || !c) return;
    logged = closed;
    try {
      let size = 0;
      try { size = statSync(counterLog).size; } catch { /* not there yet */ }
      if (size > COUNTER_LOG_MAX_BYTES) return;
      const end = dayStart(closed.date) + (closed.index + 1) * SLOT_MS;
      appendFileSync(counterLog, JSON.stringify({
        slot: `${closed.date}/${slotField(closed.index)}`,
        end: new Date(end).toISOString(),
        wh: closed.slot,
        regAt: new Date(c.t).toISOString(),
        reg: c.values,
      }) + '\n');
    } catch (err) {
      console.warn('[energy] could not log the counters:', (err as Error).message);
    }
  }

  async function flush() {
    if (!db || flushing || clock() < retryAt) return;
    const docs = rec.pendingWrites();
    if (docs.length === 0) return;
    const day = new Date(clock()).toISOString().slice(0, 10);
    if (day !== capDay) {
      capDay = day;
      writesToday = 0;
    }
    flushing = true;
    try {
      for (const { id, fields } of docs) {
        if (writesToday >= maxWritesPerDay) {
          // Logged at most every 30 min: that is when the next attempt is.
          console.warn(`[energy] ${maxWritesPerDay} writes today, holding the rest until tomorrow`);
          retryAt = clock() + 30 * 60_000;
          return;
        }
        writesToday++;
        await db.setDoc(`${COLLECTION}/${id}`, { ...fields, updatedAt: new Date() });
        rec.written(id, fields);
      }
      failures = 0;
    } catch (err) {
      failures++;
      const delay = Math.min(30 * 60_000, 30_000 * 2 ** (failures - 1));
      retryAt = clock() + delay;
      console.warn(`[energy] write failed, retrying in ${Math.round(delay / 1000)}s:`, (err as Error).message);
    } finally {
      flushing = false;
      save();
    }
  }

  return {
    /** Once per poll, with whatever the inverter read gave (online or not). */
    observe(inv: InverterReading) {
      const now = clock();
      const ok = inv.online && inv.pvPowerW !== undefined && inv.gridPowerW !== undefined && inv.batteryPowerW !== undefined;
      rec.observe(ok ? {
        t: inv.readAt,
        pvW: inv.pvPowerW!,
        gridW: inv.gridPowerW!,
        batteryW: inv.batteryPowerW!,
        soc: inv.soc,
      } : undefined, now);
      const pending = rec.pendingCount();
      if (pending !== lastPending || now - savedAt >= SAVE_EVERY_MS) save();
      lastPending = pending;
      logCounters();
      return flush();
    },
  };
}
