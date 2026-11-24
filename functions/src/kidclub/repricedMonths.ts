// Which of a family's months a billing recompute actually rewrites. Pure.
//
// billing.ts recomputes a bill only while it is still open (isRecomputableBill);
// a paid, invoiced, processing, failed or admin-cancelled bill is never touched.
// reservationEvents.ts uses the same answer to decide which ELAPSED days follow
// a schedule edit: the day records of a month must agree with the schedule its
// bill is priced on, and with nothing else.

/**
 * A billing record is eligible for recompute if it's still "pending", or if it
 * was cancelled by the billing sync itself (autoCancelled: true) because the
 * family had nothing billable that period — not a deliberate admin
 * cancellation of a specific invoice.
 */
export function isRecomputableBill(data: { status?: string; autoCancelled?: boolean } | undefined | null): boolean {
  return data?.status === "pending" || (data?.status === "cancelled" && data?.autoCancelled === true);
}

export interface MonthlyBillLite {
  /** yyyy-mm */
  period: string;
  status?: string;
  autoCancelled?: boolean;
  /** The study/transport subscriptions with a line on this bill. */
  serviceSubscriptionIds: string[];
}

/**
 * The months, up to and including the current one, whose bill the next
 * recompute prices with the family's CURRENT schedules:
 *   - the current month, unless its bill exists and is closed (a month with no
 *     bill yet gets one, at the current schedule);
 *   - an earlier month only when its bill exists, is still open, and every
 *     subscription on it is still active (the same "pastMonthSafe" test
 *     autoCreateBillingSchedule applies before rewriting a past month).
 * Later months are not listed: their days are all in the future and are
 * regenerated on every schedule edit anyway.
 */
export function repricedMonths(input: {
  /** yyyy-mm */
  currentMonth: string;
  bills: MonthlyBillLite[];
  activeSubscriptionIds: string[];
}): string[] {
  const { currentMonth, bills, activeSubscriptionIds } = input;
  const active = new Set(activeSubscriptionIds);
  const out = new Set<string>();
  const current = bills.find(b => b.period === currentMonth);
  if (!current || isRecomputableBill(current)) out.add(currentMonth);
  for (const b of bills) {
    if (b.period >= currentMonth || !isRecomputableBill(b)) continue;
    if (b.serviceSubscriptionIds.every(id => active.has(id))) out.add(b.period);
  }
  return [...out].sort();
}
