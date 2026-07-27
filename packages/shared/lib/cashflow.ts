import type { ForecastEventDoc } from '../models/RecurringEntry';
import { monthRange } from './forecast';

export type MonthlyAccountFlow = {
  yearMonth: string;
  inCents: number;
  outCents: number;
  netCents: number;
  endingBalanceCents: number;
};

export type AccountTrajectory = {
  accountId: string;
  accountName: string;
  startingBalanceCents: number;
  months: MonthlyAccountFlow[];
};

export type EntityTotals = {
  yearMonth: string;
  totalBalanceCents: number;
};

/** Cash-like account types that participate in balance trajectory */
export const CASH_ACCOUNT_TYPES = new Set(["bank", "wallet", "cash", "credit", "bonds"]);

/**
 * Compute month-by-month running balance for a single account.
 * Uses forecast events for income/expense/transfer flows.
 */
export function computeAccountTrajectory(
  accountId: string,
  accountName: string,
  startingBalanceCents: number,
  events: ForecastEventDoc[],
  startYM: string,
  numMonths: number
): AccountTrajectory {
  let balance = startingBalanceCents;
  const months = monthRange(startYM, numMonths).map<MonthlyAccountFlow>(ym => {
    const monthEvents = events.filter(e => e.yearMonth === ym && e.status !== 'skipped');
    let inCents = 0;
    let outCents = 0;

    for (const e of monthEvents) {
      if (e.type === 'income' && e.accountId === accountId) inCents += e.amountCents;
      if (e.type === 'expense' && e.accountId === accountId) outCents += e.amountCents;
      if (e.type === 'transfer' && e.toAccountId === accountId) inCents += e.amountCents;
      if (e.type === 'transfer' && e.accountId === accountId) outCents += e.amountCents;
    }

    const netCents = inCents - outCents;
    balance += netCents;

    return { yearMonth: ym, inCents, outCents, netCents, endingBalanceCents: balance };
  });

  return { accountId, accountName, startingBalanceCents, months };
}

/**
 * Sum account trajectories into entity-level totals per month.
 */
export function computeEntityTotals(trajectories: AccountTrajectory[]): EntityTotals[] {
  if (!trajectories.length) return [];
  const months = trajectories[0].months.map(m => m.yearMonth);
  return months.map((ym, i) => ({
    yearMonth: ym,
    totalBalanceCents: trajectories.reduce((s, t) => s + t.months[i].endingBalanceCents, 0),
  }));
}
