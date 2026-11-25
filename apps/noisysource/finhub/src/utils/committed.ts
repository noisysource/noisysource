// What he actually committed from one of Atlas's imports (#386 in Atlas, "capture now"):
// the items he kept, with his edits, beside what Atlas proposed. Atlas compares the two
// and keeps the differences as training data, so it learns from his corrections. Kept on
// the import itself (`committed`), never the books. Pure: no Firebase here.

type Selected = { readonly selected: boolean };

export type CommittedLine = {
  date: string;
  description: string;
  amount: number;
  direction: 'credit' | 'debit';
  /** He kept it as a transaction (unticked: not one). */
  included: boolean;
  vendor: string;
  category: string;
  type: string;
  ivaRate: number;
  ivaDeductible: boolean;
};

export type CommittedSnapshot = {
  contracts: Record<string, unknown>[];
  subscriptions: Record<string, unknown>[];
  facilities: Record<string, unknown>[];
  payslips: { employeeName: string; periodStart: string; grossPay: number; netPay: number }[];
  statements: { filename: string; lines: CommittedLine[] }[];
};

/** Sizes the rules hold `committed` to (the import's own limits). */
export const COMMITTED_LIMITS = { contracts: 20, subscriptions: 200, facilities: 20, payslips: 60, statements: 20 } as const;

/** Drops the workbench's own flag; keeps everything he might have edited. */
const withoutSelected = <T extends Selected>(x: T): Record<string, unknown> => {
  const { selected: _selected, ...rest } = x;
  return rest as Record<string, unknown>;
};

export const committedOf = (w: {
  readonly contracts: readonly Selected[];
  readonly subscriptions: readonly Selected[];
  readonly facilities: readonly Selected[];
  readonly payslips: readonly (Selected & { employeeName: string; periodStart: string; grossPay: number; netPay: number })[];
  readonly statements: readonly (Selected & {
    filename: string;
    lines: readonly (Omit<CommittedLine, 'included'> & { includeTx: boolean })[];
  })[];
}): CommittedSnapshot => ({
  contracts: w.contracts.filter((c) => c.selected).slice(0, COMMITTED_LIMITS.contracts).map(withoutSelected),
  subscriptions: w.subscriptions.filter((s) => s.selected).slice(0, COMMITTED_LIMITS.subscriptions).map(withoutSelected),
  facilities: w.facilities.filter((f) => f.selected).slice(0, COMMITTED_LIMITS.facilities).map(withoutSelected),
  payslips: w.payslips
    .filter((p) => p.selected)
    .slice(0, COMMITTED_LIMITS.payslips)
    .map((p) => ({ employeeName: p.employeeName, periodStart: p.periodStart, grossPay: p.grossPay, netPay: p.netPay })),
  statements: w.statements
    .filter((s) => s.selected)
    .slice(0, COMMITTED_LIMITS.statements)
    .map((s) => ({
      filename: s.filename,
      lines: s.lines.map((l) => ({
        date: l.date,
        description: l.description,
        amount: l.amount,
        direction: l.direction,
        included: l.includeTx,
        vendor: l.vendor,
        category: l.category,
        type: l.type,
        ivaRate: l.ivaRate,
        ivaDeductible: l.ivaDeductible,
      })),
    })),
});
