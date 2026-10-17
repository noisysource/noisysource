/**
 * movementMatching.ts — Movimentos (HANDOFF-finhub-redesign.md step 4). Pure.
 *
 * For one account and one month: what was expected to move (recurring entries, credit
 * instalments, processed salaries), a suggestion for each statement line still to classify, and
 * the expected items that never showed up. Suggestions are never stored or confirmed on their own
 * (Renato, 2026-10-18): the page shows them and waits for a click.
 */
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import { recurringMonthlyAmountCents } from "@shared/models/RecurringEntry";
import type { CreditContractDoc } from "@shared/models/CreditContract";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import type { BankTransactionDoc, BankTransactionMatch, MovementRuleDoc } from "@shared/models/BankTransaction";
import { buildAmortizationSchedule } from "@shared/lib/amortization";
import { recurringOccursInMonth } from "./recurringSchedule";

export type ExpectedItem = {
  /** `${kind}:${ref}:${yearMonth}` */
  key: string;
  kind: "recurring" | "credit" | "payroll";
  ref: string;
  yearMonth: string;
  label: string;
  /** Signed like a statement line: money out < 0. */
  amountCents: number;
  /** ISO date it's expected on. */
  date: string;
  /** The amount is an estimate (a commission): match by description and date, not exact amount. */
  estimate?: boolean;
  /** Any line amount in this range fits (absolute cents): a salary is net + whatever benefits came in cash. */
  amountRangeCents?: [number, number];
};

export type MovementSuggestion = {
  match: Omit<BankTransactionMatch, "confirmedAt">;
  /** The expected item it would settle, if any. */
  item?: ExpectedItem;
  score: number;
  reason: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m, 0).getDate(); };
const dateIn = (ym: string, day: number) => `${ym}-${pad(Math.min(Math.max(day, 1), lastDay(ym)))}`;
const daysBetween = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

/**
 * A description reduced to its stable words: upper case, no accents, digits, punctuation or
 * single letters. "DD MEO, SA 41177542876" → "DD MEO SA"; IBANs and reference numbers drop out.
 */
export function normalizeDescription(desc: string): string {
  return desc
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1)
    .join(" ");
}

const words = (s: string) => new Set(normalizeDescription(s).split(" ").filter(w => w.length > 2));

/** What was expected to move through `accountId` in month `ym`. */
export function expectedForMonth(input: {
  ym: string;
  accountId: string;
  entries: readonly RecurringEntryDoc[];
  credits: readonly CreditContractDoc[];
  payrollRuns: readonly PayrollRunDoc[];
  peopleById: Readonly<Record<string, string>>;
}): ExpectedItem[] {
  const { ym, accountId } = input;
  const out: ExpectedItem[] = [];

  for (const e of input.entries) {
    if (!e.active || !recurringOccursInMonth(e, ym)) continue;
    const amount = recurringMonthlyAmountCents(e);
    const base = { kind: "recurring" as const, ref: e.id, yearMonth: ym, label: e.description, date: dateIn(ym, e.dayOfMonth), estimate: e.costModel === "commission" };
    if (e.accountId === accountId) {
      const sign = e.type === "income" ? 1 : -1;
      out.push({ ...base, key: `recurring:${e.id}:${ym}`, amountCents: sign * amount });
    }
    if (e.type === "transfer" && e.toAccountId === accountId) {
      out.push({ ...base, key: `recurring-in:${e.id}:${ym}`, amountCents: amount });
    }
  }

  for (const c of input.credits) {
    if (!c.active || c.accountId !== accountId) continue;
    const row = buildAmortizationSchedule(c).find(r => r.ym === ym);
    if (!row) continue;
    out.push({
      key: `credit:${c.id}:${ym}`, kind: "credit", ref: c.id, yearMonth: ym, label: c.description,
      amountCents: -row.paymentCents, date: dateIn(ym, c.dayOfMonth ?? 15),
    });
  }

  const [y, m] = ym.split("-").map(Number);
  for (const r of input.payrollRuns) {
    if (r.year !== y || r.month !== m || r.sourceAccountId !== accountId) continue;
    out.push({
      key: `payroll:${r.id}:${ym}`, kind: "payroll", ref: r.id, yearMonth: ym,
      label: `Salário — ${input.peopleById[r.personId] ?? r.personId}`,
      // What reaches the person's account: net + benefits paid in cash; vouchers go to cards.
      amountCents: -r.netCents, date: dateIn(ym, 28),
      amountRangeCents: [r.netCents, r.netCents + r.benefitsCents],
    });
  }
  return out;
}

/** True when an expected item is already settled by a confirmed line. */
const settledBy = (item: ExpectedItem, m?: BankTransactionMatch) =>
  !!m && m.kind === item.kind && m.ref === item.ref && (m.yearMonth ?? item.yearMonth) === item.yearMonth;

/**
 * One suggestion per line still to classify: a remembered description first, then the expected
 * item with the same sign that fits best (exact amount, close date, words in common). Each
 * expected item is suggested for one line at most; already settled ones aren't suggested again.
 */
export function suggestMatches(
  lines: readonly BankTransactionDoc[],
  expected: readonly ExpectedItem[],
  rules: readonly MovementRuleDoc[],
): Map<string, MovementSuggestion> {
  const out = new Map<string, MovementSuggestion>();
  const open = expected.filter(item => !lines.some(l => settledBy(item, l.match)));
  const pending = lines.filter(l => !l.match);

  // Remembered descriptions.
  const taken = new Set<string>();
  for (const l of pending) {
    const key = normalizeDescription(l.description);
    const rule = rules.find(r => r.key === key && (!r.accountId || r.accountId === l.accountId));
    if (!rule) continue;
    const item = rule.match.ref ? open.find(i => i.ref === rule.match.ref && i.kind === rule.match.kind && !taken.has(i.key)) : undefined;
    if (item) taken.add(item.key);
    out.set(l.id, {
      match: { ...rule.match, yearMonth: item?.yearMonth ?? l.date.slice(0, 7), label: item?.label ?? rule.match.label },
      item, score: 100, reason: "descrição já classificada antes",
    });
  }

  // Expected items, best pairs first.
  const pairs: Array<{ line: BankTransactionDoc; item: ExpectedItem; score: number; reason: string }> = [];
  for (const line of pending) {
    if (out.has(line.id)) continue;
    for (const item of open) {
      if (taken.has(item.key) || Math.sign(item.amountCents) !== Math.sign(line.amountCents)) continue;
      const diff = Math.abs(Math.abs(item.amountCents) - Math.abs(line.amountCents));
      const exact = diff <= 1;
      const close = diff <= Math.abs(item.amountCents) * 0.15;
      const abs = Math.abs(line.amountCents);
      const inRange = !!item.amountRangeCents && abs >= item.amountRangeCents[0] - 1 && abs <= item.amountRangeCents[1] + 1;
      if (!exact && !(item.estimate && close) && !inRange) continue;
      const days = daysBetween(item.date, line.date);
      if (days > 12) continue;
      const lw = words(line.description);
      const common = [...words(item.label)].filter(w => lw.has(w)).length;
      const score = (exact ? 70 : 40) + Math.max(0, 12 - days) + Math.min(common, 3) * 6;
      const reason = `${exact ? "mesmo valor" : "valor parecido"}, ${days === 0 ? "mesmo dia" : `${days} dia(s) de diferença`}${common ? ", descrição parecida" : ""}`;
      pairs.push({ line, item, score, reason });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    if (out.has(p.line.id) || taken.has(p.item.key)) continue;
    taken.add(p.item.key);
    out.set(p.line.id, {
      match: { kind: p.item.kind, ref: p.item.ref, yearMonth: p.item.yearMonth, label: p.item.label },
      item: p.item, score: p.score, reason: p.reason,
    });
  }
  return out;
}

/** Expected items with no confirmed line, a few days past their date. */
export function missingExpected(
  expected: readonly ExpectedItem[],
  lines: readonly BankTransactionDoc[],
  today: string,
  graceDays = 5,
): ExpectedItem[] {
  return expected.filter(item =>
    !lines.some(l => settledBy(item, l.match)) &&
    Date.parse(`${item.date}T12:00:00Z`) + graceDays * 86400000 < Date.parse(`${today}T12:00:00Z`));
}
