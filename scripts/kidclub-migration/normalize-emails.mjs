#!/usr/bin/env node
/**
 * Lowercase every stored email, and repair links that a mixed-case address broke.
 *
 * A parent's account is joined to their subscriptions purely by email — there is
 * no other key — and Firestore's `==` is case-sensitive. One capital letter is
 * enough to hide a family's entire enrolment from them while the admin list
 * still shows it normally. That is not hypothetical: "Leonor Lago" was stored as
 * "Teresasplazevedo@gmail.com" against an account of "teresasplazevedo@...", and
 * the mother saw no subscription at all.
 *
 * The application fix (normalizeEmail() on every read and write) stops new rows
 * drifting, but cannot repair rows already stored with capitals. This does that.
 *
 * Deliberately separate from identity.mjs: that script owns the Phase 0 identity
 * migration, and this is a narrow, independently reviewable pass that has to run
 * against dev and prod on its own schedule.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed, and --apply
 * is refused against production unless --i-know-this-is-prod is also given.
 *
 *   node normalize-emails.mjs --project kidclub-dev
 *   node normalize-emails.mjs --project kidclub-dev --apply
 *
 * Auth: uses `gcloud auth print-access-token` against the Firestore REST API —
 * no service-account key on disk, matching the org policy that blocks SA keys.
 */

import { execSync } from "node:child_process";

const PROD = "rainbow-prod-2454b";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const PROJECT = opt("--project", PROD);
const APPLY = flag("--apply");
const PROD_OK = flag("--i-know-this-is-prod");

if (APPLY && PROJECT === PROD && !PROD_OK) {
  console.error("Refusing to write to production without --i-know-this-is-prod.");
  process.exit(1);
}

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ROOT = `${BASE}/_apps/arcoiris`;

/**
 * Subscriptions whose childId cannot be recovered by any heuristic, because the
 * name on the subscription and the name on the child document are genuinely
 * different people-names rather than spelling variants.
 *
 * "Leonor Lago" is the child's informal name (Lago is the mother's surname);
 * the child document in that same family reads "Maria Leonor De Sá Azevedo
 * Magalhães costa". No normalisation matches those, and identity.mjs does not
 * cover this shape — it handles children with NO familyId, and subs pointing at
 * DUPLICATE children; this sub has a valid familyId and a null childId.
 *
 * The subscription's childName is deliberately left as the mother entered it.
 * Verified against kidclub-dev on 2026-09-24; ids confirmed before adding.
 */
const MANUAL_CHILD_LINKS = [
  {
    collection: "transportationSubscriptions",
    id: "obEzm5E4Jntp9tEHGM8k",
    childName: "Leonor Lago",
    familyId: "oK6GHA7D0f4cRVM3RNZW",
    childId: "7qetdunyiFAEgWbebEFp",
    userId: "GDcSI7vF3wPCqU9GDaEJ5UpYpX73",
  },
];

const norm = (s) => (s ?? "").toString().trim().toLowerCase();

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

async function listAll(collection) {
  const res = await fetch(`${ROOT}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }] } }),
  });
  if (!res.ok) throw new Error(`${collection}: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.filter(r => r.document).map(r => ({
    id: r.document.name.split("/").pop(),
    ...Object.fromEntries(Object.entries(r.document.fields ?? {}).map(([k, v]) => [k, decode(v)])),
  }));
}

async function patch(collection, id, fields) {
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const res = await fetch(`${ROOT}/${collection}/${id}?${mask}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`patch ${collection}/${id}: ${res.status} ${await res.text()}`);
}

// ── gather ───────────────────────────────────────────────────────────────────
const [families, study, transport] = await Promise.all(
  ["families", "studyroom", "transportationSubscriptions"].map(listAll)
);

const emailFixes = [];

for (const f of families) {
  const pc = f.primaryContact ?? {};
  if (pc.email && pc.email !== norm(pc.email)) {
    emailFixes.push({ col: "families", id: f.id, field: "primaryContact.email",
      who: pc.name ?? f.id, from: pc.email, to: norm(pc.email) });
  }
}
for (const [col, subs] of [["studyroom", study], ["transportationSubscriptions", transport]]) {
  for (const s of subs) {
    for (const field of ["contactEmail", "email"]) {
      const v = s[field];
      if (v && v !== norm(v)) {
        emailFixes.push({ col, id: s.id, field, who: s.childName ?? s.id, from: v, to: norm(v) });
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const line = (s = "") => console.log(s);
line("=".repeat(78));
line(`normalize-emails.mjs — project ${PROJECT}`);
line("=".repeat(78));

line(`\n## 1. Emails not in canonical form (${emailFixes.length})\n`);
if (!emailFixes.length) line("  none — every stored email is already lowercase.");
for (const e of emailFixes) {
  line(`  ${e.col}/${e.id}  ${e.who}`);
  line(`      ${e.field}: ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`);
}

line(`\n## 2. Manual child links (${MANUAL_CHILD_LINKS.length})\n`);
const linkPlan = [];
for (const m of MANUAL_CHILD_LINKS) {
  const all = m.collection === "studyroom" ? study : transport;
  const sub = all.find(s => s.id === m.id);
  if (!sub) { line(`  SKIP ${m.collection}/${m.id} (${m.childName}) — not found in ${PROJECT}`); continue; }
  const sets = {};
  if (!sub.childId) sets.childId = m.childId;
  if (!sub.userId) sets.userId = m.userId;
  if (sub.familyId !== m.familyId) {
    line(`  SKIP ${m.collection}/${m.id} (${m.childName}) — familyId is ${JSON.stringify(sub.familyId)}, expected ${JSON.stringify(m.familyId)}`);
    continue;
  }
  if (!Object.keys(sets).length) { line(`  OK   ${m.collection}/${m.id} (${m.childName}) — already linked`); continue; }
  line(`  ${m.collection}/${m.id}  ${m.childName}`);
  for (const [k, v] of Object.entries(sets)) line(`      ${k}: null -> ${v}`);
  linkPlan.push({ ...m, sets });
}

const total = emailFixes.length + linkPlan.length;
line(`\n${"=".repeat(78)}`);
line(`TOTAL DOCUMENT WRITES THIS WOULD MAKE: ${total}`);
line(APPLY ? "MODE: APPLY — writes will be performed." : "MODE: DRY RUN — nothing written.");
line("=".repeat(78) + "\n");

if (!APPLY || !total) process.exit(0);

// ── apply ────────────────────────────────────────────────────────────────────
let done = 0;
for (const e of emailFixes) {
  if (e.field === "primaryContact.email") {
    const fam = families.find(f => f.id === e.id);
    const pc = { ...(fam.primaryContact ?? {}), email: e.to };
    await patch("families", e.id, {
      primaryContact: { mapValue: { fields: Object.fromEntries(
        Object.entries(pc).map(([k, v]) => [k, v == null ? { nullValue: null } : { stringValue: String(v) }])) } },
    });
  } else {
    await patch(e.col, e.id, { [e.field]: { stringValue: e.to } });
  }
  done++;
  console.log(`  wrote ${e.col}/${e.id} ${e.field}`);
}
for (const l of linkPlan) {
  await patch(l.collection, l.id, Object.fromEntries(
    Object.entries(l.sets).map(([k, v]) => [k, { stringValue: v }])));
  done++;
  console.log(`  wrote ${l.collection}/${l.id} ${Object.keys(l.sets).join(", ")}`);
}
console.log(`\nDone — ${done} document(s) written.\n`);
