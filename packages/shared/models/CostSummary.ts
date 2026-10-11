import { Timestamp } from 'firebase/firestore';

/**
 * finances_entities/{entityId}/costSummary/{yyyy-mm}
 *
 * Computed monthly cost total for an entity (currently only produced for
 * `noisyphocus`). Written by FinHub (see
 * apps/noisysource/finances/src/lib/api/domains/costSummary.ts), read
 * cross-app by KidClub's "Resumo Financeiro" page for the expense side of
 * its own numbers — see root CLAUDE.md "Cross-App Data Contracts".
 *
 * Recomputed (and overwritten) every time the FinHub Custos page is opened
 * for a given month, rather than being a one-off/manual snapshot — see
 * apps/noisysource/finances/STATUS.md for the reasoning.
 */
export interface CostSummaryBreakdownLine {
  label: string;
  amountCents: number;
}

export interface CostSummaryDoc {
  payrollCostCents: number;
  softwareCostCents: number;
  vatCents: number;
  totalCostCents: number;
  computedAt: Timestamp;
  breakdown?: CostSummaryBreakdownLine[];
}
