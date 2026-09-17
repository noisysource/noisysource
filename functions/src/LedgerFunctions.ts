// functions/src/LedgerFunctions.ts
import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";

/** ---------- Admin init ---------- */
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
// Belt & suspenders: never persist undefined to Firestore
db.settings({ ignoreUndefinedProperties: true });

/** ---------- Models ---------- */

type PostingSide = "debit" | "credit";
type TemplateKind = "single" | "transfer" | "split";
type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval?: number;
  endDate?: string | Date | admin.firestore.Timestamp;
  dayOfMonth?: number;
  dayOfWeek?: number; // 0..6 (Sun..Sat)
}

interface SingleTemplate {
  kind: "single";
  accountId: string;      // category or account id/code (non-cash side)
  amountCents: number;    // positive
  type: "income" | "expense";
}
interface TransferTemplate {
  kind: "transfer";
  fromAccountId: string;  // source account id/code
  toAccountId: string;    // destination account id/code
  amountCents: number;    // positive
}
interface SplitTemplate {
  kind: "split";
  lines: {
    accountId: string;
    amountCents: number;  // positive
    side: PostingSide;
    personId?: string;
    tag?: string;
  }[];
}
type TemplateShape = SingleTemplate | TransferTemplate | SplitTemplate;

interface PlannedTransactionTemplate {
  id: string;
  orgId: string;
  label: string;
  kind: TemplateKind;
  currency: string;
  cashAccountId?: string;
  dateAnchor: Date | string | admin.firestore.Timestamp;
  recurrence: RecurrenceRule;
  shape: TemplateShape;
  active: boolean;
  createdBy: string;
  createdAt: Date | string | admin.firestore.Timestamp;
  tags?: string[];
}

type PlannedEventStatus = "draft" | "approved" | "converted";
interface PlannedTransactionInstance {
  id: string;
  templateId: string;
  orgId: string;
  label: string;
  kind: TemplateKind;
  currency: string;
  cashAccountId?: string;
  date: Date;
  status: PlannedEventStatus;
  shape: TemplateShape;
  idempotencyKey: string;
}

interface Posting {
  accountId: string;
  amountCents: number; // positive
  side: PostingSide;
  personId?: string;
  tag?: string;
}

interface LedgerTransaction {
  id: string;
  orgId: string;
  date: Date;
  label: string;
  currency: string;
  postings: Posting[];
  createdBy: string;
  createdAt: Date;
  source?: { type: "planned" | "manual" | "payroll" | "import"; refId?: string };
  idempotencyKey?: string;
}

/** ---------- Utils ---------- */

function cleanUndefinedDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cleanUndefinedDeep) as any;
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v as any)) {
      if (val === undefined) continue;
      out[k] = cleanUndefinedDeep(val as any);
    }
    return out;
  }
  return v;
}

// Safe Firestore doc id (keep [A-Za-z0-9_-])
const safeDocId = (s: string) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");

// Build a stable key when instance is missing one
const buildIdempotencyKey = (inst: any) => {
  const dateKey =
    inst?.date instanceof Date
      ? inst.date.toISOString().slice(0, 10)
      : typeof inst?.date === "string"
        ? inst.date.slice(0, 10)
        : "nodate";
  const base =
    inst?.idempotencyKey ||
    inst?.id ||
    `${inst?.templateId || "ad-hoc"}:${dateKey}:${inst?.kind || "txn"}:${inst?.label || "txn"}`;
  return String(base);
};

/** ---------- Date helpers (UTC-safe) ---------- */

const DAY = 86_400_000; // milliseconds in a day

const toUTC = (v: any): Date => {
  if (!v) return new Date(NaN);
  if (v instanceof admin.firestore.Timestamp) return v.toDate();
  if (typeof v === "string") return new Date(v);
  return v as Date;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const toUTCDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const eomDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const clampDay = (y: number, m: number, d: number) => Math.min(d, eomDay(y, m));
const sameYMD = (a: Date, b: Date) => ymd(a) === ymd(b);

/** ---------- Recurrence engine ---------- */

function* recurrenceDates(
  anchorIn: Date,
  rule: RecurrenceRule,
  from: Date,
  to: Date,
  max = 1000
) {
  const anchor = anchorIn;
  if (isNaN(anchor.getTime())) return;

  const freq = rule.frequency;
  const interval = rule.interval ?? 1;
  const ruleEnd = rule.endDate ? toUTC(rule.endDate) : null;
  const stop = ruleEnd && ruleEnd < to ? ruleEnd : to;

  const alignWeekly = (dt: Date) => {
    if (rule.dayOfWeek == null) return dt;
    const want = rule.dayOfWeek; // 0..6
    const cur = dt.getUTCDay();
    const delta = (want - cur + 7) % 7;
    return new Date(dt.getTime() + delta * DAY);
  };

  const alignMonthly = (yy: number, mm: number) => {
    const dom = rule.dayOfMonth ?? anchor.getUTCDate();
    const day = clampDay(yy, mm, dom);
    return toUTCDate(yy, mm, day);
  };

  // fast-forward to first >= from
  let cur = new Date(anchor.getTime());
  while (cur < from) {
    switch (freq) {
      case "daily":
        cur = new Date(cur.getTime() + interval * DAY);
        break;
      case "weekly":
        cur = alignWeekly(cur);
        if (cur < from) cur = new Date(cur.getTime() + interval * 7 * DAY);
        break;
      case "monthly": {
        const yy = cur.getUTCFullYear();
        const mm = cur.getUTCMonth();
        const nm = mm + interval;
        cur = alignMonthly(yy + Math.floor(nm / 12), nm % 12);
        break;
      }
      case "yearly":
        cur = toUTCDate(cur.getUTCFullYear() + interval, cur.getUTCMonth(), cur.getUTCDate());
        break;
    }
  }

  if (freq === "weekly") cur = alignWeekly(cur);
  if (freq === "monthly") cur = alignMonthly(cur.getUTCFullYear(), cur.getUTCMonth());

  let count = 0;
  while (cur <= stop && count < max) {
    yield cur;
    count++;
    switch (freq) {
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
        cur = toUTCDate(cur.getUTCFullYear() + interval, cur.getUTCMonth(), cur.getUTCDate());
        break;
    }
  }
}

/** ---------- Template → PlannedInstance ---------- */

function deepCloneShape(shape: TemplateShape): TemplateShape {
  switch (shape.kind) {
    case "single":
    case "transfer":
      return { ...shape };
    case "split":
      return { kind: "split", lines: shape.lines.map((l) => ({ ...l })) };
  }
}

function expandTemplate(
  tpl: PlannedTransactionTemplate,
  window: { from: Date; to: Date; max?: number }
): PlannedTransactionInstance[] {
  const out: PlannedTransactionInstance[] = [];

  const anchor = toUTC(tpl.dateAnchor);
  if (isNaN(anchor.getTime())) return out;

  const r = (tpl.recurrence ?? {}) as RecurrenceRule;
  const end = r.endDate ? toUTC(r.endDate) : null;

  // Single-shot guard: interpret "Once" as endDate == anchor (same YYYY-MM-DD)
  const isOnce = !!end && sameYMD(anchor, end);
  if (isOnce) {
    if (anchor >= window.from && anchor <= window.to) {
      const key = `${tpl.id}:${ymd(anchor)}`;
      out.push({
        id: key,
        templateId: tpl.id,
        orgId: tpl.orgId,
        label: tpl.label,
        kind: tpl.kind,
        currency: tpl.currency,
        cashAccountId: (tpl as any).cashAccountId,
        date: anchor,
        status: "draft",
        shape: deepCloneShape(tpl.shape),
        idempotencyKey: key,
      });
    }
    return out;
  }

  // Normal recurrence
  for (const dt of recurrenceDates(anchor, r, window.from, window.to, window.max ?? 1000)) {
    const key = `${tpl.id}:${ymd(dt)}`;
    out.push({
      id: key,
      templateId: tpl.id,
      orgId: tpl.orgId,
      label: tpl.label,
      kind: tpl.kind,
      currency: tpl.currency,
      date: dt,
      status: "draft",
      shape: deepCloneShape(tpl.shape),
      idempotencyKey: key,
    });
  }

  return out;
}

/** ---------- PlannedInstance shape normalizer ---------- */

function ensureShape(inst: any): TemplateShape {
  if (inst?.shape?.kind) return inst.shape as TemplateShape;

  const kind = inst?.kind as TemplateKind;

  if (kind === "transfer") {
    const amount = Number(inst?.amountCents) || 0;
    const fromAccountId = inst?.fromAccountId;
    const toAccountId = inst?.toAccountId;
    if (!fromAccountId || !toAccountId || amount <= 0) {
      throw new HttpsError("invalid-argument", "transfer requires fromAccountId, toAccountId and amountCents > 0");
    }
    return { kind: "transfer", fromAccountId, toAccountId, amountCents: amount };
  }

  if (kind === "single") {
    const amount = Math.abs(Number(inst?.amountCents) || 0);
    const accountId = inst?.accountId;
    const type = inst?.type === "income" ? "income" : "expense";
    if (!accountId || amount <= 0) {
      throw new HttpsError("invalid-argument", "single requires accountId and amountCents > 0");
    }
    return { kind: "single", accountId, amountCents: amount, type };
  }

  if (kind === "split") {
    if (!Array.isArray(inst?.lines) || !inst.lines.length) {
      throw new HttpsError("invalid-argument", "split requires non-empty lines[]");
    }
    const lines = inst.lines.map((l: any) => {
      const amt = Number(l?.amountCents) || 0;
      if (!l?.accountId || amt === 0) {
        throw new HttpsError("invalid-argument", "split lines require accountId and non-zero amount");
      }
      const side: PostingSide = l?.side ?? (amt > 0 ? "debit" : "credit");
      return {
        accountId: l.accountId,
        amountCents: Math.abs(amt),
        side,
        personId: l?.personId || undefined,
        tag: l?.tag || undefined,
      };
    });
    return { kind: "split", lines };
  }

  throw new HttpsError("failed-precondition", "planned instance missing shape/kind");
}

/** ---------- PlannedInstance → LedgerTransaction ---------- */

function postingsFromShape(shape: TemplateShape, cashAccountId: string): Posting[] {
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
      if (!shape.lines.length) throw new Error("split must have at least one line");
      return shape.lines.map((l) => {
        const base: Posting = {
          accountId: l.accountId,
          amountCents: l.amountCents,
          side: l.side,
        };
        if (l.personId) base.personId = l.personId;
        if (l.tag) base.tag = l.tag;
        return base;
      });
    }
  }
}

function sumPostings(postings: Posting[]) {
  let debits = 0;
  let credits = 0;
  for (const p of postings) {
    if (p.amountCents <= 0) throw new Error("amountCents must be > 0");
    if (p.side === "debit") debits += p.amountCents;
    else if (p.side === "credit") credits += p.amountCents;
  }
  return { debits, credits, net: debits - credits };
}

function assertBalanced(postings: Posting[]) {
  const { debits, credits } = sumPostings(postings);
  if (debits !== credits) throw new Error(`unbalanced transaction: debits=${debits} credits=${credits}`);
}

function instanceToLedger(
  inst: PlannedTransactionInstance,
  opts: {
    orgId: string;
    currency: string;
    cashAccountId: string;
    createdBy: string;
    date?: Date;
    id?: string; // safe doc id we pass in
    idempotencyKeyPrefix?: string;
    shape?: TemplateShape; // normalized shape (optional override)
  }
): LedgerTransaction {
  const date = opts.date ?? inst.date;
  const shape = opts.shape ?? inst.shape;
  const postings = postingsFromShape(shape, opts.cashAccountId);
  assertBalanced(postings);

  const idem = inst.idempotencyKey || buildIdempotencyKey(inst);

  return {
    id: opts.id || safeDocId(idem),
    orgId: opts.orgId,
    date,
    label: inst.label,
    currency: opts.currency,
    postings,
    createdBy: opts.createdBy,
    createdAt: new Date(),
    source: { type: "planned", refId: inst.id },
    idempotencyKey: opts.idempotencyKeyPrefix ? `${opts.idempotencyKeyPrefix}:${idem}` : idem,
  };
}

/** ---------- Firestore helpers ---------- */

const colTemplates = (orgId: string) => db.collection("orgs").doc(orgId).collection("templates");
const colPlanned = (orgId: string) => db.collection("orgs").doc(orgId).collection("plannedInstances");
const colLedger = (orgId: string) => db.collection("orgs").doc(orgId).collection("ledgerTransactions");

/** ---------- Callable: expandTemplatesInRange ---------- */
// Real deployment is us-central1 (verified via `firebase functions:list`), not
// Terraform's europe-west3, which is an inert placeholder for this function —
// see OrgDataTools.ts's comment for the full story.
export const expandTemplatesInRange = onCall({ region: "us-central1" }, async (req) => {
  const { orgId, from, to, templateIds, dryRun } = (req.data ?? {}) as {
    orgId: string;
    from: string;
    to: string;
    templateIds?: string[];
    dryRun?: boolean;
  };

  if (!orgId || !from || !to) {
    throw new HttpsError("invalid-argument", "orgId, from, to are required");
  }

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T23:59:59.999Z`);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    throw new HttpsError("invalid-argument", "from/to must be YYYY-MM-DD");
  }

  // Load templates
  let q:
    | FirebaseFirestore.Query<FirebaseFirestore.DocumentData>
    | { get: () => Promise<{ docs: any[] }> } = colTemplates(orgId).where("active", "==", true);

  if (templateIds?.length) {
    const ids = templateIds.slice();
    const chunks: string[][] = [];
    while (ids.length) chunks.push(ids.splice(0, 10));
    const snaps = await Promise.all(
      chunks.map((chunk) =>
        colTemplates(orgId).where(admin.firestore.FieldPath.documentId(), "in", chunk).get()
      )
    );
    const docs = snaps.flatMap((s) => s.docs);
    q = { get: async () => ({ docs }) as any };
  }

  const snap = await (q as any).get();
  const templates: PlannedTransactionTemplate[] = snap.docs.map((d: any) => ({
    id: d.id,
    ...(d.data() as any),
  }));

  const plannedToWrite: { docId: string; data: any }[] = [];
  const samples: string[] = [];

  for (const tpl of templates) {
    const instances = expandTemplate(tpl, { from: fromDate, to: toDate, max: 1000 });
    for (const inst of instances) {
      const docId = safeDocId(inst.idempotencyKey); // safe doc id

      const base = {
        ...inst,
        date: admin.firestore.Timestamp.fromDate(inst.date),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "draft",
      };
      const data = cleanUndefinedDeep(base);

      plannedToWrite.push({ docId, data });

      if (samples.length < 5) samples.push(`${tpl.label} → ${ymd(inst.date)} (${docId})`);
    }
  }

  if (dryRun) {
    return {
      created: 0,
      upserted: plannedToWrite.length,
      skipped: 0,
      total: plannedToWrite.length,
      samples,
      dryRun: true,
    };
  }

  // Upsert in batches
  let upserted = 0;
  for (let i = 0; i < plannedToWrite.length; i += 450) {
    const chunk = plannedToWrite.slice(i, i + 450);
    const batch = db.batch();
    for (const { docId, data } of chunk) {
      const ref = colPlanned(orgId).doc(docId);
      batch.set(ref, data, { merge: true });
    }
    await batch.commit();
    upserted += chunk.length;
  }

  return { created: upserted, upserted, skipped: 0, total: upserted, samples };
});

/** ---------- Callable: postPlannedInstance ---------- */
// Same as expandTemplatesInRange above — real deployment is us-central1.
export const postPlannedInstance = onCall({ region: "us-central1" }, async (req) => {
  const { orgId, instanceId, cashAccountId, createdBy, postDate } = (req.data ?? {}) as {
    orgId: string;
    instanceId: string;
    cashAccountId?: string;
    createdBy: string;
    postDate?: string;
  };

  if (!orgId || !instanceId || !createdBy) {
    throw new HttpsError("invalid-argument", "orgId, instanceId, createdBy are required");
  }

  const instRef = colPlanned(orgId).doc(instanceId);
  const ledCol = colLedger(orgId);

  const result = await db.runTransaction(async (tx) => {
    const instSnap = await tx.get(instRef);
    if (!instSnap.exists) throw new HttpsError("not-found", "planned instance not found");

    const inst = instSnap.data() as any as PlannedTransactionInstance;

    // If already converted and target ledger exists, return early (idempotent)
    if ((inst as any).status === "converted" && (inst as any).ledgerTransactionId) {
      const ledgerIdExisting = String((inst as any).ledgerTransactionId);
      const exists = await tx.get(ledCol.doc(ledgerIdExisting));
      if (exists.exists) {
        return { ledgerId: ledgerIdExisting, idempotencyKey: (inst as any).idempotencyKey ?? ledgerIdExisting };
      }
      // fall through to recreate if ledger doc somehow missing
    }

    // Normalize date
    inst.date =
      inst.date instanceof admin.firestore.Timestamp ? inst.date.toDate() : new Date(inst.date);

    // Normalize/derive shape if missing
    const shape = ensureShape(inst);

    // Determine effective cash account (instance wins)
    const effectiveCash = (inst as any).cashAccountId || cashAccountId;
    if (!effectiveCash) {
      throw new HttpsError("failed-precondition", "cashAccountId missing on instance and request");
    }

    // Safe, stable idempotency key + doc id
    const idem = inst.idempotencyKey || buildIdempotencyKey(inst);
    const ledgerId = safeDocId(idem);

    // Build ledger (idempotent)
    const ledger = instanceToLedger(inst, {
      orgId,
      currency: inst.currency,
      cashAccountId: effectiveCash,
      createdBy,
      date: postDate ? new Date(`${postDate}T00:00:00.000Z`) : inst.date,
      id: ledgerId,
      shape, // normalized shape
    });

    const ledgerRef = ledCol.doc(ledger.id);
    const existing = await tx.get(ledgerRef);

    if (!existing.exists) {
      const cleanPostings = ledger.postings.map((p) => {
        const base: any = { accountId: p.accountId, amountCents: p.amountCents, side: p.side };
        if (p.personId) base.personId = p.personId;
        if (p.tag) base.tag = p.tag;
        return base;
      });

      tx.set(
        ledgerRef,
        cleanUndefinedDeep({
          ...ledger,
          postings: cleanPostings,
          date: admin.firestore.Timestamp.fromDate(ledger.date),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      );
    }

    // Mark instance converted + backfill idempotencyKey if absent
    tx.set(
      instRef,
      cleanUndefinedDeep({
        status: "converted",
        ledgerTransactionId: ledger.id,
        idempotencyKey: (inst as any).idempotencyKey || idem,
        convertedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );

    return { ledgerId: ledger.id, idempotencyKey: ledger.idempotencyKey ?? ledger.id };
  });

  return result;
});