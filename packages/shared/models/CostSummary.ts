import { Timestamp } from 'firebase/firestore';
import type { VatCode } from '../lib/vat';

/**
 * finances_entities/{entityId}/costSummary/{yyyy-mm}
 *
 * Computed monthly cost total for an entity (currently only produced for
 * `noisyphocus`). Written by FinHub (see
 * apps/noisysource/finances/src/lib/api/domains/costSummary.ts), read
 * cross-app by KidClub's "Resumo Financeiro" page for the expense side of
 * its own numbers — see root CLAUDE.md "Cross-App Data Contracts".
 *
 * Recomputed (and overwritten) every time the FinHub Custos page is opened
 * for a given month, rather than being a one-off/manual snapshot — see
 * apps/noisysource/finances/STATUS.md for the reasoning.
 *
 * VAT convention (2026-10-12, packages/shared/HANDOFF-vat-convention.md): every amount
 * is VAT-inclusive ("com IVA") and has a "sem IVA" twin. Docs computed before that added
 * the VAT on top (vatCents was an extra cost line) and have no *NetCents fields.
 */
export interface CostSummaryBreakdownLine {
  label: string;
  /** Group it's shown under: "Pessoal" for payroll, else the top-level category of the recurring entry. */
  group?: string;
  /** Com IVA. */
  amountCents: number;
  /** Sem IVA. Equal to amountCents when no VAT applies (payroll, exempt) or it's unknown. */
  netCents?: number;
  /** Absent for payroll (VAT doesn't apply). 'por_confirmar' = counted at face value. */
  vatCode?: VatCode;
}

/** Subtotal of one group (a top-level category, "Pessoal", or "Sem categoria"). */
export interface CostSummaryGroup {
  name: string;
  amountCents: number;
  netCents: number;
}

export interface CostSummaryDoc {
  payrollCostCents: number;
  /** Every recurring cost (rent, utilities, software, …), com IVA. */
  recurringCostCents?: number;
  /** Every recurring cost, sem IVA. */
  recurringNetCents?: number;
  /**
   * Recurring costs in the "Software" category only, com IVA. Docs computed before 2026-10-16 counted
   * every recurring cost here (no categories then).
   */
  softwareCostCents: number;
  /** The same, sem IVA. */
  softwareNetCents?: number;
  /** VAT inside the recurring costs (dedutível). Already part of recurringCostCents, not extra. */
  vatCents: number;
  /** payroll + recurring costs, com IVA. */
  totalCostCents: number;
  /** payroll + recurring costs, sem IVA. */
  totalNetCents?: number;
  /** Recurring costs with "IVA por confirmar", counted at face value in both totals. */
  unconfirmedVatCount?: number;
  computedAt: Timestamp;
  /** Subtotals per group, payroll ("Pessoal") first, then the largest. */
  groups?: CostSummaryGroup[];
  breakdown?: CostSummaryBreakdownLine[];
}
