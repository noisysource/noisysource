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
  /** Com IVA. */
  amountCents: number;
  /** Sem IVA. Equal to amountCents when no VAT applies (payroll, exempt) or it's unknown. */
  netCents?: number;
  /** Absent for payroll (VAT doesn't apply). 'por_confirmar' = counted at face value. */
  vatCode?: VatCode;
}

export interface CostSummaryDoc {
  payrollCostCents: number;
  /** Recurring costs, com IVA. */
  softwareCostCents: number;
  /** Recurring costs, sem IVA. */
  softwareNetCents?: number;
  /** VAT inside the recurring costs (dedutível). Already part of softwareCostCents, not extra. */
  vatCents: number;
  /** payroll + recurring costs, com IVA. */
  totalCostCents: number;
  /** payroll + recurring costs, sem IVA. */
  totalNetCents?: number;
  /** Recurring costs with "IVA por confirmar", counted at face value in both totals. */
  unconfirmedVatCount?: number;
  computedAt: Timestamp;
  breakdown?: CostSummaryBreakdownLine[];
}
