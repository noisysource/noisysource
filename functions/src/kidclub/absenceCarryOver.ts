// Absence credit carried from a closed month onto the next open bill.
//
// Since 2026-10-31 (Renato) a family can mark or undo days in a month whose
// bill is already paid. The paid bill is never touched. Instead, whatever the
// change does to that month's >=3-absence credit is carried onto the next bill
// still open for the SAME subscription (same service, so the same VAT rate on
// the invoice line), recorded on that line as `carriedAbsenceCredits`.
//
// It is a ledger, recomputed from scratch on every billing recompute, never an
// increment, so repeated recomputes and later payments stay exact. For a
// closed month M and a subscription S on M's bill:
//   should(M)  the credit M's line would get with M's CURRENT events, on M's own
//              stored price: net-before-absence = amount + absenceCreditAmount
//              + closureCreditAmount + whatever M itself received from earlier
//              months; same formula as reconcileService step 4: the club's
//              closure days in full, then the family's absences behind the
//              >=3 gate.
//   granted(M) the credit M's line was actually given (absenceCreditAmount +
//              closureCreditAmount).
//   carried(M) what other closed bills already carry from M.
//   outstanding = should - granted - carried
// Positive: a credit, taken off the next open lines of S, never below EUR 0,
// any remainder going on to the month after. Negative: days restored after a
// credited month was paid; the difference is charged back on the next open
// line. Nowhere to put it (S has no later open line, e.g. it ended): left
// unapplied, and the caller logs it.
//
// Pure: billing.ts loads the bills and events and writes the result.

export interface CarriedAbsenceCredit {
  /** yyyy-mm of the closed month the credit comes from. */
  fromPeriod: string;
  /** Euros. Positive = credit (lowers this line), negative = charge (raises it). */
  amount: number;
  /** The source month has days on which the club was closed, so (part of) this is a closure credit. */
  closure?: boolean;
}

/** The subset of a billing line item the ledger reads and writes. */
export interface LedgerLine {
  subscriptionId?: string;
  type?: string;
  amount: number;
  grossAmount?: number;
  absenceCount?: number;
  absenceCreditAmount?: number;
  /** Credit for days the club was closed (lines written from 2026-11-24). */
  closureCreditAmount?: number;
  notionalOccurrences?: number;
  carriedAbsenceCredits?: CarriedAbsenceCredit[];
}

export interface LedgerBill {
  /** yyyy-mm */
  period: string;
  status: string;
  lines: LedgerLine[];
}

/** One subscription's events in one month, as the ledger needs them. */
export interface MonthEvents {
  /** Every event, any status. 0 means the month can't be evaluated. */
  total: number;
  /** CANCELLED events that are NOT closure days: the family's absences and boundary-month ones. */
  cancelled: number;
  /** CANCELLED events on days the club was closed (closureLogic.ts). Credited without the >=3 gate. */
  closed?: number;
  /** The frozen per-occurrence price (basePriceCents) of the month's events. */
  rateCents?: number;
}

/**
 * Bills whose amount is fixed and is (or will be) charged as it stands: their
 * own absences can only move money by carrying, and the credit they carry
 * counts as delivered. `failed` is a refused MB WAY: not recomputable, still
 * payable at the same amount.
 */
export const CLOSED_STATUSES = new Set(["paid", "invoiced", "processing", "failed"]);

export interface Outstanding { subscriptionId: string; fromPeriod: string; cents: number; closure?: boolean }
export interface SkippedSource { subscriptionId: string; fromPeriod: string; reason: string }

const cents = (eur: number | undefined) => Math.round((eur ?? 0) * 100);
const key = (subId: string, period: string) => `${subId}|${period}`;
const carriedInCents = (l: LedgerLine) => (l.carriedAbsenceCredits ?? []).reduce((n, c) => n + cents(c.amount), 0);

export function isServiceLine(l: LedgerLine): boolean {
  return !!l.subscriptionId && (l.type === "study" || l.type === "transport");
}

/** reconcileService step 4, on cents: the credit `cancelled` absences earn on `netBeforeCents`. */
export function absenceCreditCents(netBeforeCents: number, notional: number, cancelled: number): number {
  if (cancelled < 3 || notional <= 0 || netBeforeCents <= 0) return 0;
  const perOccurrenceRateCents = netBeforeCents / notional;
  return Math.min(netBeforeCents, Math.round(cancelled * perOccurrenceRateCents));
}

/**
 * reconcileService step 4 in full, on cents: closure days first, always, then
 * the ordinary absence credit on what is left.
 */
export function monthCreditCents(netBeforeCents: number, notional: number, cancelled: number, closed: number): { closure: number; absence: number } {
  if (notional <= 0 || netBeforeCents <= 0) return { closure: 0, absence: 0 };
  const closure = closed > 0 ? Math.min(netBeforeCents, Math.round(closed * (netBeforeCents / notional))) : 0;
  const absence = Math.min(netBeforeCents - closure, absenceCreditCents(netBeforeCents, notional, cancelled));
  return { closure, absence };
}

/**
 * The notional occurrences behind a closed line's flat price, from that
 * month's own data only (never the subscription as it is today, whose pattern
 * may have changed since). Lines written from 2026-10-31 store it. Older lines:
 * gross / the events' frozen per-occurrence price, which is exact while the
 * rate hasn't changed. Null when it can't be known, and nothing is carried.
 */
export function notionalFor(line: LedgerLine, ev: MonthEvents | undefined): number | null {
  if (typeof line.notionalOccurrences === "number" && line.notionalOccurrences > 0) return line.notionalOccurrences;
  const gross = cents(line.grossAmount);
  const rate = ev?.rateCents ?? 0;
  if (gross > 0 && rate > 0 && gross % rate === 0) return gross / rate;
  return null;
}

/**
 * What each closed month still owes (or is owed) per subscription. Every
 * evaluated (subscription, month) pair is returned, zeros included, so a
 * caller can tell "evaluated, nothing to carry" from "not evaluated".
 */
export function outstandingCarryOver(
  bills: LedgerBill[],
  eventsFor: (period: string, subscriptionId: string) => MonthEvents | undefined,
): { outstanding: Outstanding[]; skipped: SkippedSource[] } {
  const delivered = new Map<string, number>();
  for (const b of bills) {
    if (!CLOSED_STATUSES.has(b.status)) continue;
    for (const l of b.lines) {
      if (!isServiceLine(l)) continue;
      for (const c of l.carriedAbsenceCredits ?? []) {
        const k = key(l.subscriptionId!, c.fromPeriod);
        delivered.set(k, (delivered.get(k) ?? 0) + cents(c.amount));
      }
    }
  }

  const outstanding: Outstanding[] = [];
  const skipped: SkippedSource[] = [];
  for (const b of bills) {
    if (!CLOSED_STATUSES.has(b.status)) continue;
    for (const l of b.lines) {
      if (!isServiceLine(l)) continue;
      const subscriptionId = l.subscriptionId!;
      const skip = (reason: string) => skipped.push({ subscriptionId, fromPeriod: b.period, reason });
      // A line with no absenceCount was not written by the reconciliation
      // engine: it is one of the bills paid before the 2026-09-27 cutover,
      // priced by the old excludedDates model. Those excluded days were
      // migrated as CANCELLED events, so reading them as "0 credit granted"
      // would credit the same days a second time. Nothing is carried from them.
      if (typeof l.absenceCount !== "number") { skip("pre-cutover line (no absenceCount)"); continue; }
      const ev = eventsFor(b.period, subscriptionId);
      // No events at all for a month that was billed is a data problem, not
      // "zero absences": evaluating it would charge back every credit given.
      if (!ev || ev.total === 0) { skip("no reservation events for this month"); continue; }
      const notional = notionalFor(l, ev);
      if (!notional) { skip("notional occurrences unknown (rate changed since, or gross is 0)"); continue; }

      const granted = cents(l.absenceCreditAmount) + cents(l.closureCreditAmount);
      const netBefore = cents(l.amount) + granted + carriedInCents(l);
      const credit = monthCreditCents(netBefore, notional, ev.cancelled, ev.closed ?? 0);
      const should = credit.closure + credit.absence;
      outstanding.push({
        subscriptionId, fromPeriod: b.period,
        cents: should - granted - (delivered.get(key(subscriptionId, b.period)) ?? 0),
        ...(credit.closure > 0 ? { closure: true } : {}),
      });
    }
  }
  outstanding.sort((a, b) => a.fromPeriod.localeCompare(b.fromPeriod) || a.subscriptionId.localeCompare(b.subscriptionId));
  return { outstanding, skipped };
}

/**
 * Hands the outstanding amounts out to the open bills of one recompute, which
 * must call it in ascending period order: `apply` for every bill it is about
 * to write, `standing` for an open bill it leaves as it is (a past month whose
 * recompute is skipped), whose recorded carry then counts as delivered.
 */
export function createCarryApplier(outstanding: Outstanding[]) {
  const remaining = outstanding.map(o => ({ ...o }));
  const find = (subId: string, fromPeriod: string) =>
    remaining.find(r => r.subscriptionId === subId && r.fromPeriod === fromPeriod);

  return {
    standing(lines: LedgerLine[]): void {
      for (const l of lines) {
        if (!isServiceLine(l)) continue;
        for (const c of l.carriedAbsenceCredits ?? []) {
          const r = find(l.subscriptionId!, c.fromPeriod);
          if (r) r.cents -= cents(c.amount);
        }
      }
    },

    /** Returns the lines with this period's carry applied, and the change to the bill's total. */
    apply<T extends LedgerLine>(period: string, lines: T[]): { lines: T[]; deltaCents: number } {
      let deltaCents = 0;
      const out = lines.map(l => {
        const base: T = { ...l };
        delete base.carriedAbsenceCredits; // always recomputed, never carried over from the stored line
        if (!isServiceLine(l)) return base;
        const mine = remaining.filter(r => r.subscriptionId === l.subscriptionId && r.fromPeriod < period && r.cents !== 0);
        if (!mine.length) return base;
        let amount = cents(l.amount);
        const entries: CarriedAbsenceCredit[] = [];
        // Charges first, then credits oldest first: a charge raises the line,
        // which leaves more room under the EUR 0 floor for the credits.
        for (const r of [...mine.filter(r => r.cents < 0), ...mine.filter(r => r.cents > 0)]) {
          const take = r.cents < 0 ? r.cents : Math.min(r.cents, amount);
          if (take === 0) continue;
          amount -= take;
          r.cents -= take;
          deltaCents -= take;
          entries.push({ fromPeriod: r.fromPeriod, amount: take / 100, ...(r.closure && take > 0 ? { closure: true } : {}) });
        }
        if (!entries.length) return base;
        entries.sort((a, b) => a.fromPeriod.localeCompare(b.fromPeriod));
        return { ...base, amount: amount / 100, carriedAbsenceCredits: entries };
      });
      return { lines: out, deltaCents };
    },

    /** What no open bill could take, after every apply/standing call. */
    unapplied(): Outstanding[] {
      return remaining.filter(r => r.cents !== 0).map(r => ({ ...r }));
    },
  };
}

export type CarryApplier = ReturnType<typeof createCarryApplier>;

/** "2026-10" -> "Outubro 2026", the way bill period labels read. */
export function periodLabelPt(period: string): string {
  const months = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const [y, m] = period.split("-").map(Number);
  return months[m - 1] ? `${months[m - 1]} ${y}` : period;
}
