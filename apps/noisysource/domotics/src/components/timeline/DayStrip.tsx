import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { lisbonOffsetMs } from '@shared/lib/energyBill';
import {
  axisTicks, isLine, lineDomain, lineRuns, nearestPoint, pickSegment, segmentAt, stepLane, stepSelection,
  type LineLane, type SegmentLane, type StripLane, type StripSelection, type StripTick, type StripTone,
} from './stripLogic';

export type {
  LineLane, LinePoint, SegmentLane, StripLane, StripSegment, StripSelection, StripTick, StripTone,
} from './stripLogic';

/**
 * A time range as stacked lanes on one Lisbon-time axis: bands of segments
 * ("what was happening") or a thin line ("how much"), with a "now" marker and
 * a selection the caller keeps. It knows nothing about what the lanes mean: the
 * caller says who the tones are and what to show for a selection.
 *
 * Same conventions as PumpChart and EnergyChart: SVG, `--viz-*` tokens, no chart
 * library, crosshair on hover/touch, ←/→ from the keyboard (↑/↓ change lane).
 * Mostly used on a phone: it fits from 280 px, the page only scrolls vertically
 * over it (`touch-action: pan-y`), and a tap near a thin band selects the band.
 */

export interface DayStripProps {
  from: number;
  to: number;
  lanes: StripLane[];
  tones: Record<string, StripTone>;
  /** Draws the marker and shades what's still to come; ignored outside the range. */
  now?: number;
  /** Under the marker. Default: "agora" and the time. */
  nowLabel?: string;
  selection?: StripSelection | null;
  onSelect?: (s: StripSelection) => void;
  /** Says what the strip shows, for screen readers. */
  ariaLabel: string;
  /** Instead of hour labels from the wall clock. */
  ticks?: StripTick[];
}

const M = { left: 8, right: 8 };
const HEAD_H = 14;
const LANE_GAP = 5;
const SEGMENT_H = 24;
const LINE_H = 34;
const AXIS_H = 16;
const NOW_H = 14;
const THIN_H = 3;
const MIN_W = 2;
/** px around a tap in which a narrow band still counts as tapped. */
const SLOP_PX = 10;

const clock = (t: number) => new Date(t + lisbonOffsetMs(t)).toISOString().slice(11, 16);

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');

/** One tone's texture, for a band or a legend swatch. */
function ToneDefs({ id, tone }: { id: string; tone: StripTone }) {
  if (!tone.pattern || tone.pattern === 'solid') return null;
  if (tone.pattern === 'dots') {
    return (
      <pattern id={id} width={4} height={4} patternUnits="userSpaceOnUse">
        <circle cx={2} cy={2} r={1.1} fill={tone.fill} />
      </pattern>
    );
  }
  const [size, line] = tone.pattern === 'dense' ? [3.5, 2] : [6, 1.8];
  return (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={line} height={size} fill={tone.fill} />
    </pattern>
  );
}

const textured = (t: StripTone) => !!t.pattern && t.pattern !== 'solid';

export default function DayStrip({ from, to, lanes, tones, now, nowLabel, selection, onSelect, ariaLabel, ticks }: DayStripProps) {
  const [ref, width] = useWidth();
  const uid = safeId(useId());
  const [hover, setHover] = useState<{ t: number; y: number } | null>(null);
  useEffect(() => setHover(null), [from, to]);

  const innerW = Math.max(1, width - M.left - M.right);
  const x = (t: number) => M.left + ((t - from) / Math.max(1, to - from)) * innerW;
  const tAt = (px: number) => from + ((px - M.left) / innerW) * (to - from);
  const showNow = now !== undefined && now >= from && now <= to;

  const layout = useMemo(() => {
    let y = 0;
    const rows = lanes.map(lane => {
      const h = lane.height ?? (isLine(lane) ? LINE_H : SEGMENT_H);
      const row = { lane, head: y, top: y + HEAD_H, h };
      y += HEAD_H + h + LANE_GAP;
      return row;
    });
    return { rows, bottom: Math.max(0, y - LANE_GAP) };
  }, [lanes]);
  const height = layout.bottom + AXIS_H + (showNow ? NOW_H : 0);
  const marks = ticks ?? axisTicks(from, to, innerW);
  const usedTones = useMemo(() => {
    const keys = new Set<string>();
    for (const l of lanes) if (!isLine(l)) for (const s of l.segments) keys.add(s.tone);
    return [...keys].filter(k => tones[k]);
  }, [lanes, tones]);
  const fillOf = (key: string) => {
    const tone = tones[key];
    return textured(tone) ? `url(#${uid}-${safeId(key)})` : tone.fill;
  };

  const laneAtY = (y: number) => {
    let best = layout.rows[0];
    for (const r of layout.rows) if (Math.abs(y - (r.top + r.h / 2)) < Math.abs(y - (best.top + best.h / 2))) best = r;
    return best;
  };

  function select(t: number, y: number) {
    if (!onSelect || layout.rows.length === 0) return;
    const { lane } = laneAtY(y);
    if (isLine(lane)) {
      const p = nearestPoint(lane.points, t, lane.maxGapMs ?? 30 * 60_000);
      if (p) onSelect({ lane: lane.id, t: p.t });
      return;
    }
    const slop = (SLOP_PX / innerW) * (to - from);
    const s = pickSegment(lane.segments, t, slop, seg => !tones[seg.tone]?.thin);
    if (s) onSelect({ lane: lane.id, id: s.id, t });
  }

  function pointerAt(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const y = ((e.clientY - box.top) / box.height) * height;
    return { t: Math.min(to, Math.max(from, tAt(px))), y };
  }

  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (!onSelect || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const first = layout.rows.map(r => r.lane).find(l => (isLine(l) ? l.points.length > 0 : l.segments.length > 0));
    if (!first) return;
    const cur: StripSelection = selection ?? { lane: first.id, t: showNow ? now! - 1 : from };
    const next = e.key === 'ArrowLeft' ? stepSelection(lanes, cur, -1)
      : e.key === 'ArrowRight' ? stepSelection(lanes, cur, 1)
      : stepLane(lanes, cur, e.key === 'ArrowUp' ? -1 : 1);
    onSelect(next);
  }

  /** What each lane says at the crosshair. */
  const readings = hover ? layout.rows.map(({ lane }) => {
    if (isLine(lane)) {
      const p = nearestPoint(lane.points, hover.t, lane.maxGapMs ?? 30 * 60_000);
      const r = lane.reference?.length ? nearestPoint(lane.reference, hover.t) : null;
      return p ? `${lane.label}: ${lane.format(p.v)}${r ? ` / ${lane.format(r.v)}` : ''}` : null;
    }
    const s = segmentAt(lane.segments, hover.t);
    return s ? `${lane.label}: ${s.label}` : null;
  }).filter((v): v is string => !!v) : [];

  return (
    <div ref={ref} className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="group"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="block overflow-visible outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--viz-axis)] rounded"
        style={{ fontFamily: 'inherit' }}
      >
        <defs>
          {usedTones.map(k => <ToneDefs key={k} id={`${uid}-${safeId(k)}`} tone={tones[k]} />)}
        </defs>

        {/* Hour lines, behind everything. */}
        {marks.map(m => (
          <line key={m.t} x1={x(m.t)} x2={x(m.t)} y1={HEAD_H} y2={layout.bottom} stroke="var(--viz-grid)" strokeWidth={1} />
        ))}
        {/* What's still to come. */}
        {showNow && now! < to && (
          <rect x={x(now!)} y={0} width={x(to) - x(now!)} height={layout.bottom} fill="var(--viz-ink)" opacity={0.03} />
        )}

        {layout.rows.map(({ lane, head, top, h }) => (
          <g key={lane.id}>
            <text x={M.left} y={head + 10} fontSize={10} fontWeight={600} fill="var(--viz-ink-2)">{lane.label}</text>
            {lane.note && (
              <text x={width - M.right} y={head + 10} fontSize={10} textAnchor="end" fill="var(--viz-muted)" className="tabular-nums">{lane.note}</text>
            )}
            {isLine(lane)
              ? <LineBody lane={lane} top={top} h={h} x={x} selection={selection} left={M.left} right={width - M.right} />
              : <SegmentBody lane={lane} top={top} h={h} x={x} tones={tones} fillOf={fillOf} selection={selection} />}
          </g>
        ))}

        {/* Axis */}
        {marks.map(m => (
          <text key={m.t} x={x(m.t)} y={layout.bottom + 12} textAnchor="middle" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">
            {m.label}
          </text>
        ))}

        {showNow && (
          <g>
            <line x1={x(now!)} x2={x(now!)} y1={0} y2={layout.bottom + 2} stroke="var(--viz-ink)" strokeWidth={1.5} />
            <path d={`M${x(now!)} ${layout.bottom + AXIS_H - 3} l-4 5 h8 Z`} fill="var(--viz-ink)" />
            <text
              x={x(now!) + (x(now!) > width / 2 ? -7 : 7)}
              y={layout.bottom + AXIS_H + 8}
              textAnchor={x(now!) > width / 2 ? 'end' : 'start'}
              fontSize={10}
              fontWeight={600}
              fill="var(--viz-ink)"
              className="tabular-nums"
            >
              {nowLabel ?? `agora ${clock(now!)}`}
            </text>
          </g>
        )}

        {hover && <line x1={x(hover.t)} x2={x(hover.t)} y1={0} y2={layout.bottom} stroke="var(--viz-ink-2)" strokeWidth={1} />}

        {/* Pointer target over the whole strip. `pan-y`: a vertical swipe still scrolls the page. */}
        <rect
          x={0}
          y={0}
          width={width}
          height={layout.bottom + AXIS_H}
          fill="transparent"
          style={{ touchAction: 'pan-y', cursor: onSelect ? 'pointer' : undefined }}
          onPointerDown={e => setHover(pointerAt(e))}
          onPointerMove={e => setHover(pointerAt(e))}
          onPointerUp={e => { const p = pointerAt(e); select(p.t, p.y); }}
          onPointerLeave={() => setHover(null)}
          onPointerCancel={() => setHover(null)}
        />
      </svg>

      {hover && readings.length > 0 && (
        // Against the strip's own edges, on the side away from the pointer: it must never widen the page on a phone.
        <div
          className={`pointer-events-none absolute z-10 bottom-full mb-1 max-w-full rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-[11px] shadow-lg flex flex-col gap-0.5 tabular-nums ${x(hover.t) > width / 2 ? 'left-0' : 'right-0'}`}
        >
          <span className="text-zinc-400">{clock(hover.t)}</span>
          {readings.map(r => <span key={r} className="text-zinc-100">{r}</span>)}
        </div>
      )}
    </div>
  );
}

function SegmentBody({ lane, top, h, x, tones, fillOf, selection }: {
  lane: SegmentLane; top: number; h: number; x: (t: number) => number;
  tones: Record<string, StripTone>; fillOf: (key: string) => string; selection?: StripSelection | null;
}) {
  return (
    <g>
      {lane.segments.map(s => {
        const tone = tones[s.tone];
        if (!tone) return null;
        const left = x(s.from);
        const w = Math.max(MIN_W, x(s.to) - left);
        const selected = selection?.lane === lane.id && selection.id === s.id;
        const y = tone.thin ? top + h - THIN_H : top;
        const bandH = tone.thin ? THIN_H : h;
        return (
          <g key={s.id}>
            {/* A faint wash under a texture, so its extent reads at a glance. */}
            {textured(tone) && <rect x={left} y={y} width={w} height={bandH} fill={tone.fill} opacity={0.16} />}
            <rect x={left} y={y} width={w} height={bandH} fill={fillOf(s.tone)} />
            {tone.mark && w >= (tone.thin ? 16 : 12) && (
              <text
                x={left + w / 2}
                y={tone.thin ? top + h - THIN_H - 3 : top + h / 2}
                dy={tone.thin ? undefined : '0.35em'}
                textAnchor="middle"
                fontSize={10}
                fontWeight={700}
                fill={textured(tone) || tone.thin ? 'var(--viz-ink-2)' : 'var(--viz-surface)'}
                style={textured(tone) ? { paintOrder: 'stroke', stroke: 'var(--viz-surface)', strokeWidth: 3 } : undefined}
              >
                {tone.mark}
              </text>
            )}
            {selected && (
              <rect x={left - 1} y={top - 1} width={w + 2} height={h + 2} fill="none" stroke="var(--viz-ink)" strokeWidth={1.5} rx={1.5} />
            )}
          </g>
        );
      })}
    </g>
  );
}

function LineBody({ lane, top, h, x, selection, left, right }: {
  lane: LineLane; top: number; h: number; x: (t: number) => number; selection?: StripSelection | null; left: number; right: number;
}) {
  const color = lane.color ?? 'var(--viz-ink)';
  const values = [...lane.points, ...(lane.reference ?? [])].map(p => p.v);
  const [lo, hi] = lineDomain(values);
  const y = (v: number) => top + h - ((v - lo) / (hi - lo)) * h;
  const maxGap = lane.maxGapMs ?? 30 * 60_000;

  const pieces: ReactNode[] = lineRuns(lane.points, maxGap).map(run => (
    run.length === 1
      ? <circle key={run[0].t} cx={x(run[0].t)} cy={y(run[0].v)} r={2} fill={color} />
      : <path key={run[0].t} d={run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}
          fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
  ));
  const reference = lane.reference ?? [];
  let refPath = '';
  reference.forEach((p, i) => {
    refPath += i === 0 ? `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(p.v).toFixed(1)}`;
  });
  const selected = selection?.lane === lane.id ? nearestPoint(lane.points, selection.t) : null;

  return (
    <g>
      <line x1={left} x2={right} y1={top + h} y2={top + h} stroke="var(--viz-axis)" strokeWidth={1} />
      {refPath && <path d={refPath} fill="none" stroke="var(--viz-muted)" strokeWidth={1.25} strokeDasharray="4 3" />}
      {pieces}
      {selected && (
        <g>
          <line x1={x(selected.t)} x2={x(selected.t)} y1={top} y2={top + h} stroke="var(--viz-ink-2)" strokeWidth={1} />
          <circle cx={x(selected.t)} cy={y(selected.v)} r={3} fill={color} stroke="var(--viz-surface)" strokeWidth={1.5} />
        </g>
      )}
    </g>
  );
}

/** A small swatch for a tone, texture and mark included. */
export function ToneSwatch({ tone }: { tone: StripTone }) {
  const id = `swatch-${safeId(useId())}`;
  const fill = textured(tone) ? `url(#${id})` : tone.fill;
  return (
    <svg width="18" height="11" aria-hidden="true" className="shrink-0">
      <defs><ToneDefs id={id} tone={tone} /></defs>
      {tone.thin
        ? <rect x={0} y={8} width={18} height={3} fill={fill} />
        : (
          <>
            {textured(tone) && <rect width={18} height={11} fill={tone.fill} opacity={0.16} />}
            <rect width={18} height={11} rx={1} fill={fill} />
            {tone.mark && (
              <text x={9} y={5.5} dy="0.36em" textAnchor="middle" fontSize={8.5} fontWeight={700}
                fill={textured(tone) ? 'var(--viz-ink)' : 'var(--viz-surface)'}>
                {tone.mark}
              </text>
            )}
          </>
        )}
    </svg>
  );
}

/** A compact legend for the tones named, in that order. */
export function StripLegend({ tones, keys }: { tones: Record<string, StripTone>; keys: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] leading-tight text-[color:var(--viz-ink-2)]">
      {keys.filter(k => tones[k]).map(k => (
        <span key={k} className="flex items-center gap-1">
          <ToneSwatch tone={tones[k]} />
          {tones[k].label}
        </span>
      ))}
    </div>
  );
}
