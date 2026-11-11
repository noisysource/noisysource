// packages/shared/finhub/noisysource/blueprints.ts
//
// The blueprints (HANDOFF § "Order change"): what the forecast is generated from, what Renato
// confirms, and the year it generates. A confirmation names the versions he saw, so a later version
// of a blueprint goes back to "por confirmar" on its own. Nothing here is stored but the
// confirmations themselves: the months are recomputed from the blueprints on every load.

import { formatEUR } from '../../lib/money';
import { addDays, daysBetween, lastDay, monthOf, yearOf, type IsoDate, type YearMonth } from '../dates';
import { ecRunway } from './ec';
import { intercompanyPosition } from './intercompany';
import { dateLabelPt, loanInstalment, monthLabelPt, PLAN_KIND_LABEL, type PlannedItem } from './plan';
import type { Reconciliation } from './reconcile';
import { costPlanVersions, termsAt, type NsState } from './state';
import { projectTreasury, type RealBalance } from './treasury';

export type BlueprintGroup = 'receitas' | 'pessoas' | 'creditos' | 'entre-empresas' | 'despesas' | 'dias' | 'calendario';

export const BLUEPRINT_GROUPS: { id: BlueprintGroup; label: string }[] = [
  { id: 'receitas', label: 'Receitas' },
  { id: 'pessoas', label: 'Pessoas e salários' },
  { id: 'creditos', label: 'Créditos' },
  { id: 'entre-empresas', label: 'Dinheiro entre empresas' },
  { id: 'despesas', label: 'Despesas' },
  { id: 'dias', label: 'Dias de pagamento' },
  { id: 'calendario', label: 'Calendário' },
];

export interface Blueprint {
  /** `ec:…`, `pessoa:…`, `custo:…`, `entre:…`, `regra:…`, `feriados:…:…`, `ausencias:…`. */
  id: string;
  group: BlueprintGroup;
  label: string;
  /** Contract number, person id, cost key… */
  ref: string;
  /** The versions it rests on from today on: what a confirmation covers. */
  eventIds: string[];
  /** Still shapes the months ahead. A finished contract or a paid-off loan doesn't. */
  active: boolean;
  confirmed: boolean;
  confirmEventId?: string;
  /** Values marked "a confirmar" (a placeholder until Renato says). */
  placeholders: string[];
}

export function blueprints(state: NsState, opts: { today: IsoDate }): Blueprint[] {
  const { today } = opts;
  const out: Blueprint[] = [];
  const add = (b: Omit<Blueprint, 'confirmed' | 'confirmEventId'>) => {
    const confirmed = b.eventIds.length > 0 && b.eventIds.every(id => state.confirmedEventIds.has(id));
    out.push({ ...b, confirmed, confirmEventId: confirmed ? state.confirmations[b.id]?.eventId : undefined });
  };

  for (const c of state.contracts) {
    const runway = ecRunway(state, c, today);
    add({
      id: `ec:${c.number}`, group: 'receitas', label: `${c.client} · contrato ${c.number}`, ref: c.number,
      eventIds: [c.eventId, ...(c.endEventId ? [c.endEventId] : [])],
      active: !runway.finished, placeholders: [],
    });
  }

  for (const p of state.people) {
    const versions = state.terms[p.id] ?? [];
    const current = termsAt(state, p.id, today);
    const ahead = versions.filter(v => v === current || v.from > today);
    add({
      id: `pessoa:${p.id}`, group: 'pessoas', label: p.name, ref: p.id,
      eventIds: ahead.map(v => v.eventId),
      active: ahead.length > 0,
      placeholders: ahead.flatMap(v => v.toConfirm ?? []),
    });
  }

  for (const [key, versions] of Object.entries(costPlanVersions(state))) {
    const latest = versions[versions.length - 1];
    let current = versions[0];
    for (const v of versions) if (v.from <= today) current = v;
    const ahead = versions.filter(v => v === current || v.from > today);
    let active = latest.frequency === 'once' ? latest.from >= today : !latest.to || latest.to >= today;
    if (latest.loan && !loanInstalment(latest.loan, latest.day, monthOf(today))
      && monthOf(today) >= latest.loan.firstPaymentMonth) active = false;
    add({
      id: `custo:${key}`,
      group: latest.loan ? 'creditos' : latest.direction === 'entrada' ? 'receitas' : 'despesas',
      label: latest.description, ref: key,
      eventIds: ahead.map(v => v.eventId), active,
      placeholders: ahead.some(v => v.toConfirm) ? ['valores'] : [],
    });
  }

  for (const ic of state.intercompany) {
    add({
      id: `entre:${ic.key}`, group: 'entre-empresas', label: ic.counterparty, ref: ic.key,
      eventIds: [ic.eventId], active: true, placeholders: ic.toConfirm ? ['saldo inicial'] : [],
    });
  }

  const whats = [...new Set(state.rules.map(r => r.what))];
  for (const what of whats) {
    const versions = state.rules.filter(r => r.what === what).sort((a, b) => a.from.localeCompare(b.from));
    let current = versions[0];
    for (const v of versions) if (v.from <= today) current = v;
    const ahead = versions.filter(v => v === current || v.from > today);
    add({
      id: `regra:${what}`, group: 'dias', label: current.label, ref: what,
      eventIds: ahead.map(v => v.eventId), active: true,
      placeholders: ahead.some(v => v.toConfirm) ? ['dia'] : [],
    });
  }

  const thisYear = yearOf(today);
  for (const [calendarId, byYear] of Object.entries(state.extraHolidays)) {
    for (const yearStr of Object.keys(byYear).sort()) {
      const year = Number(yearStr);
      if (year < thisYear) continue;
      const meta = state.holidayMeta[`${calendarId}:${year}`];
      if (!meta) continue;
      add({
        id: `feriados:${calendarId}:${year}`, group: 'calendario', label: `Feriados ${calendarId} ${year}`, ref: `${calendarId}:${year}`,
        eventIds: [meta.eventId], active: true, placeholders: meta.toConfirm ? ['datas'] : [],
      });
    }
  }
  for (const p of state.people) {
    const ahead = state.calendar.filter(c => c.personId === p.id && c.dates.some(d => d >= today));
    if (!ahead.length) continue;
    add({
      id: `ausencias:${p.id}`, group: 'calendario', label: `Ausências ${p.name}`, ref: p.id,
      eventIds: ahead.map(c => c.eventId), active: true,
      placeholders: ahead.some(c => c.datesToConfirm) ? ['datas'] : [],
    });
  }
  return out;
}

/** The blueprint a planned item comes from. SS and IRS follow from everyone's terms: null. */
export function blueprintIdOfItem(item: PlannedItem): string | null {
  switch (item.kind) {
    case 'ec': return `ec:${item.ref}`;
    case 'salario':
    case 'refeicao': return `pessoa:${item.ref}`;
    case 'vales': return `pessoa:${item.ref.split('.')[0]}`;
    case 'custo': return `custo:${item.ref}`;
    case 'entre': return `entre:${item.ref}`;
    default: return null;
  }
}

/** Fewer holidays than this in a client calendar's year means it hasn't been filled in. */
const FEW_HOLIDAYS = 5;

/** Client calendars missing a year that an active contract runs into (beyond its first weeks). */
export function calendarGaps(state: NsState, today: IsoDate): { contract: string; calendarId: string; year: number; count: number }[] {
  const out: { contract: string; calendarId: string; year: number; count: number }[] = [];
  for (const c of state.contracts) {
    const r = ecRunway(state, c, today);
    if (r.finished || !r.lastDay) continue;
    // A contract ending in January barely touches the year: nothing to warn about until March.
    const lastFull = r.lastDay.slice(5, 7) >= '03' ? yearOf(r.lastDay) : yearOf(r.lastDay) - 1;
    for (let y = Math.max(yearOf(c.startDate), yearOf(today)); y <= lastFull; y++) {
      const count = state.extraHolidays[c.holidayCalendar]?.[y]?.length ?? 0;
      if (count < FEW_HOLIDAYS) out.push({ contract: c.number, calendarId: c.holidayCalendar, year: y, count });
    }
  }
  return out;
}

/** The last day of the latest EC contract, or null with no contracts. */
export function lastEcDay(state: NsState, today: IsoDate): IsoDate | null {
  let last: IsoDate | null = null;
  for (const c of state.contracts) {
    const d = ecRunway(state, c, today).lastDay;
    if (d && (!last || d > last)) last = d;
  }
  return last;
}

/** Bank lines classified "Empresas do grupo" that no intercompany plan names yet. */
export function unplannedGroupLines(state: NsState, rec: Reconciliation): { count: number; outCents: number; inCents: number } {
  let count = 0, outCents = 0, inCents = 0;
  const planned = new Set(state.intercompany.flatMap(ic => intercompanyPosition(state, ic, rec.accountId).lines.map(l => l.id)));
  for (const l of rec.lines.values()) {
    if (l.category !== 'intragrupo' || planned.has(l.movement.id)) continue;
    count++;
    if (l.movement.amountCents < 0) outCents -= l.movement.amountCents; else inCents += l.movement.amountCents;
  }
  return { count, outCents, inCents };
}

// ── The year ─────────────────────────────────────────────────────────────────

export interface GridRow {
  /** The blueprint id, or `ss` / `irs`. */
  key: string;
  group: BlueprintGroup;
  label: string;
  blueprint: Blueprint | null;
  /** By the month the money moves, not the month it's for. */
  items: Record<YearMonth, PlannedItem[]>;
  totalCents: number;
}

export interface GridMonth {
  month: YearMonth;
  inCents: number;
  outCents: number;
  endCents: number;
}

export interface GridWarning {
  kind: 'sem-receita' | 'saldo-negativo' | 'entre-sem-data' | 'entre-sem-plano' | 'calendario';
  text: string;
}

export interface YearGrid {
  start: RealBalance;
  months: GridMonth[];
  rows: GridRow[];
  warnings: GridWarning[];
}

/** From the last real balance to the end of next year: the same numbers as Tesouraria. */
export function yearGrid(state: NsState, opts: { accountId: string; today: IsoDate; toMonth?: YearMonth; rec?: Reconciliation | null }): YearGrid | null {
  const { accountId, today } = opts;
  const toMonth = opts.toMonth ?? `${yearOf(today) + 1}-12`;
  const projection = projectTreasury(state, { accountId, today, horizonDays: daysBetween(today, lastDay(toMonth)) });
  if (!projection) return null;

  const list = blueprints(state, { today });
  const byId = new Map(list.map(b => [b.id, b]));
  const rows = new Map<string, GridRow>();
  const months = new Map<YearMonth, GridMonth>(projection.monthEnds.map(m => [m.month, { month: m.month, inCents: 0, outCents: 0, endCents: m.balanceCents }]));

  for (const day of projection.days) {
    const cash = monthOf(day.date);
    for (const item of day.items) {
      const id = blueprintIdOfItem(item);
      const bp = id ? byId.get(id) ?? null : null;
      const key = id ?? item.kind;
      const row = rows.get(key) ?? {
        key, group: bp?.group ?? 'pessoas', label: bp?.label ?? PLAN_KIND_LABEL[item.kind], blueprint: bp, items: {}, totalCents: 0,
      };
      (row.items[cash] ??= []).push(item);
      row.totalCents += item.amountCents;
      rows.set(key, row);
      const m = months.get(cash);
      if (m) { if (item.amountCents > 0) m.inCents += item.amountCents; else m.outCents += item.amountCents; }
    }
  }

  const warnings: GridWarning[] = [];
  const lastEc = lastEcDay(state, today);
  if (lastEc && lastEc < lastDay(toMonth)) {
    warnings.push({ kind: 'sem-receita', text: `Não há contrato EC depois de ${dateLabelPt(lastEc)}: a receita acaba aí, os salários e as despesas continuam. Quando houver contrato novo, adiciona-o no Plano e os meses geram-se sozinhos.` });
  }
  const negative = projection.monthEnds.find(m => m.balanceCents < 0);
  if (negative) {
    warnings.push({ kind: 'saldo-negativo', text: `O saldo previsto fica negativo no fim de ${monthLabelPt(negative.month)} e chega a ${formatEUR(projection.lowest.balanceCents)} em ${dateLabelPt(projection.lowest.date)}.` });
  }
  for (const ic of state.intercompany) {
    if (ic.repayment) continue;
    const owed = intercompanyPosition(state, ic, accountId).balanceCents;
    if (!owed) continue;
    warnings.push({ kind: 'entre-sem-data', text: owed > 0
      ? `${ic.counterparty} deve ${formatEUR(owed)} à NoisySource, sem data de devolução: não entra na previsão.`
      : `A NoisySource deve ${formatEUR(-owed)} a ${ic.counterparty}, sem data de devolução: não entra na previsão.` });
  }
  if (opts.rec) {
    const u = unplannedGroupLines(state, opts.rec);
    if (u.count) warnings.push({ kind: 'entre-sem-plano', text: `${u.count} linha(s) do banco entre empresas ainda sem plano (saiu ${formatEUR(u.outCents)}, entrou ${formatEUR(u.inCents)}).` });
  }
  for (const g of calendarGaps(state, today)) {
    warnings.push({ kind: 'calendario', text: `O calendário ${g.calendarId} de ${g.year} só tem ${g.count} feriado(s): o contrato ${g.contract} conta os outros como dias de trabalho.` });
  }

  const groupOrder = new Map(BLUEPRINT_GROUPS.map((g, i) => [g.id, i]));
  return {
    start: projection.start,
    months: [...months.values()],
    rows: [...rows.values()].sort((a, b) => groupOrder.get(a.group)! - groupOrder.get(b.group)! || Math.abs(b.totalCents) - Math.abs(a.totalCents)),
    warnings,
  };
}

/** The working day after a contract's last day: where the next contract would start. */
export function nextContractStart(state: NsState, today: IsoDate): IsoDate {
  let d = addDays(lastEcDay(state, today) ?? today, 1);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
}

