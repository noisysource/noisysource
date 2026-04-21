import { RecurrenceRule } from "../FinancialEvent";
import { PlannedTransactionTemplate, PlannedTransactionInstance, TemplateShape, LedgerTransaction, Posting } from "../Ledger";


type ExpandOpts = {
  from: Date;     // inclusive
  to: Date;       // inclusive
  max?: number;   // safety cap, defaults 1000
};

type ToLedgerOpts = {
  orgId: string;
  currency: string;
  date?: Date;
  createdBy: string;
  /** Counterparty account for single templates (cash/bank). */
  cashAccountId: string;
  /** Optional predetermined id for the ledger transaction. */
  id?: string;
  /** Optional prefix for idempotency keys. */
  idempotencyKeyPrefix?: string;
};

// ---------- Date / recurrence helpers (UTC-safe) ----------

const DAY = 24 * 60 * 60 * 1000; // 1 day in ms

function toUTCDate(y: number, m: number, d: number) {
  return new Date(Date.UTC(y, m, d));
}
function endOfMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}
function clampDay(y: number, m: number, d: number) {
  return Math.min(d, endOfMonth(y, m));
}

/**
 * Generate dates for a recurrence window, honoring dayOfWeek/dayOfMonth when provided.
 */
function* recurrenceDates(
  anchor: Date,
  rule: RecurrenceRule,
  from: Date,
  to: Date,
  max = 1000
) {
  const interval = rule.interval ?? 1;
  const stopAt = rule.endDate && rule.endDate < to ? rule.endDate : to;

  // Align helpers
  const alignWeekly = (dt: Date) => {
    if (rule.dayOfWeek == null) return dt;
    const want = rule.dayOfWeek; // 0..6 (Sun..Sat)
    const cur = dt.getUTCDay();
    const delta = (want - cur + 7) % 7;
    return new Date(dt.getTime() + delta * DAY);
  };
  const alignMonthly = (y: number, m: number) => {
    const dom = rule.dayOfMonth ?? anchor.getUTCDate();
    const day = clampDay(y, m, dom);
    return toUTCDate(y, m, day);
  };

  // Start from an aligned first occurrence >= from
  let first = new Date(anchor.getTime());

  switch (rule.frequency) {
    case "weekly":
      first = alignWeekly(first);
      break;
    case "monthly":
      first = alignMonthly(first.getUTCFullYear(), first.getUTCMonth());
      break;
    // daily/yearly: anchor already aligned
  }

  while (first < from) {
    switch (rule.frequency) {
      case "daily":
        first = new Date(first.getTime() + interval * DAY);
        break;
      case "weekly":
        first = new Date(first.getTime() + interval * 7 * DAY);
        first = alignWeekly(first);
        break;
      case "monthly": {
        const yy = first.getUTCFullYear();
        const mm = first.getUTCMonth();
        const nm = mm + interval;
        first = alignMonthly(yy + Math.floor(nm / 12), nm % 12);
        break;
      }
      case "yearly":
        first = toUTCDate(
          first.getUTCFullYear() + interval,
          first.getUTCMonth(),
          first.getUTCDate()
        );
        break;
    }
  }

  let count = 0;
  let cur = first;
  while (cur <= stopAt && cur <= to && count < max) {
    yield cur;
    count++;
    switch (rule.frequency) {
      case "daily":
        cur = new Date(cur.getTime() + interval * DAY);
        break;
      case "weekly":
        cur = new Date(cur.getTime() + interval * 7 * DAY);
        break;
      case "monthly": {
        const yy = cur.getUTCFullYear();
        const mm = cur.getUTCMonth();
        const nm = mm + interval;
        cur = alignMonthly(yy + Math.floor(nm / 12), nm % 12);
        break;
      }
      case "yearly":
        cur = toUTCDate(
          cur.getUTCFullYear() + interval,
          cur.getUTCMonth(),
          cur.getUTCDate()
        );
        break;
    }
  }
}

// ---------- Template → PlannedInstance ----------

export function expandTemplate(
  tpl: PlannedTransactionTemplate,
  opts: ExpandOpts
): PlannedTransactionInstance[] {
  const max = opts.max ?? 1000;
  const out: PlannedTransactionInstance[] = [];

  for (const dt of recurrenceDates(
    tpl.dateAnchor,
    tpl.recurrence,
    opts.from,
    opts.to,
    max
  )) {
    const idem = `${tpl.id}:${dt.toISOString().slice(0, 10)}`;
    out.push({
      id: idem, // caller can overwrite later
      templateId: tpl.id,
      orgId: tpl.orgId,
      label: tpl.label,
      kind: tpl.kind,
      currency: tpl.currency,
      date: dt,
      status: "draft",
      shape: deepCloneShape(tpl.shape),
      idempotencyKey: idem,
    });
  }
  return out;
}

function deepCloneShape(shape: TemplateShape): TemplateShape {
  switch (shape.kind) {
    case "single":
    case "transfer":
      return { ...shape };
    case "split":
      return { kind: "split", lines: shape.lines.map((l) => ({ ...l })) };
  }
}

// ---------- PlannedInstance → LedgerTransaction ----------

export function instanceToLedger(
  inst: PlannedTransactionInstance,
  options: ToLedgerOpts
): LedgerTransaction {
  const date = options.date ?? inst.date;
  // Narrow by discriminating on shape.kind (no separate 'kind' param)
  const postings = postingsFromShape(inst.shape, options.cashAccountId);

  assertBalanced(postings);

  return {
    id: options.id ?? inst.idempotencyKey,
    orgId: options.orgId,
    date,
    label: inst.label,
    currency: options.currency,
    postings,
    createdBy: options.createdBy,
    createdAt: new Date(),
    source: { type: "planned", refId: inst.id },
    idempotencyKey: options.idempotencyKeyPrefix
      ? `${options.idempotencyKeyPrefix}:${inst.idempotencyKey}`
      : inst.idempotencyKey,
  };
}

function postingsFromShape(
  shape: TemplateShape,
  cashAccountId: string
): Posting[] {
  switch (shape.kind) {
    case "single": {
      const { amountCents, accountId, type } = shape;
      if (amountCents <= 0) throw new Error("amountCents must be > 0");
      return type === "income"
        ? [
            { accountId: cashAccountId, amountCents, side: "debit" },
            { accountId, amountCents, side: "credit" },
          ]
        : [
            { accountId, amountCents, side: "debit" },
            { accountId: cashAccountId, amountCents, side: "credit" },
          ];
    }
    case "transfer": {
      const { fromAccountId, toAccountId, amountCents } = shape;
      if (amountCents <= 0) throw new Error("amountCents must be > 0");
      return [
        { accountId: toAccountId, amountCents, side: "debit" },
        { accountId: fromAccountId, amountCents, side: "credit" },
      ];
    }
    case "split": {
      if (!shape.lines.length)
        throw new Error("split must have at least one line");
      return shape.lines.map((l) => ({
        accountId: l.accountId,
        amountCents: l.amountCents,
        side: l.side,
        personId: l.personId,
        tag: l.tag,
      }));
    }
  }
}

// ---------- Validation ----------

export function assertBalanced(postings: Posting[]) {
  const { debits, credits } = sumPostings(postings);
  if (debits !== credits) {
    throw new Error(`unbalanced transaction: debits=${debits} credits=${credits}`);
  }
}

export function sumPostings(postings: Posting[]) {
  let debits = 0;
  let credits = 0;
  for (const p of postings) {
    if (p.amountCents <= 0) throw new Error("amountCents must be > 0");
    if (p.side === "debit") debits += p.amountCents;
    else if (p.side === "credit") credits += p.amountCents;
    else throw new Error("invalid side");
  }
  return { debits, credits, net: debits - credits };
}

// ---------- Small utility ----------

export function isoDateUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}