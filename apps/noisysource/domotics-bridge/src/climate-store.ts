import { readFileSync, writeFileSync } from 'node:fs';
import type { FirestoreRest } from './firestore-rest';
import { createClimateRecorder, INITIAL_CLIMATE, type ClimateReading, type ClimateSnapshot } from './climate';
import type { SwitchSource } from './incidents';

/**
 * The climate recorder (climate.ts) wired to the disk and to Firestore, the
 * same way as the energy store (energy-store.ts): state saved when something
 * is queued, at least every 5 minutes and on exit; waiting fields go out
 * together at most once an hour, one PATCH per day document with only those
 * fields; a failure backs off from 30 s to 30 min; a hard daily cap well above
 * normal use, so a fault here can never turn into a write loop.
 */

const COLLECTION = 'domotics_climate';
const SAVE_EVERY_MS = 5 * 60_000;
export const WRITE_EVERY_MS = 60 * 60_000;
/** ~24 a day in normal use; this is the ceiling, not a target. */
export const MAX_WRITES_PER_DAY = 300;

function load(path: string): ClimateSnapshot {
  try {
    return { ...INITIAL_CLIMATE, ...(JSON.parse(readFileSync(path, 'utf8')) as ClimateSnapshot) };
  } catch {
    return INITIAL_CLIMATE;
  }
}

type Db = Pick<FirestoreRest, 'setDoc'>;

export function createClimateStore(
  db: Db | undefined,
  statePath: string,
  { clock = Date.now, maxWritesPerDay = MAX_WRITES_PER_DAY, writeEveryMs = WRITE_EVERY_MS } = {},
) {
  const rec = createClimateRecorder(load(statePath));
  let savedAt = 0;
  let lastPending = rec.pendingCount();
  let failures = 0;
  let retryAt = 0;
  /** The first write after a start goes out straight away, then hourly. */
  let nextWriteAt = 0;
  let flushing = false;
  let capDay = '';
  let writesToday = 0;

  function save() {
    try {
      writeFileSync(statePath, JSON.stringify(rec.snapshot()));
      savedAt = clock();
    } catch (err) {
      console.warn('[climate] could not save state:', (err as Error).message);
    }
  }
  process.on('exit', save);

  async function flush() {
    if (!db || flushing || clock() < retryAt || clock() < nextWriteAt) return;
    const docs = rec.pendingWrites();
    if (docs.length === 0) return;
    const day = new Date(clock()).toISOString().slice(0, 10);
    if (day !== capDay) { capDay = day; writesToday = 0; }
    flushing = true;
    try {
      for (const { id, fields } of docs) {
        if (writesToday >= maxWritesPerDay) {
          console.warn(`[climate] ${maxWritesPerDay} writes today, holding the rest until tomorrow`);
          retryAt = clock() + 30 * 60_000;
          return;
        }
        writesToday++;
        await db.setDoc(`${COLLECTION}/${id}`, { ...fields, updatedAt: new Date() });
        rec.written(id, fields);
      }
      failures = 0;
      nextWriteAt = clock() + writeEveryMs;
    } catch (err) {
      failures++;
      const delay = Math.min(30 * 60_000, 30_000 * 2 ** (failures - 1));
      retryAt = clock() + delay;
      console.warn(`[climate] write failed, retrying in ${Math.round(delay / 1000)}s:`, (err as Error).message);
    } finally {
      flushing = false;
      save();
    }
  }

  return {
    /** Once per poll. */
    observe(r: ClimateReading) {
      const events = rec.observe(r);
      for (const e of events) {
        console.log(`[climate] ${e.kind === 'pump' ? `pump ${e.on ? 'on' : 'off'}` : `${e.zoneName} ${e.from} → ${e.to}`} by ${e.by} (${e.meaning}), rooms ${e.mean ?? '—'}°C`);
      }
      const pending = rec.pendingCount();
      if (pending !== lastPending || clock() - savedAt >= SAVE_EVERY_MS) save();
      lastPending = pending;
      return flush();
    },
    noteTarget: (zone: string, value: number, by: SwitchSource) => rec.noteTarget(zone, value, by, clock()),
  };
}
