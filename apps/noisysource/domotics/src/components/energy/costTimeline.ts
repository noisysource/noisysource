import {
  SLOT_MS, computeBill, isVazio, lisbonDate, type Bill, type BillLine, type EnergyDay, type Tariff,
} from '@shared/lib/energyBill';
import type { ClimateDay, HeatingDayView, PumpStretch } from '../../data/heatingTimeline';
import { isLine, type SegmentLane, type StripMargins } from '../timeline/stripLogic';
import { coverageOf, fmtDuration, fmtEur, fmtHM, fmtKwh, fmtPct, grainOf, periodContaining, stacks, type Bucket, type Grain, type Period } from './view';

/**
 * The Energia page's cost chart, without React: which euros go in the bars and
 * which don't, what a tap means, and what the pump did meanwhile.
 *
 * In the bars: what varies with the energy bought from the grid, which is the
 * kWh lines of computeBill (`vazio`, `fora`, `iec`) and the VAT on them.
 * Fixed: `power`, `cav`, `dgeg` and the VAT on those, which run by the day.
 * The bill itself is the only source of the numbers: `fixed` is the same bill
 * with no energy, and the bars share out the difference, so bars + fixed − export
 * credit is the "Custo do período" tile to the cent, rounding included.
 *
 * The one thing that has no per-slot answer is the reduced VAT: it covers the
 * first kWh of the *period*, at the period's average price, not any hour in
 * particular. So every slot carries the period's mix, and a dear day comes out
 * higher in its own view than in the month's (tens of cents on a 30 kWh day).
 */

/** Below this share of its time with readings, a bucket's figure is a lower bound. Same as EnergyChart's mark. */
const COMPLETE_SHARE = 0.9;
/** The bars' margins, which the pump strip under them takes too, so an hour sits over itself. */
export const COST_MARGINS: StripMargins = { left: 40, right: 10 };

const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// The bill, split
// ---------------------------------------------------------------------------

export interface CostSplit {
  /** € in the bars: kWh lines and their VAT. Whole cents. */
  energy: number;
  /** € that isn't: power, CAV, DGEG and their VAT. Whole cents. */
  fixed: number;
  /** € paid for what was sent to the grid; 0 without an export price. */
  credit: number;
  /** The bill's total, which is what the tile shows. energy + fixed − credit. */
  total: number;
  /** `energy`, by tariff period. */
  vazio: number;
  fora: number;
}

/**
 * `actual`, as computed for these kWh over these `days`, into what the bars carry
 * and what they don't. Lines are rounded to the cent on a bill and VAT by rate,
 * and those rounding cents end up in `energy`.
 */
export function splitBill(actual: Bill, kwh: { vazio: number; fora: number }, days: number, tariff: Tariff): CostSplit {
  const fixed = computeBill({ kwhVazio: 0, kwhFora: 0, kwhExport: 0, days }, tariff).total;
  const energy = r2(actual.total + actual.exportCredit - fixed);
  const net = (key: BillLine['key']) => actual.lines.find(l => l.key === key)?.net ?? 0;
  const netVazio = net('vazio');
  const energyNet = netVazio + net('fora');
  const iecGross = net('iec') * (1 + tariff.vatStandard / 100);
  const all = kwh.vazio + kwh.fora;
  let vazio = 0;
  if (all > 0) {
    const share = kwh.vazio / all;
    // The VAT left once the IEC has its own goes with the price; IEC goes with the kWh.
    vazio = energyNet > 0
      ? netVazio + iecGross * share + (energy - energyNet - iecGross) * (netVazio / energyNet)
      : energy * share;
  }
  vazio = Math.min(energy, Math.max(0, vazio));
  return { energy, fixed, credit: actual.exportCredit, total: actual.total, vazio, fora: energy - vazio };
}

// ---------------------------------------------------------------------------
// The buckets
// ---------------------------------------------------------------------------

/**
 * - ok: a figure to trust (a real 0 € included).
 * - partial: readings for only part of its time: a lower bound.
 * - nodata: had its time and nothing was recorded. Not 0 €.
 * - pending: has happened, but the bridge sends hourly and it isn't in yet. Not 0 €.
 * - future: hasn't happened. Not 0 €.
 */
export type CostState = 'ok' | 'partial' | 'nodata' | 'pending' | 'future';

export interface CostBucket extends Bucket {
  kwhVazio: number;
  kwhFora: number;
  eurVazio: number;
  eurFora: number;
  /** € in the bar; null for a bucket with nothing to go on, never 0. */
  eur: number | null;
  state: CostState;
  /** Still running, or its data is: the figures go up to here. */
  until?: number;
  /** Battery % at the end of the last slot with a reading. */
  socEnd?: number;
}

export interface CostView {
  grain: Grain;
  buckets: CostBucket[];
  split: CostSplit;
  /** kWh bought in the period, by tariff period: the bill's own figures. */
  kwhVazio: number;
  kwhFora: number;
  /** The dearest bucket with a figure above 0. */
  peak: CostBucket | null;
  /** The buckets' tallest bar, €. */
  maxEur: number;
  /** Some of what has already happened has no figure, or only part of one. */
  incomplete: boolean;
  /** Anything recorded at all. */
  covered: boolean;
}

export function costState(b: Pick<Bucket, 'start' | 'coveredSec' | 'expectedSec'>, now: number): CostState {
  if (b.start >= now) return 'future';
  if (b.expectedSec === 0) return 'pending';
  if (b.coveredSec === 0) return 'nodata';
  return coverageOf(b.coveredSec, b.expectedSec) < COMPLETE_SHARE ? 'partial' : 'ok';
}

export interface CostInput {
  period: Period;
  days: EnergyDay[];
  tariff: Tariff;
  /** bucketize's, for this period. */
  buckets: Bucket[];
  /** What summarize was given: the bars count the slots it counted, no others. */
  range: { from: number; to: number; now: number };
  /** computeScenarios(...).actual, what the tile shows. */
  actual: Bill;
  billedDays: number;
  /** The real now, ahead of range.now by whatever the bridge hasn't sent yet. */
  now: number;
}

export function costView({ period, days, tariff, buckets, range, actual, billedDays, now }: CostInput): CostView {
  const end = Math.min(range.to, range.now);
  const sums = buckets.map(() => ({ vazio: 0, fora: 0, soc: undefined as number | undefined }));
  let kwhVazio = 0;
  let kwhFora = 0;
  let at = 0;
  for (const day of [...days].sort((a, b) => a.start - b.start)) {
    day.slots.forEach((slot, i) => {
      if (!slot || slot.sec <= 0) return;
      const t = day.start + i * SLOT_MS;
      if (t < range.from || t >= end) return;
      while (at < buckets.length - 1 && t >= buckets[at].end) at++;
      const sum = sums[at];
      // Slot by slot: a bucket can span both, and a day always does.
      const kwh = slot.imp / 1000;
      if (isVazio(t, tariff)) { sum.vazio += kwh; kwhVazio += kwh; } else { sum.fora += kwh; kwhFora += kwh; }
      if (slot.soc !== undefined) sum.soc = slot.soc;
    });
  }
  const split = splitBill(actual, { vazio: kwhVazio, fora: kwhFora }, billedDays, tariff);
  const out: CostBucket[] = buckets.map((b, i) => {
    const sum = sums[i];
    const state = costState(b, now);
    const eurVazio = kwhVazio > 0 ? (split.vazio * sum.vazio) / kwhVazio : 0;
    const eurFora = kwhFora > 0 ? (split.fora * sum.fora) / kwhFora : 0;
    const known = state === 'ok' || state === 'partial';
    const running = b.expectedSec > 0 && b.expectedSec < (b.end - b.start) / 1000;
    return {
      ...b,
      kwhVazio: sum.vazio,
      kwhFora: sum.fora,
      eurVazio,
      eurFora,
      eur: known ? eurVazio + eurFora : null,
      state,
      ...(running ? { until: b.start + b.expectedSec * 1000 } : {}),
      ...(sum.soc !== undefined ? { socEnd: sum.soc } : {}),
    };
  });
  let peak: CostBucket | null = null;
  for (const b of out) if ((b.eur ?? 0) > (peak?.eur ?? 0)) peak = b;
  return {
    grain: grainOf(period),
    buckets: out,
    split,
    kwhVazio,
    kwhFora,
    peak,
    maxEur: peak?.eur ?? 0,
    incomplete: out.some(b => b.state === 'partial' || b.state === 'nodata' || b.state === 'pending'),
    covered: out.some(b => b.coveredSec > 0),
  };
}

/** A round top for the € scale: 1, 2, 2.5 or 5 × 10ⁿ, and never under 10 cents, so a cheap day doesn't look like a dear one. */
export function niceEur(v: number): number {
  if (v <= 0.1) return 0.1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

// ---------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------

/** "0,42 €", "pelo menos 0,42 €", or what there is instead of a figure. */
export function eurText(b: CostBucket): string {
  switch (b.state) {
    case 'future': return 'ainda não aconteceu';
    case 'pending': return 'ainda a chegar';
    case 'nodata': return 'sem dados';
    case 'partial': return `pelo menos ${fmtEur(b.eur ?? 0)}`;
    default: return fmtEur(b.eur ?? 0);
  }
}

/** Whether the dearest bucket comes to at least a cent, so there's something to name. */
export const hasPeak = (c: Pick<CostView, 'peak'>) => (c.peak?.eur ?? 0) >= 0.005;

/** Where the money went, in one line. */
export function moneyLine(c: CostView): string {
  if (!c.covered) return 'Sem dados neste período.';
  const kwh = c.kwhVazio + c.kwhFora;
  if (kwh <= 0) return c.incomplete ? 'Sem compras à rede nas horas com dados.' : 'Sem compras à rede neste período.';
  if (!hasPeak(c)) return `Quase nada comprado à rede neste período (${fmtKwh(kwh * 1000)}).`;
  return `Mais caro: ${c.peak!.title}, ${eurText(c.peak!)}`;
}

/** "2,1 kWh comprados, fora de vazio". */
export function boughtText(b: Pick<CostBucket, 'kwhVazio' | 'kwhFora'>): string {
  const wh = (b.kwhVazio + b.kwhFora) * 1000;
  if (wh <= 0) return 'nada comprado à rede';
  if (b.kwhVazio <= 0) return `${fmtKwh(wh)} comprados, fora de vazio`;
  if (b.kwhFora <= 0) return `${fmtKwh(wh)} comprados, em vazio`;
  return `${fmtKwh(wh)} comprados: ${fmtKwh(b.kwhFora * 1000)} fora de vazio, ${fmtKwh(b.kwhVazio * 1000)} em vazio`;
}

/** The sums that make up the tile. "registada": with gaps, the bars can only be what was recorded. */
export function reconciliationText(split: CostSplit, incomplete: boolean): string {
  const credit = split.credit > 0 ? ` − excedente pago ${fmtEur(split.credit)}` : '';
  return `Energia${incomplete ? ' registada' : ''} ${fmtEur(split.energy)} + potência e taxas ${fmtEur(split.fixed)}${credit} = Custo do período ${fmtEur(split.total)}`;
}

/** Why an hour cost what it did, as facts: what was bought, what else the house had, and what's missing. Whether the pump was on is the caller's. */
export function hourFacts(b: CostBucket): string[] {
  if (b.state === 'future') return ['Esta hora ainda não aconteceu.'];
  if (b.state === 'pending') return ['A ponte envia os dados de hora a hora: esta ainda não chegou.'];
  if (b.state === 'nodata') return ['A ponte ou o inversor não registaram esta hora, o que não quer dizer 0 €.'];
  const out: string[] = [];
  const kwh = b.kwhVazio + b.kwhFora;
  const bought = boughtText(b);
  const unit = kwh > 0 && b.eur ? `, a ${(b.eur / kwh).toFixed(2).replace('.', ',')} €/kWh com IVA e IEC` : '';
  out.push(`${bought.charAt(0).toUpperCase()}${bought.slice(1)}${unit}.`);
  const house = stacks(b.flows).house;
  const part = (wh: number) => (wh > 0 ? fmtKwh(wh, false) : '0');
  out.push(`A casa gastou ${fmtKwh(b.flows.load)}: sol ${part(house.solar)}, bateria ${part(house.battery)}, rede ${part(house.grid)}.${b.socEnd !== undefined ? ` Bateria no fim: ${Math.round(b.socEnd)} %.` : ''}`);
  if (b.flows.gridBat > 0) out.push(`${fmtKwh(b.flows.gridBat)} da rede foram para a bateria.`);
  if (b.state === 'partial') out.push(`Dados em ${fmtPct(coverageOf(b.coveredSec, b.expectedSec))} do tempo: o custo real pode ser maior.`);
  if (b.until !== undefined) out.push(`Até às ${fmtHM(b.until)}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Selecting a period
// ---------------------------------------------------------------------------

/** What a tap on a bar opens: year → that month, month or week → that day. Null for an hour, and for what hasn't happened. */
export function zoomPeriod(period: Period, b: Pick<Bucket, 'start'>, today: string): Period | null {
  const grain = grainOf(period);
  if (grain === 'hour') return null;
  const date = lisbonDate(b.start);
  if (date > today) return null;
  return periodContaining(grain === 'month' ? 'month' : 'day', date);
}

/** What a drag across bars `a` to `b` (either way) selects: whole days, up to today. Null within one bar, or for hours. */
export function rangePeriod(period: Period, buckets: Array<Pick<Bucket, 'start' | 'end'>>, a: number, b: number, today: string): Period | null {
  if (grainOf(period) === 'hour' || a === b) return null;
  const first = buckets[Math.min(a, b)];
  const last = buckets[Math.max(a, b)];
  if (!first || !last) return null;
  const from = lisbonDate(first.start);
  const end = lisbonDate(last.end - 1);
  const to = end > today ? today : end;
  if (from > today || from === to) return null;
  return { kind: 'custom', from, to };
}

/** How far a press may wander and still be a tap: a finger is never perfectly still. */
export const TAP_SLOP_PX = 8;
export const movedBeyondTap = (x0: number, y0: number, x: number, y: number) => Math.hypot(x - x0, y - y0) > TAP_SLOP_PX;

/**
 * What a press was. A tap is a press with no movement, whatever pressed it;
 * only a mouse selects by dragging, because on a phone a drag is the crosshair
 * (sideways) or the page scrolling (which the browser takes over, with a pointercancel).
 */
export function pressOutcome(p: { pointerType: string; moved: boolean; canDrag: boolean; from: number; to: number }): 'tap' | 'range' | 'none' {
  if (!p.moved) return 'tap';
  return p.pointerType === 'mouse' && p.canDrag && p.from !== p.to ? 'range' : 'none';
}

/** Vazio as stretches of [from, to), by the same 15-min slots the bill uses. */
export function vazioRuns(from: number, to: number, tariff: Pick<Tariff, 'vazioFrom' | 'vazioTo'>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (let t = from; t < to; t += SLOT_MS) {
    if (!isVazio(t, tariff)) continue;
    const last = out[out.length - 1];
    if (last && last.to === t) last.to = t + SLOT_MS;
    else out.push({ from: t, to: t + SLOT_MS });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

/** The pump lane from step 2's day, and the legend for what's in it. Null when there's nothing to draw. */
export function pumpLaneOf(view: Pick<HeatingDayView, 'lanes' | 'legend' | 'pump'>): { lane: SegmentLane; legend: string[] } | null {
  const lane = view.lanes.find(l => l.id === 'pump');
  if (!lane || isLine(lane) || lane.segments.length === 0) return null;
  const tones = new Set(lane.segments.map(s => s.tone));
  const legend = view.legend.filter(k => (k === 'pump-off' ? [...tones].some(t => t.startsWith('off-')) : tones.has(k)));
  const onMs = view.pump.filter(s => s.state === 'on').reduce((sum, s) => sum + (s.to - s.from), 0);
  return { lane: { ...lane, note: onMs > 0 ? `ligada ${fmtDuration(onMs / 1000)}` : undefined }, legend };
}

export interface PumpInBucket {
  onMin: number;
  /** The stretch to explain this bucket by: the longest running one, or failing that the longest. */
  main: PumpStretch | null;
}

export function pumpInBucket(stretches: PumpStretch[], from: number, to: number): PumpInBucket {
  let onMs = 0;
  let longestOn = 0;
  let longestAny = 0;
  let mainOn: PumpStretch | null = null;
  let mainAny: PumpStretch | null = null;
  for (const s of stretches) {
    const ms = Math.min(s.to, to) - Math.max(s.from, from);
    if (ms <= 0) continue;
    if (s.state === 'on') {
      onMs += ms;
      if (ms > longestOn) { longestOn = ms; mainOn = s; }
    }
    if (ms > longestAny) { longestAny = ms; mainAny = s; }
  }
  return { onMin: onMs / 60_000, main: mainOn ?? mainAny };
}

/** "Bomba ligada 45 min", "Bomba desligada", or that nobody knows. Undefined before anything has happened. */
export function pumpText(p: PumpInBucket): string | undefined {
  if (p.onMin > 0) return `Bomba ligada ${fmtDuration(p.onMin * 60)}`;
  if (!p.main) return undefined;
  if (p.main.state === 'nodata') return 'Bomba sem registo';
  if (p.main.state === 'fault') return 'Bomba em avaria';
  return 'Bomba desligada';
}

export interface PumpDayHours {
  hours: number;
  /** Readings for only part of the time so far: a lower bound. */
  incomplete: boolean;
}

/** The hours a day's slots had the pump on, by 15 min × its share. Null: no pump reading at all that day. */
export function pumpHoursOf(day: ClimateDay | null | undefined, expectedSlots: number): PumpDayHours | null {
  if (!day) return null;
  let min = 0;
  let read = 0;
  for (const s of day.slots) {
    if (!s || !s.pn) continue;
    read++;
    min += 15 * Math.min(1, Math.max(0, s.on ?? 0));
  }
  if (read === 0) return null;
  return { hours: min / 60, incomplete: read < expectedSlots * COMPLETE_SHARE };
}

/**
 * One entry per day bucket for the week and month views: the hours, null for a
 * day with no pump reading, undefined for one that hasn't happened or wasn't read.
 */
export function pumpHoursByBucket(buckets: CostBucket[], climate: Map<string, ClimateDay | null>): Array<PumpDayHours | null | undefined> {
  return buckets.map(b => {
    if (b.state === 'future') return undefined;
    const date = lisbonDate(b.start);
    if (!climate.has(date)) return undefined;
    const upTo = b.until ?? b.end;
    return pumpHoursOf(climate.get(date), Math.round((upTo - b.start) / SLOT_MS));
  });
}
