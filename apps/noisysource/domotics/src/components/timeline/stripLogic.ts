import { lisbonMinutes } from '@shared/lib/energyBill';

/**
 * What DayStrip draws and the arithmetic behind it, kept apart from React so it
 * can be tested without a browser. Knows nothing about heating or energy: lanes
 * of segments, or a line, over a time range.
 */

export interface StripSegment {
  /** Unique within the strip, and stable while the data grows: the selection is kept by it. */
  id: string;
  from: number;
  to: number;
  /** Key into the tones. */
  tone: string;
  /** Short, in words: shown under the crosshair. */
  label: string;
}

export interface SegmentLane {
  kind?: 'segments';
  id: string;
  label: string;
  /** Right of the label, small. */
  note?: string;
  /** px; default 24. */
  height?: number;
  segments: StripSegment[];
}

export interface LinePoint { t: number; v: number }

export interface LineLane {
  kind: 'line';
  id: string;
  label: string;
  note?: string;
  /** px; default 34. */
  height?: number;
  points: LinePoint[];
  /** A dashed line to read it against: a target, a limit. Holds its value until the next point. */
  reference?: LinePoint[];
  format: (v: number) => string;
  color?: string;
  /** The line breaks across a gap longer than this; default 30 min. */
  maxGapMs?: number;
}

export type StripLane = SegmentLane | LineLane;

/** How a tone is drawn. The pattern and the mark are there so colour is never the only difference. */
export interface StripTone {
  /** For the legend. */
  label: string;
  /** Any CSS colour, normally a `--viz-*` token. */
  fill: string;
  pattern?: 'solid' | 'hatch' | 'dense' | 'dots';
  /** A low stripe along the lane's foot instead of a full band: for "nothing is happening here". Still selectable. */
  thin?: boolean;
  /** One character drawn on the band where it fits, and in the legend. */
  mark?: string;
}

/** What is selected: a segment in its lane (`id`), or an instant on a line lane. */
export interface StripSelection {
  lane: string;
  id?: string;
  t: number;
}

export interface StripTick { t: number; label: string }

const HOUR = 3_600_000;
const STEPS_H = [1, 2, 3, 4, 6, 12, 24];

/**
 * Hour labels by Lisbon's wall clock. Walks real hours, so the clock-change
 * days come out right: 01 is missing on the March one and comes twice on the
 * October one. A range ending at midnight ends in "24", not a second "00".
 */
export function axisTicks(from: number, to: number, innerWidth: number, minGapPx = 26): StripTick[] {
  const pxPerH = (innerWidth * HOUR) / Math.max(1, to - from);
  const every = STEPS_H.find(h => h * pxPerH >= minGapPx) ?? 24;
  const out: StripTick[] = [];
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) {
    const m = lisbonMinutes(t);
    if (m % (every * 60) !== 0) continue;
    const h = t === to && m === 0 ? 24 : m / 60;
    out.push({ t, label: String(h).padStart(2, '0') });
  }
  return out;
}

const distance = (s: StripSegment, t: number) => (t < s.from ? s.from - t : t >= s.to ? t - s.to : 0);

export const segmentAt = (segments: StripSegment[], t: number) =>
  segments.find(s => t >= s.from && t < s.to) ?? null;

/**
 * The segment a tap at `t` means. A short band is only a few pixels on a phone:
 * within `slopMs` a visible one wins over the empty stretch the tap landed on.
 * Failing that, what's under the tap, or the nearest segment if nothing is.
 */
export function pickSegment(
  segments: StripSegment[],
  t: number,
  slopMs: number,
  isProminent: (s: StripSegment) => boolean,
): StripSegment | null {
  const under = segmentAt(segments, t);
  if (under && isProminent(under)) return under;
  let best: StripSegment | null = null;
  let bestD = Infinity;
  for (const s of segments) {
    if (!isProminent(s)) continue;
    const d = distance(s, t);
    if (d <= slopMs && d < bestD) { best = s; bestD = d; }
  }
  if (best || under) return best ?? under;
  for (const s of segments) {
    const d = distance(s, t);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

export const isLine = (l: StripLane): l is LineLane => l.kind === 'line';

/** The point nearest `t`, unless the nearest is further than `maxMs`. */
export function nearestPoint(points: LinePoint[], t: number, maxMs = Infinity): LinePoint | null {
  let best: LinePoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best && bestD <= maxMs ? best : null;
}

/** The selection one step left or right within its lane. Unchanged at the ends. */
export function stepSelection(lanes: StripLane[], sel: StripSelection, dir: 1 | -1): StripSelection {
  const lane = lanes.find(l => l.id === sel.lane);
  if (!lane) return sel;
  if (isLine(lane)) {
    const pts = lane.points;
    if (pts.length === 0) return sel;
    const i = pts.indexOf(nearestPoint(pts, sel.t)!);
    const p = pts[Math.min(pts.length - 1, Math.max(0, i + dir))];
    return { lane: lane.id, t: p.t };
  }
  const segs = lane.segments;
  const i = segs.findIndex(s => s.id === sel.id);
  if (i < 0) {
    const s = segmentAt(segs, sel.t);
    return s ? { lane: lane.id, id: s.id, t: s.from } : sel;
  }
  const s = segs[Math.min(segs.length - 1, Math.max(0, i + dir))];
  return { lane: lane.id, id: s.id, t: s.from };
}

/** The same instant in the lane above or below. Lanes with nothing to select are skipped. */
export function stepLane(lanes: StripLane[], sel: StripSelection, dir: 1 | -1): StripSelection {
  const usable = lanes.filter(l => (isLine(l) ? l.points.length > 0 : l.segments.length > 0));
  const at = usable.findIndex(l => l.id === sel.lane);
  const next = usable[at + dir];
  if (!next) return sel;
  if (isLine(next)) return { lane: next.id, t: nearestPoint(next.points, sel.t)!.t };
  const s = segmentAt(next.segments, sel.t) ?? pickSegment(next.segments, sel.t, Infinity, () => true);
  return s ? { lane: next.id, id: s.id, t: sel.t } : sel;
}

/** The runs of a line, broken across gaps longer than `maxGapMs`; a run of one point is drawn as a dot. */
export function lineRuns(points: LinePoint[], maxGapMs: number): LinePoint[][] {
  const runs: LinePoint[][] = [];
  for (const p of points) {
    const run = runs[runs.length - 1];
    if (run && p.t - run[run.length - 1].t <= maxGapMs) run.push(p);
    else runs.push([p]);
  }
  return runs;
}

/** A vertical scale for a line lane, at least `minSpan` tall so a flat day doesn't look like a storm. */
export function lineDomain(values: number[], minSpan = 1): [number, number] {
  if (values.length === 0) return [0, minSpan];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mid = (lo + hi) / 2;
  const half = Math.max(minSpan, hi - lo + 0.2 * minSpan) / 2;
  return [mid - half, mid + half];
}
