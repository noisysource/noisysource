/**
 * vatFromMovements.ts — IVA from what actually moved (HANDOFF-finhub-redesign.md step 5). Pure.
 *
 * A month that is over and has statement lines is "real": its VAT comes from the confirmed lines
 * (a line matched to a recurring entry takes that entry's VAT code; an ad hoc one, the code it was
 * classified with; credits, salaries and transfers carry no VAT; 'por_confirmar' is listed apart,
 * never counted as 0). Other months keep the estimate from the recurring entries.
 */
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import { recurringVatCode } from "@shared/models/RecurringEntry";
import type { BankTransactionDoc } from "@shared/models/BankTransaction";
import { splitGross, vatCodeChargesVat, type VatCode } from "@shared/lib/vat";
import { recurringVatInMonths, type RecurringVatRow } from "./recurringSchedule";

export type VatSource = "real" | "previsto";

export type QuarterVat = {
  monthSource: Record<string, VatSource>;
  /** IVA liquidado (income) and dedutível (expenses), one row per description and source. */
  incomeRows: Array<RecurringVatRow & { source: VatSource }>;
  expenseRows: Array<RecurringVatRow & { source: VatSource }>;
  unconfirmed: Array<{ description: string; amountCents: number; kind: "rendimento" | "despesa"; source: VatSource }>;
  /** Lines of the real months still to classify: the real figure is incomplete until they are. */
  pendingLines: number;
};

function addRow(rows: Array<RecurringVatRow & { source: VatSource }>, description: string, vatCode: VatCode, baseCents: number, ivaCents: number) {
  const r = rows.find(x => x.description === description && x.vatCode === vatCode && x.source === "real");
  if (r) { r.baseCents += baseCents; r.ivaCents += ivaCents; }
  else rows.push({ description, vatCode, baseCents, ivaCents, source: "real" });
}

export function quarterVat(input: {
  months: readonly string[];
  /** "YYYY-MM" of today: months up to the one before are over. */
  currentYM: string;
  lines: readonly BankTransactionDoc[];
  entries: readonly RecurringEntryDoc[];
  volumeByMonth?: Record<string, number>;
  /** NoisyPhocus: KidClub's income VAT comes from Vendus, so income lines are left out (estimates stay). */
  incomeFromLines: boolean;
}): QuarterVat {
  const entryById = new Map(input.entries.map(e => [e.id, e]));
  const monthSource: Record<string, VatSource> = {};
  for (const ym of input.months) {
    monthSource[ym] = ym < input.currentYM && input.lines.some(l => l.date.startsWith(ym)) ? "real" : "previsto";
  }
  const out: QuarterVat = { monthSource, incomeRows: [], expenseRows: [], unconfirmed: [], pendingLines: 0 };

  for (const l of input.lines) {
    const ym = l.date.slice(0, 7);
    if (monthSource[ym] !== "real") continue;
    const income = l.amountCents > 0;
    if (income && !input.incomeFromLines) continue;
    const m = l.match;
    if (!m) { out.pendingLines++; continue; }
    let code: VatCode | null | undefined;
    let description = m.label;
    if (m.kind === "adhoc") code = m.vatCode ?? "por_confirmar";
    else if (m.kind === "recurring") {
      const e = m.ref ? entryById.get(m.ref) : undefined;
      code = e ? recurringVatCode(e) : null;
      if (e) description = e.description;
    } else code = null; // credit, payroll, transfer
    if (code == null) continue;
    const amount = Math.abs(l.amountCents);
    if (code === "por_confirmar") {
      out.unconfirmed.push({ description, amountCents: amount, kind: income ? "rendimento" : "despesa", source: "real" });
      continue;
    }
    if (!vatCodeChargesVat(code)) continue;
    const split = splitGross(amount, code);
    if (!split) continue;
    addRow(income ? out.incomeRows : out.expenseRows, description, code, split.netCents, split.vatCents);
  }

  const estimateMonths = input.months.filter(ym => monthSource[ym] === "previsto");
  if (estimateMonths.length) {
    const entries = input.entries as RecurringEntryDoc[];
    const inc = recurringVatInMonths(entries, estimateMonths, "income", input.volumeByMonth);
    const exp = recurringVatInMonths(entries, estimateMonths, "expense", input.volumeByMonth);
    out.incomeRows.push(...inc.rows.map(r => ({ ...r, source: "previsto" as const })));
    out.unconfirmed.push(...inc.unconfirmed.map(r => ({ ...r, kind: "rendimento" as const, source: "previsto" as const })));
    out.expenseRows.push(...exp.rows.map(r => ({ ...r, source: "previsto" as const })));
    out.unconfirmed.push(...exp.unconfirmed.map(r => ({ ...r, kind: "despesa" as const, source: "previsto" as const })));
  }
  return out;
}
