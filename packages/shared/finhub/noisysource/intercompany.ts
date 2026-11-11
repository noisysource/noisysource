// packages/shared/finhub/noisysource/intercompany.ts
//
// Money between companies (HANDOFF § "Order change"): what's owed is the opening amount plus every
// bank line naming the other company. Money out means they owe us more; money in, less. Nothing is
// stored: importing a statement moves the position on its own.

import type { IsoDate, YearMonth } from '../dates';
import { monthOf } from '../dates';
import type { IntercompanyPlan } from './events';
import type { MovementState, NsState } from './state';

const squash = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Does a bank line name this company? Case, accents and spaces don't matter. */
export function namesCounterparty(plan: Pick<IntercompanyPlan, 'matchWords'>, description: string): boolean {
  const d = squash(description);
  return plan.matchWords.some(w => squash(w) && d.includes(squash(w)));
}

export interface IntercompanyPosition {
  /** + they owe us, − we owe them. */
  balanceCents: number;
  /** The bank lines counted, oldest first. */
  lines: MovementState[];
  outCents: number;
  inCents: number;
}

/** What's owed from the bank lines after `openingAsOf` (only those before `before`, when given). */
export function intercompanyPosition(state: NsState, plan: IntercompanyPlan, accountId: string, before?: IsoDate): IntercompanyPosition {
  const lines = state.movements.filter(m => m.accountId === accountId && m.date > plan.openingAsOf
    && (!before || m.date < before) && namesCounterparty(plan, m.description));
  const outCents = lines.filter(m => m.amountCents < 0).reduce((s, m) => s - m.amountCents, 0);
  const inCents = lines.filter(m => m.amountCents > 0).reduce((s, m) => s + m.amountCents, 0);
  return { balanceCents: plan.openingCents + outCents - inCents, lines, outCents, inCents };
}

/** The month of the account's last imported bank line. */
export function lastLineMonth(state: NsState, accountId: string): YearMonth | null {
  let last: IsoDate | null = null;
  for (const m of state.movements) if (m.accountId === accountId && (!last || m.date > last)) last = m.date;
  return last ? monthOf(last) : null;
}
