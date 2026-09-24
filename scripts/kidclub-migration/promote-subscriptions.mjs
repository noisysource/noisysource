#!/usr/bin/env node
/**
 * Promote the reconciled subscription data from kidclub-dev to production.
 *
 * THE RULE (Renato, 2026-09-24):
 *   dev  is the source of truth for SUBSCRIPTION CONTENT — days, schedule,
 *        times, weekPattern, prices, discounts, status.
 *   prod is the source of truth for IDENTITY — familyId, childId, userId and
 *        the contact email that links a parent's account to their subs.
 *
 * That split is not cosmetic. dev and prod are separate Firebase projects, so a
 * Firebase Auth uid taken from dev is meaningless in prod, and overwriting a
 * prod userId with a dev one would silently detach a family from their own
 * subscriptions — the exact failure that hid Leonor Lago's subscription from her
 * mother. So this script NEVER writes an identity field. It only carries across
 * the schedule/price content that the September reconciliation corrected.
 *
 * Deletions are reported but NOT performed. Dev had 10 synthetic test records
 * removed; whether the same ids are junk in prod is a judgement call, not
 * something to infer from absence.
 *
 * DRY RUN BY DEFAULT.
 *
 *   node promote-subscriptions.mjs                       # dry run, dev -> prod
 *   node promote-subscriptions.mjs --apply --i-know-this-is-prod
 *
 * Auth: `gcloud auth print-access-token`, needs read on dev AND read/write on
 * prod. Per CLAUDE.md prod access is opt-in — add firestore-prod to your own
 * gitignored .claude/settings.local.json for the session, and remove it after.
 */

import { execSync } from "node:child_process";

const DEV = "kidclub-dev";
const PROD = "rainbow-prod-2454b";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const FROM = opt("--from", DEV);
const TO = opt("--to", PROD);
const APPLY = flag("--apply");
const PROD_OK = flag("--i-know-this-is-prod");

if (APPLY && TO === PROD && !PROD_OK) {
  console.error("Refusing to write to production without --i-know-this-is-prod.");
  process.exit(1);
}

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const root = (p) => `https://firestore.googleapis.com/v1/projects/${p}/databases/(default)/documents/_apps/arcoiris`;

/** Carried from dev. Everything not listed here is left exactly as prod has it. */
const CONTENT_FIELDS = {
  studyroom: ["days", "weekPattern", "status", "monthlyPrice", "basePrice", "appliedDiscounts", "schoolName", "schoolYear"],
  transportationSubscriptions: ["schedule", "weekPattern", "status", "monthlyFee", "originalFee", "appliedDiscounts", "schoolName"],
};
/** Never written, whatever dev says. Listed explicitly so the intent is auditable. */
const IDENTITY_FIELDS = ["familyId", "childId", "userId", "contactEmail", "email", "contactMobile", "contactPhone", "contactName", "guardianName"];

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
function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
  return { stringValue: String(v) };
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
    ...Object.fromEntries(Object.entries(r.document.fields ?? {}).map(([k, v]) => [k, decode(v)])),
  }));
}

async function patch(project, collection, id, fields) {
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const res = await fetch(`${root(project)}/${collection}/${id}?${mask}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encode(v)])) }),
  });
  if (!res.ok) throw new Error(`patch ${collection}/${id}: ${res.status} ${await res.text()}`);
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const line = (s = "") => console.log(s);

line("=".repeat(78));
line(`promote-subscriptions.mjs   ${FROM}  ->  ${TO}`);
line("content from dev · identity preserved from prod · deletions reported only");
line("=".repeat(78));

let writes = 0;
const plan = [];

for (const collection of Object.keys(CONTENT_FIELDS)) {
  const [devDocs, prodDocs] = await Promise.all([listAll(FROM, collection), listAll(TO, collection)]);
  const prodById = new Map(prodDocs.map(d => [d.id, d]));
  const devById = new Map(devDocs.map(d => [d.id, d]));

  const updates = [], onlyDev = [], onlyProd = [];

  for (const dev of devDocs) {
    if (dev.isTestData) continue;
    const prod = prodById.get(dev.id);
    if (!prod) { onlyDev.push(dev); continue; }
    const diff = {};
    for (const f of CONTENT_FIELDS[collection]) {
      if (dev[f] !== undefined && !same(dev[f], prod[f])) diff[f] = { from: prod[f], to: dev[f] };
    }
    if (Object.keys(diff).length) updates.push({ dev, prod, diff });
  }
  for (const prod of prodDocs) if (!devById.has(prod.id)) onlyProd.push(prod);

  line(`\n## ${collection}`);
  line(`   dev ${devDocs.length} · prod ${prodDocs.length} · to update ${updates.length} · only-in-dev ${onlyDev.length} · only-in-prod ${onlyProd.length}\n`);

  for (const u of updates) {
    line(`  ${u.prod.id}  ${u.prod.childName ?? "?"}`);
    for (const [f, { from, to }] of Object.entries(u.diff)) {
      const short = (v) => { const s = JSON.stringify(v); return s && s.length > 96 ? s.slice(0, 93) + "..." : s; };
      line(`      ${f}: ${short(from)}`);
      line(`      ${" ".repeat(f.length)}  -> ${short(to)}`);
    }
    writes++;
  }
  if (onlyDev.length) {
    line(`\n  -- in dev, absent from prod (NOT created; check each by hand) --`);
    for (const d of onlyDev) line(`     ${d.id}  ${d.childName ?? "?"}  status=${d.status}`);
  }
  if (onlyProd.length) {
    line(`\n  -- in prod, absent from dev (NOT deleted; dev deletions are not replayed) --`);
    for (const d of onlyProd) line(`     ${d.id}  ${d.childName ?? "?"}  status=${d.status}`);
  }
  plan.push({ collection, updates });
}

line(`\n${"=".repeat(78)}`);
line(`TOTAL DOCUMENT WRITES THIS WOULD MAKE: ${writes}`);
line(`identity fields never written: ${IDENTITY_FIELDS.join(", ")}`);
line(APPLY ? "MODE: APPLY — writes will be performed." : "MODE: DRY RUN — nothing written.");
line("=".repeat(78) + "\n");

if (!APPLY || !writes) process.exit(0);

let done = 0;
for (const { collection, updates } of plan) {
  for (const u of updates) {
    const fields = Object.fromEntries(Object.entries(u.diff).map(([f, { to }]) => [f, to]));
    for (const f of IDENTITY_FIELDS) delete fields[f];   // belt and braces
    if (!Object.keys(fields).length) continue;
    await patch(TO, collection, u.prod.id, fields);
    done++;
    console.log(`  wrote ${collection}/${u.prod.id}  ${Object.keys(fields).join(", ")}`);
  }
}
console.log(`\nDone — ${done} document(s) written to ${TO}.\n`);
