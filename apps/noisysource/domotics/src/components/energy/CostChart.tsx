import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { daysBetween, type Tariff } from '@shared/lib/energyBill';
import type { AutomationStatus } from '../../data/automation';
import { cachedHeatingDay, loadClimateDays, loadHeatingDay } from '../../data/heatingHistory';
import { HEATING_TONES, buildHeatingDay, type ClimateDay, type HeatingRecord } from '../../data/heatingTimeline';
import DayStrip, { StripLegend, useWidth, type StripSelection } from '../timeline/DayStrip';
import {
  COST_MARGINS, boughtText, eurText, hasPeak, hourFacts, moneyLine, movedBeyondTap, niceEur, pressOutcome, pumpHoursByBucket, pumpInBucket,
  pumpLaneOf, pumpText, rangePeriod, reconciliationText, vazioRuns, zoomPeriod, type CostBucket, type CostView, type PumpDayHours,
} from './costTimeline';
import { fmtDuration, periodLabel, type Period } from './view';

/**
 * "Custos": when the money went, how much, and what was going on at the time.
 * € bars on the page's buckets, split into vazio and fora de vazio, with the
 * pump under them on the same axis; a tap opens the bar, a mouse drag selects a
 * period. The maths is in costTimeline.ts, and the reconciliation under the
 * chart adds up to the "Custo do período" tile by construction.
 *
 * The bars never wait for the pump: its records load on their own, and without
 * them (signed out, a failed read) there's just no strip.
 */

const FORA = 'var(--viz-ink)';
const VAZIO = 'var(--viz-ink-2)';
const M = COST_MARGINS;
const TOP = 14;
const PANEL_H = 120;
const AXIS_H = 18;
const ROW_HEAD = 14;
const ROW_H = 16;
/** Longer periods go without the pump's row: a document per day isn't worth it there. */
const ROW_MAX_DAYS = 31;

const iconBtn = 'shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30';

interface Props {
  /** The period the figures are for. */
  period: Period;
  cost: CostView;
  tariff: Tariff;
  now: number;
  today: string;
  canRead: boolean;
  /** Bumped by the page's refresh button. */
  refresh: number;
  status?: AutomationStatus;
  /** False while another period is on its way: what's on screen is about to go. */
  interactive: boolean;
  badge?: ReactNode;
  /** Where "voltar" goes, if a bar was opened. */
  backTo?: Period;
  onBack: () => void;
  /** A bar opened or a range dragged; `bar` is what the opened bar showed. */
  onPeriod: (p: Period, bar?: CostBucket) => void;
  /** Said under the figures, when they need it. */
  note?: string;
}

const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');

export default function CostChart({
  period, cost, tariff, now, today, canRead, refresh, status, interactive, badge, backTo, onBack, onPeriod, note,
}: Props) {
  const { grain, buckets, peak, split } = cost;
  const [ref, width] = useWidth();
  const uid = safeId(useId());
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  /** Day view: the hour picked, by when it starts. Until there's one, the dearest. */
  const [pickedAt, setPickedAt] = useState<number | null>(null);
  /** Day view: a stretch tapped on the pump strip. */
  const [pickedStretch, setPickedStretch] = useState<StripSelection | null>(null);
  const press = useRef<{ id: number; type: string; x: number; y: number; i: number; moved: boolean } | null>(null);
  const periodKey = `${period.from}|${period.to}`;
  useEffect(() => { setHover(null); setPickedAt(null); setPickedStretch(null); setDrag(null); press.current = null; }, [periodKey]);

  // --- The pump, in its own time ------------------------------------------
  const [record, setRecord] = useState<{ date: string; record: HeatingRecord } | null>(null);
  const [climate, setClimate] = useState<{ key: string; days: Map<string, ClimateDay | null> } | null>(null);
  const date = period.from;
  const wantsStrip = canRead && grain === 'hour' && date <= today;
  const wantsRow = canRead && grain === 'day' && daysBetween(period.from, period.to) < ROW_MAX_DAYS;

  useEffect(() => {
    if (!wantsStrip) return;
    let live = true;
    const cached = cachedHeatingDay(date);
    if (cached) setRecord({ date, record: cached });
    // Bounded by heatingHistory: a past day is read once, today at most every 10 minutes.
    loadHeatingDay(date)
      .then(r => { if (live && r) setRecord({ date, record: r }); })
      .catch(() => { /* no strip; the bars don't depend on it */ });
    return () => { live = false; };
  }, [wantsStrip, date, refresh]);

  useEffect(() => {
    if (!wantsRow) return;
    let live = true;
    loadClimateDays(period.from, period.to)
      .then(days => { if (live) setClimate({ key: periodKey, days }); })
      .catch(() => { /* no row */ });
    return () => { live = false; };
  }, [wantsRow, period.from, period.to, periodKey, refresh]);

  const pumpDay = useMemo(() => {
    if (!wantsStrip || record?.date !== date) return null;
    try {
      const view = buildHeatingDay({ date, now, status, record: record.record });
      const pump = pumpLaneOf(view);
      return pump ? { view, ...pump } : null;
    } catch {
      return null; // A record it can't make sense of isn't worth losing the bars over.
    }
  }, [wantsStrip, date, record, now, status]);

  const pumpHours = useMemo(() => {
    if (!wantsRow || climate?.key !== periodKey || climate.days.size === 0) return null;
    return pumpHoursByBucket(buckets, climate.days);
  }, [wantsRow, climate, periodKey, buckets]);

  // --- Geometry -----------------------------------------------------------
  const showRow = grain !== 'hour' && !!pumpHours;
  const innerW = Math.max(1, width - M.left - M.right);
  const n = Math.max(1, buckets.length);
  const step = innerW / n;
  const barW = Math.max(2, Math.min(28, step * 0.72));
  const barX = (i: number) => M.left + i * step + (step - barW) / 2;
  const max = niceEur(cost.maxEur);
  const plotBottom = TOP + PANEL_H;
  const y = (eur: number) => plotBottom - (eur / max) * PANEL_H;
  const rowTop = plotBottom + AXIS_H + ROW_HEAD;
  const height = showRow ? rowTop + ROW_H + 2 : plotBottom + AXIS_H;
  const every = Math.max(1, Math.ceil(30 / step));
  const digits = max >= 100 ? 0 : max >= 10 ? 1 : 2;
  const tick = (v: number) => v.toFixed(digits).replace('.', ',');
  const t0 = buckets[0]?.start ?? 0;
  const t1 = buckets[buckets.length - 1]?.end ?? t0 + 1;
  const vazio = useMemo(
    () => (grain === 'hour' ? vazioRuns(t0, t1, tariff) : []),
    [grain, t0, t1, tariff],
  );
  const xt = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * innerW;

  const indexAtPx = (clientX: number, box: DOMRect) => {
    const px = ((clientX - box.left) / box.width) * width;
    return Math.max(0, Math.min(buckets.length - 1, Math.floor((px - M.left) / step)));
  };

  // --- Choosing -----------------------------------------------------------
  const peakIndex = peak ? buckets.indexOf(peak) : -1;
  const pickedIndex = pickedAt === null ? -1 : buckets.findIndex(b => b.start === pickedAt);
  const selected = grain !== 'hour' ? -1 : pickedIndex >= 0 ? pickedIndex : peakIndex;

  function activate(i: number) {
    if (!interactive) return;
    const b = buckets[i];
    if (!b) return;
    if (grain === 'hour') {
      setPickedAt(b.start);
      setPickedStretch(null);
      return;
    }
    const next = zoomPeriod(period, b, today);
    if (next) onPeriod(next, b);
  }

  function onPointerDown(e: PointerEvent<SVGRectElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const i = indexAtPx(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect());
    press.current = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, i, moved: false };
    setHover(i);
    // A finger already stays with its element; a mouse may wander off the chart mid-drag.
    if (e.pointerType === 'mouse') e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent<SVGRectElement>) {
    const i = indexAtPx(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect());
    setHover(i);
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && movedBeyondTap(p.x, p.y, e.clientX, e.clientY)) p.moved = true;
    if (p.moved && p.type === 'mouse' && grain !== 'hour' && interactive) setDrag({ a: p.i, b: i });
  }
  function onPointerUp(e: PointerEvent<SVGRectElement>) {
    const p = press.current;
    setDrag(null);
    if (!p) return;
    const to = indexAtPx(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect());
    const outcome = pressOutcome({ pointerType: p.type, moved: p.moved, canDrag: grain !== 'hour', from: p.i, to });
    if (outcome === 'range' && interactive) {
      const next = rangePeriod(period, buckets, p.i, to, today);
      if (next) onPeriod(next);
    }
    if (p.type !== 'mouse') setHover(null);
    // A tap is decided by the click that follows: the browser sends none if this touch was a scroll.
  }
  function onClick() {
    const p = press.current;
    press.current = null;
    if (p && !p.moved) activate(p.i);
  }
  function onCancel() {
    press.current = null;
    setDrag(null);
    setHover(null);
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = hover ?? (e.key === 'ArrowLeft' ? buckets.length : -1);
      setHover(Math.min(buckets.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if ((e.key === 'Enter' || e.key === ' ') && hover !== null) {
      e.preventDefault();
      activate(hover);
    }
  }

  const hovered = hover !== null ? buckets[hover] : null;
  const pointed = hovered ?? (selected >= 0 ? buckets[selected] : null);
  const pumpFor = (b: CostBucket): string | undefined => {
    if (grain === 'hour') return pumpDay ? pumpText(pumpInBucket(pumpDay.view.pump, b.start, b.end)) : undefined;
    const h = pumpHours?.[buckets.indexOf(b)];
    return h ? pumpDayText(h) : undefined;
  };
  const labelled = hover ?? (selected >= 0 ? selected : peakIndex);
  const labelBar = labelled >= 0 ? buckets[labelled] : null;
  const dragged = drag ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) } : null;

  const money = moneyLine(cost);
  const peakPump = peak ? pumpFor(peak) : undefined;
  const legendHas = (...states: CostBucket['state'][]) => buckets.some(b => states.includes(b.state));

  // --- The hour picked, day view ------------------------------------------
  const hourBucket = grain === 'hour' && selected >= 0 ? buckets[selected] : null;
  const hourPump = hourBucket && pumpDay ? pumpInBucket(pumpDay.view.pump, hourBucket.start, hourBucket.end) : null;
  const stretchSel: StripSelection | null = useMemo(() => {
    if (!pumpDay || !hourPump?.main) return null;
    if (pickedStretch && hourBucket && pickedStretch.t >= hourBucket.start && pickedStretch.t < hourBucket.end) return pickedStretch;
    const main = hourPump.main;
    const seg = pumpDay.lane.segments.find(s => s.from === main.from);
    return seg ? { lane: pumpDay.lane.id, id: seg.id, t: Math.max(main.from, hourBucket?.start ?? main.from) } : null;
  }, [pumpDay, hourPump?.main, pickedStretch, hourBucket]);
  const stretchDetail = stretchSel && pumpDay ? pumpDay.view.describe(stretchSel) : null;

  function onStripSelect(sel: StripSelection) {
    const i = buckets.findIndex(b => sel.t >= b.start && sel.t < b.end);
    if (i < 0) return;
    setPickedAt(buckets[i].start);
    setPickedStretch(sel);
  }
  function stepHour(dir: 1 | -1) {
    const i = Math.min(buckets.length - 1, Math.max(0, selected + dir));
    setPickedAt(buckets[i].start);
    setPickedStretch(null);
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h2 className="text-base font-semibold text-zinc-100">Custos</h2>
        {badge}
        {backTo && (
          <button type="button" onClick={onBack}
            className="ml-auto flex items-center gap-1.5 h-9 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200">
            <ArrowLeft size={14} className="shrink-0" />
            <span>Voltar a {periodLabel(backTo, today)}</span>
          </button>
        )}
      </div>

      <div className="flex flex-col gap-0.5" aria-live="polite">
        <p className="text-sm font-medium text-zinc-100 tabular-nums leading-snug">{money}</p>
        {peak && hasPeak(cost) && (
          <p className="text-[11px] text-zinc-400 tabular-nums leading-snug first-letter:uppercase">
            {boughtText(peak)}{peakPump ? ` · ${peakPump.charAt(0).toLowerCase()}${peakPump.slice(1)}` : ''}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--viz-ink-2)]">
        <span className="text-zinc-500">€ por {grain === 'hour' ? 'hora' : grain === 'day' ? 'dia' : 'mês'}</span>
        <Swatch color={FORA} label="Fora de vazio" />
        <Swatch color={VAZIO} label="Vazio" />
        {legendHas('nodata') && <PatternSwatch uid={`${uid}-lg`} kind="gap" label="Sem dados" />}
        {legendHas('pending') && <PatternSwatch uid={`${uid}-lg`} kind="wait" label="A chegar" />}
        {legendHas('partial') && (
          <span className="flex items-center gap-1.5">
            <svg width="14" height="4" aria-hidden="true"><line x1="0" y1="2" x2="14" y2="2" stroke="var(--viz-muted)" strokeWidth="2" strokeDasharray="2 2" /></svg>
            Incompleto
          </span>
        )}
      </div>

      <div ref={ref} className="relative flex flex-col gap-1">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="group"
          aria-label={`Custo da energia por ${grain === 'hour' ? 'hora' : grain === 'day' ? 'dia' : 'mês'}. ${money}. Setas para percorrer, Enter para ${grain === 'hour' ? 'ver o detalhe' : 'abrir'}.`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className="block overflow-visible outline-none select-none focus-visible:ring-1 focus-visible:ring-[color:var(--viz-axis)] rounded"
          style={{ fontFamily: 'inherit' }}
        >
          <defs>
            <PatternDefs uid={uid} />
          </defs>

          {/* Vazio hours, behind everything. */}
          {vazio.map(r => (
            <rect key={r.from} x={xt(r.from)} y={TOP} width={xt(r.to) - xt(r.from)} height={PANEL_H} fill="var(--viz-ink)" opacity={0.045} />
          ))}
          {selected >= 0 && hover === null && (
            <rect x={M.left + selected * step} y={TOP} width={step} height={PANEL_H} fill="var(--viz-ink)" opacity={0.08} />
          )}
          {hover !== null && (
            <rect x={M.left + hover * step} y={TOP} width={step} height={PANEL_H} fill="var(--viz-ink)" opacity={0.08} />
          )}

          {/* Scale */}
          {[0, max / 2, max].map(v => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
              <text x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--viz-muted)" className="tabular-nums">{tick(v)}</text>
            </g>
          ))}

          {buckets.map((b, i) => {
            if (b.state === 'future') return null;
            // No figure isn't a low figure: the whole height is marked as not known.
            if (b.eur === null) {
              return (
                <rect key={i} x={M.left + i * step + 0.5} y={TOP} width={Math.max(1, step - 1)} height={PANEL_H}
                  fill={`url(#${uid}-${b.state === 'nodata' ? 'gap' : 'wait'})`} />
              );
            }
            const yVazio = y(b.eurVazio);
            const yTop = y(b.eur);
            const rough = b.state === 'partial' || b.until !== undefined;
            return (
              <g key={i}>
                {/* A real 0 €: a small mark, where a gap has its hatching. */}
                {b.eur <= 0 && <rect x={barX(i)} y={plotBottom - 1.5} width={barW} height={1.5} fill="var(--viz-muted)" />}
                {b.eurVazio > 0 && (
                  <rect x={barX(i)} y={yVazio} width={barW} height={Math.max(0.5, plotBottom - yVazio)} fill={VAZIO}
                    stroke="var(--viz-surface)" strokeWidth={step > 8 ? 0.75 : 0} />
                )}
                {b.eurFora > 0 && (
                  <rect x={barX(i)} y={yTop} width={barW} height={Math.max(0.5, yVazio - yTop)} fill={FORA}
                    stroke="var(--viz-surface)" strokeWidth={step > 8 ? 0.75 : 0} />
                )}
                {/* Incomplete, or still running: a short bar isn't to be read as a quiet hour. */}
                {rough && (
                  <line x1={barX(i)} x2={barX(i) + barW} y1={plotBottom + 3} y2={plotBottom + 3}
                    stroke="var(--viz-muted)" strokeWidth={2} strokeDasharray="2 2" />
                )}
              </g>
            );
          })}

          {/* The figure on the bar that matters. */}
          {labelBar?.eur != null && labelBar.eur >= 0.005 && (
            <text
              x={Math.min(width - M.right - 14, Math.max(M.left + 14, barX(labelled) + barW / 2))}
              y={Math.max(10, y(labelBar.eur) - 4)}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill="var(--viz-ink)"
              className="tabular-nums"
              style={{ paintOrder: 'stroke', stroke: 'var(--viz-surface)', strokeWidth: 3 }}
            >
              {labelBar.eur.toFixed(2).replace('.', ',')}
            </text>
          )}

          {grain === 'hour' && now >= t0 && now <= t1 && (
            <line x1={xt(now)} x2={xt(now)} y1={TOP} y2={plotBottom} stroke="var(--viz-ink)" strokeWidth={1} opacity={0.5} />
          )}

          {dragged && (
            <rect x={M.left + dragged.a * step} y={TOP} width={(dragged.b - dragged.a + 1) * step} height={PANEL_H}
              fill="var(--viz-ink)" opacity={0.14} stroke="var(--viz-ink)" strokeWidth={1} />
          )}

          {/* Time axis */}
          {buckets.map((b, i) => i % every === 0 && (
            <text key={`l${i}`} x={M.left + i * step + step / 2} y={plotBottom + 15} textAnchor="middle" fontSize={10}
              fill="var(--viz-muted)" className="tabular-nums">
              {b.label}
            </text>
          ))}

          {/* Week and month: the pump's hours per day, on the same columns. */}
          {showRow && pumpHours && (
            <PumpRow hours={pumpHours} left={M.left} top={rowTop} height={ROW_H} step={step} barX={barX} barW={barW} />
          )}

          {/* Pointer target over the whole plot. `pan-y`: a vertical swipe still scrolls the page. */}
          <rect
            x={M.left}
            y={0}
            width={innerW}
            height={height}
            fill="transparent"
            style={{ touchAction: 'pan-y', cursor: interactive ? 'pointer' : undefined }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { if (!press.current) setHover(null); }}
            onPointerCancel={onCancel}
            onClick={onClick}
          />
        </svg>

        {pumpDay && (
          <div className="flex flex-col gap-1">
            <DayStrip
              from={t0}
              to={t1}
              lanes={[pumpDay.lane]}
              tones={HEATING_TONES}
              now={pumpDay.view.now}
              margins={M}
              highlight={pointed ? { from: pointed.start, to: pointed.end } : null}
              hideAxisLabels
              selection={stretchSel}
              onSelect={onStripSelect}
              ariaLabel="O que a bomba fez, na mesma escala de horas das barras. Setas para mudar de troço."
            />
            <StripLegend tones={HEATING_TONES} keys={pumpDay.legend} />
          </div>
        )}

        {hovered && hover !== null && (
          <Tooltip b={hovered} pump={pumpFor(hovered)} grain={grain} flip={M.left + hover * step > width / 2} canOpen={grain !== 'hour' && hovered.state !== 'future'} />
        )}
      </div>

      {hourBucket && (
        <div className="flex items-stretch gap-1.5 rounded-lg bg-zinc-950/60 border border-zinc-800 p-1.5">
          <button type="button" className={iconBtn} aria-label="Hora anterior" disabled={selected <= 0} onClick={() => stepHour(-1)}>
            <ChevronLeft size={15} />
          </button>
          <div aria-live="polite" className="flex-1 min-w-0 flex flex-col gap-1 py-1 self-center">
            <p className="text-xs text-zinc-100 leading-snug tabular-nums">
              <b className="font-semibold">{hourBucket.title}</b>{' · '}{eurText(hourBucket)}
            </p>
            {hourFacts(hourBucket).map(line => (
              <p key={line} className="text-[11px] text-zinc-400 leading-snug tabular-nums">{line}</p>
            ))}
            {hourPump && pumpText(hourPump) && (
              <p className="text-[11px] text-zinc-300 leading-snug tabular-nums">
                <b className="font-semibold">{pumpText(hourPump)}.</b>
                {stretchDetail ? ` ${stretchDetail.text}` : ''}
              </p>
            )}
          </div>
          <button type="button" className={iconBtn} aria-label="Hora seguinte" disabled={selected >= buckets.length - 1} onClick={() => stepHour(1)}>
            <ChevronRight size={15} />
          </button>
        </div>
      )}
      {grain === 'hour' && !hourBucket && (
        <p className="text-[11px] text-zinc-500 leading-snug">Toque numa hora para ver o detalhe.</p>
      )}

      <div className="flex flex-col gap-1">
        <p className="text-xs text-zinc-300 leading-relaxed tabular-nums">{reconciliationText(split, cost.incomplete)}</p>
        {note && <p className="text-[11px] text-amber-300/90 leading-snug">{note}</p>}
        <p className="text-[11px] text-zinc-500 leading-snug">
          As barras são o que varia com a energia comprada: o preço do kWh, o IEC e o IVA deles. Potência, contribuição audiovisual e DGEG
          contam pelos dias, não pela hora.
          {grain !== 'hour' && (
            <>
              {' '}Toque numa barra para a abrir<span className="hidden [@media(hover:hover)]:inline">, ou arraste com o rato para escolher um período</span>.
            </>
          )}
        </p>
      </div>
    </section>
  );
}

/** '8 h 15 min ligada', a lower bound if the readings are incomplete. */
function pumpDayText(h: PumpDayHours): string {
  return `Bomba ligada ${h.incomplete ? 'pelo menos ' : ''}${fmtDuration(h.hours * 3600)}`;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

/** The two "no figure" textures: hatching for a gap, dots for what's on its way. */
function PatternDefs({ uid }: { uid: string }) {
  return (
    <>
      <pattern id={`${uid}-gap`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={1.8} height={6} fill="var(--viz-axis)" />
      </pattern>
      <pattern id={`${uid}-wait`} width={5} height={5} patternUnits="userSpaceOnUse">
        <circle cx={2.5} cy={2.5} r={0.9} fill="var(--viz-axis)" />
      </pattern>
    </>
  );
}

function PatternSwatch({ uid, kind, label }: { uid: string; kind: 'gap' | 'wait'; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="12" height="10" aria-hidden="true" className="shrink-0">
        <defs><PatternDefs uid={uid} /></defs>
        <rect width="12" height="10" fill={`url(#${uid}-${kind})`} stroke="var(--viz-axis)" strokeWidth={0.5} />
      </svg>
      {label}
    </span>
  );
}

function PumpRow({ hours, left, top, height, step, barX, barW }: {
  hours: Array<PumpDayHours | null | undefined>;
  left: number;
  top: number;
  height: number;
  step: number;
  barX: (i: number) => number;
  barW: number;
}) {
  const bottom = top + height;
  return (
    <g>
      <text x={left} y={top - 4} fontSize={10} fontWeight={600} fill="var(--viz-ink-2)">Bomba · horas ligada</text>
      <line x1={left} x2={left + step * hours.length} y1={bottom} y2={bottom} stroke="var(--viz-axis)" strokeWidth={1} />
      {hours.map((h, i) => {
        if (h === undefined) return null;
        // A day with no reading isn't a day it was off.
        if (h === null) {
          return <line key={i} x1={barX(i)} x2={barX(i) + barW} y1={bottom - 2} y2={bottom - 2} stroke="var(--viz-muted)" strokeWidth={1.5} strokeDasharray="2 2" />;
        }
        // Room for the figure: the figure. A month on a phone: how much of the day, as a bar.
        if (step >= 26) {
          return (
            <text key={i} x={barX(i) + barW / 2} y={bottom - 4} textAnchor="middle" fontSize={10} fontWeight={600}
              fill={h.incomplete ? 'var(--viz-ink-2)' : 'var(--viz-ink)'} className="tabular-nums">
              {h.incomplete ? '≥ ' : ''}{Math.round(h.hours)} h
            </text>
          );
        }
        const bar = Math.max(1, Math.min(1, h.hours / 24) * height);
        return <rect key={i} x={barX(i)} y={bottom - bar} width={barW} height={bar} fill="var(--viz-ink-2)" opacity={h.incomplete ? 0.5 : 0.8} />;
      })}
    </g>
  );
}

function Tooltip({ b, pump, grain, flip, canOpen }: { b: CostBucket; pump?: string; grain: string; flip: boolean; canOpen: boolean }) {
  const row = (color: string, label: string, eur: number, kwh: number) => (
    <span className="flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-sm" style={{ background: color }} aria-hidden="true" />
      <span className="text-zinc-400">{label}</span>
      <b className="ml-auto pl-3 text-zinc-100 font-semibold">{eur.toFixed(2).replace('.', ',')} €</b>
      <span className="text-zinc-500">{kwh.toFixed(1).replace('.', ',')} kWh</span>
    </span>
  );
  return (
    // Against the chart's own edges, away from the pointer: it must never widen the page on a phone.
    <div className={`pointer-events-none absolute z-10 top-0 w-60 max-w-full rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-2 text-[11px] shadow-lg flex flex-col gap-0.5 tabular-nums ${flip ? 'left-0' : 'right-0'}`}>
      <span className="text-zinc-300 font-medium">{b.title}</span>
      <span className="text-zinc-100 font-semibold">{eurText(b)}</span>
      {b.eur !== null && (
        <>
          {b.eurFora > 0 && row(FORA, 'fora de vazio', b.eurFora, b.kwhFora)}
          {b.eurVazio > 0 && row(VAZIO, 'vazio', b.eurVazio, b.kwhVazio)}
        </>
      )}
      {pump && <span className="mt-0.5 text-zinc-300">{pump}</span>}
      {b.state === 'partial' && <span className="text-amber-300">Dados incompletos: o custo real pode ser maior.</span>}
      {b.state === 'nodata' && <span className="text-zinc-500">Nada registado, o que não quer dizer 0 €.</span>}
      {b.state === 'pending' && <span className="text-zinc-500">A ponte envia de hora a hora.</span>}
      {b.until !== undefined && b.state !== 'partial' && <span className="text-zinc-500">Até agora.</span>}
      {canOpen && <span className="mt-0.5 text-zinc-500">Toque para ver {grain === 'month' ? 'este mês' : 'este dia'}.</span>}
    </div>
  );
}
