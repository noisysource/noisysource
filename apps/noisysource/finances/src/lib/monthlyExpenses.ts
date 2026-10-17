/**
 * monthlyExpenses.ts — Despesas do mês (HANDOFF-finhub-redesign.md step 2). Pure.
 *
 * For each month of a year, what the entity is expected to spend, grouped like Recorrentes:
 * - recurring expense entries that fall in that month (typed and derived: insurances, …), with the
 *   same month rules as IVA and Custos do mês (recurringOccursInMonth);
 * - the credit instalments of that month;
 * - salaries ("Pessoal"): the confirmed payroll run of that month when there is one (what was
 *   actually processed), else the contract in force (forecast). The contracts' synced "Encargos"
 *   entries are left out: they'd count the same pay twice, without the vouchers.
 * Expected costs only; actual ones come with Movimentos (step 4).
 */
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import { recurringMonthlyAmountCents, recurringVatCode } from "@shared/models/RecurringEntry";
import type { CreditContractDoc } from "@shared/models/CreditContract";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import { buildAmortizationSchedule } from "@shared/lib/amortization";
import { computeMonthlyPayroll, contractInForce } from "@shared/lib/payroll";
import { splitGross, type VatCode } from "@shared/lib/vat";
import { formatEUR } from "@shared/lib/money";
import { recurringOccursInMonth } from "./recurringSchedule";
import { DERIVED_GROUP, kindOf, topCategory } from "./recurringItems";

export type ExpenseLineSource = "recurring" | "credit" | "payroll_run" | "contract";

export type ExpenseLine = {
  key: string;
  label: string;
  /** Com IVA (as paid). */
  amountCents: number;
  /** Sem IVA; equal to amountCents when no VAT applies or it's unknown. */
  netCents: number;
  /** For recurring entries in a company: the entry's VAT code. */
  vatCode?: VatCode;
  source: ExpenseLineSource;
  detail?: string;
};

export type ExpenseGroup = { name: string; amountCents: number; netCents: number; lines: ExpenseLine[] };

export type MonthExpenses = {
  ym: string;
  amountCents: number;
  netCents: number;
  groups: ExpenseGroup[];
  /** Lines with "IVA por confirmar": counted at face value in both columns. */
  unconfirmedVatCount: number;
  /** Some salary comes from a processed payroll run (not a forecast). */
  hasPayrollRuns: boolean;
};

export type MonthlyExpensesInput = {
  year: number;
  entries: readonly RecurringEntryDoc[];
  credits: readonly CreditContractDoc[];
  categories: ReadonlyArray<{ id: string; name: string; parentId?: string }>;
  /** The entity's employment contracts and confirmed payroll runs (companies; none for Casa). */
  contracts: readonly EmploymentContractDoc[];
  payrollRuns: readonly PayrollRunDoc[];
  peopleById: Readonly<Record<string, string>>;
  /** "YYYY-MM" → KidClub volume, for commission entries (EasyPay). */
  volumeByMonth?: Readonly<Record<string, number>>;
  /** Split VAT out (companies). Casa: false, every amount as paid. */
  withVat: boolean;
};

const PAYROLL_GROUP = DERIVED_GROUP.salary_cost;
const cents = (n: number) => formatEUR(n);

function monthLines(input: MonthlyExpensesInput, ym: string): { lines: Array<ExpenseLine & { group: string }>; unconfirmed: number; runs: boolean } {
  const [y, m] = ym.split("-").map(Number);
  const catById = new Map(input.categories.map(c => [c.id, c]));
  const lines: Array<ExpenseLine & { group: string }> = [];
  let unconfirmed = 0;

  for (const e of input.entries) {
    if (e.type !== "expense" || !e.active || !recurringOccursInMonth(e, ym)) continue;
    const { kind } = kindOf(e.sourceId);
    if (kind === "salary_cost") continue; // salaries come from runs / contracts below
    const amountCents = recurringMonthlyAmountCents(e, input.volumeByMonth?.[ym]);
    if (!amountCents) continue;
    let netCents = amountCents;
    let vatCode: VatCode | undefined;
    if (input.withVat) {
      vatCode = recurringVatCode(e) ?? undefined;
      const split = vatCode ? splitGross(amountCents, vatCode) : null;
      if (split) netCents = split.netCents;
      else if (vatCode === "por_confirmar") unconfirmed++;
    }
    lines.push({
      key: e.id, label: e.description, amountCents, netCents, vatCode, source: "recurring",
      group: kind === "manual" ? topCategory(e.categoryId, catById) : DERIVED_GROUP[kind],
    });
  }

  for (const c of input.credits) {
    if (!c.active) continue;
    const row = buildAmortizationSchedule(c).find(r => r.ym === ym);
    if (!row) continue;
    lines.push({
      key: `credit:${c.id}`, label: c.description, amountCents: row.paymentCents, netCents: row.paymentCents,
      source: "credit", group: DERIVED_GROUP.credit,
      detail: `capital ${cents(row.capitalCents)} · juros ${cents(row.interestCents)}`,
    });
  }

  const runsThisMonth = input.payrollRuns.filter(r => r.year === y && r.month === m);
  const paidPeople = new Set(runsThisMonth.map(r => r.personId));
  for (const r of runsThisMonth) {
    lines.push({
      key: `run:${r.id}`, label: `Salário — ${input.peopleById[r.personId] ?? r.personId}`,
      amountCents: r.costToEmployerCents, netCents: r.costToEmployerCents, source: "payroll_run", group: PAYROLL_GROUP,
      detail: `processado · bruto ${cents(r.grossCents)} · SS patronal ${cents(r.ssErCents)} · benefícios ${cents(r.benefitsCents)}`,
    });
  }
  for (const c of input.contracts) {
    if (paidPeople.has(c.personId) || !contractInForce(c, y, m)) continue;
    const row = computeMonthlyPayroll(c, y, m);
    const who = input.peopleById[c.personId] ?? c.personId;
    lines.push({
      key: `contract:${c.id}`,
      label: `${c.contractType === "green_receipt" ? "Recibo verde" : "Salário"} — ${who}`,
      amountCents: row.totals.costToEmployerCents, netCents: row.totals.costToEmployerCents,
      source: "contract", group: PAYROLL_GROUP,
      detail: `previsto · bruto ${cents(row.grossCents)} · SS patronal ${cents(row.ssErCents)} · benefícios ${cents(row.totals.benefitsCents)}`,
    });
  }

  return { lines, unconfirmed, runs: runsThisMonth.length > 0 };
}

/** The twelve months of `year`, January first. */
export function buildMonthlyExpenses(input: MonthlyExpensesInput): MonthExpenses[] {
  return Array.from({ length: 12 }, (_, i) => {
    const ym = `${input.year}-${String(i + 1).padStart(2, "0")}`;
    const { lines, unconfirmed, runs } = monthLines(input, ym);
    const byGroup = new Map<string, ExpenseGroup>();
    for (const { group, ...line } of lines) {
      const g = byGroup.get(group) ?? { name: group, amountCents: 0, netCents: 0, lines: [] };
      g.lines.push(line);
      g.amountCents += line.amountCents;
      g.netCents += line.netCents;
      byGroup.set(group, g);
    }
    const groups = [...byGroup.values()].sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));
    for (const g of groups) g.lines.sort((a, b) => b.amountCents - a.amountCents || a.label.localeCompare(b.label));
    return {
      ym,
      amountCents: groups.reduce((s, g) => s + g.amountCents, 0),
      netCents: groups.reduce((s, g) => s + g.netCents, 0),
      groups,
      unconfirmedVatCount: unconfirmed,
      hasPayrollRuns: runs,
    };
  });
}
