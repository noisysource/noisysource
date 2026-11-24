// Club-wide closures (Renato, 2026-11-24): a date range in which KidClub is
// closed for everyone, e.g. 16-31 December 2026. Pure: no Firestore here.
//
// A closure lives in config/closures as { closures: [{ id, from, to, label }] }
// (written only by the setClubClosures callable, closures.ts). Every study day
// and transport trip inside one is a SYSTEM absence on its reservation event:
//   status "CANCELLED", changedByRole "system", reason REASON_CLOSED.
// Unlike the other system absences (before start / after end), which earn the
// ordinary >=3-absence credit, a closure day is always credited in full and
// never counts towards the family's own absences (reconciliation.ts, step 4).

export const REASON_CLOSED = "club closed";

export interface Closure {
  id: string;
  /** First closed day, yyyy-mm-dd, inclusive. */
  from: string;
  /** Last closed day, yyyy-mm-dd, inclusive. */
  to: string;
  /** Short text shown to families and on the bill, e.g. "Férias de Natal". */
  label: string;
}

export const MAX_CLOSURES = 50;
export const MAX_CLOSURE_DAYS = 120;
export const MAX_LABEL_LENGTH = 60;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(iso: unknown): iso is string {
  if (typeof iso !== "string" || !ISO_DAY.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Validates what the admin sent. Returns the cleaned list sorted by start
 * day, or the reason it is refused (in Portuguese: it is shown to the admin).
 */
export function validateClosures(raw: unknown): { closures: Closure[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "Lista de encerramentos inválida." };
  if (raw.length > MAX_CLOSURES) return { error: `No máximo ${MAX_CLOSURES} encerramentos.` };
  const out: Closure[] = [];
  const ids = new Set<string>();
  for (const [i, c] of raw.entries()) {
    const n = i + 1;
    const from = (c as any)?.from;
    const to = (c as any)?.to;
    const label = typeof (c as any)?.label === "string" ? (c as any).label.trim() : "";
    if (!isRealDay(from) || !isRealDay(to)) return { error: `Encerramento ${n}: datas inválidas.` };
    if (to < from) return { error: `Encerramento ${n}: a data de fim é anterior à de início.` };
    if (daysBetween(from, to) > MAX_CLOSURE_DAYS) return { error: `Encerramento ${n}: no máximo ${MAX_CLOSURE_DAYS} dias.` };
    if (!label) return { error: `Encerramento ${n}: falta a descrição.` };
    if (label.length > MAX_LABEL_LENGTH) return { error: `Encerramento ${n}: descrição com mais de ${MAX_LABEL_LENGTH} caracteres.` };
    let id = typeof (c as any)?.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test((c as any).id) ? (c as any).id : "";
    if (!id || ids.has(id)) id = `c_${from}_${to}_${n}`;
    ids.add(id);
    out.push({ id, from, to, label });
  }
  out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { closures: out };
}

/** What is stored in config/closures, read defensively: anything malformed is dropped. */
export function readClosures(raw: unknown): Closure[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(c => isRealDay(c?.from) && isRealDay(c?.to) && c.from <= c.to)
    .map((c, i) => ({ id: String(c.id ?? `c${i}`), from: c.from, to: c.to, label: String(c.label ?? "").trim() }));
}

/** The closure a day falls in, if any (the first one, by list order). */
export function closureFor(dateIso: string, closures: Closure[] | undefined): Closure | undefined {
  return (closures ?? []).find(c => dateIso >= c.from && dateIso <= c.to);
}

/** Is this reservation event a closure day (as opposed to any other absence)? */
export function isClosureAbsence(e: { status?: string; changedByRole?: string; reason?: string } | undefined | null): boolean {
  return e?.status === "CANCELLED" && e?.changedByRole === "system" && e?.reason === REASON_CLOSED;
}

/** The labels of the closures that cover the given days, in list order, without repeats. */
export function closureLabelFor(dates: string[], closures: Closure[] | undefined): string {
  const labels: string[] = [];
  for (const c of closures ?? []) {
    if (c.label && !labels.includes(c.label) && dates.some(d => d >= c.from && d <= c.to)) labels.push(c.label);
  }
  return labels.join(", ");
}

// ── What one sync does to one event ─────────────────────────────────────────

export interface ClosureSyncEvent {
  id: string;
  date: string;
  status: string;
  changedByRole?: string;
  changedBy?: string;
  changedAt?: unknown;
  reason?: string;
  /** What a human had recorded on this day before the closure covered it. */
  preClosure?: { status: string; changedByRole?: string; changedBy?: string; changedAt?: unknown; reason?: string };
}

/** The contract of the event's subscription, as far as restoring a day needs it. */
export interface ClosureSyncSub {
  /** False when the subscription is cancelled or gone. */
  active: boolean;
  /** First served day, yyyy-mm-dd. */
  start?: string;
  /** Last served day, yyyy-mm-dd: its own end date, or the day it was cancelled. */
  end?: string;
}

export type ClosureSyncAction =
  | { kind: "none" }
  /** The day becomes a closure absence. `keep` is what a human had recorded, to put back later. */
  | { kind: "close"; keep?: ClosureSyncEvent["preClosure"] }
  /** The day is no longer closed: back to what it would be without the closure. */
  | { kind: "reopen"; status: "EXPECTED" | "CANCELLED"; changedByRole?: string; changedBy?: string; changedAt?: unknown; reason?: string };

const isHuman = (role: string | undefined) => role === "parent" || role === "staff";

/**
 * Decided per event, from the event and the closure list alone, so the sync is
 * idempotent: running it twice changes nothing the second time.
 *
 * `outsideReasons` are the before-start / after-end reasons of
 * reservationEvents.ts (passed in to keep this file free of that import).
 */
export function closureSyncAction(
  e: ClosureSyncEvent,
  closures: Closure[],
  sub: ClosureSyncSub | undefined,
  outsideReasons: { beforeStart: string; afterEnd: string },
): ClosureSyncAction {
  if (e.status === "VOIDED") return { kind: "none" };
  const closed = isClosureAbsence(e);
  const inClosure = !!closureFor(e.date, closures);

  if (inClosure) {
    if (closed) return { kind: "none" };
    // Outside the contract: the child isn't enrolled that day, closed or not.
    if (e.status === "CANCELLED" && e.changedByRole === "system") return { kind: "none" };
    if (e.status === "CANCELLED" && isHuman(e.changedByRole)) {
      return {
        kind: "close",
        keep: {
          status: "CANCELLED", changedByRole: e.changedByRole,
          ...(e.changedBy ? { changedBy: e.changedBy } : {}),
          ...(e.changedAt ? { changedAt: e.changedAt } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
        },
      };
    }
    return { kind: "close" };
  }

  if (!closed) return { kind: "none" };
  // The closure that covered this day was removed or shortened.
  if (sub?.start && e.date < sub.start) return { kind: "reopen", status: "CANCELLED", changedByRole: "system", reason: outsideReasons.beforeStart };
  if (sub?.end && e.date > sub.end) return { kind: "reopen", status: "CANCELLED", changedByRole: "system", reason: outsideReasons.afterEnd };
  // A cancelled (or deleted) subscription with no known last day: the family
  // has left, so the day stays an absence rather than becoming a served day.
  if (!sub || (!sub.active && !sub.end)) return { kind: "reopen", status: "CANCELLED", changedByRole: "system", reason: outsideReasons.afterEnd };
  const keep = e.preClosure;
  if (keep?.status === "CANCELLED" && isHuman(keep.changedByRole)) {
    return { kind: "reopen", status: "CANCELLED", changedByRole: keep.changedByRole, changedBy: keep.changedBy, changedAt: keep.changedAt, reason: keep.reason };
  }
  return { kind: "reopen", status: "EXPECTED" };
}
