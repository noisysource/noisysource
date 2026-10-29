/**
 * Pure part of the "warm by HH:MM" request (warmBy.ts): what a request means,
 * and whether it is one the automation can take. No Firestore here, so the
 * chat (HANDOFF-reports-and-chat.md, section 2) can reuse it as is.
 */

export const WARM_BY_TZ = "Europe/Lisbon";
/** Sooner than this is not a plan, it is "now". */
export const MIN_AHEAD_MS = 10 * 60_000;
export const MAX_AHEAD_MS = 24 * 3600_000;
/** The automation's absolute bounds on room targets; it also clamps to its own, narrower limits. */
export const TARGET_MIN = 18;
export const TARGET_MAX = 26;

export interface WarmByInput {
  /** "HH:MM", Lisbon time: the next time it comes round. */
  time?: unknown;
  /** Or an exact instant, ISO 8601. */
  at?: unknown;
  /** °C; absent or null = the comfort temperature. */
  target?: unknown;
  /** Remove the request instead. */
  clear?: unknown;
  /** Who asked: "app" (default) or "chat". */
  source?: unknown;
}

export type WarmByParsed =
  | { clear: true }
  | { clear: false; at: number; target: number | null; source: "app" | "chat" };

const parts = (t: number, tz: string) => {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(t));
  const get = (k: string) => Number(p.find(x => x.type === k)!.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute") };
};

/** Minutes the zone's wall clock is ahead of UTC at `t` (Lisbon: 0 in winter, 60 in summer). */
export function offsetMinutes(t: number, tz = WARM_BY_TZ): number {
  const w = parts(t, tz);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000) / 60_000);
}

/** A wall-clock time in the zone, as an instant. Days past the end of the month roll over. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Twice: the offset at the guess can differ from the one at the answer near a clock change.
  let t = naive - offsetMinutes(naive, tz) * 60_000;
  t = naive - offsetMinutes(t, tz) * 60_000;
  return t;
}

/** The next time the zone's clock shows HH:MM, at least MIN_AHEAD_MS from now. */
export function nextLocalTime(hhmm: string, now: number, tz = WARM_BY_TZ): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  const today = parts(now, tz);
  for (let k = 0; k <= 2; k++) {
    const t = wallToUtc(today.y, today.mo, today.d + k, Number(m[1]), Number(m[2]), tz);
    if (t >= now + MIN_AHEAD_MS) return t;
  }
  return null;
}

/** A request as the callable receives it, checked: what to store, or why not. */
export function parseWarmByInput(raw: WarmByInput | undefined, now: number): WarmByParsed | { error: string } {
  const r = raw ?? {};
  if (r.clear === true) return { clear: true };

  let at: number | null;
  if (typeof r.time === "string") {
    at = nextLocalTime(r.time.trim(), now);
    if (at === null) return { error: "time must be HH:MM (00:00–23:59)" };
  } else if (typeof r.at === "string") {
    at = Date.parse(r.at);
    if (!Number.isFinite(at)) return { error: "at must be an ISO 8601 date-time" };
  } else {
    return { error: "give time (HH:MM), at (ISO 8601) or clear" };
  }
  if (at < now + MIN_AHEAD_MS) return { error: "at least 10 minutes from now" };
  if (at > now + MAX_AHEAD_MS) return { error: "no more than 24 hours from now" };

  let target: number | null = null;
  if (r.target !== undefined && r.target !== null) {
    if (typeof r.target !== "number" || !Number.isFinite(r.target)) return { error: "target must be a number of °C" };
    if (r.target < TARGET_MIN || r.target > TARGET_MAX) return { error: `target must be between ${TARGET_MIN} and ${TARGET_MAX} °C` };
    // The thermostats step in half degrees.
    target = Math.round(r.target * 2) / 2;
  }
  const source = r.source === "chat" ? "chat" : "app";
  return { clear: false, at, target, source };
}

/** "HH:MM" on the zone's clock, and whether that's today or tomorrow there. */
export function describeLocal(at: number, now: number, tz = WARM_BY_TZ) {
  const a = parts(at, tz);
  const n = parts(now, tz);
  const day = a.y === n.y && a.mo === n.mo && a.d === n.d ? "hoje" : "amanhã";
  return { local: `${String(a.h).padStart(2, "0")}:${String(a.mi).padStart(2, "0")}`, day };
}
