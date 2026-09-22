#!/usr/bin/env node
/**
 * KidClub identity consolidation — Phase 0 of the prod data migration.
 *
 * Subscriptions, children and families drifted apart over time: the same child
 * exists as several `children` docs, several active subscriptions carry no
 * `familyId` at all, and personal data (schoolName, contactEmail, schoolYear)
 * is copied onto subscription docs where it diverges from the canonical record.
 *
 * This matters *before* ReservationEvents are generated, not after: every
 * generated event freezes `familyId` and `childId` into its own document, so
 * generating against today's fragmented identity bakes the wrong links into
 * thousands of rows. Repairing ~50 documents now is the cheap version of the
 * same job.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed, and --apply
 * is refused against production unless --i-know-this-is-prod is also given.
 *
 *   node identity.mjs                      # dry run against prod (read-only)
 *   node identity.mjs --project kidclub-dev
 *   node identity.mjs --project kidclub-dev --apply
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

// ── Firestore REST value coercion ───────────────────────────────────────────
function decode(f) {
  if (f == null) return null;
  const k = Object.keys(f)[0], x = f[k];
  switch (k) {
    case "arrayValue": return (x.values ?? []).map(decode);
    case "mapValue": return Object.fromEntries(Object.entries(x.fields ?? {}).map(([a, b]) => [a, decode(b)]));
    case "integerValue": return Number(x);
    case "doubleValue": return x;
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
    ...Object.fromEntries(Object.entries(r.document.fields ?? {}).map(([a, b]) => [a, decode(b)])),
  }));
}

const norm = (s) => (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
const childKey = (c) => norm(`${c.firstName ?? ""} ${c.lastName ?? ""}`);
const isoDay = (d) => (d ?? "").toString().slice(0, 10);

// Exact-name grouping misses real duplicates: "Mafalda Raposo Duarte" and
// "Mafalda Duarte" are the same child with a middle name dropped. These are
// reported for a human to confirm, never merged automatically — several
// duplicates carry a placeholder date of birth (a Jan-1 default), so a
// differing dob is not evidence they're different people, but it is enough
// reason not to merge them unattended.
function similarity(a, b) {
  if (a === b) return 1;
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / Math.max(A.size, B.size);
}
function fuzzyCandidates(children, exactKeys) {
  const out = [];
  for (let i = 0; i < children.length; i++) {
    for (let j = i + 1; j < children.length; j++) {
      const a = children[i], b = children[j];
      const ka = childKey(a), kb = childKey(b);
      if (!ka || !kb || ka === kb) continue;        // exact pairs handled elsewhere
      // 0.6 requires more than a shared first name: "Mafalda Raposo Duarte" vs
      // "Mafalda Duarte" scores 0.67 and is flagged, while "Maria Vicente" vs
      // "Maria Manon" scores 0.5 and is correctly left alone.
      if (similarity(ka, kb) < 0.6) continue;
      out.push({ a, b, score: similarity(ka, kb), dobMatches: isoDay(a.dateOfBirth) === isoDay(b.dateOfBirth) });
    }
  }
  return out;
}

// How "complete" a child record is — used to pick the survivor of a merge.
// familyId is weighted heavily: a record already linked to a family carries the
// billing relationship, which is the expensive thing to rebuild.
const CHILD_FIELDS = ["firstName", "lastName", "dateOfBirth", "age", "schoolYear",
  "schoolName", "homeAddress", "userId", "contactEmail", "contactPhone", "status"];
function completeness(c) {
  let score = CHILD_FIELDS.reduce((n, f) => n + (c[f] ? 1 : 0), 0);
  if (c.familyId) score += 5;
  return score;
}

function main(data) {
  const { families, children, study, transport } = data;
  const activeStudy = study.filter(s => ["active", "confirmed"].includes(s.status));
  const activeTransport = transport.filter(s => s.status === "active");
  const allSubs = [
    ...activeStudy.map(s => ({ ...s, _col: "studyroom" })),
    ...activeTransport.map(s => ({ ...s, _col: "transportationSubscriptions" })),
  ];

  const plan = { mergeChildren: [], createFamilies: [], linkSubs: [], linkChildren: [], needsDecision: [] };

  // ── 1. Duplicate children ────────────────────────────────────────────────
  const byName = new Map();
  for (const c of children) {
    const k = childKey(c);
    if (!k) continue;
    byName.set(k, [...(byName.get(k) ?? []), c]);
  }
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => completeness(b) - completeness(a));
    const survivor = ranked[0];
    const losers = ranked.slice(1);
    plan.mergeChildren.push({
      name, survivor, losers,
      // Fields the survivor lacks but a loser has — merged up, so "keep the most
      // complete" doesn't silently discard data held only on a duplicate.
      salvage: Object.fromEntries(
        CHILD_FIELDS.concat("familyId")
          .filter(f => !survivor[f] && losers.some(l => l[f]))
          .map(f => [f, losers.find(l => l[f])[f]])
      ),
      repoint: allSubs.filter(s => losers.some(l => l.id === s.childId))
        .map(s => ({ col: s._col, id: s.id, childName: s.childName, from: s.childId, to: survivor.id })),
    });
  }

  plan.needsDecision = fuzzyCandidates(children).map(f => ({
    ...f,
    subsA: allSubs.filter(s => s.childId === f.a.id).map(s => `${s._col}/${s.id}`),
    subsB: allSubs.filter(s => s.childId === f.b.id).map(s => `${s._col}/${s.id}`),
  }));

  // ── 2. Orphan subscriptions → families, keyed by contactEmail ────────────
  const famByEmail = new Map();
  for (const f of families) {
    const e = norm(f.primaryContact?.email ?? f.email);
    if (e) famByEmail.set(e, f);
  }
  const orphans = allSubs.filter(s => !s.familyId);
  const byEmail = new Map();
  for (const s of orphans) {
    const e = norm(s.contactEmail);
    byEmail.set(e || `(no-email:${s.id})`, [...(byEmail.get(e || `(no-email:${s.id})`) ?? []), s]);
  }
  for (const [email, subs] of byEmail) {
    const existing = famByEmail.get(email);
    // Child names on the subs tell us which children belong to this family.
    const names = [...new Set(subs.map(s => norm(s.childName)).filter(Boolean))];
    const matchedChildren = names.map(n => {
      const g = byName.get(n) ?? [];
      const merge = plan.mergeChildren.find(m => m.name === n);
      return { name: n, resolvedId: merge ? merge.survivor.id : g[0]?.id ?? null, candidates: g.length };
    });
    if (existing) {
      plan.linkSubs.push({ email, familyId: existing.id, existing: true, subs, matchedChildren });
    } else {
      plan.createFamilies.push({
        email,
        primaryContact: { name: subs[0].parentName ?? null, email: subs[0].contactEmail ?? null,
                          phone: subs[0].contactPhone ?? null },
        subs, matchedChildren,
      });
    }
  }

  // ── 3. Children with no familyId ─────────────────────────────────────────
  for (const c of children) {
    if (c.familyId) continue;
    const merge = plan.mergeChildren.find(m => m.losers.some(l => l.id === c.id));
    if (merge) continue; // handled by the merge
    const sub = allSubs.find(s => norm(s.childName) === childKey(c));
    plan.linkChildren.push({ child: c, viaSub: sub?.id ?? null, email: sub?.contactEmail ?? null });
  }

  return plan;
}

function report(plan) {
  const line = (s = "") => console.log(s);
  line(`\n${"=".repeat(78)}`);
  line(`IDENTITY CONSOLIDATION — ${APPLY ? "APPLY" : "DRY RUN"} — project: ${PROJECT}`);
  line("=".repeat(78));

  line(`\n## 1. Duplicate children to merge (${plan.mergeChildren.length})\n`);
  for (const m of plan.mergeChildren) {
    line(`  ${m.name}`);
    line(`    KEEP   ${m.survivor.id}  (score ${completeness(m.survivor)}, familyId=${m.survivor.familyId || "none"}, school=${m.survivor.schoolName || "none"})`);
    for (const l of m.losers)
      line(`    MERGE  ${l.id}  (score ${completeness(l)}, familyId=${l.familyId || "none"}, school=${l.schoolName || "none"})`);
    if (Object.keys(m.salvage).length) line(`    SALVAGE onto survivor: ${JSON.stringify(m.salvage)}`);
    for (const r of m.repoint)
      line(`    REPOINT ${r.col}/${r.id} (${r.childName}) childId ${r.from} -> ${r.to}`);
    line();
  }

  line(`## 1b. NEEDS A HUMAN DECISION — possible duplicates, NOT merged (${plan.needsDecision.length})\n`);
  for (const f of plan.needsDecision) {
    line(`  "${f.a.firstName} ${f.a.lastName}" vs "${f.b.firstName} ${f.b.lastName}"  (name overlap ${(f.score * 100).toFixed(0)}%)`);
    line(`    ${f.a.id}  fam=${f.a.familyId || "none"}  dob=${isoDay(f.a.dateOfBirth) || "?"}  school=${f.a.schoolName || "none"}  subs=[${f.subsA.join(", ") || "none"}]`);
    line(`    ${f.b.id}  fam=${f.b.familyId || "none"}  dob=${isoDay(f.b.dateOfBirth) || "?"}  school=${f.b.schoolName || "none"}  subs=[${f.subsB.join(", ") || "none"}]`);
    line(`    date of birth ${f.dobMatches ? "MATCHES" : "DIFFERS — confirm before merging"}`);
    line();
  }

  line(`## 2. Families to create (${plan.createFamilies.length})\n`);
  for (const f of plan.createFamilies) {
    line(`  ${f.email}`);
    line(`    primaryContact: ${JSON.stringify(f.primaryContact)}`);
    line(`    profileComplete: false   (NIF / billing address / payment method still missing)`);
    for (const s of f.subs) line(`    LINK ${s._col}/${s.id}  ${s.childName}`);
    for (const c of f.matchedChildren)
      line(`    CHILD ${c.name} -> ${c.resolvedId ?? "NO CHILD RECORD — would be created"} (${c.candidates} candidate(s))`);
    line();
  }

  if (plan.linkSubs.length) {
    line(`## 2b. Orphan subs matching an EXISTING family (${plan.linkSubs.length})\n`);
    for (const l of plan.linkSubs) {
      line(`  ${l.email} -> family ${l.familyId}`);
      for (const s of l.subs) line(`    LINK ${s._col}/${s.id}  ${s.childName}`);
      line();
    }
  }

  line(`## 3. Children with no familyId, not covered by a merge (${plan.linkChildren.length})\n`);
  for (const c of plan.linkChildren)
    line(`  ${c.child.id}  ${c.child.firstName} ${c.child.lastName}  via sub ${c.viaSub ?? "NONE FOUND"}  (${c.email ?? "no email"})`);

  const writes = plan.mergeChildren.reduce((n, m) => n + m.losers.length + m.repoint.length + (Object.keys(m.salvage).length ? 1 : 0), 0)
    + plan.createFamilies.reduce((n, f) => n + 1 + f.subs.length, 0)
    + plan.linkSubs.reduce((n, l) => n + l.subs.length, 0)
    + plan.linkChildren.length;
  line(`\n${"=".repeat(78)}`);
  line(`TOTAL DOCUMENT WRITES THIS WOULD MAKE: ${writes}`);
  line(APPLY ? "MODE: APPLY — writes will be performed." : "MODE: DRY RUN — nothing written.");
  line("=".repeat(78) + "\n");
}

const [families, children, study, transport] = await Promise.all(
  ["families", "children", "studyroom", "transportationSubscriptions"].map(listAll)
);
const plan = main({ families, children, study, transport });
report(plan);

if (APPLY) {
  console.error("APPLY mode is not implemented yet — the dry-run plan must be reviewed and signed off first.");
  process.exit(2);
}
