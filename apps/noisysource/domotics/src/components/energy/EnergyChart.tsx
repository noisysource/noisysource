import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { coverageOf, fmtHM, fmtKwh, fmtPct, stacks, type Bucket, type Grain } from './view';
import { derivedFlows } from '@shared/lib/energyBill';

/**
 * kWh over time, two panels on one time axis and one kWh scale:
 * - top: the house's consumption, by where it came from (sun, battery, grid);
 * - bottom: the panels' production, by where it went (house, battery, grid).
 * The same colour means the same counterpart in both, and a shared scale means
 * a bar in one panel can be compared with the bar under it. In the day view a
 * third, thin panel has the battery's % and the vazio hours are shaded.
 *
 * Same conventions as the Reports page's PumpChart: SVG, `--viz-*` tokens,
 * crosshair on hover/touch, ←/→ from the keyboard, no chart library.
 */

interface Props {
  buckets: Bucket[];
  grain: Grain;
  /** Day view: battery % through the day. */
  soc?: Array<{ t: number; soc: number }>;
}

const SOLAR = 'var(--viz-solar)';
const BATTERY = 'var(--viz-battery)';
const GRID = 'var(--viz-net)';

const M = { left: 40, right: 10, top: 18 };
const PANEL_H = 130;
const GAP = 34;
const SOC_H = 44;
const AXIS_H = 20;

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

/** A round top for the scale: 1, 2, 2.5 or 5 × 10ⁿ Wh. */
function niceMax(wh: number): number {
  if (wh <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(wh));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= wh) return m * p;
  return 10 * p;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

export default function EnergyChart({ buckets, grain, soc }: Props) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  // A new period: the old crosshair means nothing.
  useEffect(() => setHover(null), [buckets]);
  const showSoc = grain === 'hour' && !!soc?.length;

  const geo = useMemo(() => {
    const n = Math.max(1, buckets.length);
    const innerW = width - M.left - M.right;
    const step = innerW / n;
    const barW = Math.max(2, Math.min(28, step * 0.72));
    const x = (i: number) => M.left + i * step + (step - barW) / 2;
    const max = niceMax(Math.max(...buckets.map(b => Math.max(b.flows.load, b.flows.pv)), 0));
    const top1 = M.top;
    const top2 = M.top + PANEL_H + GAP;
    const top3 = top2 + PANEL_H + GAP;
    const y = (top: number, wh: number) => top + PANEL_H - (wh / max) * PANEL_H;
    const height = (showSoc ? top3 + SOC_H : top2 + PANEL_H) + AXIS_H;
    // Labels no closer than ~30 px.
    const every = Math.max(1, Math.ceil(30 / step));
    return { n, step, barW, x, max, top1, top2, top3, y, height, every, innerW };
  }, [buckets, width, showSoc]);

  const { step, barW, x, max, top1, top2, top3, y, height, every } = geo;
  const h = hover !== null ? buckets[hover] : null;

  function onMove(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    setHover(Math.max(0, Math.min(buckets.length - 1, Math.floor((px - M.left) / step))));
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = hover ?? (e.key === 'ArrowLeft' ? buckets.length : -1);
    setHover(Math.min(buckets.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1))));
  }

  /** One stacked bar, bottom up; a hairline of the surface colour between segments. */
  function stack(i: number, top: number, parts: Array<[number, string]>) {
    let base = 0;
    return parts.map(([wh, color], k) => {
      if (wh <= 0) return null;
      const y0 = y(top, base);
      const y1 = y(top, base + wh);
      base += wh;
      return (
        <rect key={k} x={x(i)} y={y1} width={barW} height={Math.max(0.5, y0 - y1)} fill={color}
          stroke="var(--viz-surface)" strokeWidth={step > 8 ? 0.75 : 0} />
      );
    });
  }

  const ticks = [0, max / 2, max];
  // One number of decimals for the whole axis.
  const tickDigits = max >= 10_000 ? 0 : max >= 1000 ? 1 : 2;
  const tick = (wh: number) => (wh / 1000).toFixed(tickDigits).replace('.', ',');
  const panel = (top: number, title: string) => (
    <g>
      <text x={M.left} y={top - 6} fontSize={11} fill="var(--viz-ink-2)" fontWeight={600}>{title}</text>
      {ticks.map(v => (
        <g key={v}>
          <line x1={M.left} x2={width - M.right} y1={y(top, v)} y2={y(top, v)} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
          <text x={M.left - 6} y={y(top, v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">
            {tick(v)}
          </text>
        </g>
      ))}
    </g>
  );

  const socPts = showSoc ? soc! : [];
  const t0 = buckets[0]?.start ?? 0;
  const t1 = buckets[buckets.length - 1]?.end ?? t0 + 1;
  const xt = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * geo.innerW;
  const ys = (v: number) => top3 + SOC_H - (v / 100) * SOC_H;

  return (
    <div ref={ref} className="relative flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--viz-ink-2)]">
        <Swatch color={SOLAR} label="Sol (direto)" />
        <Swatch color={BATTERY} label="Bateria" />
        <Swatch color={GRID} label="Rede" />
        {grain === 'hour' && (
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2.5 rounded-sm bg-zinc-100/10 border border-zinc-700" aria-hidden="true" /> Vazio
          </span>
        )}
        {showSoc && (
          <span className="flex items-center gap-1.5">
            <svg width="14" height="4" aria-hidden="true"><line x1="0" y1="2" x2="14" y2="2" stroke="var(--viz-soc)" strokeWidth="2" strokeLinecap="round" /></svg>
            Bateria %
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="Energia ao longo do período: consumo da casa por origem e produção solar por destino"
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="overflow-visible outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--viz-axis)] rounded"
        style={{ fontFamily: 'inherit' }}
      >
        {/* Vazio hours, behind everything. */}
        {grain === 'hour' && buckets.map((b, i) => b.vazio && (
          <rect key={`v${i}`} x={M.left + i * step} y={top1} width={step + 0.5}
            height={(showSoc ? top3 + SOC_H : top2 + PANEL_H) - top1} fill="var(--viz-ink)" opacity={0.045} />
        ))}
        {hover !== null && (
          <rect x={M.left + hover * step} y={top1} width={step}
            height={(showSoc ? top3 + SOC_H : top2 + PANEL_H) - top1} fill="var(--viz-ink)" opacity={0.07} />
        )}

        {panel(top1, 'Consumo da casa — de onde veio · kWh')}
        {panel(top2, 'Produção solar — para onde foi · kWh')}

        {buckets.map((b, i) => {
          const s = stacks(b.flows);
          const cov = coverageOf(b.coveredSec, b.expectedSec);
          const past = b.expectedSec > 0;
          return (
            <g key={i}>
              {stack(i, top1, [[s.house.solar, SOLAR], [s.house.battery, BATTERY], [s.house.grid, GRID]])}
              {stack(i, top2, [[s.solar.house, SOLAR], [s.solar.battery, BATTERY], [s.solar.grid, GRID]])}
              {/* Incomplete data: a dashed mark under the bar, so a short bar isn't read as a quiet hour. */}
              {past && cov < 0.9 && (
                <line x1={x(i)} x2={x(i) + barW} y1={top1 + PANEL_H + 4} y2={top1 + PANEL_H + 4}
                  stroke="var(--viz-muted)" strokeWidth={2} strokeDasharray="2 2" />
              )}
            </g>
          );
        })}

        {showSoc && (
          <g>
            <text x={M.left} y={top3 - 6} fontSize={11} fill="var(--viz-ink-2)" fontWeight={600}>Bateria</text>
            {[0, 50, 100].map(v => (
              <g key={v}>
                <line x1={M.left} x2={width - M.right} y1={ys(v)} y2={ys(v)} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
                <text x={M.left - 6} y={ys(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">{v}%</text>
              </g>
            ))}
            <path
              d={socPts.map((p, k) => {
                // Break the line across a gap of more than half an hour.
                const jump = k > 0 && p.t - socPts[k - 1].t > 30 * 60_000;
                return `${k === 0 || jump ? 'M' : 'L'}${xt(p.t).toFixed(1)},${ys(p.soc).toFixed(1)}`;
              }).join('')}
              fill="none" stroke="var(--viz-soc)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
            />
          </g>
        )}

        {/* Time axis */}
        {buckets.map((b, i) => i % every === 0 && (
          <text key={`l${i}`} x={M.left + i * step + step / 2} y={height - 6} textAnchor="middle" fontSize={10}
            fill="var(--viz-muted)" className="tabular-nums">
            {b.label}
          </text>
        ))}

        {/* Pointer target over the whole plot. */}
        <rect x={M.left} y={top1} width={Math.max(0, width - M.left - M.right)}
          height={(showSoc ? top3 + SOC_H : top2 + PANEL_H) - top1}
          fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
      </svg>

      {h && hover !== null && (
        <Tooltip
          b={h}
          soc={showSoc ? socPts.filter(p => p.t <= h.end).at(-1)?.soc : undefined}
          leftPct={((M.left + hover * step + step / 2) / width) * 100}
          flip={M.left + hover * step > width / 2}
        />
      )}
    </div>
  );
}

function Tooltip({ b, soc, leftPct, flip }: { b: Bucket; soc?: number; leftPct: number; flip: boolean }) {
  const s = stacks(b.flows);
  const d = derivedFlows(b.flows);
  const cov = coverageOf(b.coveredSec, b.expectedSec);
  const row = (color: string, label: string, wh: number) => (
    <span className="flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-sm" style={{ background: color }} aria-hidden="true" />
      <span className="text-zinc-400">{label}</span>
      <b className="ml-auto pl-3 text-zinc-100 font-semibold">{fmtKwh(wh)}</b>
    </span>
  );
  return (
    <div
      className="pointer-events-none absolute z-10 top-6 w-56 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-2 text-[11px] shadow-lg flex flex-col gap-0.5 tabular-nums"
      style={{ left: `${leftPct}%`, transform: flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}
    >
      <span className="text-zinc-300 font-medium">{b.title}{b.vazio ? ' · vazio' : ''}</span>
      {b.expectedSec === 0 ? (
        <span className="text-zinc-500">Ainda não aconteceu.</span>
      ) : b.coveredSec === 0 ? (
        <span className="text-zinc-500">Sem dados.</span>
      ) : (
        <>
          <span className="mt-1 text-zinc-500">Casa · {fmtKwh(b.flows.load)}</span>
          {row(SOLAR, 'do sol', s.house.solar)}
          {row(BATTERY, 'da bateria', s.house.battery)}
          {row(GRID, 'da rede', s.house.grid)}
          <span className="mt-1 text-zinc-500">Solar · {fmtKwh(b.flows.pv)}</span>
          {row(SOLAR, 'para a casa', s.solar.house)}
          {row(BATTERY, 'para a bateria', s.solar.battery)}
          {row(GRID, 'para a rede', s.solar.grid)}
          {b.flows.gridBat > 0 && <span className="mt-1 text-zinc-400">Bateria carregada da rede: {fmtKwh(b.flows.gridBat)}</span>}
          {d.selfSufficiency !== undefined && <span className="mt-1 text-zinc-400">Autossuficiência {fmtPct(d.selfSufficiency)}</span>}
          {soc !== undefined && <span className="text-zinc-400">Bateria no fim: {soc}%</span>}
          {cov < 0.9 && <span className="mt-1 text-amber-300">Dados incompletos ({fmtPct(cov)} do tempo).</span>}
          {b.expectedSec < (b.end - b.start) / 1000 && <span className="text-zinc-500">Até às {fmtHM(b.start + b.expectedSec * 1000)}.</span>}
        </>
      )}
    </div>
  );
}
