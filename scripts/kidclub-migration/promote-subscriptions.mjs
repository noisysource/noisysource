#!/usr/bin/env node
/**
 * Promote the reconciled subscription data from kidclub-dev to production.
 *
 * THE RULE (Renato, 2026-09-24, refined 2026-09-27):
 *   dev  is the source of truth for everything on a subscription — days,
 *        schedule, times, weekPattern, status, dates, prices, discounts and
 *        discount overrides — EXCEPT:
 *   prod keeps IDENTITY — familyId, childId, userId and the contact fields
 *        that link a parent's account to their subs. dev and prod are separate
 *        Firebase projects, so a dev Auth uid is meaningless in prod, and
 *        overwriting a prod userId would silently detach a family from their
 *        own subscriptions (the failure that hid Leonor Lago's sub).
 *   prod keeps BILLING STATE — `enrollmentFeeBilled`. It means "the fee is on a
 *        billing record", and billing records never travel: dev's flag points
 *        at dev's records. Copied across, prod would believe the fee is billed
 *        when no prod record carries it, and the family would never be charged.
 *        Only fees actually paid in prod count as paid.
 *   prod keeps any field dev does NOT have. A field dev lacks is not an
 *        instruction to remove it.
 *
 * Billing records are never touched here — paid/invoiced stay exactly as they are.
 *
 * Values are written as dev's RAW Firestore values, never decoded and
 * re-encoded, so a timestamp stays a timestamp (startDate, endDate, appliedAt).
 *
 * Deletions happen only for ids named explicitly with --delete, and only if the
 * id exists in prod and NOT in dev. Deleting sends no email; cancelling a
 * pending sub would send the parent a rejection email.
 *
 * DRY RUN BY DEFAULT.
 *
 *   node promote-subscriptions.mjs                               # dry run, dev -> prod
 *   node promote-subscriptions.mjs --json plan.json              # + full old/new values: the undo record
 *   node promote-subscriptions.mjs --delete id1,id2              # dry run incl. deletions
 *   node promote-subscriptions.mjs --apply --i-know-this-is-prod [--delete ...] [--json ...]
 *
 * Auth: `gcloud auth print-access-token`, needs read on dev AND read/write on
 * prod. Per CLAUDE.md prod access is opt-in — add firestore-prod to your own
 * gitignored .claude/settings.local.json for the session, and remove it after.
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const DEV = "kidclub-dev";
const PROD = "rainbow-prod-2454b";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const FROM = opt("--from", DEV);
const TO = opt("--to", PROD);
const APPLY = flag("--apply");
const PROD_OK = flag("--i-know-this-is-prod");
const JSON_OUT = opt("--json", null);
const DELETE_IDS = new Set((opt("--delete", "") || "").split(",").map(s => s.trim()).filter(Boolean));

if (APPLY && TO === PROD && !PROD_OK) {
  console.error("Refusing to write to production without --i-know-this-is-prod.");
  process.exit(1);
}
if (FROM === TO) {
  console.error(`--from and --to are both ${FROM}.`);
  process.exit(1);
}

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const root = (p) => `https://firestore.googleapis.com/v1/projects/${p}/databases/(default)/documents/_apps/arcoiris`;

const COLLECTIONS = ["studyroom", "transportationSubscriptions"];
/** Never written, whatever dev says. Listed explicitly so the intent is auditable. */
const IDENTITY_FIELDS = ["familyId", "childId", "userId", "contactEmail", "email", "contactMobile", "contactPhone", "contactName", "guardianName"];
/** Billing state that refers to billing records, which never travel. */
const PROD_OWNED_FIELDS = ["enrollmentFeeBilled"];
/** Bookkeeping, not content. */
const IGNORED_FIELDS = ["createdAt", "updatedAt", "isTestData"];
const NOT_FROM_DEV = new Set([...IDENTITY_FIELDS, ...PROD_OWNED_FIELDS, ...IGNORED_FIELDS]);

/** pending -> these statuses queues a real "approved"/"rejected" email to the parent (notifications.ts). */
const EMAILING = { active: "APPROVAL", confirmed: "APPROVAL", cancelled: "REJECTION" };

function decode(f) {
  if (f == null) return null;
  const k = Object.keys(f)[0], x = f[k];
  switch (k) {
    case "arrayValue": return (x.values ?? []).map(decode);
    case "mapValue": return Object.fromEntries(Object.entries(x.fields ?? {}).map(([a, b]) => [a, decode(b)]));
    case "integerValue": return Number(x);
    case "doubleValue": return x;
    case "booleanValue": return x;
    case "nullValue": return null;
    default: return x;
  }
}

async function listAll(project, collection) {
  const res = await fetch(`${root(project)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }] } }),
  });
  if (!res.ok) throw new Error(`${project}/${collection}: ${res.status} ${await res.text()}`);
  return (await res.json()).filter(r => r.document).map(r => ({
    id: r.document.name.split("/").pop(),
    raw: r.document.fields ?? {},
    data: Object.fromEntries(Object.entries(r.document.fields ?? {}).map(([k, v]) => [k, decode(v)])),
  }));
}

/** `set` holds raw Firestore values. Only fields in the mask are touched; everything else on the prod doc stays. */
async function patch(project, collection, id, set) {
  const mask = Object.keys(set).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const res = await fetch(`${root(project)}/${collection}/${id}?${mask}&currentDocument.exists=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: set }),
  });
  if (!res.ok) throw new Error(`patch ${collection}/${id}: ${res.status} ${await res.text()}`);
}

async function remove(project, collection, id) {
  const res = await fetch(`${root(project)}/${collection}/${id}?currentDocument.exists=true`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`delete ${collection}/${id}: ${res.status} ${await res.text()}`);
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const short = (v) => { const s = JSON.stringify(v); return s && s.length > 96 ? s.slice(0, 93) + "..." : s; };
const line = (s = "") => console.log(s);

line("=".repeat(78));
line(`promote-subscriptions.mjs   ${FROM}  ->  ${TO}`);
line("dev wins on every field it has · prod keeps identity, enrollmentFeeBilled, and fields dev lacks");
line("=".repeat(78));

let writes = 0;
const plan = [];
const deletions = [];
const unknownDeletes = new Set(DELETE_IDS);

for (const collection of COLLECTIONS) {
  const [devDocs, prodDocs] = await Promise.all([listAll(FROM, collection), listAll(TO, collection)]);
  const prodById = new Map(prodDocs.map(d => [d.id, d]));
  const devById = new Map(devDocs.map(d => [d.id, d]));
  const devLive = devDocs.filter(d => !d.data.isTestData);

  const updates = [], onlyDev = [], onlyProd = [];

  for (const dev of devLive) {
    const prod = prodById.get(dev.id);
    if (!prod) { onlyDev.push(dev); continue; }
    const diff = {};
    for (const f of Object.keys(dev.raw)) {
      if (NOT_FROM_DEV.has(f)) continue;
      if (!same(dev.data[f], prod.data[f])) diff[f] = { from: prod.data[f], to: dev.data[f], raw: dev.raw[f] };
    }
    if (Object.keys(diff).length) updates.push({ dev, prod, diff });
  }
  for (const prod of prodDocs) if (!devById.has(prod.id)) onlyProd.push(prod);

  line(`\n## ${collection}`);
  line(`   dev ${devLive.length} (+${devDocs.length - devLive.length} test, skipped) · prod ${prodDocs.length} · to update ${updates.length} · only-in-dev ${onlyDev.length} · only-in-prod ${onlyProd.length}\n`);

  for (const u of updates) {
    line(`  ${u.prod.id}  ${u.prod.data.childName ?? "?"}  [${u.prod.data.status}]`);
    for (const [f, { from, to }] of Object.entries(u.diff)) {
      line(`      ${f}: ${short(from)}`);
      line(`      ${" ".repeat(f.length)}  -> ${short(to)}`);
    }
    const st = u.diff.status;
    if (st && st.from === "pending" && EMAILING[st.to]) line(`      !! pending -> ${st.to} queues an ${EMAILING[st.to]} email to the parent (dropped if emailsEnabled=false)`);
    writes++;
  }
  if (onlyDev.length) {
    line(`\n  -- in dev, absent from prod (NOT created; check each by hand) --`);
    for (const d of onlyDev) line(`     ${d.id}  ${d.data.childName ?? "?"}  status=${d.data.status}`);
  }
  if (onlyProd.length) {
    line(`\n  -- in prod, absent from dev --`);
    for (const d of onlyProd) {
      const del = DELETE_IDS.has(d.id);
      if (del) { deletions.push({ collection, id: d.id, childName: d.data.childName ?? null, status: d.data.status ?? null, before: d.data }); unknownDeletes.delete(d.id); }
      line(`     ${d.id}  ${d.data.childName ?? "?"}  status=${d.data.status}  ${del ? "-> DELETE (named in --delete)" : "(kept; name it in --delete to remove)"}`);
    }
  }
  plan.push({ collection, updates });
}

if (unknownDeletes.size) {
  console.error(`\n--delete names ids that are not prod-only subscriptions: ${[...unknownDeletes].join(", ")}. Nothing done.`);
  process.exit(1);
}

line(`\n${"=".repeat(78)}`);
line(`DOCUMENT UPDATES: ${writes}   DELETIONS: ${deletions.length}`);
line(`never written from dev: ${[...NOT_FROM_DEV].join(", ")}`);
line(APPLY ? "MODE: APPLY — writes will be performed." : "MODE: DRY RUN — nothing written.");
line("=".repeat(78) + "\n");

if (JSON_OUT) {
  const out = {
    from: FROM, to: TO, at: new Date().toISOString(),
    updates: plan.flatMap(({ collection, updates }) => updates.map(u => ({
      collection, id: u.prod.id, childName: u.prod.data.childName ?? null,
      fields: Object.fromEntries(Object.entries(u.diff).map(([f, { from, to }]) => [f, { from: from ?? null, to }])),
      prodRawBefore: Object.fromEntries(Object.keys(u.diff).map(f => [f, u.prod.raw[f] ?? null])),
    }))),
    deletions,
  };
  writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
  line(`full plan (untruncated old and new values, raw prod values for undo) written to ${JSON_OUT}\n`);
}

if (!APPLY || (!writes && !deletions.length)) process.exit(0);

let done = 0;
for (const { collection, updates } of plan) {
  for (const u of updates) {
    const set = Object.fromEntries(Object.entries(u.diff)
      .filter(([f]) => !NOT_FROM_DEV.has(f))                       // belt and braces
      .map(([f, d]) => [f, d.raw]));
    if (!Object.keys(set).length) continue;
    await patch(TO, collection, u.prod.id, set);
    done++;
    console.log(`  wrote ${collection}/${u.prod.id}  ${Object.keys(set).join(", ")}`);
  }
}
for (const d of deletions) {
  await remove(TO, d.collection, d.id);
  console.log(`  deleted ${d.collection}/${d.id}  ${d.childName ?? ""}`);
}
console.log(`\nDone — ${done} document(s) updated, ${deletions.length} deleted in ${TO}.\n`);
