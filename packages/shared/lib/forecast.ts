import type { RecurringEntryDoc, ForecastEventDoc } from '../models/RecurringEntry';

/** "YYYY-MM" → [year, month1to12] */
export function parseYM(ym: string): [number, number] {
  const [y, m] = ym.split('-').map(Number);
  return [y, m];
}

/** [year, month1to12] → "YYYY-MM" */
export function toYM(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Advance by N months, returning "YYYY-MM" */
export function addMonths(ym: string, n: number): string {
  const [y, m] = parseYM(ym);
  const d = new Date(y, m - 1 + n, 1);
  return toYM(d.getFullYear(), d.getMonth() + 1);
}

/** All "YYYY-MM" strings from start (inclusive) for `count` months */
export function monthRange(startYM: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(startYM, i));
}

function appliesInMonth(r: RecurringEntryDoc, ym: string): boolean {
  if (!r.active) return false;
  if (r.startYearMonth && ym < r.startYearMonth) return false;
  if (r.endYearMonth && ym > r.endYearMonth) return false;

  switch (r.frequency) {
    case 'monthly':
      return true;

    case 'quarterly': {
      // Aligns to the quarter of startYearMonth (or Jan if absent)
      const ref = r.startYearMonth ?? ym.slice(0, 4) + '-01';
      const [ry, rm] = parseYM(ref);
      const [cy, cm] = parseYM(ym);
      const diffMonths = (cy - ry) * 12 + (cm - rm);
      return diffMonths >= 0 && diffMonths % 3 === 0;
    }

    case 'annual': {
      const [, cm] = parseYM(ym);
      return cm === (r.monthOfYear ?? 1);
    }

    case 'once':
      return ym === r.onceYearMonth;

    default:
      return false;
  }
}

/**
 * Generate forecast events for a set of recurring entries across a month window.
 * Uses deterministic IDs so calling this multiple times is idempotent (upsert-safe).
 * Returns only events whose ID is not already in `existingIds`.
 */
export function generateForecastEvents(
  recurring: RecurringEntryDoc[],
  startYM: string,
  months: number,
  existingIds: Set<string> = new Set()
): ForecastEventDoc[] {
  const events: ForecastEventDoc[] = [];
  const window = monthRange(startYM, months);

  for (const r of recurring) {
    for (const ym of window) {
      if (!appliesInMonth(r, ym)) continue;
      const id = `${r.id}:${ym}`;
      if (existingIds.has(id)) continue;

      events.push({
        id,
        recurringId: r.id,
        type: r.type,
        description: r.description,
        amountCents: r.amountCents,
        accountId: r.accountId,
        toAccountId: r.toAccountId,
        categoryId: r.categoryId,
        yearMonth: ym,
        dayOfMonth: r.dayOfMonth,
        status: 'forecast',
      });
    }
  }

  return events;
}

export type MonthlySummary = {
  yearMonth: string;
  incomeCents: number;
  expenseCents: number;
  transferOutCents: number;
  netCents: number;
  eventCount: number;
};

/** Aggregate events into a per-month summary */
export function summariseByMonth(events: ForecastEventDoc[]): MonthlySummary[] {
  const map = new Map<string, MonthlySummary>();

  for (const e of events) {
    if (e.status === 'skipped') continue;
    let s = map.get(e.yearMonth);
    if (!s) {
      s = { yearMonth: e.yearMonth, incomeCents: 0, expenseCents: 0, transferOutCents: 0, netCents: 0, eventCount: 0 };
      map.set(e.yearMonth, s);
    }
    s.eventCount++;
    if (e.type === 'income') s.incomeCents += e.amountCents;
    else if (e.type === 'expense') s.expenseCents += e.amountCents;
    else if (e.type === 'transfer') s.transferOutCents += e.amountCents;
  }

  for (const s of map.values()) {
    s.netCents = s.incomeCents - s.expenseCents;
  }

  return [...map.values()].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}
