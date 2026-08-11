export type BankImportSource = 'xlsx' | 'pdf' | 'chat' | 'manual';

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
