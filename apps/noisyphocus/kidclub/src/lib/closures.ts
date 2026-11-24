// Club-wide closures: date ranges in which KidClub is closed for everyone
// (Renato, 2026-11-24). The rules live on the server, in
// functions/src/kidclub/closureLogic.ts and closures.ts; this is the client's
// view of them.
//
// The list is config/closures.closures (readable by any signed-in user, written
// only through the setClubClosures callable, which also applies it to every
// family's days and recomputes their open bills). A closed day is a reservation
// event with status CANCELLED, changedByRole "system" and reason REASON_CLOSED:
// it is credited in full on the bill and nobody can change it.

import { getDoc } from 'firebase/firestore';
import { docRef } from './db';
import { callable } from './callable';

/** Must stay equal to REASON_CLOSED in functions/src/kidclub/closureLogic.ts. */
export const REASON_CLOSED = 'club closed';

export interface Closure {
  id: string;
  /** First closed day, yyyy-mm-dd, inclusive. */
  from: string;
  /** Last closed day, yyyy-mm-dd, inclusive. */
  to: string;
  label: string;
}

export interface ClosureSaveResult {
  closures: Closure[];
  /** Days (study) and trips (transport) turned into closure days by this save. */
  closed: number;
  /** Closure days put back because a closure was removed or shortened. */
  reopened: number;
  /** Families whose bills were recomputed. */
  families: number;
  /** Families whose bills could not be recomputed (their days are right; use "Recalcular" in Faturação). */
  failedFamilies: string[];
}

/** Is this reservation event a day the club is closed? */
export function isClubClosedEvent(e: { status?: string; changedByRole?: string; reason?: string } | undefined | null): boolean {
  return e?.status === 'CANCELLED' && e?.changedByRole === 'system' && e?.reason === REASON_CLOSED;
}

export function closureFor(dateIso: string, closures: Closure[]): Closure | undefined {
  return closures.find(c => dateIso >= c.from && dateIso <= c.to);
}

export const closuresService = {
  async get(): Promise<Closure[]> {
    const snap = await getDoc(docRef('config', 'closures'));
    const raw = snap.exists() ? (snap.data() as { closures?: unknown }).closures : [];
    return Array.isArray(raw)
      ? (raw as Closure[]).filter(c => typeof c?.from === 'string' && typeof c?.to === 'string')
      : [];
  },
  /** Replaces the whole list and applies it. Can take a minute: it touches every family. */
  async save(closures: Closure[]): Promise<ClosureSaveResult> {
    const fn = callable<{ closures: Closure[] }, ClosureSaveResult>('setClubClosures');
    return (await fn({ closures })).data;
  },
};
