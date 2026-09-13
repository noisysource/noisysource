import { DiscountRule, AppliedDiscount, DiscountScope } from './Discount';

/**
 * Minimal day descriptor for discount resolution.
 * Structurally compatible with the frontend's DayConfig so callers can pass
 * DayConfig[] directly; the Cloud Function builds equivalent objects from
 * stored subscription data.
 */
export interface DayLike {
  services?: { transportTrips?: unknown[] };
}

/** Compute which auto-discount rules apply to a given enrollment. */
export function resolveAutoDiscounts(
  rules: DiscountRule[],
  scope: DiscountScope,
  days: DayLike[],
  schoolName?: string,
  activeSiblingCount?: number,
): AppliedDiscount[] {
  const now = new Date();
  return rules
    .filter(r => r.active && r.appliesTo.includes(scope))
    .flatMap((r): AppliedDiscount[] => {
      switch (r.trigger) {
        case 'auto_sibling':
          if ((activeSiblingCount ?? 0) > 0) {
            return [{ ruleId: r.id, name: r.name, percentage: r.percentage, appliedAt: now, appliedBy: 'auto' }];
          }
          break;
        case 'auto_multitrip': {
          const min = r.minTripsPerDay ?? 2;
          if (days.some(d => (d.services?.transportTrips?.length ?? 0) >= min)) {
            return [{ ruleId: r.id, name: r.name, percentage: r.percentage, appliedAt: now, appliedBy: 'auto' }];
          }
          break;
        }
        case 'auto_school':
          if (schoolName && r.schoolName) {
            const a = schoolName.toLowerCase();
            const b = r.schoolName.toLowerCase();
            if (a.includes(b) || b.includes(a)) {
              return [{ ruleId: r.id, name: r.name, percentage: r.percentage, appliedAt: now, appliedBy: 'auto' }];
            }
          }
          break;
        default:
          break;
      }
      return [];
    });
}

/** Net fee after applying a list of discounts (discounts stack, capped at 100%). */
export function applyDiscounts(gross: number, discounts: AppliedDiscount[]): number {
  const totalPct = Math.min(discounts.reduce((s, d) => s + d.percentage, 0), 1);
  return Math.round(gross * (1 - totalPct) * 100) / 100;
}

/** Derive the gross (pre-discount) price from the net fee and applied discounts. */
export function grossFromAppliedDiscounts(fee: number, discounts?: { percentage: number }[]): number | null {
  if (!discounts?.length) return null;
  const pct = Math.min(discounts.reduce((s, d) => s + d.percentage, 0), 1);
  return pct > 0 ? Math.round((fee / (1 - pct)) * 100) / 100 : null;
}
