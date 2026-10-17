// apps/finances/src/lib/recurringSchedule.ts
//
// Shared "does this recurring entry occur in month X, and for how much" logic.
// Extracted from VatPage.tsx so costSummary.ts can reuse the exact same
// scheduling rules instead of re-deriving them (task: "reuse whatever
// already computes... don't reimplement").
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import { recurringMonthlyAmountCents, recurringVatCode } from "@shared/models/RecurringEntry";
import { splitGross, vatCodeChargesVat, type VatCode } from "@shared/lib/vat";

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

export interface RecurringVatRow {
  description: string;
  /** Without VAT. */
  baseCents: number;
  /** The VAT inside the entry's VAT-inclusive amount. */
  ivaCents: number;
  vatCode?: VatCode;
}

export interface RecurringVatResult {
  /** Entries whose VAT is known and charged (23, 13, 6%). */
  rows: RecurringVatRow[];
  /** Entries with "IVA por confirmar": amount as stored, left out of the VAT totals. */
  unconfirmed: { description: string; amountCents: number }[];
}

/**
 * VAT inside every active `type` entry (income/expense) across `months`, summed per entry.
 * Amounts are VAT-inclusive (VAT convention), so the VAT is split out of them, month by month
 * like the invoices, never added on top. Exempt, reverse-charge and 0% entries carry no VAT and
 * are left out; 'por_confirmar' ones are returned apart, never counted as 0.
 * Used by both VatPage (quarterly) and costSummary (single month passed as a 1-element array).
 */
export function recurringVatInMonths(
  entries: RecurringEntryDoc[],
  months: string[],
  type: "income" | "expense",
  volumeCentsByMonth?: Record<string, number>,
): RecurringVatResult {
  const result: RecurringVatResult = { rows: [], unconfirmed: [] };
  for (const e of entries) {
    if (e.type !== type) continue;
    if (!e.active) continue;
    const code = recurringVatCode(e);
    if (code == null) continue;
    const unconfirmed = code === "por_confirmar";
    if (!unconfirmed && !vatCodeChargesVat(code)) continue;

    let grossCents = 0;
    let baseCents = 0;
    let ivaCents = 0;
    for (const ym of months) {
      const amount = recurringAmountInMonth(e, ym, volumeCentsByMonth?.[ym]);
      if (!amount) continue;
      grossCents += amount;
      const split = splitGross(amount, code);
      if (!split) continue;
      baseCents += split.netCents;
      ivaCents += split.vatCents;
    }
    if (!grossCents) continue;
    if (unconfirmed) result.unconfirmed.push({ description: e.description, amountCents: grossCents });
    else result.rows.push({ description: e.description, baseCents, ivaCents, vatCode: code });
  }
  return result;
}
