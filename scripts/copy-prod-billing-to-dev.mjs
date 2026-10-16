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
 * pseudonymised (names, emails, user/subscription ids, the child's name inside line titles) or dropped (references
 * into EasyPay/Vendus, payment links, uploaded proofs). A field the rules don't cover, or a line
 * title in an unknown format, stops the run before anything is written; --inspect lists them
 * without printing values.
 *
 * Copies keep the prod id and carry `_copiedFromProd: "<YYYY-MM-DD>"`. A refresh rewrites the
 * tagged copies and deletes tagged copies whose prod record is gone. Pseudonyms come from a random
 * key per run: within a run a family keeps one pseudonym (all its bills match), and names can't be
 * recovered by hashing guesses.
 *
 * Bill ids are `<familyId>_<yyyy-mm>`, and dev's families were copied from prod with the same ids
 * (copy-prod-data-to-dev.js), so dev's own bills collide with the copies. familyId is therefore
 * kept as is: it is in the id anyway, and those families already exist on dev. Without --replace
 * a dev record without the tag is never touched (collisions are skipped). With --replace (Renato,
 * 2026-10-16) dev's billing becomes exactly prod's: dev's own records are saved to --backup (a file
 * under prodata/, real data) and then replaced or deleted, so FinHub on dev matches prod to the
 * cent. --restore <backup> puts them back (and removes the copies).
 *
 * DRY RUN BY DEFAULT.
 *   node scripts/copy-prod-billing-to-dev.mjs --inspect   # field paths, types, shapes; no values
 *   node scripts/copy-prod-billing-to-dev.mjs             # dry run: counts and totals per month × status
 *   node scripts/copy-prod-billing-to-dev.mjs --write     # write the copies to kidclub-dev
 *   node scripts/copy-prod-billing-to-dev.mjs --replace --backup ~/dev/noisysource/prodata/<file>.json [--write]
 *   node scripts/copy-prod-billing-to-dev.mjs --restore ~/dev/noisysource/prodata/<file>.json [--write]
 *   add --from kidclub-dev to try --inspect or the dry run on dev's own records (no prod read)
 *
 * Auth: `gcloud auth print-access-token`: read on prod, write on dev. Prod access is opt-in per
 * session (root CLAUDE.md "Cost & Production Safety", .claude/skills/prod-data-check). One read of
 * prod per run, no retries.
 */

import { execSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const PROD = "rainbow-prod-2454b";
const DEV = "kidclub-dev";
const TAG = "_copiedFromProd";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const FROM = opt("--from", PROD);
const INSPECT = flag("--inspect");
const WRITE = flag("--write");
const REPLACE = flag("--replace");
const BACKUP = opt("--backup", null);
const RESTORE = opt("--restore", null);
const TODAY = new Date().toISOString().slice(0, 10);

const fail = (msg) => { console.error(msg); process.exit(1); };
if (![PROD, DEV].includes(FROM)) fail(`--from must be ${PROD} or ${DEV}.`);
if (WRITE && (INSPECT || FROM !== PROD)) fail(`--write copies ${PROD} → ${DEV}; it doesn't combine with --inspect or --from.`);
if (REPLACE && WRITE && !BACKUP) fail("--replace --write needs --backup <file under prodata/>: dev's own records are saved there first.");
// Backups hold real data: only in the main checkout's gitignored prodata/, never inside a worktree.
const PRODATA = resolve(execSync("git rev-parse --path-format=absolute --git-common-dir", { encoding: "utf8" }).trim(), "..", "prodata") + sep;
for (const f of [BACKUP, RESTORE]) {
  if (f && !resolve(f).startsWith(PRODATA)) fail(`${f}: backups live in ${PRODATA} and nowhere else.`);
}

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
  ["lineItems[].absenceDates[]", KEEP], ["lineItems[].absenceCreditDates[]", KEEP], ["lineItems[].excludedDates[]", KEEP],
  ["lineItems[].appliedDiscounts[].*", KEEP], // discount rule id/name, %, when, auto/admin
  ["lineItems[].frozenMidPeriodCancellation", KEEP],
  ["manualPayment.at", KEEP],
  // Pseudonymised.
  ["familyId", KEEP], // in the record id anyway; dev already has these families (see header)
  ["userId", pseudoId], ["billingName", familyName], ["billingEmail", familyEmail],
  ["lineItems[].title", pseudoTitle], ["lineItems[].subscriptionId", pseudoSubscriptionId],
  ["manualPayment.by", () => str("admin")],
  ["invoiceError", () => str("erro copiado de prod")],
  // Dropped: references into the real EasyPay/Vendus accounts, payment links, uploaded proofs, free text.
  ["easypayId", DROP], ["paidEasypayId", DROP], ["previousEasypayIds", DROP], ["duplicatePaymentEasypayIds", DROP],
  ["multibancoEntity", DROP], ["multibancoReference", DROP], ["paymentLink", DROP],
  ["paymentProofs", DROP], ["vendusId", DROP], ["manualPayment.note", DROP], ["mbwayPhone", DROP], [TAG, DROP],
].map(([path, rule]) => [new RegExp(`^${path.replace(/[.[\]]/g, "\\$&").replace(/\*/g, "[^.\\[\\]]+")}$`), rule, path]);

const ruleFor = (path) => FIELD_RULES.find(([re]) => re.test(path))?.[1];
/** The rule transform() applies to a leaf: the first rule found walking down from the top-level field. */
const effectiveRule = (path) => {
  const cuts = [...path.matchAll(/\.|\[\]/g)].flatMap(m => (m[0] === "[]" ? [m.index, m.index + 2] : [m.index]));
  for (const end of [...cuts, path.length]) {
    const r = ruleFor(path.slice(0, end));
    if (r !== undefined) return r;
  }
  return undefined;
};
const ruleLabel = (path) => {
  const r = effectiveRule(path);
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

/** Masks every token that isn't common across `values`. Only for fields kept as-is (meant to hold no personal data). */
function masker(values) {
  const freq = new Map();
  for (const v of values) for (const t of new Set(String(v).split(/\s+/))) freq.set(t, (freq.get(t) ?? 0) + 1);
  const min = Math.max(5, values.length * 0.08);
  return (v) => String(v).split(/\s+/)
    .map(t => (freq.get(t) >= min && !/@|\d{6,}/.test(t) ? t : "▒"))
    .join(" ").replace(/(▒ )+▒/g, "▒…");
}

const MONTHS = "Janeiro Fevereiro Março Abril Maio Junho Julho Agosto Setembro Outubro Novembro Dezembro";
const TITLE_WORDS = new Set(`— Sala de Estudo Transporte Escolar Taxa Inscrição Seguro Campo Sinal 50% Festa ${MONTHS}`.split(" "));
/** Keeps only title vocabulary, weekday abbreviations and years: names never show. */
const strictMask = (t) => String(t).split(/\s+/)
  .map(w => (TITLE_WORDS.has(w) || /^\(?[2-6]ª[,)]?$/.test(w) || /^\d{4}$/.test(w) ? w : "▒"))
  .join(" ").replace(/(▒ )+▒/g, "▒…");
/** A title's shape with the child replaced by ▒ when the format is known. */
function titleShape(t) {
  for (const re of TITLE_FORMATS) {
    const m = t.match(re);
    if (m) return strictMask(`${m.groups.pre}${m.groups.child ? "▒" : ""}${m.groups.post ?? ""}`);
  }
  return `UNKNOWN FORMAT: ${strictMask(t)}`;
}
const charClass = (strings) => [
  strings.some(s => /@/.test(s)) && "emails", strings.some(s => /\d/.test(s)) && "digits", strings.some(s => /[A-Za-zÀ-ÿ]/.test(s)) && "letters",
].filter(Boolean).join("+");

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
      shape = `distinct ${new Set(strings).size}, max length ${Math.max(...strings.map(s => s.length))}, ${charClass(strings)}`;
      if (effectiveRule(p) === KEEP) { // values of pseudonymised, dropped or unclassified fields are never shown
        const shapes = [...new Set(strings.map(masker(strings)))];
        shape += shapes.length <= 12 ? ` · ${shapes.map(s => JSON.stringify(s)).join(" ")}` : ` · ${shapes.length} shapes`;
      }
    }
    if (nums.length) shape += `${shape ? " · " : ""}${Math.min(...nums)} … ${Math.max(...nums)}`;
    if (times.length) shape += `${shape ? " · " : ""}${times.sort()[0]} … ${times.at(-1)}`;
    line(`  ${p.padEnd(46)} ${String(docsWith.get(p)).padStart(5)}  ${types.padEnd(16)} ${ruleLabel(p).padEnd(13)} ${shape}`);
  }
  const titles = byPath.get("lineItems[].title")?.map(v => v.raw) ?? [];
  if (titles.length) {
    const counts = new Map();
    for (const t of titles) counts.set(titleShape(t), (counts.get(titleShape(t)) ?? 0) + 1);
    line(`\nLine titles by shape (▒ = child's name or other masked text):`);
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

const mode = INSPECT ? "INSPECT" : RESTORE ? "RESTORE" : REPLACE ? "REPLACE" : "COPY";
line("=".repeat(78));
line(`copy-prod-billing-to-dev.mjs   ${RESTORE ? RESTORE : FROM}  →  ${DEV}   ${mode} ${WRITE ? "WRITE" : "DRY RUN"}`);
line("=".repeat(78));

const devFor = async () => {
  const dev = await listBilling(DEV);
  const copiesOnDev = dev.filter(d => d.fields[TAG]);
  return { dev, copiesOnDev, ownOnDev: dev.filter(d => !d.fields[TAG]) };
};

if (RESTORE) {
  // Puts back dev's own records saved by --replace and removes every copy.
  const backup = JSON.parse(readFileSync(RESTORE, "utf8"));
  if (backup.project !== DEV || !Array.isArray(backup.records)) fail(`${RESTORE} is not a ${DEV} billing backup.`);
  const { dev, copiesOnDev } = await devFor();
  const backupIds = new Set(backup.records.map(r => r.id));
  const writes = [
    ...copiesOnDev.filter(d => !backupIds.has(d.id)).map(d => ({ delete: `${DEV_BILLING}${d.id}`, currentDocument: { updateTime: d.updateTime } })),
    ...backup.records.map(r => ({ update: { name: `${DEV_BILLING}${r.id}`, fields: r.fields } })),
  ];
  line(`\n${DEV} now: ${dev.length} records (${copiesOnDev.length} copies). Backup of ${backup.takenAt}: ${backup.records.length} records.`);
  line(`Plan: write back ${backup.records.length} · delete copies not in the backup ${writes.length - backup.records.length}`);
  if (WRITE) {
    await commitDev(writes);
    const after = await devFor();
    line(`\nRESTORED: ${DEV} has ${after.dev.length} records, ${after.copiesOnDev.length} copies.`);
  } else line(`\nDRY RUN: nothing written.`);
  process.exit(0);
}

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
  blockers.push(`${shared.badTitles.length} line titles in an unknown format, e.g. ${[...new Set(shared.badTitles.map(strictMask))].slice(0, 5).map(s => JSON.stringify(s)).join(" ")}`);
}
if (copyTotal !== sourceTotal) blockers.push("copy totals differ from the source");

if (FROM === DEV) {
  line(`\nSource is ${DEV} itself (pipeline test): no dev-side plan.`);
} else {
  const { dev, ownOnDev } = await devFor();
  const devById = new Map(dev.map(d => [d.id, d]));
  const prodIds = new Set(source.map(d => d.id));
  const writes = [];
  const n = { created: 0, refreshed: 0, replaced: 0, deletedOwn: 0, stale: 0, skipped: 0 };
  for (const c of copies) {
    const existing = devById.get(c.id);
    const update = { name: `${DEV_BILLING}${c.id}`, fields: c.fields };
    if (!existing) { writes.push({ update, currentDocument: { exists: false } }); n.created++; }
    else if (existing.fields[TAG]) { writes.push({ update, currentDocument: { updateTime: existing.updateTime } }); n.refreshed++; }
    else if (REPLACE) { writes.push({ update, currentDocument: { updateTime: existing.updateTime } }); n.replaced++; }
    else n.skipped++;
  }
  for (const d of dev) {
    if (prodIds.has(d.id)) continue;
    if (d.fields[TAG]) { writes.push({ delete: `${DEV_BILLING}${d.id}`, currentDocument: { updateTime: d.updateTime } }); n.stale++; }
    else if (REPLACE) { writes.push({ delete: `${DEV_BILLING}${d.id}`, currentDocument: { updateTime: d.updateTime } }); n.deletedOwn++; }
  }

  line(`\n## ${DEV} now: ${dev.length} billing records (${ownOnDev.length} dev's own, ${dev.length - ownOnDev.length} copies)`);
  line(`Plan: create ${n.created} · refresh copies ${n.refreshed} · delete stale copies ${n.stale}` +
    (REPLACE ? ` · replace dev's own ${n.replaced} · delete dev's own ${n.deletedOwn} (all ${ownOnDev.length} saved to --backup first)`
             : ` · dev's own records left alone, ${n.skipped} copies skipped on id collision (see --replace)`));

  if (WRITE) {
    if (blockers.length) fail(`\nNOT WRITTEN:\n  - ${blockers.join("\n  - ")}`);
    if (REPLACE && ownOnDev.length) {
      writeFileSync(BACKUP, JSON.stringify({ project: DEV, collection: "_apps/arcoiris/billing", takenAt: new Date().toISOString(),
        records: ownOnDev.map(d => ({ id: d.id, updateTime: d.updateTime, fields: d.fields })) }));
      if (JSON.parse(readFileSync(BACKUP, "utf8")).records.length !== ownOnDev.length) fail(`Backup ${BACKUP} didn't read back: nothing written.`);
      line(`\nBackup: ${ownOnDev.length} dev records saved to ${BACKUP}`);
    }
    await commitDev(writes);
    const after = await devFor();
    const afterTotal = after.copiesOnDev.reduce((a, d) => a + cents(d.fields.total), 0);
    const ok = after.copiesOnDev.length === source.length && afterTotal === sourceTotal;
    line(`\nWRITTEN to ${DEV}: ${JSON.stringify(n)}`);
    line(`Check: ${DEV} has ${after.dev.length} records, ${after.copiesOnDev.length} copies totalling ${eur(afterTotal)} ${ok ? "= prod ✓" : "!! DIFFERS FROM PROD"}`);
    if (!ok) process.exit(1);
  }
}

if (blockers.length) line(`\nBLOCKERS (a --write would refuse):\n  - ${blockers.join("\n  - ")}`);
if (!WRITE) line(`\nDRY RUN: nothing written.`);
