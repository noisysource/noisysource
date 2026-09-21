// Read-only cross-app client for the Finances app's monthly cost rollup.
//
// Cross-app data contract: `finances_entities/noisyphocus/costSummary/{yyyy-mm}`
// is owned and WRITTEN by the Finances app (a parallel task, not this one) —
// KidClub only ever reads it here. Doc shape:
//   { payrollCostCents, softwareCostCents, vatCents, totalCostCents,
//     computedAt: Timestamp, breakdown?: { label, amountCents }[] }
//
// The doc won't exist until the Finances app ships that feature AND Renato
// enters real payroll numbers for a given month — treat "missing" as
// "not yet configured", never silently as zero (zero would misleadingly
// suggest there are no staff/software/VAT costs at all).
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

export interface CostSummaryBreakdownEntry {
  label: string;
  amountCents: number;
}

export interface CostSummary {
  payrollCostCents: number;
  softwareCostCents: number;
  vatCents: number;
  totalCostCents: number;
  computedAt: Timestamp;
  breakdown?: CostSummaryBreakdownEntry[];
}

export const financeCostSummaryService = {
  /**
   * @param monthKey 'YYYY-MM'
   * @returns the cost summary doc, or `null` if the Finances app hasn't
   *   written one yet for this month (NOT the same as "zero cost").
   */
  async get(monthKey: string): Promise<CostSummary | null> {
    const ref = doc(db, 'finances_entities', 'noisyphocus', 'costSummary', monthKey);
    const snap = await getDoc(ref);
    return snap.exists() ? (snap.data() as CostSummary) : null;
  },
};
