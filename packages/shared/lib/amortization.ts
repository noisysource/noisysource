/**
 * amortization.ts
 *
 * French amortization (prestação constante) engine.
 * Supports variable rates via rateHistory — each rate change recalculates
 * the monthly payment from the outstanding balance at that point.
 */

import type { CreditContractDoc, RateHistoryEntry } from '../models/CreditContract';

export interface AmortizationRow {
  ym: string;               // "YYYY-MM"
  paymentNumber: number;    // 1-based payment index
  paymentCents: number;     // total installment
  interestCents: number;    // interest portion
  capitalCents: number;     // principal portion
  outstandingCents: number; // balance AFTER this payment
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ymToMonths(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m;
}

function addMonths(ym: string, n: number): string {
  const total = ymToMonths(ym) + n;
  const m = ((total - 1) % 12) + 1;
  const y = (total - m) / 12;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Monthly payment (PMT) for a given outstanding balance, monthly rate, and remaining months. */
function pmt(balanceCents: number, monthlyRate: number, remainingMonths: number): number {
  if (remainingMonths <= 0) return 0;
  if (monthlyRate === 0) return Math.round(balanceCents / remainingMonths);
  const r = monthlyRate;
  const n = remainingMonths;
  return Math.round(balanceCents * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
}

/** Build rate segments from the contract's initial rate and rateHistory. */
function buildRateSegments(contract: CreditContractDoc): Array<{ startYM: string; annualRatePct: number }> {
  const segments: Array<{ startYM: string; annualRatePct: number }> = [
    { startYM: contract.startYearMonth, annualRatePct: contract.annualRatePct },
  ];

  const history: RateHistoryEntry[] = (contract.rateHistory ?? [])
    .slice()
    .sort((a, b) => a.effectiveYearMonth.localeCompare(b.effectiveYearMonth));

  for (const entry of history) {
    if (entry.effectiveYearMonth > contract.startYearMonth) {
      segments.push({ startYM: entry.effectiveYearMonth, annualRatePct: entry.annualRatePct });
    }
  }

  return segments;
}

// ── public API ────────────────────────────────────────────────────────────────

/** Interest-only schedule: balance stays flat, every payment is pure interest. */
function buildInterestOnlySchedule(contract: CreditContractDoc): AmortizationRow[] {
  const rows: AmortizationRow[] = [];
  const segments = buildRateSegments(contract);
  const outstanding = contract.loanAmountCents;

  let paymentNumber = 1;
  let currentYM = contract.startYearMonth;

  for (let i = 0; i < contract.termMonths; i++) {
    // Use the rate effective for this month
    const effectiveRate = [...segments].reverse().find(s => s.startYM <= currentYM)?.annualRatePct
      ?? contract.annualRatePct;
    const monthlyRate = effectiveRate / 12 / 100;
    const interestCents = Math.round(outstanding * monthlyRate);

    rows.push({
      ym: currentYM,
      paymentNumber,
      paymentCents: interestCents,
      interestCents,
      capitalCents: 0,
      outstandingCents: outstanding,
    });

    currentYM = addMonths(currentYM, 1);
    paymentNumber++;
  }

  return rows;
}

/**
 * Build the full amortization schedule for a credit contract.
 * Rate changes in rateHistory are honoured — the monthly payment recalculates
 * from the outstanding balance at each rate-change point.
 *
 * When interestOnlyPhase=true the schedule produces flat interest-only rows
 * with no capital reduction. Call buildAmortizationSchedule again after
 * clearing the flag to get the amortizing schedule.
 */
export function buildAmortizationSchedule(contract: CreditContractDoc): AmortizationRow[] {
  if (contract.interestOnlyPhase) {
    return buildInterestOnlySchedule(contract);
  }

  // If there are balance syncs, restart from the most recent one — rows before that
  // point are generated from the original loan (for history display), then overwritten
  // from the sync point forward with the actual balance.
  const latestSync = (contract.balanceSyncs ?? [])
    .slice()
    .sort((a, b) => a.syncYearMonth.localeCompare(b.syncYearMonth))
    .at(-1);

  const rows: AmortizationRow[] = [];
  const segments = buildRateSegments(contract);
  const endYM = addMonths(contract.startYearMonth, contract.termMonths);

  // Determine effective start: original start up to sync point (pre-sync history),
  // then restart from sync balance for the remaining term.
  const syncYM = latestSync?.syncYearMonth;
  const syncN  = syncYM ? ymToMonths(syncYM) : null;

  let outstanding = contract.loanAmountCents;
  let paymentNumber = 1;
  let currentYM = contract.startYearMonth;

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const nextSegStartYM = si + 1 < segments.length ? segments[si + 1].startYM : endYM;
    const monthlyRate = seg.annualRatePct / 12 / 100;
    const monthsInSegment = ymToMonths(nextSegStartYM) - ymToMonths(currentYM);
    const totalRemainingMonths = contract.termMonths - (paymentNumber - 1);
    const monthlyPayment = pmt(outstanding, monthlyRate, totalRemainingMonths);

    for (let mi = 0; mi < monthsInSegment && paymentNumber <= contract.termMonths; mi++) {
      // At the sync month, snap the balance to the bank's actual figure and
      // recalculate the monthly payment for the remaining term from here.
      if (syncN !== null && ymToMonths(currentYM) === syncN) {
        outstanding = latestSync!.actualOutstandingCents;
        const remainingAfterSync = contract.termMonths - (paymentNumber - 1);
        // Recalculate PMT for the rest of this segment with the corrected balance
        const newPayment = pmt(outstanding, monthlyRate, remainingAfterSync);
        // Restart the segment loop with the corrected payment
        const interestCents = Math.round(outstanding * monthlyRate);
        const capitalCents = Math.min(newPayment - interestCents, outstanding);
        outstanding = Math.max(0, outstanding - capitalCents);
        rows.push({
          ym: currentYM,
          paymentNumber,
          paymentCents: capitalCents + interestCents,
          interestCents,
          capitalCents,
          outstandingCents: outstanding,
        });
        currentYM = addMonths(currentYM, 1);
        paymentNumber++;
        continue;
      }

      const interestCents = Math.round(outstanding * monthlyRate);
      const capitalCents = Math.min(monthlyPayment - interestCents, outstanding);
      outstanding = Math.max(0, outstanding - capitalCents);

      rows.push({
        ym: currentYM,
        paymentNumber,
        paymentCents: capitalCents + interestCents,
        interestCents,
        capitalCents,
        outstandingCents: outstanding,
      });

      currentYM = addMonths(currentYM, 1);
      paymentNumber++;
    }
  }

  return rows;
}

/**
 * Get the outstanding balance at the START of a given year-month
 * (i.e. before that month's payment is made).
 */
export function getOutstandingAtYM(contract: CreditContractDoc, ym: string): number {
  if (ym <= contract.startYearMonth) return contract.loanAmountCents;
  const schedule = buildAmortizationSchedule(contract);
  const prevRow = schedule.findLast(r => r.ym < ym);
  if (!prevRow) return contract.loanAmountCents;
  return prevRow.outstandingCents;
}

/**
 * Convenience stats useful for the UI summary.
 */
export interface CreditStats {
  monthlyPaymentCents: number;
  outstandingCents: number;
  totalRemainingInterestCents: number;
  payoffYearMonth: string;
  elapsedMonths: number;
  remainingMonths: number;
}

export function getCreditStats(contract: CreditContractDoc, asOfYM: string): CreditStats {
  const schedule = buildAmortizationSchedule(contract);
  if (!schedule.length) {
    return {
      monthlyPaymentCents: 0,
      outstandingCents: 0,
      totalRemainingInterestCents: 0,
      payoffYearMonth: contract.startYearMonth,
      elapsedMonths: 0,
      remainingMonths: 0,
    };
  }

  const currentRow = schedule.find(r => r.ym === asOfYM);
  const lastRow = schedule[schedule.length - 1];
  const futureRows = schedule.filter(r => r.ym >= asOfYM);

  return {
    monthlyPaymentCents: currentRow?.paymentCents ?? schedule[0].paymentCents,
    outstandingCents: currentRow
      ? currentRow.outstandingCents + currentRow.capitalCents   // balance before payment
      : (schedule.findLast(r => r.ym < asOfYM)?.outstandingCents ?? contract.loanAmountCents),
    totalRemainingInterestCents: futureRows.reduce((s, r) => s + r.interestCents, 0),
    payoffYearMonth: lastRow.ym,
    elapsedMonths: schedule.filter(r => r.ym < asOfYM).length,
    remainingMonths: futureRows.length,
  };
}
