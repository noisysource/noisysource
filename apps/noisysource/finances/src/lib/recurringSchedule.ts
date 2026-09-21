// apps/finances/src/lib/recurringSchedule.ts
//
// Shared "does this recurring entry occur in month X, and for how much" logic.
// Extracted from VatPage.tsx so costSummary.ts can reuse the exact same
// scheduling rules instead of re-deriving them (task: "reuse whatever
// already computes... don't reimplement").
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import { recurringMonthlyAmountCents } from "@shared/models/RecurringEntry";

/** True if `entry` occurs at all (regardless of amount) during "YYYY-MM" `ym`. */
export function recurringOccursInMonth(entry: RecurringEntryDoc, ym: string): boolean {
  if (entry.startYearMonth && ym < entry.startYearMonth) return false;
  if (entry.endYearMonth && ym > entry.endYearMonth) return false;
  if (entry.frequency === "monthly") return true;
  if (entry.frequency === "once") return entry.onceYearMonth === ym;
  if (entry.frequency === "quarterly") {
    const [, m] = ym.split("-").map(Number);
    return (m - 1) % 3 === 0;
  }
  if (entry.frequency === "annual") {
    return entry.monthOfYear != null && Number(ym.split("-")[1]) === entry.monthOfYear;
  }
  return false;
}

/**
 * Amount `entry` contributes in month `ym` (0 if it doesn't occur that month).
 * `volumeCentsForMonth` feeds commission-model entries — see
 * `recurringMonthlyAmountCents`.
 */
export function recurringAmountInMonth(
  entry: RecurringEntryDoc,
  ym: string,
  volumeCentsForMonth?: number,
): number {
  if (!recurringOccursInMonth(entry, ym)) return 0;
  return recurringMonthlyAmountCents(entry, volumeCentsForMonth);
}

/**
 * IVA base + amount for every `type` entry (income/expense) that occurs
 * across `months`, summed per entry. Used by both VatPage (quarterly) and
 * costSummary (single month passed as a 1-element array).
 */
export function recurringIvaInQuarter(
  entries: RecurringEntryDoc[],
  months: string[],
  type: "income" | "expense",
  volumeCentsByMonth?: Record<string, number>,
): { description: string; baseCents: number; ivaCents: number }[] {
  const result: { description: string; baseCents: number; ivaCents: number }[] = [];
  for (const e of entries) {
    if (e.type !== type) continue;
    if (!e.active) continue;
    const rate = e.ivaRatePct;
    if (!rate) continue;

    let baseCents = 0;
    for (const ym of months) {
      baseCents += recurringAmountInMonth(e, ym, volumeCentsByMonth?.[ym]);
    }
    if (!baseCents) continue;
    result.push({
      description: e.description,
      baseCents,
      ivaCents: Math.round((baseCents * rate) / 100),
    });
  }
  return result;
}
