export interface StudyCenterConfig {
  monthlyPricePerWeekday: number;       // kept for enrollment forms (= pricePerDayPerWeek × weeksPerMonth)
  registrationFee: number;
  insuranceFee: number;
  monthlyTransportFeePerWeekday: number;
  returningStudentDiscountPercentage: number;
  // operational costs
  teacherMonthlyCost?: number;
  rentMonthlyCost?: number;
  // rate-based pricing (mirrors transport: rate × weeks × days)
  pricePerDayPerWeek?: number;          // e.g. 6  (= €120 / 4 weeks / 5 days)
  weeksPerMonth?: number;               // e.g. 4
}
