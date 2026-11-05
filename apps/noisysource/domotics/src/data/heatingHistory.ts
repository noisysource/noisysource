import { doc, getDoc } from 'firebase/firestore';
import { addDays, dayStart, lisbonDate } from '@shared/lib/energyBill';
import { db } from '../lib/firebase';
import { loadAutomationConfig } from './automation';
import { DEMO } from './demoData';
import { parseClimateDay, type HeatingRecord } from './heatingTimeline';
import { loadIncidentsBetween, loadSwitchBefore, type Incident } from './incidents';

/**
 * A day's heating history: `domotics_climate/{date}` (one document), the
 * incidents of that day from `domotics_incidents`, and the last switch before
 * it. All owner-only, so this needs sign-in; on the LAN the card gets by without.
 *
 * Reads are what this costs, so days are cached for the session, like the
 * Energia page's (energyHistory.ts): a past day never changes once the bridge
 * has written it. Only today and yesterday (whose last slots may still be on
 * their way) are fetched again, at most every REFRESH_MS, or sooner when the
 * pump is seen to switch, and then only the incidents since the last one known.
 * Failures wait RETRY_MS, and MAX_FETCHES_PER_SESSION is the ceiling whatever
 * goes wrong: past it, the card shows what it already has.
 */

const MIN = 60_000;
const REFRESH_MS = 10 * MIN;
const RETRY_MS = 5 * MIN;
/** A forced refresh (the pump just switched) no closer than this to the last attempt. */
const FORCED_GAP_MS = MIN;
const MAX_FETCHES_PER_SESSION = 300;

const cache = new Map<string, { record: HeatingRecord; at: number }>();
const attempts = new Map<string, number>();
const inFlight = new Map<string, Promise<HeatingRecord>>();
let fetches = 0;

/** A day is settled once its last slot can no longer arrive. */
const settled = (date: string, today: string) => date < addDays(today, -1);

export const cachedHeatingDay = (date: string) => cache.get(date)?.record;

/** Whether `loadHeatingDay` would go to Firestore. */
export function heatingDayDue(date: string, now: number, force = false): boolean {
  if (DEMO) return true;
  const today = lisbonDate(now);
  if (date > today || inFlight.has(date) || fetches >= MAX_FETCHES_PER_SESSION) return false;
  const hit = cache.get(date);
  if (hit && settled(date, today)) return false;
  const tried = attempts.get(date);
  if (tried === undefined) return true;
  if (force) return now - tried >= FORCED_GAP_MS;
  return now - tried >= (hit ? REFRESH_MS : RETRY_MS);
}

/** From where to read a day's incidents again: the last one, or a fault still open (its end gets written onto it). */
function resumeFrom(incidents: Incident[], from: number): number {
  if (incidents.length === 0) return from;
  const open = incidents.filter(i => i.kind === 'fault' && i.status === 'active').map(i => i.at);
  return Math.min(Math.max(...incidents.map(i => i.at)), ...open);
}

async function fetchDay(date: string, now: number): Promise<HeatingRecord> {
  const from = dayStart(date);
  const to = dayStart(addDays(date, 1));
  const prev = cache.get(date)?.record;
  const [climate, fresh, before] = await Promise.all([
    getDoc(doc(db, 'domotics_climate', date)),
    loadIncidentsBetween(prev ? resumeFrom(prev.incidents, from) : from, to),
    prev ? Promise.resolve(prev.before) : loadSwitchBefore(from).then(s => s ?? null),
  ]);
  const byId = new Map((prev?.incidents ?? []).map(i => [i.id, i] as const));
  for (const i of fresh) byId.set(i.id, i);
  const record: HeatingRecord = {
    climate: climate.exists() ? parseClimateDay(date, climate.data()) : null,
    incidents: [...byId.values()].sort((a, b) => a.at - b.at),
    before,
  };
  cache.set(date, { record, at: now });
  return record;
}

/** The record for a day, from the cache if it's still good. Throws if it can't be read and nothing is cached. */
export async function loadHeatingDay(date: string, force = false): Promise<HeatingRecord | null> {
  const now = Date.now();
  if (DEMO) {
    const { demoHeatingRecord } = await import('./heatingDemo');
    return demoHeatingRecord(date, now);
  }
  const running = inFlight.get(date);
  if (running) return running;
  if (!heatingDayDue(date, now, force)) return cache.get(date)?.record ?? null;
  fetches++;
  attempts.set(date, now);
  const p = fetchDay(date, now).finally(() => inFlight.delete(date));
  inFlight.set(date, p);
  return p;
}

let warmupMax: Promise<number | undefined> | null = null;

/** The warm-up cap from the settings (one read a session); undefined if they can't be read. */
export function loadWarmupMaxMin(): Promise<number | undefined> {
  if (DEMO) return Promise.resolve(30);
  warmupMax ??= loadAutomationConfig().then(c => c.warmupMaxMin).catch(() => undefined);
  return warmupMax;
}
