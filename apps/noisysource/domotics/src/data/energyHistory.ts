import { collection, doc, documentId, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import {
  addDays, lisbonDate, parseEnergyDay, parseTariff, type EnergyDay, type Tariff,
} from '@shared/lib/energyBill';
import { db } from '../lib/firebase';
import { DEMO } from './demoData';

/**
 * The Energia page's data: the bridge's kWh history (`domotics_energy/{date}`,
 * one document per Lisbon day, see domotics-bridge/src/energy.ts) and the
 * tariff (`domotics_config/tariff`). Both owner-only, so this needs sign-in.
 *
 * Reads are what this page costs, so days are cached for the session: a past
 * day never changes once the bridge has written it, and going back and forth
 * between months re-reads nothing. Only today and yesterday (whose last slots
 * may still be on their way) are fetched again. A year is at most 366 small
 * documents, read once.
 */

const cache = new Map<string, EnergyDay>();
/** Days known to have no document (the bridge wasn't recording yet, or was down all day). */
const missing = new Set<string>();

/** A day is settled once its last slot can no longer arrive. */
const settled = (date: string, today: string) => date < addDays(today, -1);

export async function loadEnergyDays(from: string, to: string): Promise<EnergyDay[]> {
  const today = lisbonDate(Date.now());
  const last = to > today ? today : to;
  if (from > last) return [];
  if (DEMO) {
    const { demoEnergyDays } = await import('./energyDemo');
    return demoEnergyDays(from, last, Date.now());
  }
  // Fetch from the first day not already known for good.
  let start = from;
  while (start <= last && settled(start, today) && (cache.has(start) || missing.has(start))) start = addDays(start, 1);
  if (start <= last) {
    const snap = await getDocs(query(
      collection(db, 'domotics_energy'),
      where(documentId(), '>=', start),
      where(documentId(), '<=', last),
    ));
    const got = new Set<string>();
    for (const d of snap.docs) {
      cache.set(d.id, parseEnergyDay(d.id, d.data()));
      got.add(d.id);
    }
    for (let d = start; d <= last; d = addDays(d, 1)) {
      if (!got.has(d)) {
        cache.delete(d);
        if (settled(d, today)) missing.add(d);
      }
    }
  }
  const out: EnergyDay[] = [];
  for (let d = from; d <= last; d = addDays(d, 1)) {
    const day = cache.get(d);
    if (day) out.push(day);
  }
  return out;
}

const TARIFF = () => doc(db, 'domotics_config', 'tariff');

/** A missing document means the defaults, unconfirmed: every figure is then labelled an estimate. */
export async function loadTariff(): Promise<Tariff> {
  if (DEMO) return parseTariff({});
  const snap = await getDoc(TARIFF());
  return parseTariff(snap.exists() ? snap.data() : {});
}

/** Saving from the form is what confirms the prices. */
export async function saveTariff(t: Tariff): Promise<Tariff> {
  const next = parseTariff({ ...t, confirmed: true });
  if (!DEMO) await setDoc(TARIFF(), next);
  return next;
}
