// Self-check (HANDOFF-finhub-v2.md § Acceptance 1–5), run on the events as they will be after the
// import: what dev already holds (Renato's confirmations included) plus what the import writes.
// Prints statuses, counts, days and causes; amounts only with --amounts (local console only,
// never into STATUS.md or a PR).

import { monthsBetween } from '../../../packages/shared/finhub/dates';
import { acceptanceReport, CRITERIA_TITLES } from '../../../packages/shared/finhub/noisysource/acceptance';
import type { NsEvent } from '../../../packages/shared/finhub/noisysource/events';
import { rebuildNsState } from '../../../packages/shared/finhub/noisysource/state';

export interface SelfCheck {
  ok: boolean;
  lines: string[];
}

const eur = (c: number) => (c / 100).toFixed(2);

export function selfCheck(events: NsEvent[], opts: { today: string; accountId: string; amounts: boolean; months: string[] }): SelfCheck {
  const out: string[] = [];
  const state = rebuildNsState(events);
  const report = acceptanceReport(state, { accountId: opts.accountId, today: opts.today, months: opts.months });

  out.push('EC contract chain');
  for (const c of report.chain) {
    out.push(`  ${c.pass ? 'PASS' : 'FAIL'}  contract ${c.contract} (start ${c.startDate}): last day ${c.lastDay}, expected ${c.expected} (${c.expectedWhy})`);
  }
  let ok = report.chain.every(c => c.pass);

  out.push('Acceptance per month (ok = passes on confirmed events; sugerido = passes once the suggestions are confirmed)');
  for (const m of report.months) {
    out.push(`  ${m.month}: ${m.overall.toUpperCase()}${opts.amounts ? `  (real − planned ${eur(m.recon.diffCents)}; buckets ${Object.entries(m.recon.buckets).map(([k, v]) => `${k} ${eur(v)}`).join(', ')})` : ''}`);
    for (const c of m.criteria) {
      out.push(`    ${c.n}. ${CRITERIA_TITLES[c.n].padEnd(34)} ${c.status.padEnd(8)} ${c.summary}`);
      if (c.n >= 4) for (const d of c.details) out.push(`         ${d}`);
    }
    if (m.criteria.find(c => c.n === 5)?.status === 'falha') ok = false;
  }
  return { ok, lines: out };
}

export const monthsOf2026 = (to: string) => monthsBetween('2026-01', to);
