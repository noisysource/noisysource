// packages/shared/finhub/envelope.ts
//
// The event envelope shared by every FinHub v2 company module (HANDOFF-finhub-v2.md, "Event
// envelope"). Events are append-only: a correction is a `reversal` naming the wrong event, then a
// new event (suffixed id, `…-r2`). Readers drop reversed events with `liveEvents`.
//
// `recordedAt` is the server time Firestore stamped on create; the domain sees it as an ISO
// string (the event store converts the Timestamp), so this file stays free of Firebase.

import { z } from 'zod';
import { isIsoDate } from './dates';

export const COMPANIES = ['noisysource', 'noisyphocus', 'casa'] as const;
export type CompanyId = (typeof COMPANIES)[number];

export const EVENT_SOURCES = ['manual', 'import:seed', 'import:bpi-pdf', 'system'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const REVERSAL = 'reversal';

export interface FinEvent<T extends string = string, P = unknown> {
  /** Deterministic when the source has a natural key; Firestore doc id. */
  id: string;
  company: CompanyId;
  type: T;
  /** YYYY-MM-DD: when it is true in the world. */
  effectiveDate: string;
  /** ISO timestamp: when FinHub learned it (server time). */
  recordedAt: string;
  /** Firebase uid, or `importer:<name>` for the dev-only scripts. */
  recordedBy: string;
  source: EventSource;
  /** Only on type 'reversal': the id it cancels. */
  reverses?: string;
  note?: string;
  payload: P;
}

/** Firestore doc ids: no '/', not '.' or '..', at most 1500 bytes. We keep them short and plain. */
export const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const isoDateSchema = z.string().refine(isIsoDate, 'data inválida (AAAA-MM-DD)');
export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'mês inválido (AAAA-MM)');

export const envelopeSchema = z.object({
  id: z.string().regex(EVENT_ID_RE, 'id inválido'),
  company: z.enum(COMPANIES),
  type: z.string().min(1),
  effectiveDate: isoDateSchema,
  recordedAt: z.string().min(1),
  recordedBy: z.string().min(1),
  source: z.enum(EVENT_SOURCES),
  reverses: z.string().regex(EVENT_ID_RE).optional(),
  note: z.string().optional(),
  payload: z.unknown(),
});

/** Id of the reversal event for `targetId`. A second correction of the same event gets -2, -3… */
export function reversalId(targetId: string, n = 1): string {
  return n === 1 ? `rev-${targetId}` : `rev-${targetId}-${n}`;
}

/** Id of the n-th replacement of an event (n ≥ 2): `…-r2`. */
export function replacementId(originalId: string, n = 2): string {
  return `${originalId}-r${n}`;
}

/**
 * Events still in force: drops every reversal and every event a reversal names. A reversal of a
 * reversal is ignored (to restore an event, append it again with a replacement id).
 */
export function liveEvents<E extends FinEvent>(events: readonly E[]): E[] {
  const reversed = new Set<string>();
  for (const e of events) if (e.type === REVERSAL && e.reverses) reversed.add(e.reverses);
  return events.filter(e => e.type !== REVERSAL && !reversed.has(e.id));
}

/** Stable order: effective date, then recorded time, then id. */
export function sortEvents<E extends FinEvent>(events: readonly E[]): E[] {
  return [...events].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate) || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
}

/** The events as FinHub knew them at `asOf` (ISO timestamp): "what did we believe on day X". */
export function knownAt<E extends FinEvent>(events: readonly E[], asOf: string): E[] {
  return events.filter(e => e.recordedAt <= asOf);
}
