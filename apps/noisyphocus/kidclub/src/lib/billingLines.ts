// Per-subscription amounts taken from the billing engine's own line items
// (billing/{familyId}_{yyyy-mm}.lineItems), rather than from a subscription's
// stored monthlyFee/monthlyPrice. The stored figure is the flat model
// (gross − summed appliedDiscounts); since 2026-10-01 only old-pricing subs
// are billed that way — new-pricing subs get marginal multi-trip and sibling
// discounts, so their bill can differ from the stored fee. The bill line is
// what the engine actually charges under whichever model applies.

export interface BillLine {
  subscriptionId: string;
  type?: string;
  title?: string;
  amount: number;
  absenceCreditAmount: number;
  /** Credit for days the club was closed this month (0 when there were none). */
  closureCreditAmount: number;
  /** Net credit carried in from paid months (positive lowers `amount`). */
  carriedCredit: number;
  grossAmount: number;
  multiTripDiscountAmount: number;
  siblingDiscountAmount: number;
  institutionalDiscountPct: number;
  legacyPricing: boolean;
}

export const toBillLines = (raw: any[] | undefined): BillLine[] =>
  (raw ?? []).map(l => ({
    subscriptionId: l.subscriptionId ?? '',
    type: l.type,
    title: l.title,
    amount: l.amount ?? 0,
    absenceCreditAmount: l.absenceCreditAmount ?? 0,
    closureCreditAmount: l.closureCreditAmount ?? 0,
    carriedCredit: (l.carriedAbsenceCredits ?? []).reduce((n: number, c: any) => n + (c?.amount ?? 0), 0),
    grossAmount: l.grossAmount ?? l.amount ?? 0,
    multiTripDiscountAmount: l.multiTripDiscountAmount ?? 0,
    siblingDiscountAmount: l.siblingDiscountAmount ?? 0,
    institutionalDiscountPct: l.institutionalDiscountPct ?? 0,
    legacyPricing: !!l.legacyPricing,
  }));

/** The standard monthly amount: net of discounts, before absence and closure credits (this month's and any carried in). */
export const lineNet = (l: BillLine) => Math.round((l.amount + l.absenceCreditAmount + l.closureCreditAmount + l.carriedCredit) * 100) / 100;

const MONTHS_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

/** "2026-10" -> "Outubro 2026". */
export function periodLabelPt(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return MONTHS_PT[m - 1] ? `${MONTHS_PT[m - 1]} ${y}` : period;
}

/**
 * "Crédito de faltas de Outubro 2026: −€12.00" — a paid month's absence credit
 * taken off this line. Negative: "Acerto de faltas", days restored after the
 * credit was paid out. Same wording as the payment email (billing.ts).
 */
export function carriedCreditText(c: { fromPeriod: string; amount: number; closure?: boolean }): string {
  const label = periodLabelPt(c.fromPeriod);
  // A credit that comes (at least in part) from days the club was closed says so.
  if (c.amount >= 0 && c.closure) return `Crédito de ${label} (KidClub encerrado): −€${c.amount.toFixed(2)}`;
  return c.amount >= 0
    ? `Crédito de faltas de ${label}: −€${c.amount.toFixed(2)}`
    : `Acerto de faltas de ${label}: +€${(-c.amount).toFixed(2)}`;
}

/**
 * "KidClub encerrado (Férias de Natal), 12 dias: −€57.60" — the credit for
 * days the club itself was closed, under the line it lowered. Transport counts
 * trips. Empty when the month had no closed day. Same wording as the payment
 * email (closureCreditText in functions/src/kidclub/billing.ts).
 */
export function closureCreditText(li: { type?: string; closureCount?: number; closureCreditAmount?: number; closureLabel?: string }): string {
  const n = li.closureCount ?? 0;
  if (!n) return '';
  const unit = li.type === 'transport' ? (n === 1 ? 'viagem' : 'viagens') : (n === 1 ? 'dia' : 'dias');
  return `KidClub encerrado${li.closureLabel ? ` (${li.closureLabel})` : ''}, ${n} ${unit}: −€${(li.closureCreditAmount ?? 0).toFixed(2)}`;
}

/** yyyy-mm of a billing doc, from periodStart (Timestamp/Date/string) or the `_yyyy-mm` id suffix. */
export function billPeriodKey(id: string, periodStart: any): string {
  const d = periodStart?.toDate ? periodStart.toDate() : periodStart ? new Date(periodStart) : null;
  if (d && !isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return id.match(/_(\d{4}-\d{2})$/)?.[1] ?? '';
}

export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** subscriptionId -> periodKey -> line, from non-cancelled bills. */
export type LinesBySub = Map<string, Map<string, BillLine>>;

export function indexLinesBySub(bills: { periodKey: string; status: string; lines: BillLine[] }[]): LinesBySub {
  const m: LinesBySub = new Map();
  for (const b of bills) {
    if (b.status === 'cancelled') continue;
    for (const l of b.lines) {
      if (l.type === 'enrollment' || !l.subscriptionId) continue;
      let byMonth = m.get(l.subscriptionId);
      if (!byMonth) m.set(l.subscriptionId, byMonth = new Map());
      byMonth.set(b.periodKey, l);
    }
  }
  return m;
}

/**
 * The line that stands for a subscription's monthly amount: the given month's
 * if there is one, else the current month's, else the next billed month, else
 * the latest past one. A line worth €0 (a month the contract doesn't cover) is
 * skipped in the fallbacks so it can't stand in for the monthly price.
 */
export function standardLine(byMonth: Map<string, BillLine> | undefined, month?: string): BillLine | undefined {
  if (!byMonth?.size) return undefined;
  if (month) {
    const l = byMonth.get(month);
    if (l) return l;
  }
  const now = monthKey();
  const keys = [...byMonth.keys()].filter(k => lineNet(byMonth.get(k)!) > 0).sort();
  const pick = byMonth.get(now) && lineNet(byMonth.get(now)!) > 0 ? now
    : keys.find(k => k > now) ?? keys[keys.length - 1];
  return pick ? byMonth.get(pick) : undefined;
}
