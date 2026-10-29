// Night-1 self-check (HANDOFF-finhub-v2.md § Acceptance, the parts that exist on night 1), run on
// the events the importer built. Prints days, counts and causes; amounts only with --amounts
// (local console only, never into STATUS.md or a PR).

import { addDays, addMonths, monthOf, monthsBetween } from '../../../packages/shared/finhub/dates';
import { ecRunway } from '../../../packages/shared/finhub/noisysource/ec';
import type { NsEvent } from '../../../packages/shared/finhub/noisysource/events';
import { comparePayslip, estimatePayslip } from '../../../packages/shared/finhub/noisysource/payslip';
import { rebuildNsState } from '../../../packages/shared/finhub/noisysource/state';
import { pastMonthChecks } from '../../../packages/shared/finhub/noisysource/treasury';

export interface SelfCheck {
  ok: boolean;
  lines: string[];
}

const eur = (c: number) => (c / 100).toFixed(2);

export function selfCheck(events: NsEvent[], opts: { today: string; accountId: string; amounts: boolean; payMonths: string[]; ecMonths: string[]; balanceMonths: string[] }): SelfCheck {
  const out: string[] = [];
  let ok = true;
  const state = rebuildNsState(events);

  // 1. Contract chain: each runs out the day before the next starts; the last ends on the client's estimate.
  out.push('EC contracts');
  const runways = state.contracts.map(c => ecRunway(state, c, opts.today));
  runways.forEach((r, i) => {
    const next = runways[i + 1];
    const expected = next ? addDays(next.contract.startDate, -1) : r.contract.clientEstimatedEnd;
    const pass = r.lastDay === expected;
    ok &&= pass;
    out.push(`  ${pass ? 'PASS' : 'FAIL'}  contract ${i + 1} (start ${r.contract.startDate}): last day ${r.lastDay}, expected ${expected}` +
      `${next ? ' (day before the next contract)' : " (client's estimate)"}; warning ${r.warningDate}${r.warningActive ? ' — active today' : ''}`);
  });

  // 2. Planned EC days per month = days the client paid (bank credits ÷ the contract's rate, paid in M+1).
  out.push('EC days planned vs paid (per contract and work month)');
  const paid = new Map<string, number>();
  const paymentsOf = state.movements.filter(m => m.amountCents > 0 && /\bMALT\b/i.test(m.description));
  for (const m of paymentsOf) {
    const workMonth = addMonths(monthOf(m.date), -1);
    const fits = state.contracts.filter(c => m.amountCents % c.dailyRateCents === 0);
    const c = fits.length === 1 ? fits[0] : fits.find(x => runways.find(r => r.contract === x)?.months.some(mm => mm.month === workMonth));
    if (!c) { ok = false; out.push(`  FAIL  a client payment on ${m.date} isn't a whole number of days at any contract's rate`); continue; }
    const k = `${c.number}|${workMonth}`;
    paid.set(k, (paid.get(k) ?? 0) + m.amountCents / c.dailyRateCents);
  }
  let ecPass = 0, ecTotal = 0;
  for (const month of opts.ecMonths) {
    for (const r of runways) {
      const planned = r.months.find(m => m.month === month)?.days ?? 0;
      const got = paid.get(`${r.contract.number}|${month}`) ?? 0;
      if (!planned && !got) continue;
      ecTotal++;
      const pass = planned === got;
      if (pass) ecPass++; else ok = false;
      out.push(`  ${pass ? 'PASS' : 'FAIL'}  ${month} contract ${runways.indexOf(r) + 1}: planned ${planned}, paid ${got}`);
    }
  }
  out.push(`  → ${ecPass}/${ecTotal} contract-months match`);

  // 3. Payslips: estimate vs recorded.
  out.push('Payslips: estimate vs recorded');
  let equal = 0, total = 0;
  const causes = new Map<string, string[]>();
  for (const month of opts.payMonths) {
    for (const p of state.people) {
      const rec = state.payslips[`${p.id}|${month}`];
      const est = estimatePayslip(state, p.id, month);
      if (!rec || !est) continue;
      total++;
      const c = comparePayslip(est, rec);
      if (c.equal) { equal++; continue; }
      for (const d of c.diffs) {
        const list = causes.get(d.cause) ?? [];
        list.push(`${p.id} ${month}${d.detail ? ` (${d.detail})` : ''}${opts.amounts ? ` net est ${eur(est.netCents)} rec ${eur(rec.netCents)}` : ''}`);
        causes.set(d.cause, list);
      }
    }
  }
  out.push(`  ${equal}/${total} payslips equal the estimate`);
  for (const [cause, list] of causes) out.push(`  ${cause}: ${list.join('; ')}`);

  // 4. Planned vs real month-end balance.
  out.push('Month-end balance: planned (previous real + planned items) vs real');
  for (const c of pastMonthChecks(state, { accountId: opts.accountId, months: opts.balanceMonths })) {
    const hinted = c.hints.filter(h => h.movementId).length;
    out.push(`  ${c.month}: ${c.diffCents === 0 ? 'equal' : 'differs'}${opts.amounts ? ` (real − planned ${eur(c.diffCents)})` : ''}; ` +
      `${hinted}/${c.items.length} planned items have a same-amount bank line; ${c.unhintedMovementIds.length}/${c.movements.length} bank lines without one`);
  }
  return { ok, lines: out };
}

export const monthsOf2026 = (to: string) => monthsBetween('2026-01', to);
