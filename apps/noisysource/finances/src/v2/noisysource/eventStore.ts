// NoisySource's event store: finhub/noisysource/events (HANDOFF-finhub-v2.md, "Storage and rules").
// Read all, append, reverse. Nothing here updates or deletes: the rules deny both, and a
// correction is a `reversal` event followed by a new one.

import {
  collection, doc, getDocs, runTransaction, serverTimestamp, Timestamp, type DocumentData,
} from 'firebase/firestore';
import { reversalId, REVERSAL } from '@shared/finhub/envelope';
import {
  buildNsEvent, parseNsEvent, type NsEvent, type NsEventType, type NsPayload,
} from '@shared/finhub/noisysource/events';
import { auth, db } from '../../lib/firebase';

const COMPANY = 'noisysource';
const eventsCol = () => collection(db, 'finhub', COMPANY, 'events');

export interface InvalidEvent {
  id: string;
  error: string;
}

export interface LoadedEvents {
  events: NsEvent[];
  /** Stored events that don't validate (shown, never used). */
  invalid: InvalidEvent[];
}

function fromFirestore(id: string, data: DocumentData): unknown {
  const recordedAt = data.recordedAt instanceof Timestamp ? data.recordedAt.toDate().toISOString() : data.recordedAt;
  return { ...data, id: data.id ?? id, recordedAt };
}

/** Every event of the company, validated. ~1,200 a year: read once per load. */
export async function readNsEvents(): Promise<LoadedEvents> {
  const snap = await getDocs(eventsCol());
  const events: NsEvent[] = [];
  const invalid: InvalidEvent[] = [];
  for (const d of snap.docs) {
    const r = parseNsEvent(fromFirestore(d.id, d.data()));
    if (r.ok) events.push(r.event);
    else invalid.push({ id: r.id, error: r.error });
  }
  return { events, invalid };
}

/** Firestore refuses `undefined` anywhere in a document. Events are plain JSON data. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class EventExistsError extends Error {
  constructor(id: string) {
    super(`Já existe um evento com o id ${id}. Para corrigir, anule-o e registe um novo.`);
  }
}

/** Appends one event. Fails if the id exists (append-only: no overwrite). */
export async function appendNsEvent<T extends NsEventType>(
  type: T,
  payload: NsPayload<T>,
  opts: { id: string; note?: string; effectiveDate?: string; reverses?: string },
): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sessão terminada: entre outra vez.');
  // Validate with a provisional time; the stored recordedAt is the server's.
  const event = buildNsEvent(type, payload, {
    id: opts.id, source: 'manual', recordedBy: uid, recordedAt: new Date().toISOString(),
    effectiveDate: opts.effectiveDate, note: opts.note, reverses: opts.reverses,
  });
  const ref = doc(eventsCol(), event.id);
  await runTransaction(db, async tx => {
    if ((await tx.get(ref)).exists()) throw new EventExistsError(event.id);
    tx.set(ref, { ...plain(event), recordedAt: serverTimestamp() });
  });
}

export interface NewEvent<T extends NsEventType = NsEventType> {
  type: T;
  payload: NsPayload<T>;
  id: string;
  note?: string;
  effectiveDate?: string;
}

/**
 * Appends several events in one transaction (a month's confirmations): all or none. Fails if any
 * id exists. Firestore allows 500 writes per transaction; callers send fewer.
 */
export async function appendNsEvents(list: NewEvent[]): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sessão terminada: entre outra vez.');
  if (list.length > 400) throw new Error('Demasiados eventos de uma vez (máx. 400).');
  const now = new Date().toISOString();
  const events = list.map(e => buildNsEvent(e.type, e.payload as never, {
    id: e.id, source: 'manual', recordedBy: uid, recordedAt: now, effectiveDate: e.effectiveDate, note: e.note,
  }));
  await runTransaction(db, async tx => {
    const refs = events.map(e => doc(eventsCol(), e.id));
    const snaps = await Promise.all(refs.map(r => tx.get(r)));
    snaps.forEach((s, k) => { if (s.exists()) throw new EventExistsError(events[k].id); });
    events.forEach((e, k) => tx.set(refs[k], { ...plain(e), recordedAt: serverTimestamp() }));
  });
}

/** Cancels an event with a `reversal` (the first free rev-<id>[-n] id). */
export async function reverseNsEvent(targetId: string, existingIds: ReadonlySet<string>, note?: string): Promise<string> {
  let n = 1;
  while (existingIds.has(reversalId(targetId, n))) n++;
  const id = reversalId(targetId, n);
  await appendNsEvent(REVERSAL, {}, { id, note, reverses: targetId });
  return id;
}
