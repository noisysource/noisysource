/**
 * ecProjection.ts
 *
 * Pure computation: given an EC contract's start date, daily rate, total
 * contracted working days, and a list of non-working days (vacations / bank
 * holidays), produces a projection of earnings, worked/remaining days, the
 * expected contract end date, and a month-by-month breakdown.
 *
 * No external dependencies. Fully timezone-safe (all dates are treated as
 * local calendar dates via local getters, never UTC midnight).
 */

export interface EcProjection {
  /** Total contracted working days (= totalDays parameter) */
  totalContractWorkingDays: number;
  /** YYYY-MM-DD — the calendar date when the totalDays working days are exhausted */
  contractEndDate: string;
  /** Working days from startDate up to and including min(today, contractEndDate) */
  workedDays: number;
  /** totalContractWorkingDays - workedDays */
  remainingDays: number;
  /** workedDays × dailyRateCents */
  earnedCents: number;
  /** totalContractWorkingDays × dailyRateCents */
  projectedTotalCents: number;
  monthBreakdown: Array<{
    /** "YYYY-MM" */
    yearMonth: string;
    /** Mon-Fri days in that month, within the contract span, not in nonWorkingDays */
    workingDays: number;
    /** workingDays × dailyRateCents */
    incomeCents: number;
  }>;
}

/** Create a local-midnight Date from a YYYY-MM-DD string. */
function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m as number) - 1, d as number);
}

/** Format a Date as YYYY-MM-DD using local calendar getters. */
function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Advance a Date by exactly 1 calendar day (local). */
function nextDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

/** Returns the working-day weight for a date: 0 (off/weekend), 0.5 (half-day), or 1 (full day). */
function dayWeight(d: Date, nonWorking: Set<string>, halfDays: Set<string>): number {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return 0;
  const iso = localIso(d);
  if (nonWorking.has(iso)) return 0;
  if (halfDays.has(iso)) return 0.5;
  return 1;
}

/**
 * Compute a full EC contract projection.
 *
 * @param contract  Minimal contract fields needed for the computation.
 *                  startDate must be a YYYY-MM-DD string.
 * @param nonWorkingDays  ISO date strings to exclude (vacations, bank holidays).
 * @param today     The reference date for "days worked so far".
 */
export function computeEcProjection(
  contract: {
    startDate: string;
    dailyRateCents: number;
    totalDays: number;
  },
  nonWorkingDays: string[],
  today: Date,
  halfDays: string[] = [],
): EcProjection {
  const nonWorking = new Set(nonWorkingDays);
  const half = new Set(halfDays);
  const start = parseDate(contract.startDate);
  const { dailyRateCents, totalDays } = contract;

  // ── 1. Walk forward from startDate, accumulating weights until totalDays ──

  let contractEnd = start;
  let counted = 0;
  let cursor = new Date(start);

  while (counted < totalDays) {
    const w = dayWeight(cursor, nonWorking, half);
    if (w > 0) {
      counted += w;
      if (counted >= totalDays) {
        contractEnd = new Date(cursor);
        break;
      }
    }
    cursor = nextDay(cursor);
  }

  const contractEndStr = localIso(contractEnd);
  const todayStr = localIso(today);

  // ── 2. Count worked days (startDate … min(today, contractEnd)) ──

  const effectiveEndStr = todayStr <= contractEndStr ? todayStr : contractEndStr;
  const effectiveEnd = parseDate(effectiveEndStr);

  let workedDays = 0;
  cursor = new Date(start);
  while (cursor <= effectiveEnd) {
    workedDays += dayWeight(cursor, nonWorking, half);
    cursor = nextDay(cursor);
  }

  // ── 3. Month breakdown ──

  const months: EcProjection["monthBreakdown"] = [];
  let monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
  const lastMonth = new Date(contractEnd.getFullYear(), contractEnd.getMonth(), 1);

  while (monthStart <= lastMonth) {
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    const yearMonth = `${year}-${String(month + 1).padStart(2, "0")}`;

    let daysInMonth = 0;
    cursor = new Date(year, month, 1);
    const monthEndExclusive = new Date(year, month + 1, 1);

    while (cursor < monthEndExclusive) {
      const iso = localIso(cursor);
      if (iso >= contract.startDate && iso <= contractEndStr) {
        daysInMonth += dayWeight(cursor, nonWorking, half);
      }
      cursor = nextDay(cursor);
    }

    months.push({
      yearMonth,
      workingDays: daysInMonth,
      incomeCents: daysInMonth * dailyRateCents,
    });

    monthStart = new Date(year, month + 1, 1);
  }

  return {
    totalContractWorkingDays: totalDays,
    contractEndDate: contractEndStr,
    workedDays,
    remainingDays: totalDays - workedDays,
    earnedCents: workedDays * dailyRateCents,
    projectedTotalCents: totalDays * dailyRateCents,
    monthBreakdown: months,
  };
}
