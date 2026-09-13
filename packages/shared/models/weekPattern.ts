export type WeekPattern = 'all' | 'odd' | 'even';

/**
 * Returns which occurrence of that weekday this date is within its month.
 * E.g. the 3rd Monday of the month returns 3.
 */
export function weekOfMonthOccurrence(date: Date): 1 | 2 | 3 | 4 | 5 {
  const dayOfMonth = date.getDate();
  return Math.ceil(dayOfMonth / 7) as 1 | 2 | 3 | 4 | 5;
}

/**
 * Whether a given date is active under the supplied pattern.
 * 'all'  → always true
 * 'odd'  → 1st and 3rd occurrence of that weekday in the month
 * 'even' → 2nd and 4th occurrence; 5th occurrence → false for both
 */
export function isActiveThisWeek(date: Date, pattern: WeekPattern): boolean {
  if (pattern === 'all') return true;
  const occ = weekOfMonthOccurrence(date);
  if (occ === 5) return false;
  return pattern === 'odd' ? occ % 2 === 1 : occ % 2 === 0;
}

/** How many weeks of the month are active for a pattern (used for fee preview). */
export function activeWeeksInPattern(pattern: WeekPattern): 2 | 4 {
  return pattern === 'all' ? 4 : 2;
}

/**
 * Count how many sessions fall in a given month for a set of weekdays and a pattern.
 * weekdays: array of JS day-of-week numbers (0=Sun … 6=Sat), e.g. [1,3,5] for Mon/Wed/Fri.
 */
export function sessionCountInMonth(
  year: number,
  month: number, // 0-indexed
  weekdays: number[],
  pattern: WeekPattern,
): number {
  let count = 0;
  const d = new Date(year, month, 1);
  while (d.getMonth() === month) {
    if (weekdays.includes(d.getDay()) && isActiveThisWeek(d, pattern)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// JS weekday numbers for the named days
export const WEEKDAY_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};
