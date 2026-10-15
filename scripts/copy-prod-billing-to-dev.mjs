#!/usr/bin/env node
/**
 * Copy KidClub's billing records from production into kidclub-dev, pseudonymised, so FinHub on
 * dev (KidClub revenue, EasyPay commission, Custos do mês, Previsão) runs on real volume.
 * apps/noisysource/finances/HANDOFF-finhub-data.md, step 1.
 *
 * READS prod, WRITES kidclub-dev only. Every write goes through commitDev(), which refuses any
 * document outside kidclub-dev's _apps/arcoiris/billing. Nothing here can write to prod.
 *
 * Billing only. No Firestore trigger listens on _apps/arcoiris/billing (checked 2026-10-15:
 * KidClub's billing triggers fire on studyroom, transportationSubscriptions and
 * reservationEvents; syncVendusClient fires on families, which are not copied). Don't use the
 * payment or invoice actions on the copies in dev's KidClub admin.
 *
 * Every field is classified in FIELD_RULES: kept exactly (amounts, dates, statuses, line types),
 * pseudonymised (names, emails, ids, the child's name inside line titles) or dropped (references
 * into EasyPay/Vendus, payment links, uploaded proofs). A field the rules don't cover, or a line
 * title in an unknown format, stops the run before anything is written; --inspect lists them
 * without printing values.
 *
 * Copies keep the prod id and carry `_copiedFromProd: "<YYYY-MM-DD>"`. A refresh rewrites the
 * tagged copies and deletes tagged copies whose prod record is gone. A dev record without the tag
 * is never touched: an id collision is reported and skipped. Pseudonyms come from a random key per
 * run: within a run a family keeps one pseudonym (all its bills match), and names can't be
 * recovered by hashing guesses.
 *
 * DRY RUN BY DEFAULT.
 *   node scripts/copy-prod-billing-to-dev.mjs --inspect   # field paths, types, shapes; no values
 *   node scripts/copy-prod-billing-to-dev.mjs             # dry run: counts and totals per month × status
 *   node scripts/copy-prod-billing-to-dev.mjs --write     # write the copies to kidclub-dev
 *   add --from kidclub-dev to try --inspect or the dry run on dev's own records (no prod read)
 *
 * Auth: `gcloud auth print-access-token`: read on prod, write on dev. Prod access is opt-in per
 * session (root CLAUDE.md "Cost & Production Safety", .claude/skills/prod-data-check). One read of
 * prod per run, no retries.
 */

import { execSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

const PROD = "rainbow-prod-2454b";
const DEV = "kidclub-dev";
const TAG = "_copiedFromProd";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const FROM = opt("--from", PROD);
const INSPECT = flag("--inspect");
const WRITE = flag("--write");
const TODAY = new Date().toISOString().slice(0, 10);

if (![PROD, DEV].includes(FROM)) { console.error(`--from must be ${PROD} or ${DEV}.`); process.exit(1); }
if (WRITE && (INSPECT || FROM !== PROD)) { console.error(`--write copies ${PROD} → ${DEV}; it takes no other flag.`); process.exit(1); }

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const API = "https://firestore.googleapis.com/v1";
const docsRoot = (p) => `projects/${p}/databases/(default)/documents`;
const DEV_BILLING = `${docsRoot(DEV)}/_apps/arcoiris/billing/`;

async function call(project, url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "x-goog-user-project": project, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${project}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listBilling(project) {
  const rows = await call(project, `${API}/${docsRoot(project)}/_apps/arcoiris:runQuery`, {
    structuredQuery: { from: [{ collectionId: "billing" }] },
  });
  return rows.filter(r => r.document).map(r => ({
    id: r.document.name.split("/").pop(),
    fields: r.document.fields ?? {},
    updateTime: r.document.updateTime,
  }));
}

/** The only function that writes. Refuses anything outside kidclub-dev's billing collection. */
async function commitDev(writes) {
  for (const w of writes) {
    const name = w.update?.name ?? w.delete;
    if (typeof name !== "string" || !name.startsWith(DEV_BILLING)) throw new Error(`Refusing to write outside ${DEV_BILLING}: ${name}`);
  }
  for (let i = 0; i < writes.length; i += 400) {
    await call(DEV, `${API}/${docsRoot(DEV)}:commit`, { writes: writes.slice(i, i + 400) });
  }
}

// ── Pseudonyms ────────────────────────────────────────────────────────────────

const KEY = randomBytes(32);
const code = (s) => createHmac("sha256", KEY).update(String(s)).digest("hex");
const str = (s) => ({ stringValue: s });
const familyCode = (ctx) => code(`family:${ctx.familyId ?? ctx.docId}`).slice(0, 6).toUpperCase();

const pseudoId = (v) => (v.stringValue ? str(`copia-${code(v.stringValue).slice(0, 16)}`) : v);
const familyName = (_v, ctx) => str(`Família ${familyCode(ctx)}`);
const familyEmail = (_v, ctx) => str(`familia-${familyCode(ctx).toLowerCase()}@example.invalid`);
function pseudoSubscriptionId(v) {
  if (!v.stringValue) return v;
  const [head, ...rest] = v.stringValue.split(":"); // enrollment lines: "<childId>:registration"
  return str([`copia-${code(head).slice(0, 16)}`, ...rest].join(":"));
}

/** Line titles as functions/src/kidclub/billing.ts and camp.ts write them; `child` is replaced. */
const TITLE_FORMATS = [
  /^(?<pre>(?:Taxa de Inscrição|Seguro) — )(?<child>.+)$/,
  /^(?<pre>(?:Sala de Estudo|Transporte Escolar) — )(?<child>.+?)(?<post>(?: \([^)]*\))? — [^—]+)$/,
  /^(?<pre>(?:Sinal Campo|Campo) — [^—]+ — )(?<child>.+)$/,
  /^(?<pre>Sinal 50% — [^—]+)$/, // party deposit: party type, no name
];
function pseudoTitle(v, ctx) {
  for (const re of TITLE_FORMATS) {
    const m = v.stringValue?.match(re);
    if (!m) continue;
    const { pre, child, post = "" } = m.groups;
    const kid = child ? `Criança ${code(`child:${ctx.familyId}:${child}`).slice(0, 4).toUpperCase()}` : "";
    return str(`${pre}${kid}${post}`);
  }
  ctx.badTitles.push(v.stringValue ?? JSON.stringify(v));
  return v;
}

// ── Field rules ───────────────────────────────────────────────────────────────
// Path syntax: "a.b" for maps, "a[]" for array items, "*" for any one key.

const KEEP = "keep";
const DROP = "drop";
const FIELD_RULES = [
  // Kept exactly. FinHub reads status, total, dueDate, paidAt, periodLabel.
  ["status", KEEP], ["total", KEEP], ["dueDate", KEEP], ["paidAt", KEEP], ["periodLabel", KEEP],
  ["periodStart", KEEP], ["periodEnd", KEEP], ["paymentMethod", KEEP], ["autoCancelled", KEEP],
  ["createdAt", KEEP], ["updatedAt", KEEP], ["noticeSentAt", KEEP], ["proofSubmittedAt", KEEP],
  ["multibancoExpiry", KEEP], ["invoiceNumber", KEEP], ["atcud", KEEP],
  ["lineItems[].amount", KEEP], ["lineItems[].grossAmount", KEEP], ["lineItems[].type", KEEP],
  ["lineItems[].scheduleDays[]", KEEP], ["lineItems[].tripsByDay.*[]", KEEP],
  ["lineItems[].multiTripDiscountAmount", KEEP], ["lineItems[].siblingDiscountAmount", KEEP],
  ["lineItems[].institutionalDiscountAmount", KEEP], ["lineItems[].institutionalDiscountPct", KEEP],
  ["lineItems[].legacyPricing", KEEP], ["lineItems[].absenceCount", KEEP], ["lineItems[].absenceCreditAmount", KEEP],
  ["lineItems[].absenceDates[]", KEEP], ["lineItems[].absenceCreditDates[]", KEEP],
  ["lineItems[].appliedDiscounts[].*", KEEP], // discount rule id/name, %, when, auto/admin
  ["manualPayment.at", KEEP],
  // Pseudonymised.
  ["familyId", pseudoId], ["userId", pseudoId], ["billingName", familyName], ["billingEmail", familyEmail],
  ["lineItems[].title", pseudoTitle], ["lineItems[].subscriptionId", pseudoSubscriptionId],
  ["manualPayment.by", () => str("admin")],
  ["invoiceError", () => str("erro copiado de prod")],
  // Dropped: references into the real EasyPay/Vendus accounts, payment links, uploaded proofs, free text.
  ["easypayId", DROP], ["previousEasypayIds", DROP], ["duplicatePaymentEasypayIds", DROP],
  ["multibancoEntity", DROP], ["multibancoReference", DROP], ["paymentLink", DROP],
  ["paymentProofs", DROP], ["vendusId", DROP], ["manualPayment.note", DROP], [TAG, DROP],
].map(([path, rule]) => [new RegExp(`^${path.replace(/[.[\]]/g, "\\$&").replace(/\*/g, "[^.\\[\\]]+")}$`), rule, path]);

const ruleFor = (path) => FIELD_RULES.find(([re]) => re.test(path))?.[1];
const ruleLabel = (path) => {
  const r = ruleFor(path);
  return r === KEEP ? "keep" : r === DROP ? "drop" : typeof r === "function" ? "pseudonymise" : "UNCLASSIFIED";
};

/** Applies FIELD_RULES to a raw Firestore value. Leaves with no rule are kept but recorded in ctx.unclassified. */
function transform(value, path, ctx) {
  const rule = path ? ruleFor(path) : undefined;
  if (rule === DROP) return undefined;
  if (typeof rule === "function") return rule(value, ctx);
  if (rule === KEEP) return value;
  if (value.mapValue) {
    const fields = {};
    for (const [k, v] of Object.entries(value.mapValue.fields ?? {})) {
      const out = transform(v, path ? `${path}.${k}` : k, ctx);
      if (out !== undefined) fields[k] = out;
    }
    return { mapValue: { fields } };
  }
  if (value.arrayValue) {
    const values = (value.arrayValue.values ?? []).map(v => transform(v, `${path}[]`, ctx)).filter(v => v !== undefined);
    return { arrayValue: { values } };
  }
  ctx.unclassified.add(path);
  return value;
}

function copyOf(doc, shared) {
  const ctx = { docId: doc.id, familyId: doc.fields.familyId?.stringValue, ...shared };
  const fields = transform({ mapValue: { fields: doc.fields } }, "", ctx).mapValue.fields;
  fields[TAG] = str(TODAY);
  return fields;
}

// ── Output helpers ────────────────────────────────────────────────────────────

const line = (s = "") => console.log(s);
const eur = (c) => (c / 100).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
const cents = (v) => Math.round(Number(v?.doubleValue ?? v?.integerValue ?? 0) * 100);
const lisbonYM = (v) => (v?.timestampValue
  ? new Date(v.timestampValue).toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" }).slice(0, 7)
  : "(sem data)");

/** Masks every token that isn't common across `values`, so a shape shows without names or numbers. */
function masker(values) {
  const freq = new Map();
  for (const v of values) for (const t of new Set(String(v).split(/\s+/))) freq.set(t, (freq.get(t) ?? 0) + 1);
  const min = Math.max(5, values.length * 0.08);
  return (v) => String(v).split(/\s+/)
    .map(t => (freq.get(t) >= min && !/@|\d{6,}/.test(t) ? t : "▒"))
    .join(" ").replace(/(▒ )+▒/g, "▒…");
}

function leaves(value, path, out) {
  if (value.mapValue) {
    for (const [k, v] of Object.entries(value.mapValue.fields ?? {})) leaves(v, path ? `${path}.${k}` : k, out);
  } else if (value.arrayValue) {
    for (const v of value.arrayValue.values ?? []) leaves(v, `${path}[]`, out);
  } else {
    const [type, raw] = Object.entries(value)[0];
    if (!out.has(path)) out.set(path, []);
    out.get(path).push({ type, raw });
  }
}

function inspect(docs) {
  const byPath = new Map();
  const docsWith = new Map();
  for (const d of docs) {
    const mine = new Map();
    leaves({ mapValue: { fields: d.fields } }, "", mine);
    for (const [p, vs] of mine) {
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(...vs);
      docsWith.set(p, (docsWith.get(p) ?? 0) + 1);
    }
  }
  line(`\n${docs.length} records. Per leaf field: docs having it, value types, rule, shape (no values).\n`);
  for (const p of [...byPath.keys()].sort()) {
    const vs = byPath.get(p);
    const types = [...new Set(vs.map(v => v.type.replace("Value", "")))].join("|");
    let shape = "";
    const strings = vs.filter(v => v.type === "stringValue").map(v => v.raw);
    const nums = vs.filter(v => v.type === "integerValue" || v.type === "doubleValue").map(v => Number(v.raw));
    const times = vs.filter(v => v.type === "timestampValue").map(v => lisbonYM({ timestampValue: v.raw }));
    if (strings.length) {
      const distinct = [...new Set(strings)];
      const mask = masker(strings);
      shape = `distinct ${distinct.length}, max length ${Math.max(...strings.map(s => s.length))}`;
      if (strings.some(s => s.includes("@"))) shape += ", has emails";
      const shapes = [...new Set(strings.map(mask))];
      if (shapes.length <= 12) shape += ` · ${shapes.map(s => JSON.stringify(s)).join(" ")}`;
      else shape += ` · ${shapes.length} shapes`;
    }
    if (nums.length) shape += `${shape ? " · " : ""}${Math.min(...nums)} … ${Math.max(...nums)}`;
    if (times.length) shape += `${shape ? " · " : ""}${times.sort()[0]} … ${times.at(-1)}`;
    line(`  ${p.padEnd(46)} ${String(docsWith.get(p)).padStart(5)}  ${types.padEnd(16)} ${ruleLabel(p).padEnd(13)} ${shape}`);
  }
  const titles = byPath.get("lineItems[].title")?.map(v => v.raw) ?? [];
  if (titles.length) {
    const mask = masker(titles);
    const counts = new Map();
    for (const t of titles) counts.set(mask(t), (counts.get(mask(t)) ?? 0) + 1);
    line(`\nLine titles by shape (▒ = masked):`);
    for (const [s, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30)) line(`  ${String(n).padStart(5)}  ${s}`);
  }
}

function summary(docs, label) {
  const rows = new Map();
  const statuses = new Set();
  const processed = new Map();
  let total = 0;
  for (const d of docs) {
    const m = lisbonYM(d.fields.dueDate);
    const s = d.fields.status?.stringValue ?? "(sem estado)";
    const c = cents(d.fields.total);
    statuses.add(s);
    if (!rows.has(m)) rows.set(m, new Map());
    const cell = rows.get(m).get(s) ?? { n: 0, c: 0 };
    rows.get(m).set(s, { n: cell.n + 1, c: cell.c + c });
    total += c;
    if ((s === "paid" || s === "invoiced") && d.fields.paidAt?.timestampValue) {
      const pm = lisbonYM(d.fields.paidAt);
      const p = processed.get(pm) ?? { n: 0, c: 0 };
      processed.set(pm, { n: p.n + 1, c: p.c + c });
    }
  }
  line(`\n## ${label}: ${docs.length} records, ${eur(total)}`);
  line(`\nBy due month (dueDate) × status: count  total`);
  for (const m of [...rows.keys()].sort()) {
    const cells = [...rows.get(m)].sort().map(([s, x]) => `${s} ${x.n} ${eur(x.c)}`);
    const n = [...rows.get(m).values()].reduce((a, x) => a + x.n, 0);
    const c = [...rows.get(m).values()].reduce((a, x) => a + x.c, 0);
    line(`  ${m}  ${String(n).padStart(4)} ${eur(c).padStart(12)}   ${cells.join(" · ")}`);
  }
  line(`\nProcessed volume by month paid (paid/invoiced, paidAt): what FinHub counts for KidClub revenue and EasyPay`);
  for (const m of [...processed.keys()].sort()) line(`  ${m}  ${String(processed.get(m).n).padStart(4)} ${eur(processed.get(m).c).padStart(12)}`);
  return total;
}

// ── Run ───────────────────────────────────────────────────────────────────────

line("=".repeat(78));
line(`copy-prod-billing-to-dev.mjs   ${FROM}  →  ${DEV}   ${INSPECT ? "INSPECT" : WRITE ? "WRITE" : "DRY RUN"}`);
line("=".repeat(78));

const source = await listBilling(FROM);
if (INSPECT) {
  inspect(source);
  process.exit(0);
}

const shared = { unclassified: new Set(), badTitles: [] };
const copies = source.map(d => ({ id: d.id, fields: copyOf(d, shared) }));

const sourceTotal = summary(source, `Source (${FROM})`);
const copyTotal = copies.reduce((a, d) => a + cents(d.fields.total), 0);
line(`\nCopies: ${copies.length} records, ${eur(copyTotal)} ${copyTotal === sourceTotal ? "(identical)" : "!! DIFFERS FROM SOURCE"}`);

const blockers = [];
if (shared.unclassified.size) blockers.push(`fields with no rule: ${[...shared.unclassified].sort().join(", ")}`);
if (shared.badTitles.length) {
  const mask = masker(shared.badTitles);
  blockers.push(`${shared.badTitles.length} line titles in an unknown format, e.g. ${[...new Set(shared.badTitles.map(mask))].slice(0, 5).map(s => JSON.stringify(s)).join(" ")}`);
}
if (copyTotal !== sourceTotal) blockers.push("copy totals differ from the source");

if (FROM === DEV) {
  line(`\nSource is ${DEV} itself (pipeline test): no dev-side plan.`);
} else {
  const dev = await listBilling(DEV);
  const devById = new Map(dev.map(d => [d.id, d]));
  const prodIds = new Set(source.map(d => d.id));
  const own = dev.filter(d => !d.fields[TAG]);
  const writes = [];
  let created = 0, refreshed = 0;
  const collisions = [];
  for (const c of copies) {
    const existing = devById.get(c.id);
    const name = `${DEV_BILLING}${c.id}`;
    if (!existing) { writes.push({ update: { name, fields: c.fields }, currentDocument: { exists: false } }); created++; }
    else if (existing.fields[TAG]) { writes.push({ update: { name, fields: c.fields }, currentDocument: { updateTime: existing.updateTime } }); refreshed++; }
    else collisions.push(c.id);
  }
  const stale = dev.filter(d => d.fields[TAG] && !prodIds.has(d.id));
  for (const d of stale) writes.push({ delete: `${DEV_BILLING}${d.id}`, currentDocument: { updateTime: d.updateTime } });

  line(`\n## ${DEV} now: ${dev.length} billing records (${own.length} dev's own, ${dev.length - own.length} earlier copies)`);
  line(`Plan: create ${created} · refresh ${refreshed} · delete stale copies ${stale.length} · id collisions skipped ${collisions.length}`);
  if (collisions.length) line(`  collisions (dev's own record has a prod id, left alone): ${collisions.join(", ")}`);
  line(`dev's own records are not touched.`);

  if (WRITE) {
    if (blockers.length) {
      console.error(`\nNOT WRITTEN:\n  - ${blockers.join("\n  - ")}`);
      process.exit(1);
    }
    await commitDev(writes);
    line(`\nWRITTEN to ${DEV}: ${created} created, ${refreshed} refreshed, ${stale.length} deleted.`);
  }
}

if (blockers.length) line(`\nBLOCKERS (a --write would refuse):\n  - ${blockers.join("\n  - ")}`);
if (!WRITE) line(`\nDRY RUN: nothing written.`);
