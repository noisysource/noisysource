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
