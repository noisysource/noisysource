import { collection, doc, documentId, getDoc, getDocs, query, where } from 'firebase/firestore';
import { addDays, dayStart, lisbonDate } from '@shared/lib/energyBill';
import { db } from '../lib/firebase';
import { loadAutomationConfig } from './automation';
import { DEMO } from './demoData';
import { dateRuns, parseClimateDay, type ClimateDay, type HeatingRecord } from './heatingTimeline';
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
 *
 * The Energia page's week and month views only want the pump's hours, so
 * `loadClimateDays` reads just the climate documents. Those share one cache with
 * `loadHeatingDay`, so neither reads what the other already has, and they count
 * towards the same ceiling, one fetch per document.
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
/** Every climate document seen, however it was read; null: known not to exist. */
const climates = new Map<string, { day: ClimateDay | null; at: number }>();
const climateTried = new Map<string, number>();
const climateInFlight = new Map<string, Promise<void>>();
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
  // Read already, by the Energia page, and it won't change any more, or only just.
  await climateInFlight.get(date)?.catch(() => { /* then it's read below */ });
  const hit = climates.get(date);
  const known = hit && (settled(date, lisbonDate(now)) || now - hit.at < FORCED_GAP_MS) ? hit : undefined;
  const [snap, fresh, before] = await Promise.all([
    known ? Promise.resolve(null) : getDoc(doc(db, 'domotics_climate', date)),
    loadIncidentsBetween(prev ? resumeFrom(prev.incidents, from) : from, to),
    prev ? Promise.resolve(prev.before) : loadSwitchBefore(from).then(s => s ?? null),
  ]);
  const climate = known ? known.day : snap?.exists() ? parseClimateDay(date, snap.data()) : null;
  if (!known) climates.set(date, { day: climate, at: now });
  const byId = new Map((prev?.incidents ?? []).map(i => [i.id, i] as const));
  for (const i of fresh) byId.set(i.id, i);
  const record: HeatingRecord = {
    climate,
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

/** Whether `loadClimateDays` should go to Firestore for this day. */
function climateDue(date: string, today: string, now: number): boolean {
  const hit = climates.get(date);
  if (hit && (settled(date, today) || now - hit.at < REFRESH_MS)) return false;
  const tried = climateTried.get(date);
  return tried === undefined || now - tried >= (hit ? REFRESH_MS : RETRY_MS);
}

async function fetchClimateRun(run: string[], now: number): Promise<void> {
  fetches++;
  for (const d of run) climateTried.set(d, now);
  const snap = await getDocs(query(
    collection(db, 'domotics_climate'),
    where(documentId(), '>=', run[0]),
    where(documentId(), '<=', run[run.length - 1]),
  ));
  fetches += Math.max(0, snap.size - 1);
  const got = new Map(snap.docs.map(d => [d.id, d.data()] as const));
  for (const d of run) {
    const data = got.get(d);
    climates.set(d, { day: data ? parseClimateDay(d, data) : null, at: now });
  }
}

/**
 * The climate documents of [from, to], only reading the days not already known:
 * one query per unbroken run of them. A day missing from the result couldn't be
 * read; a day that is there as null has no document. Never throws: the callers
 * draw what they get.
 */
export async function loadClimateDays(from: string, to: string): Promise<Map<string, ClimateDay | null>> {
  const now = Date.now();
  const today = lisbonDate(now);
  const last = to > today ? today : to;
  const out = new Map<string, ClimateDay | null>();
  if (DEMO) {
    const { demoHeatingRecord } = await import('./heatingDemo');
    for (let d = from; d <= last; d = addDays(d, 1)) out.set(d, demoHeatingRecord(d, now).climate);
    return out;
  }
  const waits: Array<Promise<void>> = [];
  const wanted: string[] = [];
  for (let d = from; d <= last; d = addDays(d, 1)) {
    const running = climateInFlight.get(d);
    if (running) { if (!waits.includes(running)) waits.push(running); }
    else if (climateDue(d, today, now)) wanted.push(d);
  }
  for (const run of dateRuns(wanted)) {
    if (fetches >= MAX_FETCHES_PER_SESSION) break;
    const p = fetchClimateRun(run, now).finally(() => { for (const d of run) climateInFlight.delete(d); });
    for (const d of run) climateInFlight.set(d, p);
    waits.push(p);
  }
  await Promise.allSettled(waits);
  for (let d = from; d <= last; d = addDays(d, 1)) {
    const hit = climates.get(d);
    if (hit) out.set(d, hit.day);
  }
  return out;
}

let warmupMax: Promise<number | undefined> | null = null;

/** The warm-up cap from the settings (one read a session); undefined if they can't be read. */
export function loadWarmupMaxMin(): Promise<number | undefined> {
  if (DEMO) return Promise.resolve(30);
  warmupMax ??= loadAutomationConfig().then(c => c.warmupMaxMin).catch(() => undefined);
  return warmupMax;
}
