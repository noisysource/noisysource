/**
 * recurringItems.ts — everything that repeats for one entity, as Recorrentes shows it
 * (HANDOFF-finhub-redesign.md step 1). Pure: the page loads the docs and renders the result.
 *
 * Items come from the entity's recurring entries (hand-entered, and the ones the forms derive:
 * `emp:` salaries and charges, `inc:` external income, `ec:` EC income, `insurance:` premiums)
 * and from its credit contracts (the instalment of the month, which has no recurring entry).
 * Totals count only what is in force this month, as a monthly equivalent.
 */
import type { RecurringEntryDoc, RecurringFrequency, RecurringType } from "@shared/models/RecurringEntry";
import { recurringMonthlyAmountCents } from "@shared/models/RecurringEntry";
import type { CreditContractDoc } from "@shared/models/CreditContract";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import { buildAmortizationSchedule } from "@shared/lib/amortization";
import { computeMonthlyPayroll } from "@shared/lib/payroll";

export type RecurringItemKind =
  | "manual"        // typed in Recorrentes
  | "salary_cost"   // emp:<contract>:ns — the company's charge for a contract
  | "salary"        // emp:<contract>:private — net salary credited to Casa
  | "benefit"       // emp:/inc:…:benefit:<TYPE> — voucher credited to a card
  | "income_source" // inc:<source> — external employer's net pay
  | "ec"            // ec:<contract> — EC income
  | "insurance"     // insurance:<id> — premium
  | "credit";       // a credit contract's instalment

export type RecurringItemStatus = "current" | "future" | "ended" | "inactive";

export type RecurringItemDetail = { label: string; amountCents?: number; text?: string };

export type RecurringItem = {
  key: string;
  kind: RecurringItemKind;
  type: RecurringType;
  description: string;
  /** Per occurrence (credits: this month's instalment, or the next/last one when not current). */
  amountCents: number;
  /** Monthly equivalent counted in the totals: quarterly ÷ 3, annual ÷ 12; 0 when not current. */
  monthlyCents: number;
  frequency: RecurringFrequency;
  dayOfMonth: number;
  monthOfYear?: number;
  onceYearMonth?: string;
  startYearMonth?: string;
  endYearMonth?: string;
  /** Account it's paid from (expense, transfer) or credited to (income). */
  accountId?: string;
  toAccountId?: string;
  group: string;
  status: RecurringItemStatus;
  /** The recurring entry behind it (every kind except credit). */
  entry?: RecurringEntryDoc;
  credit?: CreditContractDoc;
  /** Id of the contract / source / insurance / credit it comes from (derived kinds). */
  sourceRef?: string;
  details: RecurringItemDetail[];
};

/** Group names for derived items: the seeded category names, so typed entries can share them. */
export const DERIVED_GROUP: Record<Exclude<RecurringItemKind, "manual">, string> = {
  salary_cost: "Pessoal",
  salary: "Salários",
  benefit: "Vales",
  income_source: "Salários",
  ec: "Prestação de serviços",
  insurance: "Seguros",
  credit: "Créditos",
};
export const UNCATEGORISED = "Sem categoria";

const BENEFIT_LABEL: Record<string, string> = {
  MEAL_CARD: "Cartão refeição", MEAL: "Subsídio de refeição", MEAL_VOUCHER: "Vale refeição",
  CHILDCARE: "Vale creche", EDUCATION: "Vale educação", EXPENSE_ALLOWANCE: "Ajudas de custo", OTHER: "Outro",
};
export const benefitLabel = (t?: string) => BENEFIT_LABEL[(t ?? "").toUpperCase()] ?? t ?? "Benefício";

export type RecurringItemsInput = {
  /** "YYYY-MM": the month whose items are current. */
  ym: string;
  entries: readonly RecurringEntryDoc[];
  credits: readonly CreditContractDoc[];
  categories: ReadonlyArray<{ id: string; name: string; parentId?: string }>;
  /** The entity's employment contracts, to break a salary charge down. */
  contracts?: readonly EmploymentContractDoc[];
};

function kindOf(sourceId: string | undefined): { kind: RecurringItemKind; ref?: string } {
  const s = sourceId ?? "";
  const part = s.split(":");
  if (s.startsWith("emp:")) {
    if (part[2] === "ns") return { kind: "salary_cost", ref: part[1] };
    if (part[2] === "private") return { kind: "salary", ref: part[1] };
    if (part[2] === "benefit") return { kind: "benefit", ref: part[1] };
  }
  if (s.startsWith("inc:")) return { kind: part[2] === "benefit" ? "benefit" : "income_source", ref: part[1] };
  if (s.startsWith("ec:")) return { kind: "ec", ref: part[1] };
  if (s.startsWith("insurance:")) return { kind: "insurance", ref: part[1] };
  return { kind: "manual" };
}

function topCategory(id: string | undefined, byId: ReadonlyMap<string, { name: string; parentId?: string }>): string {
  let c = id ? byId.get(id) : undefined;
  if (!c) return UNCATEGORISED;
  for (let i = 0; i < 10 && c.parentId && byId.has(c.parentId); i++) c = byId.get(c.parentId)!;
  return c.name;
}

function entryStatus(e: RecurringEntryDoc, ym: string): RecurringItemStatus {
  if (!e.active) return "inactive";
  if (e.frequency === "once" && e.onceYearMonth) {
    if (e.onceYearMonth < ym) return "ended";
    if (e.onceYearMonth > ym) return "future";
    return "current";
  }
  if (e.startYearMonth && e.startYearMonth > ym) return "future";
  if (e.endYearMonth && e.endYearMonth < ym) return "ended";
  return "current";
}

/** What an entry costs or earns per month, on average, while it's in force. */
export function monthlyEquivalentCents(e: RecurringEntryDoc, ym: string): number {
  const amount = recurringMonthlyAmountCents(e); // a commission: its estimate
  switch (e.frequency) {
    case "monthly": return amount;
    case "quarterly": return Math.round(amount / 3);
    case "annual": return Math.round(amount / 12);
    case "once": return e.onceYearMonth === ym ? amount : 0;
  }
}

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function salaryDetails(contract: EmploymentContractDoc | undefined, ym: string): RecurringItemDetail[] {
  if (!contract) return [];
  const [y, m] = ym.split("-").map(Number);
  const row = computeMonthlyPayroll(contract, y, m);
  const out: RecurringItemDetail[] = [
    { label: "Vencimento bruto", amountCents: row.grossCents },
    { label: `Segurança Social patronal (${contract.ssErPct ?? 0}%)`, amountCents: row.ssErCents },
    { label: "Encargos (bruto + SS patronal)", amountCents: row.grossCents + row.ssErCents },
  ];
  for (const b of row.benefits) {
    if (b.totalCents > 0) out.push({ label: `${benefitLabel(b.type)} (pago à parte)`, amountCents: b.totalCents });
  }
  out.push({ label: "Custo total para a empresa", amountCents: row.totals.costToEmployerCents });
  out.push({ label: "Líquido ao trabalhador", amountCents: row.netCents });
  return out;
}

function creditItem(c: CreditContractDoc, ym: string): RecurringItem {
  const schedule = buildAmortizationSchedule(c);
  const row = schedule.find(r => r.ym === ym);
  const first = schedule[0];
  const last = schedule[schedule.length - 1];
  const status: RecurringItemStatus = !c.active ? "inactive"
    : row ? "current"
    : first && ym < first.ym ? "future"
    : "ended";
  const shown = row ?? (status === "future" ? first : last);
  const endYM = addMonths(c.startYearMonth, c.termMonths - 1);
  const details: RecurringItemDetail[] = [];
  if (shown) {
    details.push({ label: "Capital", amountCents: shown.capitalCents });
    details.push({ label: "Juros", amountCents: shown.interestCents });
    details.push({ label: "Capital em dívida depois desta prestação", amountCents: shown.outstandingCents });
  }
  details.push({ label: "Taxa", text: `${c.annualRatePct}% ${c.rateType === "variable" ? "variável" : "fixa"}${c.interestOnlyPhase ? " · só juros" : ""}` });
  details.push({ label: "Credor", text: c.creditor });
  details.push({ label: "Última prestação", text: endYM });
  return {
    key: `credit:${c.id}`,
    kind: "credit",
    type: "expense",
    description: c.description,
    amountCents: shown?.paymentCents ?? 0,
    monthlyCents: status === "current" ? row!.paymentCents : 0,
    frequency: "monthly",
    dayOfMonth: c.dayOfMonth ?? 15,
    startYearMonth: c.startYearMonth,
    endYearMonth: endYM,
    accountId: c.accountId,
    group: DERIVED_GROUP.credit,
    status,
    credit: c,
    sourceRef: c.id,
    details,
  };
}

/** Every recurring item of one entity, for the month `ym`. */
export function buildRecurringItems(input: RecurringItemsInput): RecurringItem[] {
  const catById = new Map(input.categories.map(c => [c.id, c]));
  const contractById = new Map((input.contracts ?? []).map(c => [c.id, c]));
  const items: RecurringItem[] = [];

  for (const e of input.entries) {
    const { kind, ref } = kindOf(e.sourceId);
    const status = entryStatus(e, input.ym);
    const details: RecurringItemDetail[] = [];
    if (kind === "salary_cost") details.push(...salaryDetails(ref ? contractById.get(ref) : undefined, input.ym));
    if (e.startYearMonth || e.endYearMonth) {
      details.push({ label: "Período", text: `${e.startYearMonth ?? "…"} → ${e.endYearMonth ?? "sem fim"}` });
    }
    items.push({
      key: e.id,
      kind,
      type: e.type,
      description: e.description,
      amountCents: recurringMonthlyAmountCents(e),
      monthlyCents: status === "current" ? monthlyEquivalentCents(e, input.ym) : 0,
      frequency: e.frequency,
      dayOfMonth: e.dayOfMonth,
      monthOfYear: e.monthOfYear,
      onceYearMonth: e.onceYearMonth,
      startYearMonth: e.startYearMonth,
      endYearMonth: e.endYearMonth,
      accountId: e.accountId,
      toAccountId: e.toAccountId,
      group: kind === "manual" ? topCategory(e.categoryId, catById) : DERIVED_GROUP[kind],
      status,
      entry: e,
      sourceRef: ref,
      details,
    });
  }

  for (const c of input.credits) items.push(creditItem(c, input.ym));
  return items;
}

export type RecurringGroup = {
  name: string;
  items: RecurringItem[];
  /** Monthly equivalents of the current items. */
  incomeCents: number;
  expenseCents: number;
};

/**
 * Current items grouped by category (their group) or by account; groups and items sorted by size.
 * Items that aren't current are left out: the page lists them apart.
 */
export function groupRecurringItems(
  items: readonly RecurringItem[],
  by: "category" | "account",
  accountName: (id: string | undefined) => string,
): RecurringGroup[] {
  const groups = new Map<string, RecurringGroup>();
  for (const it of items) {
    if (it.status !== "current") continue;
    const name = by === "category" ? it.group : accountName(it.accountId);
    const g = groups.get(name) ?? { name, items: [], incomeCents: 0, expenseCents: 0 };
    g.items.push(it);
    if (it.type === "income") g.incomeCents += it.monthlyCents;
    if (it.type === "expense") g.expenseCents += it.monthlyCents;
    groups.set(name, g);
  }
  for (const g of groups.values()) g.items.sort((a, b) => b.monthlyCents - a.monthlyCents || a.description.localeCompare(b.description));
  return [...groups.values()].sort((a, b) =>
    (b.expenseCents + b.incomeCents) - (a.expenseCents + a.incomeCents) || a.name.localeCompare(b.name));
}
