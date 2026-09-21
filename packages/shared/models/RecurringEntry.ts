export type RecurringType = 'income' | 'expense' | 'transfer';
export type RecurringFrequency = 'monthly' | 'quarterly' | 'annual' | 'once';
/**
 * 'fixed'      — amountCents is the actual monthly value (default, backward-compatible
 *                with every pre-existing entry that has no costModel field at all).
 * 'commission' — amountCents is just a fallback/estimate; the real monthly value is
 *                commissionPct% of a volume figure for that month (see
 *                commissionVolumeSource). Needed for fees like EasyPay's, which are a
 *                percentage of processed payment volume rather than a flat SaaS fee.
 */
export type RecurringCostModel = 'fixed' | 'commission';
/**
 * Where the volume a commission is applied against comes from. Only one source exists
 * today — KidClub's own processed billing (`_apps/arcoiris/billing`, status paid/invoiced)
 * — via `api.kidclub.monthlyProcessedVolumeCents()`. Modeled as a union (not hardcoded)
 * so a future commission-based cost with a different volume source doesn't need a
 * field rename.
 */
export type RecurringCommissionVolumeSource = 'kidclub_billing';

export interface RecurringEntryDoc {
  id: string;
  type: RecurringType;
  description: string;
  amountCents: number;      // for costModel 'commission': fallback/estimate only, see RecurringCostModel
  accountId?: string;       // source account (income/expense) or from-account (transfer)
  toAccountId?: string;     // target account (transfer only)
  categoryId?: string;
  frequency: RecurringFrequency;
  dayOfMonth: number;       // 1-31 — day within the month it occurs
  monthOfYear?: number;     // 1-12 — required for frequency = 'annual'
  startYearMonth?: string;  // "YYYY-MM" — inclusive; absent = no limit
  endYearMonth?: string;    // "YYYY-MM" — inclusive; absent = indefinite
  onceYearMonth?: string;   // "YYYY-MM" — for frequency = 'once'
  active: boolean;
  sourceId?: string;        // e.g. "ec:{id}" or "emp:{id}:ns" — used for upsert-by-source
  reimbursable?: boolean;    // true = paid from a personal account on behalf of this entity
  paidByAccountId?: string;  // e.g. 'private-revolut' — account that actually pays; entity derived by prefix
  lastReimbursedYM?: string; // "YYYY-MM" — month through which reimbursement was settled
  ivaRatePct?: number;       // 0 | 6 | 13 | 23 — IVA rate applied to this entry (base amount is IVA-exclusive)
  costModel?: RecurringCostModel;                       // absent = 'fixed'
  commissionPct?: number;                               // required when costModel = 'commission'
  commissionVolumeSource?: RecurringCommissionVolumeSource; // absent + costModel='commission' = 'kidclub_billing'
  createdAt?: Date;
}

/**
 * Resolves what a recurring entry actually costs/earns in a given month.
 * - 'fixed' (or no costModel, i.e. every pre-existing entry): amountCents, unchanged.
 * - 'commission': commissionPct% of the month's volume, when the caller can supply one
 *   (e.g. VatPage/costSummary already fetched KidClub's monthly processed billing).
 *   Falls back to the stored amountCents estimate when no volume is available yet, so
 *   the entry still shows *something* rather than silently going to zero.
 */
export function recurringMonthlyAmountCents(
  entry: RecurringEntryDoc,
  volumeCentsForMonth?: number,
): number {
  if (entry.costModel === 'commission') {
    if (typeof volumeCentsForMonth === 'number') {
      return Math.round((volumeCentsForMonth * (entry.commissionPct ?? 0)) / 100);
    }
    return entry.amountCents; // fallback estimate — see field doc above
  }
  return entry.amountCents;
}

export type ForecastEventStatus = 'forecast' | 'confirmed' | 'skipped';

export interface ForecastEventDoc {
  id: string;               // deterministic: "{recurringId}:{YYYY-MM}" or generated for one-offs
  recurringId?: string;     // parent recurring entry (absent for manual one-offs)
  type: RecurringType;
  description: string;
  amountCents: number;
  accountId?: string;
  toAccountId?: string;
  categoryId?: string;
  yearMonth: string;        // "YYYY-MM"
  dayOfMonth: number;
  status: ForecastEventStatus;
  createdAt?: Date;
}
