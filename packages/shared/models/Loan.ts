export type LoanKind =
  | 'lent'          // I gave them money  → they owe me (+)
  | 'borrowed'      // They gave me money → I owe them (-)
  | 'repayment_in'  // They repaid me     → reduces their debt (-)
  | 'repayment_out' // I repaid them      → reduces my debt  (+)
  | 'covered_for_me'; // They paid my expense → reduces their debt (-)

export interface LoanEntryDoc {
  id: string;
  counterparty: string;  // "João", "Tia Maria", etc.
  amountCents: number;   // positive = in my favor (they owe me more); negative = against me
  description: string;
  date: string;          // "YYYY-MM-DD"
  kind: LoanKind;
  notes?: string;
  createdAt?: Date;
}

/** Running balance for a counterparty: positive = they owe me, negative = I owe them */
export function loanBalance(entries: LoanEntryDoc[]): number {
  return entries.reduce((sum, e) => sum + e.amountCents, 0);
}
