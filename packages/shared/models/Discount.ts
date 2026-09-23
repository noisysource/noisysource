export type DiscountTrigger =
  | 'auto_sibling'    // auto: another child in the family has an active subscription
  | 'auto_multitrip'  // auto: 2+ trips on the same day
  | 'auto_school'     // auto: child's school matches schoolName
  | 'manual';         // admin applies explicitly per subscription

export type DiscountScope = 'study' | 'transport';

export interface DiscountRule {
  id: string;
  name: string;
  percentage: number;          // 0–1
  appliesTo: DiscountScope[];  // ['study'], ['transport'], or ['study', 'transport']
  trigger: DiscountTrigger;
  active: boolean;
  // trigger-specific config
  minTripsPerDay?: number;     // for auto_multitrip
  schoolName?: string;         // for auto_school
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AppliedDiscount {
  ruleId: string;
  name: string;
  percentage: number;
  appliedAt: Date;
  appliedBy: 'auto' | 'admin';
}

/**
 * An admin's explicit per-rule override, keyed by rule id.
 *
 *   true  = apply this discount even if it would not apply automatically
 *   false = do not apply it even if it would
 *   absent = no opinion; the automatic result stands
 *
 * This exists because the absence of an entry in `appliedDiscounts` is
 * ambiguous — it means either "the rule did not match" or "an admin turned it
 * off", and discountRecalc rewrites that array from the rules on every
 * schedule change, so an admin's "off" could not survive. An override is a
 * separate, durable statement of intent.
 *
 * An overridden rule is applied as a FLAT percentage on the post-sibling
 * subtotal and its structural calculation is suppressed — the marginal
 * multi-trip and ranked sibling discounts have no meaning once an admin has
 * overruled them, and a flat percentage is what the admin sees in the UI.
 */
export type DiscountOverrides = Record<string, boolean>;
