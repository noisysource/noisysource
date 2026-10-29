// packages/shared/finhub/noisysource/plan.ts
//
// Expected movements (HANDOFF-finhub-v2.md, "Expected movements"): what the plan says leaves or
// enters the bank, and when. Each item carries the inputs that explain its number.
//
// - EC invoice for month M: days(M) × rate (timesheet if submitted, else planned); issued per the
//   'ec-fatura' rule; cash in at issue + the contract's daysToPayment, next business day.
//   No income after a contract's last day: a gap between contracts shows as it is.
// - Per worker and month: net salary ('salarios'), meal card top-up ('refeicao'), one item per
//   voucher card ('vales', plus the provider's fee when the rule has one: the top-ups are ordered
//   per card, sometimes several cards in one payment); a recorded payslip replaces the estimate.
// - SS (employee + employer) and IRS withheld for M, all workers together ('ss', 'irs').
// - Fixed costs from the cost plans (direct debits move to the next business day).

import { formatEUR } from '../../lib/money';
import {
  addDays, addMonths, daysInMonth, isoFromParts, monthOf, monthsBetween, yearOf, type IsoDate, type YearMonth,
} from '../dates';
import { adjustToBusinessDay, holidayDates } from '../holidays';
import { ecRunway } from './ec';
import type { PaymentFee, PaymentRuleWhat, Payslip } from './events';
import { estimatePayslip, recordedAmounts, type PayslipEstimate } from './payslip';
import { costPlanVersions, ruleAt, type NsState } from './state';

export type PlanKind = 'ec' | 'salario' | 'refeicao' | 'vales' | 'ss' | 'irs' | 'custo';

export const PLAN_KIND_LABEL: Record<PlanKind, string> = {
  ec: 'Fatura EC',
  salario: 'Salário',
  refeicao: 'Cartão refeição',
  vales: 'Vales (cartão)',
  ss: 'Segurança Social',
  irs: 'IRS retido',
  custo: 'Custo fixo',
};

export interface PlannedItem {
  /** Deterministic: `${kind}:${ref}:${month}`. */
  id: string;
  /** Contract number, worker id (`worker.benefit` for vouchers), cost key, or 'all' (SS, IRS). */
  ref: string;
  date: IsoDate;
  /** Before moving off a weekend/holiday. */
  nominalDate: IsoDate;
  kind: PlanKind;
  label: string;
  /** Signed: + enters the account, − leaves it. Includes a provider's fee when there is one. */
  amountCents: number;
  /** Signed, before the provider's fee (only when there is a fee). */
  baseCents?: number;
  /** The month it belongs to (work month for pay and EC, the cost's month). */
  month: YearMonth;
  /** Why this number, e.g. "21 dias × 500,00 € (contrato 123, planeado)". */
  inputs: string;
  source: 'plano' | 'recibo' | 'folha' | 'fatura';
  /** Rests on something marked "a confirmar" (payment day, cost plan, dates). */
  toConfirm: boolean;
  account?: string;
  personId?: string;
  contractNumber?: string;
  costKey?: string;
}

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export function monthLabelPt(m: YearMonth): string {
  return `${MONTHS_PT[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

function dayInMonth(month: YearMonth, day: number): IsoDate {
  const [y, m] = month.split('-').map(Number);
  return isoFromParts(y, m, Math.min(day, daysInMonth(month)));
}

/** A provider's fee on `baseCents` (positive): pct of it, plus VAT on the fee, each rounded to the cent. */
export function providerFeeCents(baseCents: number, fee: PaymentFee): number {
  const f = Math.round((baseCents * fee.pct) / 100);
  return f + Math.round((f * fee.vatPct) / 100);
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The voucher cards loaded for the month, per benefit: from the recorded payslip, else the estimate. */
function cardBenefits(est: PayslipEstimate, rec: Payslip | undefined): { code: string; label: string; cents: number }[] {
  if (!rec) {
    return est.lines.filter(l => l.kind === 'beneficio' && l.paidAs === 'cartao')
      .map(l => ({ code: l.code ?? norm(l.label).replace(/ /g, '-'), label: l.label, cents: l.amountCents }));
  }
  const byLabel = new Map(est.terms.benefits.map(b => [norm(b.label), b]));
  return rec.lines.filter(l => l.kind === 'beneficio' && (l.paidAs ?? 'conta') === 'cartao').map(l => {
    const b = byLabel.get(norm(l.label));
    return { code: b?.code ?? (norm(l.code || l.label).replace(/ /g, '-') || 'vale'), label: b?.label ?? l.label, cents: l.amountCents };
  });
}

const DEFAULT_RULES: Record<PaymentRuleWhat, { day: number; monthOffset: number; nonBusinessDay: 'before' | 'after' }> = {
  salarios: { day: 25, monthOffset: 0, nonBusinessDay: 'before' },
  refeicao: { day: 25, monthOffset: 0, nonBusinessDay: 'before' },
  vales: { day: 25, monthOffset: 0, nonBusinessDay: 'before' },
  ss: { day: 20, monthOffset: 1, nonBusinessDay: 'after' },
  irs: { day: 20, monthOffset: 1, nonBusinessDay: 'after' },
  'ec-fatura': { day: 31, monthOffset: 0, nonBusinessDay: 'before' },
};

export interface PlanOptions {
  from: IsoDate;
  to: IsoDate;
  /** The account items are paid from/into when the plan doesn't say (the company's bank account). */
  mainAccount: string;
}

export function plannedItems(state: NsState, opts: PlanOptions): PlannedItem[] {
  const { from, to } = opts;
  const years: number[] = [];
  for (let y = yearOf(from) - 1; y <= yearOf(to) + 1; y++) years.push(y);
  const national = holidayDates(['pt'], years, state.extraHolidays);

  const ruleDate = (what: PaymentRuleWhat, workMonth: YearMonth) => {
    const nominal0 = dayInMonth(workMonth, 1);
    const rule = ruleAt(state, what, nominal0) ?? ruleAt(state, what, dayInMonth(workMonth, 31));
    const r = rule ?? DEFAULT_RULES[what];
    const nominal = dayInMonth(addMonths(workMonth, r.monthOffset), r.day);
    return {
      nominal,
      date: adjustToBusinessDay(nominal, r.nonBusinessDay, national),
      toConfirm: !rule || !!rule.toConfirm,
      fee: rule?.fee,
    };
  };

  const items: PlannedItem[] = [];
  // Work months whose money can land in [from, to]: pay and EC arrive up to ~2 months later.
  const months = monthsBetween(addMonths(monthOf(from), -3), monthOf(to));

  // ── EC income ──
  for (const c of state.contracts) {
    const runway = ecRunway(state, c, from);
    for (const m of runway.months) {
      if (!months.includes(m.month)) continue;
      const invoice = state.invoices.find(i => i.contractNumber === c.number && i.month === m.month);
      let date: IsoDate;
      let nominal: IsoDate;
      let toConfirm = false;
      if (invoice) {
        nominal = invoice.dueDate;
        date = adjustToBusinessDay(nominal, 'after', national);
      } else {
        const issue = ruleDate('ec-fatura', m.month);
        nominal = addDays(issue.date, c.daysToPayment);
        date = adjustToBusinessDay(nominal, 'after', national);
        toConfirm = issue.toConfirm;
      }
      const amount = invoice ? invoice.amountCents : m.amountCents;
      items.push({
        id: `ec:${c.number}:${m.month}`,
        ref: c.number,
        date, nominalDate: nominal, kind: 'ec',
        label: `${c.client} — ${monthLabelPt(m.month)}`,
        amountCents: amount,
        month: m.month,
        inputs: invoice
          ? `fatura ${invoice.invoiceNumber}`
          : `${m.days} dias × ${formatEUR(c.dailyRateCents)} (contrato ${c.number}, ${m.source === 'folha' ? 'folha de horas' : 'dias planeados'}); recebe ${c.daysToPayment} dias após a fatura`,
        source: invoice ? 'fatura' : m.source === 'folha' ? 'folha' : 'plano',
        toConfirm,
        account: opts.mainAccount,
        contractNumber: c.number,
      });
    }
  }

  // ── Payroll ──
  for (const month of months) {
    let ss = 0, ssEmp = 0, ssEr = 0, irs = 0;
    let anyEstimate = false;
    for (const p of state.people) {
      const est = estimatePayslip(state, p.id, month);
      if (!est) continue;
      const rec = state.payslips[`${p.id}|${month}`];
      const name = p.name;
      const net = rec ? rec.netCents : est.netCents;
      const mealCard = rec ? recordedAmounts(rec).cardTopUps.refeicao : est.cardTopUps.refeicao;
      const source = rec ? 'recibo' : 'plano';
      if (!rec) anyEstimate = true;

      const sal = ruleDate('salarios', month);
      if (net > 0) {
        items.push({
          id: `salario:${p.id}:${month}`, ref: p.id, date: sal.date, nominalDate: sal.nominal, kind: 'salario',
          label: `Salário ${name} — ${monthLabelPt(month)}`, amountCents: -net, month,
          inputs: rec
            ? 'recibo registado'
            : `estimativa: bruto ${formatEUR(est.grossCents)} − IRS ${formatEUR(est.irsCents)} − SS ${formatEUR(est.ssEmpCents)}`
              + (est.perDiemCents ? ` + ajudas ${formatEUR(est.perDiemCents)}` : '') + `; ${est.explain[0]}`,
          source, toConfirm: sal.toConfirm, account: opts.mainAccount, personId: p.id,
        });
      }
      const meal = ruleDate('refeicao', month);
      if (mealCard > 0) {
        items.push({
          id: `refeicao:${p.id}:${month}`, ref: p.id, date: meal.date, nominalDate: meal.nominal, kind: 'refeicao',
          label: `Cartão refeição ${name} — ${monthLabelPt(month)}`, amountCents: -mealCard, month,
          inputs: rec ? 'recibo registado' : `${est.meal.days} dias × ${formatEUR(est.terms.mealPerDayCents)} (${est.explain[0]})`,
          source, toConfirm: meal.toConfirm, account: opts.mainAccount, personId: p.id,
        });
      }
      const vales = ruleDate('vales', month);
      for (const v of cardBenefits(est, rec)) {
        if (v.cents <= 0) continue;
        const fee = vales.fee ? providerFeeCents(v.cents, vales.fee) : 0;
        items.push({
          id: `vales:${p.id}.${v.code}:${month}`, ref: `${p.id}.${v.code}`, date: vales.date, nominalDate: vales.nominal, kind: 'vales',
          label: `${v.label} ${name} — ${monthLabelPt(month)}`, amountCents: -(v.cents + fee),
          ...(fee ? { baseCents: -v.cents } : {}), month,
          inputs: (rec ? `recibo registado: ${formatEUR(v.cents)}` : `estimativa: ${formatEUR(v.cents)}`)
            + (vales.fee && fee ? ` + ${vales.fee.label} ${formatEUR(fee)} (${vales.fee.pct}% + IVA ${vales.fee.vatPct}%)` : ''),
          source, toConfirm: vales.toConfirm, account: opts.mainAccount, personId: p.id,
        });
      }
      ssEmp += rec ? rec.ssEmpCents : est.ssEmpCents;
      ssEr += rec ? rec.ssErCents : est.ssErCents;
      irs += rec ? rec.irsCents : est.irsCents;
    }
    ss = ssEmp + ssEr;
    const ssDate = ruleDate('ss', month);
    if (ss > 0) {
      items.push({
        id: `ss:all:${month}`, ref: 'all', date: ssDate.date, nominalDate: ssDate.nominal, kind: 'ss',
        label: `Segurança Social — ${monthLabelPt(month)}`, amountCents: -ss, month,
        inputs: `trabalhadores ${formatEUR(ssEmp)} + empresa ${formatEUR(ssEr)}`,
        source: anyEstimate ? 'plano' : 'recibo', toConfirm: ssDate.toConfirm, account: opts.mainAccount,
      });
    }
    const irsDate = ruleDate('irs', month);
    if (irs > 0) {
      items.push({
        id: `irs:all:${month}`, ref: 'all', date: irsDate.date, nominalDate: irsDate.nominal, kind: 'irs',
        label: `IRS retido — ${monthLabelPt(month)}`, amountCents: -irs, month,
        inputs: 'retenções na fonte dos salários do mês',
        source: anyEstimate ? 'plano' : 'recibo', toConfirm: irsDate.toConfirm, account: opts.mainAccount,
      });
    }
  }

  // ── Fixed costs ──
  for (const [key, versions] of Object.entries(costPlanVersions(state))) {
    for (const month of months) {
      const monthNo = Number(month.slice(5, 7));
      for (let vi = 0; vi < versions.length; vi++) {
        const v = versions[vi];
        const next = versions[vi + 1];
        let nominal: IsoDate;
        if (v.frequency === 'once') {
          if (monthOf(v.from) !== month) continue;
          nominal = v.from;
        } else {
          if (v.frequency === 'annual' && !(v.months ?? []).includes(monthNo)) continue;
          nominal = dayInMonth(month, v.day);
        }
        if (nominal < v.from || (v.to && nominal > v.to) || (next && nominal >= next.from)) continue;
        const date = adjustToBusinessDay(nominal, 'after', national);
        let amount = v.amountCents;
        let inputs = v.frequency === 'monthly' ? `mensal, dia ${v.day}`
          : v.frequency === 'annual' ? `anual (${(v.months ?? []).map(n => MONTHS_PT[n - 1]).join(', ')}), dia ${v.day}`
          : `uma vez, ${v.from}`;
        if (v.loan) {
          const k = monthsBetween(v.loan.firstPaymentMonth, month).length - 1;
          if (k < 0) continue;
          const balance = v.loan.principalCents - v.loan.capitalPerMonthCents * k;
          if (balance <= 0) continue;
          const interest = Math.round((balance * v.loan.annualRatePct) / 100 / 12);
          const stamp = Math.round((interest * v.loan.stampDutyPct) / 100);
          amount = Math.min(v.loan.capitalPerMonthCents, balance) + interest + stamp;
          inputs = `capital ${formatEUR(Math.min(v.loan.capitalPerMonthCents, balance))} + juros ${formatEUR(interest)} sobre ${formatEUR(balance)} + selo ${formatEUR(stamp)}`;
        }
        items.push({
          id: `custo:${key}:${month}`, ref: key, date, nominalDate: nominal, kind: 'custo',
          label: v.description, amountCents: v.direction === 'entrada' ? amount : -amount, month,
          inputs, source: 'plano', toConfirm: !!v.toConfirm, account: v.account, costKey: key,
        });
      }
    }
  }

  return items
    .filter(i => i.date >= from && i.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}
