// Builds NoisySource's FinHub v2 events from the local documents (prodata/, never committed):
//   - finhub-seed.json (#94's seed): people, NoisySource's employment contracts, payroll runs
//     (for employer SS, which isn't on the payslips), recurring costs, insurances, the BPI loan;
//   - finhub-v2-noisysource.json: the Malt contracts (transcribed from Malt's pages), holiday
//     calendars, days off, per diem values, subsidy months, the SS exemption, payment rules and a
//     few cost plans read from the statements (shape: scripts/finhub-v2/noisysource-inputs.example.json);
//   - the payslip PDFs and the BPI statement PDFs, already parsed.
// Pure apart from the inputs passed in. Every event is validated (buildNsEvent) and has a
// deterministic id, so a second import finds them all and writes nothing.

import { bpiPdfTxId } from '../../../apps/noisysource/finances/src/lib/parsers/bpiPdf';
import type { ParsedBpiStatement } from '../../../apps/noisysource/finances/src/lib/parsers/bpiXlsx';
import { addDays, monthOf, yearOf } from '../../../packages/shared/finhub/dates';
import { personDays, workingDays } from '../../../packages/shared/finhub/days';
import { holidayDates } from '../../../packages/shared/finhub/holidays';
import {
  buildNsEvent, nsIds, type CalendarKind, type EmploymentTerms, type NsEvent, type NsEventType, type NsPayload,
  type PaymentRuleWhat, type PayslipLine,
} from '../../../packages/shared/finhub/noisysource/events';
import type { VatCode } from '../../../packages/shared/lib/vat';
import type { ParsedPayslip } from './payslipPdf';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Seed = any;
type Inputs = any;

export interface SourceStatement { file: string; statement: ParsedBpiStatement }
export interface SourcePayslip { file: string; payslip: ParsedPayslip }

export interface BuildResult {
  events: NsEvent[];
  /** Problems that refuse the import (nothing is written). */
  errors: string[];
  /** Things worth knowing that don't block (no amounts). */
  notes: string[];
}

export const IMPORTER = 'importer:finhub-v2-noisysource-dev';

export function buildNoisySourceEvents(seed: Seed, inputs: Inputs, statements: SourceStatement[], payslips: SourcePayslip[], now: string): BuildResult {
  const events: NsEvent[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  const add = <T extends NsEventType>(type: T, payload: NsPayload<T>, id: string, note?: string) => {
    try {
      events.push(buildNsEvent(type, payload, { id, source: type === 'bank.movement.imported' ? 'import:bpi-pdf' : 'import:seed', recordedBy: IMPORTER, recordedAt: now, note }) as unknown as NsEvent);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  };
  const ns = seed.entities.noisysource;
  const account: string = inputs.accountId;
  const names = new Map<string, string>(seed.people.map((p: any) => [p.key, p.name]));

  // ── Holiday calendars ──
  for (const h of inputs.holidays) {
    add('holidays.set', { calendarId: h.calendarId, year: h.year, dates: h.dates, names: h.names, toConfirm: !!h.toConfirm, note: h.note }, nsIds.holidays(h.calendarId, h.year));
  }
  const extra: Record<string, Record<number, string[]>> = {};
  for (const h of inputs.holidays) (extra[h.calendarId] ??= {})[h.year] = h.dates;
  const companyCalendars = ['pt-coimbra', ...inputs.holidays.filter((h: any) => h.calendarId.startsWith('empresa-')).map((h: any) => h.calendarId)]
    .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

  // ── EC contracts ──
  for (const c of inputs.ecContracts) {
    const { comment: _c, ...payload } = c;
    add('ec.contract.signed', payload, nsIds.ecContract(c.number));
  }

  // ── Employment terms: the seed's versions, split where the employer SS exemption starts and ends ──
  const ex = inputs.employerSsExemption;
  const exemptAfter = addDays(ex.to, 1);
  const byPerson = new Map<string, any[]>();
  for (const c of ns.employmentContracts) byPerson.set(c.person, [...(byPerson.get(c.person) ?? []), c]);
  for (const [personId, versions] of byPerson) {
    versions.sort((a, b) => a.from.localeCompare(b.from));
    const points = [...new Set([...versions.map(v => v.from), ex.from, exemptAfter])].sort();
    for (const from of points) {
      const v = versions.find(x => x.from <= from && (!x.to || from <= x.to));
      if (!v) continue;
      const exempt = from >= ex.from && from <= ex.to;
      const meal = (v.benefits ?? []).find((b: any) => b.type === 'MEAL_CARD');
      const benefits = (v.benefits ?? []).filter((b: any) => b.type !== 'MEAL_CARD').map((b: any) => {
        if (b.type === 'CHILDCARE') return { code: 'creche', label: 'Vale infância', perMonthCents: b.perMonthCents, subjectToIRS: !!b.subjectToIRS, subjectToSS: !!b.subjectToSS, paidAs: 'cartao' as const };
        if (b.type === 'EDUCATION') return { code: 'educacao', label: 'Vale educação', perMonthCents: b.perMonthCents, subjectToIRS: !!b.subjectToIRS, subjectToSS: !!b.subjectToSS, paidAs: 'cartao' as const };
        errors.push(`terms ${personId}: unknown benefit ${b.type}`);
        return null;
      }).filter(Boolean);
      const toConfirm: string[] = [];
      if ((inputs.perDiemToConfirm ?? []).includes(personId)) toConfirm.push('perDiemCents');
      if (inputs.christmasSubsidyToConfirm) toConfirm.push('christmasSubsidyMonth');
      const terms: EmploymentTerms = {
        personId,
        personName: names.get(personId) ?? personId,
        from,
        contractType: v.contractType === 'green_receipt' ? 'green_receipt' : 'employee',
        grossMonthlyCents: v.grossMonthlyCents,
        irsRatePct: v.irsRatePct,
        ssEmpPct: v.ssEmpPct,
        ssErPct: exempt ? 0 : v.ssErPct,
        ...(exempt ? { ssErNote: ex.note } : {}),
        mealPerDayCents: meal?.perDayCents ?? 0,
        mealPaidAs: 'cartao',
        perDiemCents: inputs.perDiemCents?.[personId] ?? 0,
        benefits,
        holidaySubsidyMonth: inputs.holidaySubsidyMonth?.[personId] ?? null,
        christmasSubsidyMonth: inputs.christmasSubsidyMonth?.[personId] ?? null,
        payDay: inputs.salaryPayDay,
        calendars: companyCalendars,
        ...(toConfirm.length ? { toConfirm } : {}),
      };
      add('employment.terms.set', terms, nsIds.terms(personId, from));
    }
  }

  // ── Calendar entries given in the inputs ──
  const calendar: { personId: string; kind: CalendarKind; dates: string[] }[] = [];
  for (const c of inputs.calendar) {
    calendar.push(c);
    add('calendar.entry.set', { personId: c.personId, kind: c.kind, dates: c.dates, halfDays: [], label: c.label, ...(c.datesToConfirm ? { datesToConfirm: true } : {}) },
      nsIds.calendar(c.personId, c.kind, [...c.dates].sort()[0]));
  }

  // ── Payslips (recorded facts) + trip days read back from their per diem lines ──
  const runs = new Map<string, any>();
  const contractPerson = new Map<string, string>(ns.employmentContracts.map((c: any) => [c.key, c.person]));
  for (const r of ns.payrollRuns) runs.set(`${contractPerson.get(r.contract)}|${r.month}`, r);
  const rebuilt = new Map<string, any[]>();
  for (const l of inputs.rebuiltPayslipLines ?? []) rebuilt.set(`${l.personId}|${l.month}`, [...(rebuilt.get(`${l.personId}|${l.month}`) ?? []), l]);

  const seen = new Set<string>();
  for (const { file, payslip: p } of payslips) {
    const personId = inputs.employeeNumbers[p.employeeNo];
    if (!personId) { errors.push(`${file} p.${p.page}: unknown employee number`); continue; }
    const key = `${personId}|${p.month}`;
    if (seen.has(key)) { errors.push(`${file}: second payslip for ${key}`); continue; }
    seen.add(key);
    const run = runs.get(key);
    if (!run) { errors.push(`${file}: no seed payroll run for ${key}`); continue; }

    const lines: PayslipLine[] = [...p.lines];
    let gross = p.totalIliquidoCents - lines.filter(l => l.kind === 'ajudas').reduce((s, l) => s + l.amountCents, 0);
    let irs = p.irsCents;
    let ssEmp = p.ssCents;
    let net = p.netCents;
    let note: string | undefined;
    for (const rb of rebuilt.get(key) ?? []) {
      lines.push({ code: '—', label: rb.label, kind: rb.kind, amountCents: rb.amountCents, rebuilt: true });
      gross += rb.amountCents;
      irs += rb.irsCents;
      ssEmp += rb.ssEmpCents;
      net += rb.amountCents - rb.irsCents - rb.ssEmpCents;
      note = rb.note;
    }
    const checks: [string, number, number][] = [
      ['gross', gross, run.grossCents], ['IRS', irs, run.irsCents], ['SS', ssEmp, run.ssEmpCents], ['net', net, run.netPaidCents],
    ];
    for (const [what, got, want] of checks) {
      if (got !== want) errors.push(`${file} ${key}: ${what} on the payslip ≠ the seed's payroll run`);
    }
    add('payroll.payslip.recorded', {
      personId, month: p.month, lines, grossCents: gross, irsRatePct: p.irsRatePct, irsCents: irs, ssEmpCents: ssEmp,
      ssErCents: run.ssErCents, ssErDerived: true, netCents: net,
    }, nsIds.payslip(personId, p.month), note);

    const perDiem = inputs.perDiemCents?.[personId] ?? 0;
    const ajudas = p.lines.filter(l => l.kind === 'ajudas').reduce((s, l) => s + l.amountCents, 0);
    if (ajudas > 0 && perDiem > 0) {
      const n = Math.round(ajudas / perDiem);
      if (ajudas % perDiem !== 0) notes.push(`${key}: per diem line isn't a whole number of days at the terms' value (rounded to ${n})`);
      const holidays = holidayDates(companyCalendars, [yearOf(p.month)], extra);
      const away = personDays(calendar.filter(c => c.personId === personId) as any);
      const free = workingDays(p.month, { holidays }).dates.filter(d => !away.off.has(d) && !away.leave.has(d) && !away.trip.has(d));
      const dates = free.slice(0, n);
      if (dates.length < n) { errors.push(`${key}: not enough working days to place ${n} trip days`); continue; }
      const entry = { personId, kind: 'viagem' as const, dates };
      calendar.push(entry);
      add('calendar.entry.set', { ...entry, halfDays: [], label: `Viagem: ${n} dias pelas ajudas de custo do recibo (datas a confirmar)`, datesToConfirm: true },
        nsIds.calendar(personId, 'viagem', dates[0]));
    }
  }

  // ── Payment rules ──
  for (const r of inputs.paymentRules) {
    add('payment.rule.set', { what: r.what as PaymentRuleWhat, label: r.label, from: '2026-01-01', day: r.day, monthOffset: r.monthOffset, nonBusinessDay: r.nonBusinessDay, toConfirm: !!r.toConfirm, evidence: r.evidence, ...(r.fee ? { fee: r.fee } : {}) },
      nsIds.rule(r.what, '2026-01-01'));
  }

  // ── Cost plans: seed recurring costs, insurances, the loan, and the extras from the statements ──
  for (const r of ns.recurring) {
    if (r.type !== 'expense') { notes.push(`recurring ${r.key}: type ${r.type} skipped`); continue; }
    add('cost.plan.set', {
      key: r.key, description: r.description, amountCents: r.amountCents, direction: 'saida', vatCode: r.vatCode as VatCode,
      frequency: 'monthly', day: r.dayOfMonth, from: '2026-01-01', account: r.account, category: r.category,
    }, nsIds.cost(r.key, '2026-01-01'));
  }
  for (const s of ns.insurances) {
    const override = inputs.insurancePlans?.[s.key];
    const monthly = (override?.frequency ?? s.frequency) === 'monthly';
    const renewal: string | undefined = s.renewalDate;
    if (!monthly && !renewal) { errors.push(`insurance ${s.key}: annual without a renewal date`); continue; }
    add('cost.plan.set', {
      key: s.key, description: `Seguro — ${s.name}`, amountCents: s.premiumCents, direction: 'saida', vatCode: 'isento',
      frequency: monthly ? 'monthly' : 'annual', ...(monthly ? {} : { months: [Number(renewal!.slice(5, 7))] }),
      day: override?.day ?? Number(renewal?.slice(8, 10) ?? 1), from: '2026-01-01', account, category: 'cat-ns-seguros',
      toConfirm: /PRECISA DE MAIS DADOS/.test(s.notes ?? ''),
    }, nsIds.cost(s.key, '2026-01-01'));
  }
  for (const c of ns.creditContracts) {
    const l = inputs.loan;
    add('cost.plan.set', {
      key: l.key, description: l.description, amountCents: 0, direction: 'saida', vatCode: 'isento', frequency: 'monthly',
      day: l.day, from: `${c.startYearMonth}-01`, account, category: l.category, toConfirm: !!l.toConfirm,
      loan: { principalCents: c.loanAmountCents, capitalPerMonthCents: l.capitalPerMonthCents, annualRatePct: c.annualRatePct, firstPaymentMonth: c.startYearMonth, stampDutyPct: l.stampDutyPct },
    }, nsIds.cost(l.key, `${c.startYearMonth}-01`));
  }
  for (const c of inputs.extraCostPlans ?? []) {
    const { comment: _c, ...p } = c;
    add('cost.plan.set', { ...p, account }, nsIds.cost(c.key, c.from));
  }

  // ── Bank movements ──
  const ids = new Set<string>();
  for (const { file, statement } of [...statements].sort((a, b) => a.statement.dateFrom.localeCompare(b.statement.dateFrom))) {
    const importId = `bpi-pdf-${account}-${statement.dateTo}`;
    statement.transactions.forEach((tx, seq) => {
      const id = bpiPdfTxId(account, tx);
      if (ids.has(id)) { errors.push(`${file}: duplicate movement id`); return; }
      ids.add(id);
      add('bank.movement.imported', {
        accountId: account, date: tx.date, valueDate: tx.valueDate, amountCents: tx.amountCents, description: tx.description,
        balanceAfterCents: tx.balanceCents, importId, seq,
      }, id);
    });
  }
  // Consecutive statements must chain: each opening balance = the previous closing balance.
  const sorted = [...statements].sort((a, b) => a.statement.dateFrom.localeCompare(b.statement.dateFrom));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].statement.openingBalanceCents !== sorted[i - 1].statement.closingBalanceCents) {
      errors.push(`${sorted[i].file}: opening balance ≠ the previous statement's closing balance`);
    }
  }
  if (sorted.length && monthOf(sorted[0].statement.dateFrom) !== '2026-01') notes.push('first statement does not start in January 2026');

  return { events, errors, notes };
}
