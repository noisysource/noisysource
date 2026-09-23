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
 * Run this BEFORE migrate.mjs, not after. migrate.mjs refuses to generate
 * events while any active subscription still has no familyId, because every
 * generated event freezes familyId into its own document.
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
  const { families, study, transport } = data;
  // A child retired by an earlier merge is not a duplicate any more. Without
  // this filter the Mafalda pair completed on 2026-09-22 keeps being
  // re-proposed, and --apply would try to redo a merge that is already done.
  const children = data.children.filter(c => c.status !== "merged");
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
    // The subscription object itself is kept, not just its id: --apply needs
    // the familyId it ends up with, which may be one created moments earlier.
    plan.linkChildren.push({ child: c, viaSub: sub?.id ?? null, sub: sub ?? null, email: sub?.contactEmail ?? null });
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

// ── Writing ─────────────────────────────────────────────────────────────────
// Every repair here is an identity link — familyId, childId, a retired
// duplicate. NONE of it touches schedule/days/weekPattern/startDate/endDate/
// status, which is deliberate and load-bearing: those fields fire
// regenerateFutureEvents() in reservationEvents.ts, which voids and recreates
// future events and would wipe parent-recorded absences. familyId and childId
// are absent from both triggers' `scheduleChanged` check, so these writes are
// inert as far as event generation is concerned. Keep it that way.

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
  return { stringValue: String(v) };
}

async function patchDoc(collection, id, fields) {
  const mask = Object.keys(fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const res = await fetch(`${ROOT}/${collection}/${id}?${mask}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`PATCH ${collection}/${id}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** patchDoc with plain JS values rather than hand-encoded REST ones. */
const setFields = (collection, id, obj) =>
  patchDoc(collection, id, Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encode(v)])));

async function createDoc(collection, obj) {
  const res = await fetch(`${ROOT}/${collection}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encode(v)])) }),
  });
  if (!res.ok) throw new Error(`CREATE ${collection}: ${res.status} ${await res.text()}`);
  return (await res.json()).name.split("/").pop();
}

let written = 0;
const did = (msg) => { written++; console.log(`  ${APPLY ? "WROTE" : "would write"}  ${msg}`); };

/**
 * Applies the reviewed plan. Exact-name duplicate merges, orphan → family
 * links and child → family links only; the near-name pairs in section 1b are
 * never touched here, they go through --approve-merge below.
 */
async function applyPlan(plan) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(APPLY ? "APPLYING PLAN" : "APPLY PREVIEW (dry run — nothing written)");
  console.log("=".repeat(78));

  // Subscriptions that get a familyId in this run, so step 4 can resolve a
  // child's family through a subscription repaired moments earlier rather than
  // reading a stale familyId off the snapshot loaded at startup.
  const familyIdBySub = new Map();

  console.log(`\n1. Duplicate children (${plan.mergeChildren.length})`);
  for (const m of plan.mergeChildren) {
    if (Object.keys(m.salvage).length) {
      if (APPLY) await setFields("children", m.survivor.id, m.salvage);
      did(`children/${m.survivor.id} salvage ${Object.keys(m.salvage).join(", ")}`);
    }
    // Repoint before retiring: if this fails, the loser is still live and the
    // subscription still resolves to a real child record.
    for (const r of m.repoint) {
      if (APPLY) await setFields(r.col, r.id, { childId: r.to });
      did(`${r.col}/${r.id} childId ${r.from} → ${r.to}`);
    }
    for (const l of m.losers) {
      if (APPLY) await setFields("children", l.id, { status: "merged", mergedInto: m.survivor.id, mergedAt: new Date() });
      did(`children/${l.id} retired (status=merged → ${m.survivor.id}) — not deleted, reversible`);
    }
  }
  if (!plan.mergeChildren.length) console.log("  nothing to do.");

  console.log(`\n2. Families to create (${plan.createFamilies.length})`);
  for (const f of plan.createFamilies) {
    // profileComplete stays false and status "active": the family exists for
    // billing and event generation, but NIF / billing address / payment method
    // are genuinely unknown, and the parent's own onboarding fills them in.
    // primaryContact.userId is deliberately left empty — the account link
    // arrives on first login (decision 7), it cannot be invented here.
    const doc = {
      primaryContact: {
        name: f.primaryContact.name ?? "",
        email: f.primaryContact.email ?? "",
        phone: f.primaryContact.phone ?? "",
        userId: "",
      },
      profileComplete: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      notes: "Created by identity.mjs (Phase 0 migration) from subscription contactEmail.",
    };
    const famId = APPLY ? await createDoc("families", doc) : `(new-family:${f.email})`;
    did(`families/${famId} for ${f.email}`);
    for (const s of f.subs) {
      if (APPLY) await setFields(s._col, s.id, { familyId: famId });
      familyIdBySub.set(s.id, famId);
      did(`${s._col}/${s.id} familyId → ${famId}  (${s.childName})`);
    }
    for (const c of f.matchedChildren) {
      if (!c.resolvedId) {
        console.log(`  SKIP   child "${c.name}" has no children record — not created here, repair by hand`);
        continue;
      }
      if (APPLY) await setFields("children", c.resolvedId, { familyId: famId });
      did(`children/${c.resolvedId} familyId → ${famId}  (${c.name})`);
    }
  }
  if (!plan.createFamilies.length) console.log("  nothing to do.");

  console.log(`\n3. Orphan subs matching an existing family (${plan.linkSubs.length})`);
  for (const l of plan.linkSubs) {
    for (const s of l.subs) {
      if (APPLY) await setFields(s._col, s.id, { familyId: l.familyId });
      familyIdBySub.set(s.id, l.familyId);
      did(`${s._col}/${s.id} familyId → ${l.familyId}  (${s.childName})`);
    }
    for (const c of l.matchedChildren) {
      if (!c.resolvedId) continue;
      if (APPLY) await setFields("children", c.resolvedId, { familyId: l.familyId });
      did(`children/${c.resolvedId} familyId → ${l.familyId}  (${c.name})`);
    }
  }
  if (!plan.linkSubs.length) console.log("  nothing to do.");

  console.log(`\n4. Children with no familyId (${plan.linkChildren.length})`);
  for (const c of plan.linkChildren) {
    const familyId = c.sub ? (familyIdBySub.get(c.sub.id) ?? c.sub.familyId) : null;
    if (!familyId) {
      console.log(`  SKIP   children/${c.child.id} ${c.child.firstName} ${c.child.lastName} — no subscription resolves a family`);
      continue;
    }
    if (APPLY) await setFields("children", c.child.id, { familyId });
    did(`children/${c.child.id} familyId → ${familyId}  (${c.child.firstName} ${c.child.lastName})`);
  }
  if (!plan.linkChildren.length) console.log("  nothing to do.");

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${APPLY ? "DOCUMENTS WRITTEN" : "DOCUMENTS THAT WOULD BE WRITTEN"}: ${written}`);
  console.log("=".repeat(78) + "\n");
}

await applyPlan(plan);

// ── Approved fuzzy merges ───────────────────────────────────────────────────
// Near-name duplicates are never merged unattended. A merge happens only when
// it is named explicitly on the command line as loserId:survivorId, so the
// invocation itself is the audit record of who approved what:
//
//   node identity.mjs --apply --i-know-this-is-prod \
//     --approve-merge G1XkEDBciLr7k2Hk9eRa:6DdwHVG0WFr975wMYyBC
//
// The loser is RETIRED, never deleted — status becomes "merged" with a pointer
// to the survivor, so the record stays auditable and the merge is reversible.
// Any subscription pointing at the loser is repointed first.

const approved = args.flatMap((a, i) => (a === "--approve-merge" && args[i + 1] ? [args[i + 1]] : []));

if (approved.length) {
  const all = [...study.map(s => ({ ...s, _col: "studyroom" })),
               ...transport.map(s => ({ ...s, _col: "transportationSubscriptions" }))];
  for (const pair of approved) {
    const [loserId, survivorId] = pair.split(":");
    const loser = children.find(c => c.id === loserId);
    const survivor = children.find(c => c.id === survivorId);
    if (!loser || !survivor) { console.error(`  SKIP ${pair}: record not found`); continue; }
    if (loser.status === "merged") {
      console.log(`  SKIP ${pair}: children/${loserId} is already merged into ${loser.mergedInto ?? "?"} — nothing to do.`);
      continue;
    }

    const pointing = all.filter(s => s.childId === loserId);
    console.log(`\nMERGE ${loser.firstName} ${loser.lastName} (${loserId}) -> ${survivor.firstName} ${survivor.lastName} (${survivorId})`);
    console.log(`  subscriptions pointing at the duplicate: ${pointing.length ? pointing.map(s => `${s._col}/${s.id}`).join(", ") : "none"}`);
    const salvage = CHILD_FIELDS.filter(f => !survivor[f] && loser[f]);
    console.log(`  fields the survivor is missing that the duplicate has: ${salvage.length ? salvage.join(", ") : "none"}`);

    if (!APPLY) { console.log("  DRY RUN — not written."); continue; }

    for (const s of pointing) {
      await patchDoc(s._col, s.id, { childId: { stringValue: survivorId } });
      console.log(`  repointed ${s._col}/${s.id}`);
    }
    await patchDoc("children", loserId, {
      status: { stringValue: "merged" },
      mergedInto: { stringValue: survivorId },
      mergedAt: { timestampValue: new Date().toISOString() },
    });
    console.log(`  retired children/${loserId} (status=merged, mergedInto=${survivorId}) — not deleted, reversible`);
  }
}
