// packages/shared/finhub/noisysource/treasury.ts
//
// Tesouraria: the real balance (bank balances are the truth) and the plan projected from it, day
// by day; for past months, the planned month-end balance against the real one.
//
// The real balance is the running balance printed after each imported bank line. Before an
// account's first imported line it is that line's balance minus its amount (the statement's
// opening balance).
//
// Planned items a confirmed match already paid (a lump payment ahead of the planned day) aren't
// projected again.

import { addDays, firstDay, lastDay, monthOf, type IsoDate, type YearMonth } from '../dates';
import { plannedItems, type PlannedItem } from './plan';
import { matchedItemIds, type MovementState, type NsState } from './state';

export interface RealBalance {
  accountId: string;
  date: IsoDate;
  balanceCents: number;
}

export function accountMovements(state: NsState, accountId: string): MovementState[] {
  return state.movements.filter(m => m.accountId === accountId);
}

/** The latest balance the bank printed for the account, or null with no imported lines. */
export function lastRealBalance(state: NsState, accountId: string): RealBalance | null {
  const ms = accountMovements(state, accountId);
  if (!ms.length) return null;
  const last = ms[ms.length - 1];
  return { accountId, date: last.date, balanceCents: last.balanceAfterCents };
}

/** Balance at the end of `date` (null if `date` is before the first imported line's statement). */
export function realBalanceAt(state: NsState, accountId: string, date: IsoDate): number | null {
  const ms = accountMovements(state, accountId);
  if (!ms.length || date < firstDay(monthOf(ms[0].date))) return null;
  let bal = ms[0].balanceAfterCents - ms[0].amountCents;
  for (const m of ms) {
    if (m.date > date) break;
    bal = m.balanceAfterCents;
  }
  return bal;
}

export interface ProjectionDay {
  date: IsoDate;
  items: PlannedItem[];
  /** Projected balance at the end of the day. */
  balanceCents: number;
  /** Before today: should already be in a statement that isn't imported yet. */
  beforeToday: boolean;
}

export interface TreasuryProjection {
  start: RealBalance;
  /** Only days with at least one item. */
  days: ProjectionDay[];
  monthEnds: { month: YearMonth; balanceCents: number }[];
  lowest: { date: IsoDate; balanceCents: number };
  end: IsoDate;
}

/** The plan from the day after the last real balance up to today + horizonDays. */
export function projectTreasury(
  state: NsState,
  opts: { accountId: string; today: IsoDate; horizonDays: number },
): TreasuryProjection | null {
  const start = lastRealBalance(state, opts.accountId);
  if (!start) return null;
  const end = addDays(opts.today, opts.horizonDays);
  const paid = matchedItemIds(state);
  const items = plannedItems(state, { from: addDays(start.date, 1), to: end, mainAccount: opts.accountId })
    .filter(i => (!i.account || i.account === opts.accountId) && !paid.has(i.id));

  const byDay = new Map<IsoDate, PlannedItem[]>();
  for (const i of items) byDay.set(i.date, [...(byDay.get(i.date) ?? []), i]);

  let bal = start.balanceCents;
  let lowest = { date: start.date, balanceCents: bal };
  const days: ProjectionDay[] = [];
  const monthEnds: TreasuryProjection['monthEnds'] = [];
  const dates = [...byDay.keys()].sort();
  let curMonth = monthOf(addDays(start.date, 1));
  const closeMonthsUntil = (month: YearMonth) => {
    while (curMonth < month) {
      monthEnds.push({ month: curMonth, balanceCents: bal });
      curMonth = monthOf(addDays(lastDay(curMonth), 1));
    }
  };
  for (const d of dates) {
    closeMonthsUntil(monthOf(d));
    const dayItems = byDay.get(d)!;
    for (const i of dayItems) bal += i.amountCents;
    days.push({ date: d, items: dayItems, balanceCents: bal, beforeToday: d < opts.today });
    if (bal < lowest.balanceCents) lowest = { date: d, balanceCents: bal };
  }
  closeMonthsUntil(monthOf(addDays(end, 1)));
  return { start, days, monthEnds, lowest, end };
}

export interface ItemHint {
  itemId: string;
  /** A bank line with exactly the same amount within ±10 days (a hint only; matching is night 2). */
  movementId: string | null;
}

export interface MonthCheck {
  month: YearMonth;
  /** Real balance at the end of the previous month. */
  openingCents: number;
  plannedInCents: number;
  plannedOutCents: number;
  /** opening + planned items dated in the month. */
  plannedEndCents: number;
  realEndCents: number;
  /** real − planned. Night 2 explains it line by line (ad hoc lines). */
  diffCents: number;
  items: PlannedItem[];
  movements: MovementState[];
  hints: ItemHint[];
  /** Bank lines no planned item points at (by the same hint). */
  unhintedMovementIds: string[];
}

/** Planned vs real month-end balance for each month that has real balances at both ends. */
export function pastMonthChecks(state: NsState, opts: { accountId: string; months: YearMonth[] }): MonthCheck[] {
  const out: MonthCheck[] = [];
  const all = accountMovements(state, opts.accountId);
  for (const month of opts.months) {
    const opening = realBalanceAt(state, opts.accountId, addDays(firstDay(month), -1))
      ?? (all.length && monthOf(all[0].date) === month ? all[0].balanceAfterCents - all[0].amountCents : null);
    const realEnd = realBalanceAt(state, opts.accountId, lastDay(month));
    const lastImported = all.length ? all[all.length - 1].date : null;
    if (opening == null || realEnd == null || !lastImported || lastImported < firstDay(month)) continue;
    const items = plannedItems(state, { from: firstDay(month), to: lastDay(month), mainAccount: opts.accountId })
      .filter(i => !i.account || i.account === opts.accountId);
    const movements = all.filter(m => monthOf(m.date) === month);
    const plannedIn = items.filter(i => i.amountCents > 0).reduce((s, i) => s + i.amountCents, 0);
    const plannedOut = items.filter(i => i.amountCents < 0).reduce((s, i) => s + i.amountCents, 0);
    const plannedEnd = opening + plannedIn + plannedOut;

    // Hints: same amount, closest date within ±10 days, each bank line used once.
    const window = all.filter(m => m.date >= addDays(firstDay(month), -10) && m.date <= addDays(lastDay(month), 10));
    const used = new Set<string>();
    const hints: ItemHint[] = items.map(i => {
      let best: MovementState | null = null;
      let bestGap = Infinity;
      for (const m of window) {
        if (used.has(m.id) || m.amountCents !== i.amountCents) continue;
        const gap = Math.abs(new Date(m.date).getTime() - new Date(i.date).getTime()) / 86_400_000;
        if (gap <= 10 && gap < bestGap) { best = m; bestGap = gap; }
      }
      if (best) used.add(best.id);
      return { itemId: i.id, movementId: best?.id ?? null };
    });

    out.push({
      month,
      openingCents: opening,
      plannedInCents: plannedIn,
      plannedOutCents: plannedOut,
      plannedEndCents: plannedEnd,
      realEndCents: realEnd,
      diffCents: realEnd - plannedEnd,
      items,
      movements,
      hints,
      unhintedMovementIds: movements.filter(m => !used.has(m.id)).map(m => m.id),
    });
  }
  return out;
}
