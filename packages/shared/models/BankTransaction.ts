import type { VatCode } from '../lib/vat';

export type BankImportSource = 'xlsx' | 'pdf' | 'chat' | 'manual';

/**
 * What a statement line is, confirmed in Movimentos (HANDOFF-finhub-redesign.md step 4):
 * - 'recurring' / 'credit' / 'payroll': the expected item it pays (ref = recurring entry id,
 *   credit contract id, payroll run id; yearMonth = the month it belongs to);
 * - 'adhoc': a one-off expense or income, with its category and VAT code;
 * - 'transfer': money moving between the group's own accounts (not an expense or income).
 * The KidClub reconciliation (HANDOFF-kidclub-reconciliation.md) adds its kinds here.
 */
export type BankMatchKind = 'recurring' | 'credit' | 'payroll' | 'adhoc' | 'transfer';

export interface BankTransactionMatch {
  kind: BankMatchKind;
  ref?: string;
  yearMonth?: string;
  /** What it was matched to or classified as, as shown. */
  label: string;
  categoryId?: string;
  /** VAT inside the amount (companies); never a silent 0: 'por_confirmar' when unknown. */
  vatCode?: VatCode;
  /** ISO timestamp. */
  confirmedAt: string;
}

/**
 * finances_entities/{entityId}/movementRules/{id}: "lines with this description are …",
 * saved when a classification is confirmed with "Lembrar". Suggestions only, never auto-confirmed.
 */
export interface MovementRuleDoc {
  id: string;
  /** normalizeDescription() of the line. */
  key: string;
  accountId?: string;
  match: Omit<BankTransactionMatch, 'confirmedAt' | 'yearMonth'>;
}

export interface BankTransactionDoc {
  id: string;
  accountId: string;
  entityId: string;
  importId?: string;
  sourceType: BankImportSource;
  date: string;           // YYYY-MM-DD (movement date)
  valueDate?: string;     // YYYY-MM-DD (value date)
  description: string;
  amountCents: number;    // signed (negative = debit)
  balanceCents?: number;  // running balance after this tx
  categoryId?: string;
  recurringId?: string;
  notes?: string;
  importedAt?: Date;
  /** Absent = still to classify (Movimentos). */
  match?: BankTransactionMatch;
}

export interface BankImportDoc {
  id: string;
  accountId: string;
  entityId: string;
  sourceFormat: 'xlsx' | 'pdf';
  filename: string;
  storagePath?: string;   // PDF only
  dateFrom: string;       // YYYY-MM-DD
  dateTo: string;         // YYYY-MM-DD
  transactionCount: number;
  newCount: number;
  duplicateCount: number;
  openingBalanceCents?: number;
  closingBalanceCents?: number;
  importedAt?: Date;
}
