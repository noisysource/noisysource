import { useEffect, useRef, useState } from 'react';
import {
  endPhrase, fmtDateTime, fmtTime, hourOfDay, num, tripContext, type FaultIncident,
} from '../../data/incidents';

/** Shared by the Reports page and the technicians' printout. */

export interface StripDot {
  at: number;
  /** Which legend entry: index into `kinds`. */
  kind: number;
  title: string;
}

/**
 * When in the day things happened: one dot per event on a 0–24 h line. The
 * question it answers is "is there a pattern?" — the 00:54 switch-offs on
 * three nights, or trips at any hour. Dots that would overlap stack upwards.
 */
export function TimeStrip({ dots, kinds }: { dots: StripDot[]; kinds: Array<{ label: string; color: string }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = 8, R = 8, ROW = 13;
  const x = (h: number) => L + (h / 24) * (width - L - R);
  const placed: Array<StripDot & { h: number; row: number }> = [];
  for (const d of [...dots].sort((a, b) => hourOfDay(a.at) - hourOfDay(b.at))) {
    const h = hourOfDay(d.at);
    let row = 0;
    while (placed.some(p => p.row === row && Math.abs(x(p.h) - x(h)) < 11) && row < 2) row++;
    placed.push({ ...d, h, row });
  }
  // As tall as the stacked dots need, no more.
  const BASE = 20 + ROW * Math.max(0, ...placed.map(p => p.row));
  const f = focus !== null ? placed[focus] : null;

  return (
    <div ref={ref} className="relative flex flex-col gap-1.5 print-avoid-break">
      {kinds.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[color:var(--viz-ink-2)]">
          {kinds.map(k => (
            <span key={k.label} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: k.color }} aria-hidden="true" />{k.label}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${BASE + 18}`} width="100%" role="img" aria-label="Hora do dia de cada ocorrência" className="overflow-visible">
        <line x1={L} x2={width - R} y1={BASE} y2={BASE} stroke="var(--viz-axis)" strokeWidth={1} />
        {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(hh => (
          <g key={hh}>
            <line x1={x(hh)} x2={x(hh)} y1={BASE} y2={BASE + 3} stroke="var(--viz-axis)" strokeWidth={1} />
            <text x={x(hh)} y={BASE + 14} textAnchor="middle" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">
              {String(hh).padStart(2, '0')}h
            </text>
          </g>
        ))}
        {placed.map((d, i) => (
          <g
            key={i}
            tabIndex={0}
            onPointerEnter={() => setFocus(i)}
            onPointerLeave={() => setFocus(null)}
            onFocus={() => setFocus(i)}
            onBlur={() => setFocus(null)}
            className="outline-none cursor-default"
          >
            <title>{d.title}</title>
            <circle cx={x(d.h)} cy={BASE - 8 - d.row * ROW} r={12} fill="transparent" />
            <circle cx={x(d.h)} cy={BASE - 8 - d.row * ROW} r={focus === i ? 5.5 : 4.5}
              fill={kinds[d.kind]?.color ?? 'var(--viz-1)'} stroke="var(--viz-surface)" strokeWidth={2} />
          </g>
        ))}
      </svg>
      {f && (
        <div
          className="pointer-events-none absolute z-10 -top-1 rounded-md border border-zinc-700 bg-zinc-950/95 px-2 py-1 text-[11px] text-zinc-200 whitespace-nowrap print:hidden"
          style={{ left: `${(x(f.h) / width) * 100}%`, transform: x(f.h) > width / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}
        >
          {f.title}
        </div>
      )}
    </div>
  );
}

const cell = 'px-2 py-1.5 text-left align-top';

/**
 * The trips side by side, as the first hand-written report had them: what the
 * pump was doing in the minutes before, and how it ended. Only trips with
 * readings; the rest are in the occurrence list.
 */
export function TripTable({ trips, light = false }: { trips: FaultIncident[]; light?: boolean }) {
  const rows = trips.map(f => ({ f, c: tripContext(f) })).filter(r => r.c);
  if (rows.length === 0) return null;
  const head = light ? 'text-[color:var(--viz-ink-2)] border-b border-[color:var(--viz-axis)]' : 'text-zinc-500 border-b border-zinc-800';
  const line = light ? 'border-b border-[color:var(--viz-grid)]' : 'border-b border-zinc-800/60';
  return (
    <div className="overflow-x-auto -mx-1 print-avoid-break">
      <table className="w-full text-xs tabular-nums border-collapse">
        <thead>
          <tr className={head}>
            <th className={cell}>Disparo</th>
            <th className={cell}>Água (setpoint)</th>
            <th className={cell}>Parada no setpoint antes</th>
            <th className={cell}>Compressor (~3 min antes → disparo)</th>
            <th className={cell}>Descarga (~3 min antes → disparo)</th>
            <th className={cell}>Exterior</th>
            <th className={cell}>Válvulas abertas</th>
            <th className={cell}>Fim</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ f, c }) => (
            <tr key={f.id} className={line}>
              <td className={`${cell} whitespace-nowrap font-medium`}>{fmtDateTime(f.at)}</td>
              <td className={`${cell} whitespace-nowrap`}>{num(c!.last.out)}° ({c!.last.sp ?? '—'}°)</td>
              <td className={cell}>{c!.idleMin > 0 ? `${c!.idleMin} min` : '—'}</td>
              <td className={`${cell} whitespace-nowrap`}>{c!.hzBefore ?? '—'} → {c!.hzMax ?? '—'} Hz</td>
              <td className={`${cell} whitespace-nowrap`}>
                {num(c!.disBefore)}° → {num(c!.disAt)}°
                {c!.disRise !== undefined && <b className="font-semibold"> (+{num(c!.disRise, 0)}°)</b>}
              </td>
              <td className={cell}>{num(c!.last.outdoor)}°</td>
              <td className={cell}>{c!.last.valves ?? '—'}{c!.last.zones !== undefined ? ` de ${c!.last.zones}` : ''}</td>
              <td className={cell}>{f.lockout ? 'bloqueou — ' : ''}{endPhrase(f)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The last few readings before a trip and the first one in fault — the table under each chart in the printout. */
export function MinutesBefore({ f, light = false }: { f: FaultIncident; light?: boolean }) {
  const rows = [...f.before.slice(-4), ...f.after.slice(0, 1)];
  if (rows.length === 0) return null;
  const head = light ? 'text-[color:var(--viz-ink-2)] border-b border-[color:var(--viz-axis)]' : 'text-zinc-500 border-b border-zinc-800';
  return (
    <table className="w-full text-xs tabular-nums border-collapse print-avoid-break">
      <thead>
        <tr className={head}>
          <th className={cell}>Hora</th><th className={cell}>Compressor</th><th className={cell}>Água saída</th>
          <th className={cell}>Água entrada</th><th className={cell}>Descarga</th><th className={cell}>Setpoint</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(s => {
          const tripRow = s.faults.length > 0;
          return (
            <tr key={s.t} className={tripRow ? 'font-semibold' : ''}>
              <td className={`${cell} whitespace-nowrap`}>
                {tripRow && <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: 'var(--viz-critical)' }} aria-hidden="true" />}
                {fmtTime(s.t, true)}{tripRow ? ` · ${s.faults.join(', ')}` : ''}
              </td>
              <td className={cell}>{s.hz} Hz</td>
              <td className={cell}>{num(s.out)} °C</td>
              <td className={cell}>{num(s.inn)} °C</td>
              <td className={cell}>{num(s.dis)} °C</td>
              <td className={cell}>{s.sp ?? '—'} °C</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
