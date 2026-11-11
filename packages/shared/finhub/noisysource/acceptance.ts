// packages/shared/finhub/noisysource/acceptance.ts
//
// The 2026 acceptance report (HANDOFF-finhub-v2.md, § Acceptance 1–5), month by month. Pure: the
// Aceitação screen and the importer's self-check both use it. Summaries and details carry counts,
// days and causes, never amounts, so the self-check can print them anywhere.
//
// Statuses: 'ok' (passes on what Renato confirmed), 'sugerido' (passes once the suggestions are
// confirmed), 'falha' (doesn't pass, the details say why), 'na' (nothing to check yet).
//
//  1. every bank line of the month is matched to a planned item or classified as ad hoc;
//  2. every planned item of the month has its bank line, or a written reason;
//  3. real − planned month-end = the named buckets (ad hoc lines, amount differences, items paid in
//     another month, items without a line but with a reason); nothing "por explicar";
//  4. each payslip of the month equals the estimate (differences named by cause);
//  5. EC: the days the client paid for the month = the planned days (an invoice, when there is
//     one, = timesheet days × rate). The contract chain's last days are checked once, on top.

import { addDays, type IsoDate, type YearMonth } from '../dates';
import { ecRunway } from './ec';
import { comparePayslip, estimatePayslip } from './payslip';
import { monthRecon, reconcile, type MonthRecon, type Reconciliation } from './reconcile';
import type { NsState } from './state';

export type CheckStatus = 'ok' | 'sugerido' | 'falha' | 'na';

export interface CriterionResult {
  n: 1 | 2 | 3 | 4 | 5;
  status: CheckStatus;
  summary: string;
  details: string[];
}

export interface MonthAcceptance {
  month: YearMonth;
  criteria: CriterionResult[];
  overall: CheckStatus;
  recon: MonthRecon;
}

export interface ChainCheck {
  contract: string;
  startDate: IsoDate;
  lastDay: IsoDate | null;
  expected: IsoDate | null;
  expectedWhy: string;
  pass: boolean;
}

export interface AcceptanceReport {
  rec: Reconciliation;
  chain: ChainCheck[];
  months: MonthAcceptance[];
}

export const CRITERIA_TITLES: Record<CriterionResult['n'], string> = {
  1: 'Linhas do banco explicadas',
  2: 'Previstos com movimento ou razão',
  3: 'Real − previsto explicado',
  4: 'Recibos = estimativa',
  5: 'Dias EC pagos = planeados',
};

const worst = (xs: CheckStatus[]): CheckStatus =>
  xs.includes('falha') ? 'falha' : xs.includes('sugerido') ? 'sugerido' : xs.every(x => x === 'na') ? 'na' : 'ok';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function contractChain(state: NsState, today: IsoDate): ChainCheck[] {
  const out: ChainCheck[] = [];
  const byClient = new Map<string, typeof state.contracts>();
  for (const c of state.contracts) byClient.set(c.client, [...(byClient.get(c.client) ?? []), c]);
  for (const list of byClient.values()) {
    const sorted = [...list].sort((a, b) => a.startDate.localeCompare(b.startDate));
    sorted.forEach((c, k) => {
      const next = sorted[k + 1];
      const r = ecRunway(state, c, today);
      const expected = next ? addDays(next.startDate, -1) : c.clientEstimatedEnd ?? null;
      out.push({
        contract: c.number,
        startDate: c.startDate,
        lastDay: r.lastDay,
        expected,
        expectedWhy: next ? `véspera do contrato ${next.number}` : 'estimativa do cliente',
        pass: !!expected && r.lastDay === expected,
      });
    });
  }
  return out;
}

export function acceptanceReport(
  state: NsState,
  opts: { accountId: string; today: IsoDate; months: YearMonth[]; rec?: Reconciliation },
): AcceptanceReport {
  const rec = opts.rec ?? reconcile(state, { accountId: opts.accountId });
  const chain = contractChain(state, opts.today);
  const runways = state.contracts.map(c => ecRunway(state, c, opts.today));
  const names = new Map(state.people.map(p => [p.id, p.name]));
  const months: MonthAcceptance[] = [];

  for (const month of opts.months) {
    const recon = monthRecon(state, rec, month);
    if (!recon) continue;
    const criteria: CriterionResult[] = [];

    // 1. Lines
    const open = recon.lines.filter(l => l.state === 'por-explicar');
    const sugL = recon.lines.filter(l => l.state === 'sugerido' || l.state === 'classificacao-sugerida');
    criteria.push({
      n: 1,
      status: open.length ? 'falha' : sugL.length ? 'sugerido' : 'ok',
      summary: open.length
        ? `${plural(open.length, 'linha', 'linhas')} por explicar de ${recon.lines.length}`
        : sugL.length ? `${recon.lines.length - sugL.length}/${recon.lines.length} confirmadas, ${sugL.length} sugeridas` : `${recon.lines.length}/${recon.lines.length} confirmadas`,
      details: open.map(l => `${l.movement.date} ${l.movement.description}`),
    });

    // 2. Items
    const missing = recon.items.filter(i => i.state === 'sem-movimento');
    const sugI = recon.items.filter(i => i.state === 'sugerido');
    const explained = recon.items.filter(i => i.state === 'explicado');
    criteria.push({
      n: 2,
      status: missing.length ? 'falha' : sugI.length ? 'sugerido' : 'ok',
      summary: missing.length
        ? `${plural(missing.length, 'previsto', 'previstos')} sem movimento nem razão, de ${recon.items.length}`
        : `${recon.items.length - sugI.length - explained.length} confirmados, ${sugI.length} sugeridos, ${explained.length} com razão`,
      details: missing.map(i => `${i.item.date} ${i.item.label}`),
    });

    // 3. Real − planned
    const b = recon.buckets;
    const parts = [
      b.adhocCents && 'ocasionais',
      b.amountDiffCents && 'diferenças de valor',
      b.otherMonthCents && 'pagos noutro mês',
      b.explainedMissingCents && 'previstos sem movimento (com razão)',
      b.missingCents && 'previstos sem movimento (sem razão)',
      b.unexplainedCents && 'linhas por explicar',
    ].filter(Boolean) as string[];
    const st3: CheckStatus = b.unexplainedCents || b.missingCents || open.length || missing.length
      ? 'falha' : worst([criteria[0].status, criteria[1].status]);
    criteria.push({
      n: 3,
      status: st3,
      summary: recon.diffCents === 0 ? 'real = previsto' : `real − previsto = ${parts.join(' + ') || '0'}`,
      details: recon.diffGroups.map(g => {
        const its = g.itemIds.map(id => rec.items.get(id)!.item.label);
        return `diferença de valor: ${its.join(', ')} (${plural(g.lineIds.length, 'linha', 'linhas')})`;
      }),
    });

    // 4. Payslips of the month
    const details4: string[] = [];
    let recorded = 0;
    let equal = 0;
    for (const p of state.people) {
      const ps = state.payslips[`${p.id}|${month}`];
      const est = estimatePayslip(state, p.id, month);
      if (!ps || !est) continue;
      recorded++;
      const c = comparePayslip(est, ps);
      if (c.equal) { equal++; continue; }
      details4.push(`${names.get(p.id) ?? p.id}: ${c.diffs.map(d => d.cause + (d.detail ? ` (${d.detail})` : '')).join('; ')}`);
    }
    criteria.push({
      n: 4,
      status: !recorded ? 'na' : equal === recorded ? 'ok' : 'falha',
      summary: !recorded ? 'sem recibos registados' : `${equal}/${recorded} iguais à estimativa`,
      details: details4,
    });

    // 5. EC days of the month
    const details5: string[] = [];
    const st5: CheckStatus[] = [];
    for (const r of runways) {
      const m = r.months.find(x => x.month === month);
      if (!m) continue;
      const c = r.contract;
      const item = rec.items.get(`ec:${c.number}:${month}`);
      const invoice = state.invoices.find(i => i.contractNumber === c.number && i.month === month);
      if (invoice) {
        const ts = state.timesheets[`${c.number}|${month}`];
        const days = ts ? ts.days : m.days;
        if (invoice.amountCents !== Math.round(days * c.dailyRateCents)) {
          st5.push('falha');
          details5.push(`contrato ${c.number}: a fatura ${invoice.invoiceNumber} não é ${days} dias × a taxa`);
        }
      }
      if (!item || item.state === 'futuro') {
        st5.push('na');
        details5.push(`contrato ${c.number}: ${m.days} dias planeados; o pagamento ainda não chegou`);
        continue;
      }
      if (!item.lineIds.length) {
        st5.push('falha');
        details5.push(`contrato ${c.number}: ${m.days} dias planeados, nenhum pagamento associado`);
        continue;
      }
      const paid = item.lineIds.reduce((s, id) => s + rec.lines.get(id)!.movement.amountCents, 0);
      const paidDays = Math.round((paid / c.dailyRateCents) * 2) / 2;
      const ok = paid === item.item.amountCents;
      st5.push(ok ? (item.state === 'confirmado' ? 'ok' : 'sugerido') : 'falha');
      details5.push(`contrato ${c.number}: ${m.days} dias planeados (${m.source === 'folha' ? 'folha de horas' : 'calendário'}), ${paidDays} pagos`);
    }
    criteria.push({
      n: 5,
      status: st5.length ? worst(st5) : 'na',
      summary: st5.length ? details5.map(d => d.replace(/^contrato \S+: /, '')).join(' · ') : 'sem dias EC no mês',
      details: details5,
    });

    months.push({ month, criteria, overall: worst(criteria.map(c => c.status)), recon });
  }
  return { rec, chain, months };
}
