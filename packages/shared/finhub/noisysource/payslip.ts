// packages/shared/finhub/noisysource/payslip.ts
//
// Payslip estimate from the employment terms in force and the month's days (HANDOFF-finhub-v2.md,
// "Payslip estimate"), and its comparison with a recorded payslip.
//
// Like computeMonthlyPayroll (packages/shared/lib/payroll.ts), but meal days, per diems and leave
// come from the calendar instead of a fixed daysPerMonth / 22, and it knows what the 2026 payslips
// do: IRS withheld rounded to the euro, leave deducted at base/30 per day, holiday and Christmas
// subsidies in their month, employer SS exemption as a terms version. The old function is left as
// it is for the old pages (they read EmploymentContractDoc, which pulls in Firebase types).

import { formatEUR } from '../../lib/money';
import { firstDay, yearOf, type YearMonth } from '../dates';
import { leaveDaysInMonth, mealDays, personDays, tripDaysInMonth, type MealDays } from '../days';
import { holidayDates } from '../holidays';
import type { EmploymentTerms, Payslip, PayslipLineKind } from './events';
import { calendarOf, termsAt, type NsState, type WithId } from './state';

export interface EstimateLine {
  kind: PayslipLineKind;
  /** Benefit code from the terms (benefit lines only). */
  code?: string;
  label: string;
  amountCents: number;
  quantity?: number;
  unitCents?: number;
  paidAs?: 'cartao' | 'conta';
}

export interface PayslipEstimate {
  personId: string;
  month: YearMonth;
  terms: WithId<EmploymentTerms>;
  lines: EstimateLine[];
  /** Taxable pay: base − leave + subsidies. */
  grossCents: number;
  irsBaseCents: number;
  ssBaseCents: number;
  irsCents: number;
  ssEmpCents: number;
  ssErCents: number;
  meal: MealDays;
  mealCents: number;
  tripDays: number;
  perDiemCents: number;
  leaveDays: number;
  /** Loaded on cards, not in the net pay. */
  cardTopUps: { refeicao: number; vales: number };
  /** Paid by transfer: gross − IRS − employee SS + per diems + benefits paid with the salary. */
  netCents: number;
  /** gross + employer SS + per diems + every benefit. */
  employerCostCents: number;
  explain: string[];
}

const pctOf = (cents: number, pct: number) => Math.round((cents * pct) / 100);
/** IRS withheld is a whole number of euros on every 2026 payslip (e.g. 18.96 → 19.00). */
const irsWithheld = (baseCents: number, pct: number) => Math.round((baseCents * pct) / 100 / 100) * 100;

const KIND_PT: Record<string, string> = { ferias: 'férias', doenca: 'doença', viagem: 'viagem', outro: 'outro', licenca: 'licença' };

export function estimatePayslip(state: NsState, personId: string, month: YearMonth): PayslipEstimate | null {
  const terms = termsAt(state, personId, firstDay(month));
  if (!terms) return null;
  const person = personDays(calendarOf(state, personId));
  const holidays = holidayDates(terms.calendars, [yearOf(month)], state.extraHolidays);
  const meal = mealDays(month, { holidays, person });
  const tripDays = tripDaysInMonth(month, person);
  const leaveDays = leaveDaysInMonth(month, person);
  const monthNo = Number(month.slice(5, 7));
  const base = terms.grossMonthlyCents;
  const wholeMonthOff = leaveDays >= 30;

  const lines: EstimateLine[] = [{ kind: 'base', label: 'Vencimento base', amountCents: base }];
  if (leaveDays > 0) {
    lines.push({ kind: 'licenca', label: 'Licença', amountCents: -Math.round((base * leaveDays) / 30), quantity: leaveDays });
  }
  if (terms.holidaySubsidyMonth === monthNo) lines.push({ kind: 'subsidio-ferias', label: 'Subsídio de férias', amountCents: base });
  if (terms.christmasSubsidyMonth === monthNo) lines.push({ kind: 'subsidio-natal', label: 'Subsídio de Natal', amountCents: base });
  const grossCents = lines.reduce((s, l) => s + l.amountCents, 0);

  const mealCents = terms.mealPerDayCents * meal.days;
  if (mealCents > 0) {
    lines.push({
      kind: 'refeicao', label: 'Subsídio de refeição', amountCents: mealCents,
      quantity: meal.days, unitCents: terms.mealPerDayCents, paidAs: terms.mealPaidAs,
    });
  }
  const perDiemCents = terms.perDiemCents * tripDays;
  if (perDiemCents > 0) {
    lines.push({ kind: 'ajudas', label: 'Ajudas de custo', amountCents: perDiemCents, quantity: tripDays, unitCents: terms.perDiemCents, paidAs: 'conta' });
  }

  let irsExtra = 0;
  let ssExtra = 0;
  let cardVales = 0;
  let cashBenefits = 0;
  for (const b of terms.benefits) {
    const amount = (wholeMonthOff ? 0 : b.perMonthCents ?? 0) + (b.perDayCents ?? 0) * meal.days;
    if (amount <= 0) continue;
    lines.push({ kind: 'beneficio', code: b.code, label: b.label, amountCents: amount, paidAs: b.paidAs });
    if (b.subjectToIRS) irsExtra += amount;
    if (b.subjectToSS) ssExtra += amount;
    if (b.paidAs === 'cartao') cardVales += amount; else cashBenefits += amount;
  }

  const irsBaseCents = grossCents + irsExtra;
  const ssBaseCents = grossCents + ssExtra;
  const isEmployee = terms.contractType === 'employee';
  const irsCents = irsWithheld(irsBaseCents, terms.irsRatePct);
  const ssEmpCents = isEmployee ? pctOf(ssBaseCents, terms.ssEmpPct) : 0;
  const ssErCents = isEmployee ? pctOf(ssBaseCents, terms.ssErPct) : 0;
  const mealCash = terms.mealPaidAs === 'conta' ? mealCents : 0;
  const netCents = grossCents - irsCents - ssEmpCents + perDiemCents + cashBenefits + mealCash;

  const removed = Object.entries(meal.removed).map(([k, n]) => ` − ${n} ${KIND_PT[k] ?? k}`).join('');
  const explain = [
    `${meal.possible} dias úteis${removed} = ${meal.days} dias de refeição`,
  ];
  if (tripDays > 0) explain.push(`${tripDays} dias de viagem × ${formatEUR(terms.perDiemCents)} = ${formatEUR(perDiemCents)} de ajudas de custo`);
  if (leaveDays > 0) explain.push(`${leaveDays} dias de licença descontados (base/30 por dia)`);
  if (terms.ssErNote) explain.push(terms.ssErNote);

  return {
    personId,
    month,
    terms,
    lines,
    grossCents,
    irsBaseCents,
    ssBaseCents,
    irsCents,
    ssEmpCents,
    ssErCents,
    meal,
    mealCents,
    tripDays,
    perDiemCents,
    leaveDays,
    cardTopUps: { refeicao: terms.mealPaidAs === 'cartao' ? mealCents : 0, vales: cardVales },
    netCents,
    employerCostCents: grossCents + ssErCents + perDiemCents + mealCents + cardVales + cashBenefits,
    explain,
  };
}

/** Card top-ups and per diems read back from a recorded payslip's lines. */
export function recordedAmounts(p: Payslip) {
  const sum = (kind: PayslipLineKind, paidAs?: 'cartao' | 'conta') =>
    p.lines.filter(l => l.kind === kind && (!paidAs || (l.paidAs ?? 'conta') === paidAs)).reduce((s, l) => s + l.amountCents, 0);
  const mealLine = p.lines.find(l => l.kind === 'refeicao');
  return {
    mealDays: mealLine?.quantity ?? 0,
    mealCents: sum('refeicao'),
    perDiemCents: sum('ajudas'),
    leaveCents: sum('licenca'),
    holidaySubsidyCents: sum('subsidio-ferias'),
    christmasSubsidyCents: sum('subsidio-natal'),
    cardTopUps: { refeicao: sum('refeicao', 'cartao'), vales: sum('beneficio', 'cartao') },
  };
}

export interface PayslipDiff {
  /** Short cause in Portuguese, e.g. "dias de refeição". No amounts. */
  cause: string;
  /** Counts only (days), never money: safe to show in reports. */
  detail?: string;
}

export interface PayslipComparison {
  equal: boolean;
  diffs: PayslipDiff[];
}

/**
 * Compares the estimate with the recorded payslip, field by field, and names each difference by
 * its cause. "Equal" means gross, IRS, employee SS, net and both card top-ups are the same.
 */
export function comparePayslip(est: PayslipEstimate, rec: Payslip): PayslipComparison {
  const r = recordedAmounts(rec);
  const diffs: PayslipDiff[] = [];
  const estLeave = est.lines.filter(l => l.kind === 'licenca').reduce((s, l) => s + l.amountCents, 0);
  const estHol = est.lines.filter(l => l.kind === 'subsidio-ferias').reduce((s, l) => s + l.amountCents, 0);
  const estXmas = est.lines.filter(l => l.kind === 'subsidio-natal').reduce((s, l) => s + l.amountCents, 0);

  if (est.terms.mealPerDayCents > 0 && est.meal.days !== r.mealDays) {
    diffs.push({ cause: 'dias de refeição', detail: `estimativa ${est.meal.days}, recibo ${r.mealDays}` });
  }
  if (est.perDiemCents !== r.perDiemCents) {
    const recDays = est.terms.perDiemCents > 0 ? r.perDiemCents / est.terms.perDiemCents : NaN;
    const detail = Number.isFinite(recDays)
      ? `estimativa ${est.tripDays} dias, recibo ${Number.isInteger(recDays) ? recDays : recDays.toFixed(2)} dias ao valor diário dos termos`
      : undefined;
    diffs.push({ cause: 'ajudas de custo', detail });
  }
  if (estLeave !== r.leaveCents) diffs.push({ cause: 'licença', detail: `estimativa ${est.leaveDays} dias` });
  if (estHol !== r.holidaySubsidyCents) diffs.push({ cause: 'subsídio de férias' });
  if (estXmas !== r.christmasSubsidyCents) diffs.push({ cause: 'subsídio de Natal' });
  if (est.cardTopUps.vales !== r.cardTopUps.vales) diffs.push({ cause: 'vales (cartão)' });
  const grossOk = est.grossCents === rec.grossCents;
  if (!grossOk && !diffs.some(d => ['licença', 'subsídio de férias', 'subsídio de Natal'].includes(d.cause))) {
    diffs.push({ cause: 'remuneração base' });
  }
  if (est.irsCents !== rec.irsCents) {
    const rateDiff = rec.irsRatePct != null && rec.irsRatePct !== est.terms.irsRatePct;
    diffs.push({ cause: rateDiff ? 'taxa de IRS do mês diferente da dos termos' : 'IRS retido' });
  }
  if (est.ssEmpCents !== rec.ssEmpCents && grossOk) diffs.push({ cause: 'SS do trabalhador' });
  if (est.ssErCents !== rec.ssErCents) diffs.push({ cause: rec.ssErDerived ? 'SS da empresa (derivada)' : 'SS da empresa' });

  const equal = grossOk && est.irsCents === rec.irsCents && est.ssEmpCents === rec.ssEmpCents
    && est.netCents === rec.netCents && est.cardTopUps.refeicao === r.cardTopUps.refeicao
    && est.cardTopUps.vales === r.cardTopUps.vales;
  if (!equal && diffs.length === 0) diffs.push({ cause: 'líquido' });
  return { equal, diffs };
}
