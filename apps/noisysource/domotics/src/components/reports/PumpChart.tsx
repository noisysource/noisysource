import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtTime, num, type PumpSample } from '../../data/incidents';

/**
 * The pump around a trip: temperatures on top, compressor below, one time axis.
 *
 * Two panels rather than one chart with two y-axes — °C and Hz don't share a
 * scale, and a second axis invites reading crossings that mean nothing. The
 * fault is a band in the status colour, not a series. Colours come from the
 * `--viz-*` tokens in index.css (dark on screen, light in the printout).
 */

interface Props {
  samples: PumpSample[];
  /** Start of the fault: a line is drawn there. */
  tripAt?: number;
  tripLabel?: string;
  /** For the printout: no hover, the peak labelled. */
  printable?: boolean;
}

type Key = 'out' | 'dis' | 'inn';
const TEMPS: ReadonlyArray<{ key: Key; label: string; color: string }> = [
  { key: 'out', label: 'Água saída', color: 'var(--viz-1)' },
  { key: 'dis', label: 'Descarga (C01)', color: 'var(--viz-2)' },
  { key: 'inn', label: 'Água entrada', color: 'var(--viz-3)' },
];
const HZ_COLOR = 'var(--viz-hz)';

const M = { left: 34, right: 12, top: 10 };
const TOP_H = 150;
const GAP = 22;
const BOT_H = 64;
const AXIS_H = 20;
const HEIGHT = M.top + TOP_H + GAP + BOT_H + AXIS_H;

const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240];

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

/** A polyline that breaks where a value is missing. */
function path(samples: PumpSample[], get: (s: PumpSample) => number | undefined, x: (t: number) => number, y: (v: number) => number) {
  let d = '';
  let pen = false;
  for (const s of samples) {
    const v = get(s);
    if (v === undefined) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** The setpoint as steps: it holds until changed. */
function stepPath(samples: PumpSample[], x: (t: number) => number, y: (v: number) => number) {
  let d = '';
  let prev: number | undefined;
  for (const s of samples) {
    if (s.sp === undefined) continue;
    if (prev === undefined) d += `M${x(s.t).toFixed(1)},${y(s.sp).toFixed(1)}`;
    else d += `H${x(s.t).toFixed(1)}V${y(s.sp).toFixed(1)}`;
    prev = s.sp;
  }
  if (prev !== undefined && samples.length) d += `H${x(samples[samples.length - 1].t).toFixed(1)}`;
  return d;
}

export default function PumpChart({ samples, tripAt, tripLabel = 'avaria', printable = false }: Props) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    const t0 = samples[0]?.t ?? 0;
    const t1 = samples[samples.length - 1]?.t ?? t0 + 1;
    const innerW = width - M.left - M.right;
    const x = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * innerW;

    const temps = samples.flatMap(s => [s.out, s.inn, s.dis, s.sp]).filter((v): v is number => v !== undefined);
    const lo = Math.floor(Math.min(...temps, 20) / 10) * 10;
    const hi = Math.ceil(Math.max(...temps, 50) / 10) * 10;
    const tStep = hi - lo > 60 ? 20 : 10;
    const yT = (v: number) => M.top + TOP_H - ((v - lo) / (hi - lo)) * TOP_H;
    const tTicks: number[] = [];
    for (let v = lo; v <= hi; v += tStep) tTicks.push(v);

    const hzMax = Math.max(70, ...samples.map(s => s.hz));
    const hzTop = M.top + TOP_H + GAP;
    const yH = (v: number) => hzTop + BOT_H - (v / hzMax) * BOT_H;

    const spanMin = (t1 - t0) / 60_000;
    const step = STEPS_MIN.find(m => spanMin / m <= Math.max(3, Math.floor(innerW / 90))) ?? 240;
    const xTicks: number[] = [];
    for (let t = Math.ceil(t0 / (step * 60_000)) * step * 60_000; t <= t1; t += step * 60_000) xTicks.push(t);

    // Contiguous runs of readings in fault, each to the next reading.
    const bands: Array<[number, number]> = [];
    samples.forEach((s, i) => {
      if (s.faults.length === 0) return;
      const end = samples[i + 1]?.t ?? s.t;
      const last = bands[bands.length - 1];
      if (last && last[1] === s.t) last[1] = end;
      else bands.push([s.t, end]);
    });

    const peak = samples.reduce<PumpSample | undefined>((m, s) => (s.dis !== undefined && (m?.dis === undefined || s.dis > m.dis) ? s : m), undefined);
    return { x, yT, yH, lo, hi, tTicks, hzMax, hzTop, xTicks, bands, peak, t0, t1, innerW };
  }, [samples, width]);

  if (samples.length < 2) {
    return <p className="text-xs text-[color:var(--viz-muted)]">Sem leituras suficientes para um gráfico.</p>;
  }

  const { x, yT, yH, tTicks, hzMax, hzTop, xTicks, bands, peak } = geo;
  const hasFault = bands.length > 0 || tripAt !== undefined;
  const h = hover !== null ? samples[hover] : null;

  function nearest(px: number) {
    let best = 0;
    for (let i = 1; i < samples.length; i++) {
      if (Math.abs(x(samples[i].t) - px) < Math.abs(x(samples[best].t) - px)) best = i;
    }
    return best;
  }
  function onMove(e: PointerEvent<SVGRectElement>) {
    const svg = e.currentTarget.ownerSVGElement!;
    const box = svg.getBoundingClientRect();
    setHover(nearest(((e.clientX - box.left) / box.width) * width));
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = hover ?? (tripAt !== undefined ? nearest(x(tripAt)) : 0);
    setHover(Math.min(samples.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1))));
  }

  const legend = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--viz-ink-2)]">
      {TEMPS.map(s => (
        <span key={s.key} className="flex items-center gap-1.5">
          <svg width="14" height="4" aria-hidden="true"><line x1="0" y1="2" x2="14" y2="2" stroke={s.color} strokeWidth="2" strokeLinecap="round" /></svg>
          {s.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg width="14" height="4" aria-hidden="true"><line x1="0" y1="2" x2="14" y2="2" stroke="var(--viz-muted)" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
        Setpoint
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="4" aria-hidden="true"><line x1="0" y1="2" x2="14" y2="2" stroke={HZ_COLOR} strokeWidth="2" strokeLinecap="round" /></svg>
        Compressor (Hz)
      </span>
      {hasFault && (
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2.5 rounded-sm" style={{ background: 'var(--viz-critical)', opacity: 0.35 }} aria-hidden="true" />
          Em avaria
        </span>
      )}
    </div>
  );

  return (
    <div ref={ref} className="relative flex flex-col gap-2 print-avoid-break">
      {legend}
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label={`Leituras da bomba de ${fmtTime(samples[0].t)} a ${fmtTime(samples[samples.length - 1].t)}`}
        tabIndex={printable ? undefined : 0}
        onKeyDown={printable ? undefined : onKey}
        onBlur={() => setHover(null)}
        className="overflow-visible outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--viz-axis)] rounded"
        style={{ fontFamily: 'inherit' }}
      >
        {/* Fault bands, behind everything, across both panels. */}
        {bands.map(([a, b], i) => (
          <rect key={i} x={x(a)} y={M.top} width={Math.max(2, x(b) - x(a))} height={TOP_H + GAP + BOT_H}
            fill="var(--viz-critical)" opacity={0.14} />
        ))}

        {/* Temperature panel */}
        {tTicks.map(v => (
          <g key={v}>
            <line x1={M.left} x2={width - M.right} y1={yT(v)} y2={yT(v)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={M.left - 6} y={yT(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">{v}°</text>
          </g>
        ))}
        <path d={stepPath(samples, x, yT)} fill="none" stroke="var(--viz-muted)" strokeWidth={1.5} strokeDasharray="4 3" />
        {TEMPS.map(s => (
          <path key={s.key} d={path(samples, p => p[s.key], x, yT)} fill="none" stroke={s.color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* The one value worth labelling: the discharge peak. */}
        {peak?.dis !== undefined && (
          <g>
            <circle cx={x(peak.t)} cy={yT(peak.dis)} r={4} fill="var(--viz-2)" stroke="var(--viz-surface)" strokeWidth={2} />
            <text x={x(peak.t)} y={yT(peak.dis) - 8} textAnchor={x(peak.t) > width - 80 ? 'end' : 'middle'} fontSize={10}
              fill="var(--viz-ink)" fontWeight={600} className="tabular-nums">
              {num(peak.dis)}°
            </text>
          </g>
        )}

        {/* Compressor panel */}
        {[0, Math.round(hzMax / 2), hzMax].map(v => (
          <g key={v}>
            <line x1={M.left} x2={width - M.right} y1={yH(v)} y2={yH(v)} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
            <text x={M.left - 6} y={yH(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">{v}</text>
          </g>
        ))}
        <text x={M.left} y={hzTop - 6} fontSize={10} fill="var(--viz-muted)">Hz</text>
        <path d={path(samples, p => p.hz, x, yH)} fill="none" stroke={HZ_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Time axis */}
        {xTicks.map(t => (
          <text key={t} x={x(t)} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">
            {fmtTime(t)}
          </text>
        ))}

        {tripAt !== undefined && (
          <g>
            <line x1={x(tripAt)} x2={x(tripAt)} y1={M.top} y2={hzTop + BOT_H} stroke="var(--viz-critical)" strokeWidth={1.5} />
            {/* In the gap between the panels: the discharge peak is usually right at the top of this line. */}
            <text x={x(tripAt) + (x(tripAt) > width - 110 ? -4 : 4)} y={hzTop - 7} fontSize={10} fontWeight={600}
              textAnchor={x(tripAt) > width - 110 ? 'end' : 'start'} fill="var(--viz-ink)">
              {tripLabel} {fmtTime(tripAt, true)}
            </text>
          </g>
        )}

        {/* Crosshair */}
        {h && (
          <line x1={x(h.t)} x2={x(h.t)} y1={M.top} y2={hzTop + BOT_H} stroke="var(--viz-ink-2)" strokeWidth={1} />
        )}
        {!printable && (
          <rect x={M.left} y={M.top} width={Math.max(0, width - M.left - M.right)} height={TOP_H + GAP + BOT_H}
            fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
        )}
      </svg>

      {h && !printable && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-2 text-[11px] shadow-lg flex flex-col gap-0.5 tabular-nums"
          style={{
            top: 28,
            left: Math.min(Math.max(0, (x(h.t) / width) * 100), 100) + '%',
            transform: x(h.t) > width / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
        >
          <span className="text-zinc-400">{fmtTime(h.t, true)}{h.faults.length ? ` · ${h.faults.join(', ')}` : ''}{!h.on ? ' · desligada' : ''}</span>
          {TEMPS.map(s => (
            <span key={s.key} className="flex items-center gap-1.5">
              <svg width="10" height="4" aria-hidden="true"><line x1="0" y1="2" x2="10" y2="2" stroke={s.color} strokeWidth="2" /></svg>
              <b className="text-zinc-100 font-semibold">{num(h[s.key])}°</b>
              <span className="text-zinc-500">{s.label}</span>
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <svg width="10" height="4" aria-hidden="true"><line x1="0" y1="2" x2="10" y2="2" stroke="var(--viz-muted)" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
            <b className="text-zinc-100 font-semibold">{h.sp ?? '—'}°</b>
            <span className="text-zinc-500">Setpoint</span>
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="10" height="4" aria-hidden="true"><line x1="0" y1="2" x2="10" y2="2" stroke={HZ_COLOR} strokeWidth="2" /></svg>
            <b className="text-zinc-100 font-semibold">{h.hz} Hz</b>
            <span className="text-zinc-500">Compressor</span>
          </span>
          {(h.outdoor !== undefined || h.valves !== undefined) && (
            <span className="text-zinc-500">
              {h.outdoor !== undefined ? `exterior ${num(h.outdoor)}°` : ''}
              {h.valves !== undefined ? `${h.outdoor !== undefined ? ' · ' : ''}${h.valves}${h.zones !== undefined ? `/${h.zones}` : ''} válvulas abertas` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
