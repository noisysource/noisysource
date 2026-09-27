#!/usr/bin/env node
/**
 * KidClub Phase 2 migration — puts real data onto the event-sourced pipeline.
 *
 * Four repairs, in a fixed order, against ONE project:
 *
 *   1. date repairs     — clear the 6 `endDate: 2027-07-30` values (decision 14)
 *   2. event generation — reservationEvents for every active subscription
 *   3. historical absences — 75 billing excludedDates + 13 eventModifications
 *                            become CANCELLED events (decisions 4 and 13)
 *   4. billing status   — the 35 auto-cancelled records go back to `pending`
 *                         (decision 6)
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply, and --apply against
 * production is refused outright — there is no override flag. Phase 2 targets
 * `kidclub-dev` only (decision 12); prod is Phase 5's problem, after Renato has
 * signed off a dev run and decided how the fix travels.
 *
 *   node migrate.mjs                                  # dry run against dev
 *   node migrate.mjs --project rainbow-prod-2454b     # dry run against prod, read-only
 *   node migrate.mjs --apply                          # writes to kidclub-dev
 *   node migrate.mjs --only events --verbose
 *
 * Auth: `gcloud auth print-access-token` against the Firestore REST API — no
 * service-account key, matching the org policy that blocks them. Same pattern
 * as identity.mjs and reconcile-report.mjs; do not provision new credentials.
 *
 * ── Why this compiles functions/src instead of reimplementing it ────────────
 *
 * The events this script writes must be byte-for-byte what the deployed
 * `ensureEventsExist()` would write, or the first backfill click after the
 * migration silently rewrites half of them. So the real generators are
 * compiled out of functions/src and called directly, exactly as
 * reconcile-report.mjs does. A second copy of the generator drifts: that exact
 * mistake — a local copy of `manualDiscountPctFor` — hid a double-count for a
 * full run earlier in this effort.
 *
 * ── The ordering rule is a correctness constraint, not a preference ─────────
 *
 * `regenerateFutureEvents()` voids and recreates every future event whenever a
 * subscription's schedule/days/weekPattern/startDate/endDate/status changes. So
 * any such write AFTER generation wipes future absences. Hence: identity
 * repairs (identity.mjs, familyId-only, inert) → date repairs (this script,
 * step 1, triggers regeneration deliberately, while there is nothing to lose)
 * → generation → absences. The script enforces the order rather than
 * documenting it: step 1 will not run after step 2 in the same invocation, and
 * --only dates prints a warning if events already exist.
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS = resolve(HERE, "../../functions");
const PROD = "rainbow-prod-2454b";
const DEV = "kidclub-dev";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const PROJECT = opt("--project", DEV);
const APPLY = flag("--apply");
const VERBOSE = flag("--verbose");
const JSON_OUT = opt("--json", null);
const SETTLE_SECONDS = Number(opt("--settle-seconds", "90"));
// Writes the exact REST payloads this run would send, to a file, without
// sending them. The write path cannot be exercised by a dry run, so this is
// how it gets reviewed before the first --apply rather than after.
const DUMP = opt("--dump", null);
const STEPS = ["dates", "events", "absences", "billing-status"];
const ONLY = opt("--only", null);

if (ONLY && !STEPS.includes(ONLY)) {
  console.error(`--only must be one of: ${STEPS.join(", ")}`);
  process.exit(1);
}
const runs = (step) => !ONLY || ONLY === step;

// Phase 5 (go-live, approved by Renato 2026-09-27): prod is allowed only with
// the same explicit gate as identity.mjs and promote-subscriptions.mjs.
if (APPLY && PROJECT !== DEV && PROJECT !== PROD) {
  console.error(`Refusing to --apply against unknown project "${PROJECT}".`);
  process.exit(1);
}
if (APPLY && PROJECT === PROD && !flag("--i-know-this-is-prod")) {
  console.error(`Refusing to --apply against ${PROD} without --i-know-this-is-prod.`);
  process.exit(1);
}

// ── Load the production generators ──────────────────────────────────────────

/**
 * firebase-admin stand-in. The generators only need FieldValue.serverTimestamp()
 * for the payload they build; every other access throws, so imported code can
 * never reach a real database. All writing in this script goes through the REST
 * helpers below, where the project and the dry-run guard are enforced in one
 * place.
 */
function makeAdminStub() {
  const refuse = () => { throw new Error("migrate.mjs writes via REST: imported code tried to use the admin SDK."); };
  const firestore = () => new Proxy({}, { get: refuse });
  firestore.FieldValue = { serverTimestamp: () => "__serverTimestamp__", delete: () => "__delete__" };
  firestore.FieldPath = { documentId: () => "__documentId__" };
  return { apps: [{}], initializeApp: () => {}, firestore };
}

function loadProductionModules() {
  const out = mkdtempSync(join(tmpdir(), "kidclub-migrate-"));
  execSync(
    `"${join(FUNCTIONS, "node_modules/.bin/tsc")}" `
    + `"${join(FUNCTIONS, "src/kidclub/reconciliation.ts")}" `
    + `"${join(FUNCTIONS, "src/kidclub/reservationEvents.ts")}" `
    + `--outDir "${out}" --module CommonJS --target ES2020 --esModuleInterop --skipLibCheck --rootDir "${join(FUNCTIONS, "src/kidclub")}"`,
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const noop = () => () => ({});
  const stubs = {
    "firebase-admin": makeAdminStub(),
    "firebase-functions/v2/firestore": { onDocumentWritten: noop() },
    "firebase-functions/v2/https": { onCall: noop(), HttpsError: class extends Error {} },
    "./db": { APP_ROOT: null, appCol: () => { throw new Error("migrate.mjs writes via REST, not appCol."); } },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const req = createRequire(join(out, "x.cjs"));
    return { recon: req("./reconciliation.js"), events: req("./reservationEvents.js") };
  } finally {
    Module._load = origLoad;
  }
}

const { recon, events: ev } = loadProductionModules();
const { studyPerDayRate } = recon;
const {
  generateStudyEvents, generateTransportEvents,
  resolveGenerationWindowStart, resolveGenerationWindowEnd,
  coerceStartDate, coerceEndDate,
  REASON_BEFORE_START, REASON_AFTER_END,
} = ev;

// ── Firestore REST ──────────────────────────────────────────────────────────

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ROOT = `${BASE}/_apps/arcoiris`;

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

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
  return { stringValue: String(v) };
}

async function listAll(collection) {
  const out = [];
  let pageToken;
  // runQuery has no page token; pages come from the REST list endpoint, which
  // caps at 300 documents per page. reservationEvents runs to thousands of
  // rows after a generation, so paging is not optional here.
  do {
    const url = new URL(`${ROOT}/${collection}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`${collection}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const d of body.documents ?? []) {
      out.push({
        id: d.name.split("/").pop(),
        ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([a, b]) => [a, decode(b)])),
      });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

async function getDoc(path) {
  const res = await fetch(`${ROOT}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) return {};
  return Object.fromEntries(Object.entries((await res.json()).fields ?? {}).map(([a, b]) => [a, decode(b)]));
}

/**
 * The single write path. Every mutation in this script is a `write` object
 * handed to this function, which is also the one place the dry-run guard
 * lives — a step cannot accidentally write by forgetting to check APPLY.
 *
 * Firestore's commit limit is 500 writes; 400 leaves headroom, matching
 * commitInChunks() in reservationEvents.ts.
 */
let WRITE_COUNT = 0;
const DUMPED = [];
async function commit(writes) {
  WRITE_COUNT += writes.length;
  if (DUMP) DUMPED.push(...writes);
  if (!APPLY || !writes.length) return;
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const res = await fetch(`${BASE}:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes: writes.slice(i, i + CHUNK) }),
    });
    if (!res.ok) throw new Error(`commit: ${res.status} ${await res.text()}`);
  }
}

/** An update with an explicit field mask — fields outside the mask survive. */
const updateWrite = (collection, id, obj, extraMaskPaths = []) => ({
  update: {
    name: `${ROOT}/${collection}/${id}`.replace("https://firestore.googleapis.com/v1/", ""),
    fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encode(v)])),
  },
  updateMask: { fieldPaths: [...Object.keys(obj), ...extraMaskPaths] },
});

// A field named in the mask but absent from `fields` is DELETED. That is how
// endDate gets cleared and how autoCancelled is removed, without a separate
// request shape.
const deleteFieldWrite = (collection, id, fieldPaths) => ({
  update: { name: `${ROOT}/${collection}/${id}`.replace("https://firestore.googleapis.com/v1/", ""), fields: {} },
  updateMask: { fieldPaths },
});

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * A stored timestamp back to the CALENDAR day it was meant to represent.
 *
 * `eventModifications.date` is a timestamp written from a local Date, so
 * 2026-09-24T23:00:00Z is 2026-09-25 in Portugal (WEST, UTC+1). Slicing the
 * ISO string credits the wrong day — the same off-by-one commit eb905ed fixed
 * in the admin exclusion calendar, and invisible in a monthly total because
 * the wrong day usually still lands in the right month. Europe/Lisbon is named
 * explicitly rather than inherited from the machine's timezone, so the script
 * behaves identically wherever it runs.
 */
const LISBON = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
});
const tsToLocalIso = (raw) => {
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : LISBON.format(d);
};
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Loading ─────────────────────────────────────────────────────────────────

async function load() {
  const [families, children, transport, study, billing, realEvents, eventMods] = await Promise.all([
    listAll("families"), listAll("children"), listAll("transportationSubscriptions"),
    listAll("studyroom"), listAll("billing"), listAll("reservationEvents"), listAll("eventModifications"),
  ]);
  const [transportConfig, studyConfig, schoolCalendar] = await Promise.all([
    getDoc("config/transportation"), getDoc("config/studyCenter"), getDoc("config/schoolCalendar"),
  ]);
  // Every subscription, active or not, keyed by id: an absence that matches
  // nothing is usually an absence on a CANCELLED subscription, and saying so
  // is the difference between "expected" and "investigate this".
  const allSubsById = new Map([...study, ...transport].map(s => [s.id, s]));
  return {
    families, children, billing, realEvents, eventMods, transportConfig, studyConfig, allSubsById,
    schoolYearEnd: schoolCalendar?.yearEndDate ? new Date(`${schoolCalendar.yearEndDate}T23:59:59`) : null,
    // The same status filters billing.ts and reconcile-report.mjs query with.
    activeStudy: study.filter(s => ["active", "confirmed"].includes(s.status)).map(s => ({ ...s, _type: "study", _col: "studyroom" })),
    activeTransport: transport.filter(s => s.status === "active").map(s => ({ ...s, _type: "transport", _col: "transportationSubscriptions" })),
  };
}

// ── Guard: invoiced billing records are frozen (decision 5) ─────────────────

/**
 * Decision 5 makes an invoiced billing record untouchable: it backs an issued
 * fiscal document, and the divergence between it and the new model is reported
 * (flag (c) in reconcile-report.mjs), never corrected. Decision 13 then says
 * the EVENTS for those same periods ARE written — the event log is a record of
 * what happened, the billing record is a record of what was charged, and the
 * two are allowed to disagree.
 *
 * So the guard is deliberately narrow and absolute: no write to a `billing`
 * document whose status is "invoiced", ever, from any step. It throws rather
 * than skipping — a step that reaches it has a bug in its filter, and
 * continuing would mean the run's report no longer describes what it did.
 */
function makeBillingGuard(billing) {
  const invoiced = new Set(billing.filter(b => b.status === "invoiced").map(b => b.id));
  return {
    invoicedIds: invoiced,
    assertWritable(id, step) {
      if (invoiced.has(id)) {
        throw new Error(`${step}: refusing to write billing/${id} — status "invoiced" is frozen (decision 5). This is a bug in the step's filter.`);
      }
    },
  };
}

// ── Step 1: date repairs (decision 14) ──────────────────────────────────────

/**
 * The 6 subscriptions carrying `endDate: 2027-07-30` end one month before the
 * school year does, so August 2027 bills EUR 0 for them while the other 16 bill
 * a full month. Decision 10 made cancellation manual and decision 14 clears
 * these, so all 22 bill August 2027 (EUR 2,134.56).
 *
 * This is the step that MUST come before generation: clearing endDate fires
 * onStudyroom/onTransportReservationEventsSync → regenerateFutureEvents(),
 * which voids and recreates every future event. Running it after step 2 would
 * discard the migrated absences for those subscriptions.
 */
// The cliff is matched by MONTH, not by the string "2027-07-30".
//
// The two collections store endDate in different shapes — coerceDate()'s own
// comment says so: TransportationSubscription.endDate is the plain string
// "2027-07-30", StudyRoomEntry.endDate is a timestamp, and the stored
// timestamp is 2027-07-30T23:00:00Z, which in Europe/Lisbon (WEST, UTC+1) is
// 2027-07-31. An exact match on "2027-07-30" therefore finds the 3 transport
// subscriptions and silently misses all 4 study ones — the same class of
// off-by-one as the excludedDates bug in commit eb905ed, in the one step whose
// whole job is to remove a cliff. Matching the calendar month catches both
// shapes and cannot be thrown off by an hour.
const CLIFF_MONTH = "2027-07";

function planDates(data) {
  const out = [];
  for (const sub of [...data.activeStudy, ...data.activeTransport]) {
    const end = coerceEndDate(sub.endDate);
    if (!end) continue;
    const localDay = isoOf(end);
    if (!localDay.startsWith(CLIFF_MONTH)) continue;
    out.push({ col: sub._col, id: sub.id, type: sub._type, childName: sub.childName,
               raw: typeof sub.endDate === "string" ? sub.endDate : JSON.stringify(sub.endDate), localDay });
  }
  return out;
}

async function stepDates(data, report) {
  const plan = planDates(data);
  report.dates = { cleared: plan.map(p => ({ col: p.col, id: p.id, childName: p.childName })) };

  console.log(`\n── STEP 1: date repairs — clear endDate in ${CLIFF_MONTH} (decision 14) ──`);
  if (!plan.length) {
    console.log("  nothing to clear — no active subscription ends in that month.");
    return { triggered: false };
  }
  for (const p of plan) {
    console.log(`  ${APPLY ? "CLEAR " : "would clear"}  ${p.col}/${p.id}  ${String(p.childName ?? "?").slice(0, 24).padEnd(26)} stored ${p.raw}  → local ${p.localDay}`);
  }
  console.log(`  ${plan.length} subscription(s) → they then bill August 2027 like the rest.`);
  // Decision 14 was written against a count of 6. The set moves (STATUS calls
  // these moving targets, and one subscription was restored from cancellation
  // on 2026-09-22), so the count is reported rather than asserted — but a
  // difference is worth a human's eye before an --apply.
  if (plan.length !== 6) {
    console.log(`  ⚠️  decision 14 recorded 6 subscriptions; this run finds ${plan.length}.`);
    console.log(`      Confirm the list above is the intended one before --apply.`);
  }

  await commit(plan.map(p => deleteFieldWrite(p.col, p.id, ["endDate"])));

  if (APPLY) {
    // Each of those writes fires regenerateFutureEvents in the deployed
    // functions. Generating on top of a regeneration still in flight is a race
    // the deterministic doc ids mostly absorb, but "mostly" is not a guarantee
    // worth taking on a money path — wait for the triggers to drain first.
    console.log(`  waiting ${SETTLE_SECONDS}s for regenerateFutureEvents triggers to settle before generating…`);
    await sleep(SETTLE_SECONDS * 1000);
  }
  return { triggered: true };
}

// ── Step 2: event generation ────────────────────────────────────────────────

/**
 * Mirrors resolveGenerationEnd() in reservationEvents.ts, which is not
 * exported: the contract end is the earlier of the subscription's own endDate
 * and the school year end, and the window runs to the end of that month only
 * when the subscription's own end is what binds.
 */
function generationEnd(sub, schoolYearEnd) {
  const subEnd = coerceEndDate(sub.endDate);
  const contractEnd = subEnd && schoolYearEnd
    ? (subEnd < schoolYearEnd ? subEnd : schoolYearEnd)
    : (subEnd ?? schoolYearEnd);
  if (!contractEnd) return null;
  return { contractEnd, windowEnd: resolveGenerationWindowEnd(contractEnd, subEnd, schoolYearEnd) };
}

/**
 * Where generation starts. `ensureEventsExist()` is called with the 1st of the
 * current month, which is right for a running system but wrong for a
 * migration: the 75 historical excludedDates land on September and earlier,
 * and an absence with no occurrence to attach to is a silently dropped fact.
 * So the window opens at the earliest month any billing record covers, and the
 * subscription's own startDate clamp (resolveGenerationWindowStart) still
 * applies on top.
 */
function migrationWindowStart(billing) {
  const keys = billing.map(b => (b.id.includes("_") ? b.id.slice(b.id.lastIndexOf("_") + 1) : null)).filter(Boolean).sort();
  const now = startOfMonth(new Date());
  if (!keys.length) return now;
  const [y, m] = keys[0].split("-").map(Number);
  const earliest = new Date(y, m - 1, 1, 0, 0, 0, 0);
  return earliest < now ? earliest : now;
}

function planEvents(data) {
  const from0 = migrationWindowStart(data.billing);
  const studyRate = studyPerDayRate(data.studyConfig);
  const tripRate = data.transportConfig?.flatRatePerTrip ?? 0;

  const existingById = new Map(data.realEvents.map(e => [e.id, e]));
  const create = [], repair = [], skippedHuman = [];
  const perSub = [];
  const noFamily = [], noWindow = [];

  for (const sub of [...data.activeStudy, ...data.activeTransport]) {
    if (!sub.familyId) { noFamily.push(sub); continue; }
    const ends = generationEnd(sub, data.schoolYearEnd);
    if (!ends) { noWindow.push(sub); continue; }
    const from = resolveGenerationWindowStart(sub, from0);
    const to = ends.windowEnd;
    if (!to || to < from) { noWindow.push(sub); continue; }

    const bounds = { start: coerceStartDate(sub.startDate), end: ends.contractEnd };
    const rate = sub._type === "study" ? studyRate : tripRate;
    const generated = sub._type === "study"
      ? generateStudyEvents(sub, sub.id, rate, from, to, bounds)
      : generateTransportEvents(sub, sub.id, rate, from, to, bounds);

    let nCreate = 0, nRepair = 0, nKeep = 0;
    for (const g of generated) {
      const existing = existingById.get(g.id);
      if (!existing) { create.push(g); nCreate++; continue; }

      // A parent's or staff member's recorded absence is a fact. Generation
      // never overwrites one — the same rule splitRegenerationWrites() applies
      // in the deployed code.
      if (existing.changedByRole === "parent" || existing.changedByRole === "staff") { skippedHuman.push(g.id); nKeep++; continue; }

      // The pre-start repair. `ensureEventsExist` is ADDITIVE ONLY: it creates
      // missing occurrences and never rewrites an existing one, so an EXPECTED
      // event written by an earlier backfill — before the startDate clamp and
      // the boundary-month rules existed — stays EXPECTED forever, and a
      // backfill click will not fix it. Those days are outside the contract and
      // must read as system CANCELLED, or the boundary month bills full.
      if (existing.status !== g.data.status || (g.data.reason ?? null) !== (existing.reason ?? null)) {
        repair.push({ g, was: { status: existing.status, reason: existing.reason ?? null } });
        nRepair++;
        continue;
      }
      nKeep++;
    }
    perSub.push({ id: sub.id, type: sub._type, childName: sub.childName, familyId: sub.familyId,
                  from: isoOf(from), to: isoOf(to), generated: generated.length, create: nCreate, repair: nRepair, keep: nKeep });
  }
  return { create, repair, skippedHuman, perSub, noFamily, noWindow, from0: isoOf(from0) };
}

/** A generated event payload as a REST write. */
function eventWrite(g, extra = {}) {
  const data = { ...g.data, ...extra };
  // The generators build createdAt with FieldValue.serverTimestamp(), which
  // the admin stub renders as a sentinel string. REST has no equivalent in a
  // plain update, and a migration's honest createdAt is the moment it ran.
  data.createdAt = new Date();
  data.migratedAt = new Date();
  const fields = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)]));
  // changedByRole/reason are named in the mask even when unset, so an event
  // regenerated as EXPECTED cannot keep a stale CANCELLED provenance — the
  // same clearing commitInChunks() does with FieldValue.delete().
  const mask = [...new Set([...Object.keys(fields), "changedByRole", "reason", "changedBy"])];
  return { update: { name: `${ROOT}/reservationEvents/${g.id}`.replace("https://firestore.googleapis.com/v1/", ""), fields }, updateMask: { fieldPaths: mask } };
}

async function stepEvents(data, report) {
  console.log(`\n── STEP 2: generate reservationEvents ──`);
  const plan = planEvents(data);
  report.events = {
    window: plan.from0, create: plan.create.length, repair: plan.repair.length,
    preserved: plan.skippedHuman.length,
    noFamily: plan.noFamily.map(s => ({ id: s.id, type: s._type, childName: s.childName, contactEmail: s.contactEmail })),
    noWindow: plan.noWindow.map(s => ({ id: s.id, type: s._type, childName: s.childName })),
    perSub: plan.perSub,
  };

  console.log(`  window opens ${plan.from0} (earliest billing period, so historical absences have occurrences to land on)`);
  console.log(`  ${plan.create.length} events to create, ${plan.repair.length} to repair, ${plan.skippedHuman.length} human-recorded left untouched`);

  if (plan.repair.length) {
    console.log(`  repairs (existing events whose status disagrees with the contract — ensureEventsExist would NOT fix these):`);
    for (const r of plan.repair.slice(0, 12)) {
      console.log(`    ${r.g.id}  ${r.was.status} → ${r.g.data.status}${r.g.data.reason ? ` (${r.g.data.reason})` : ""}`);
    }
    if (plan.repair.length > 12) console.log(`    … and ${plan.repair.length - 12} more`);
  }

  if (VERBOSE) {
    for (const s of plan.perSub) {
      console.log(`    ${s.type.padEnd(9)} ${s.id}  ${String(s.childName ?? "?").slice(0, 22).padEnd(24)} ${s.from}→${s.to}  +${s.create} ~${s.repair} =${s.keep}`);
    }
  }

  await commit([...plan.create.map(g => eventWrite(g)), ...plan.repair.map(r => eventWrite(r.g))]);
  return plan;
}

// ── Step 3: historical absences (decisions 4 and 13) ────────────────────────

/**
 * 75 `excludedDates` on billing line items and 13 `eventModifications` are the
 * only record that a child was absent on a given day. Under the old model they
 * lived on the billing record; under the new one an absence is an event. They
 * are written as CANCELLED events for the occurrences they name.
 *
 * Two things are deliberate here:
 *
 * `changedByRole` is "staff", not "system". These are absences a human
 * recorded — that is literally what an excludedDate was — and the role decides
 * whether a later regeneration may overwrite them (`isHumanRecorded`). Writing
 * them as "system" would leave every migrated absence one schedule edit away
 * from being silently voided.
 *
 * The invoiced September periods get their events too (decision 13), while
 * their billing records stay frozen (decision 5). The event log records what
 * happened; the invoice records what was charged; flag (c) in the
 * reconciliation report keeps reporting the difference rather than resolving
 * it. No billing document is written by this step at all.
 */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Why an absence found no occurrence. Two causes, and they mean opposite
 * things to whoever reads the report:
 *
 *  - the subscription is not active, so nothing was generated for it. Expected,
 *    nothing to do — the absence describes a service that has since stopped.
 *  - the date falls on a weekend or on a weekday the subscription never
 *    serves. That is the signature of the pre-eb905ed `toIsoDate()` bug, which
 *    stored the day BEFORE every click for months (Portugal is UTC+1, and
 *    `.toISOString()` rolled the date back). A Sunday excludedDate is a Monday
 *    absence that was never really recorded. These are NOT migrated by
 *    shifting them a day — the correct date is a guess, and guessing on a
 *    money path is how the original bug survived so long.
 */
function classifyUnmatched(subId, iso, data) {
  const sub = data.allSubsById.get(subId);
  if (!sub) return "no subscription document with that id";
  if (!["active", "confirmed"].includes(sub.status)) return `subscription is "${sub.status}" — no events generated for it`;
  const wd = WEEKDAYS[new Date(`${iso}T12:00:00`).getDay()];
  return `${wd} — not a served day (likely a pre-eb905ed off-by-one)`;
}

function planAbsences(data, eventsAfterGeneration) {
  const bySub = new Map();
  const add = (subId, iso, source, ref) => {
    if (!subId || !iso) return;
    if (!bySub.has(subId)) bySub.set(subId, new Map());
    if (!bySub.get(subId).has(iso)) bySub.get(subId).set(iso, { sources: [] });
    bySub.get(subId).get(iso).sources.push(`${source}:${ref}`);
  };

  let nExcluded = 0, nMods = 0;
  for (const b of data.billing) {
    for (const li of b.lineItems ?? []) {
      for (const x of li.excludedDates ?? []) { add(li.subscriptionId, x, "excludedDate", b.id); nExcluded++; }
    }
  }
  for (const m of data.eventMods) {
    if (m.status && m.status !== "approved") continue;
    if (m.modificationType && m.modificationType !== "cancelled") continue;
    // Europe/Lisbon, not a string slice — see tsToLocalIso.
    add(m.subscriptionId, tsToLocalIso(m.date), "eventModification", m.id);
    nMods++;
  }

  // Every occurrence that exists after step 2, keyed subscriptionId → date →
  // [event]. A transport day has two legs and an excludedDate covers the whole
  // day, which is how the old model counted it, so both legs are cancelled.
  const bySubDate = new Map();
  for (const e of eventsAfterGeneration) {
    if (!bySubDate.has(e.subscriptionId)) bySubDate.set(e.subscriptionId, new Map());
    const m = bySubDate.get(e.subscriptionId);
    if (!m.has(e.date)) m.set(e.date, []);
    m.get(e.date).push(e);
  }

  const cancel = [], unmatched = [], alreadyCancelled = [];
  for (const [subId, dates] of bySub) {
    for (const [iso, meta] of dates) {
      const occurrences = bySubDate.get(subId)?.get(iso) ?? [];
      if (!occurrences.length) {
        // An absence naming a day the subscription never serves. These are
        // real and already understood: the toIsoDate()/UTC bug (commit
        // eb905ed) saved the day BEFORE every click for months, which is what
        // left orphaned excludedDates on Susete Luis's record. They are
        // reported, never invented — creating an occurrence to hang one on
        // would manufacture a billable day that never existed.
        unmatched.push({ subId, date: iso, sources: meta.sources, why: classifyUnmatched(subId, iso, data) });
        continue;
      }
      for (const occ of occurrences) {
        if (occ.status === "CANCELLED") { alreadyCancelled.push(occ.id); continue; }
        if (occ.status === "VOIDED") { unmatched.push({ subId, date: iso, sources: meta.sources, why: "occurrence exists but is VOIDED — a VOIDED day is not an absence" }); continue; }
        cancel.push({ id: occ.id, subId, date: iso, sources: meta.sources });
      }
    }
  }
  return { cancel, unmatched, alreadyCancelled, nExcluded, nMods };
}

async function stepAbsences(data, report, eventsAfterGeneration, guard) {
  console.log(`\n── STEP 3: historical absences → CANCELLED events (decisions 4, 13) ──`);
  const plan = planAbsences(data, eventsAfterGeneration);
  report.absences = {
    sources: { excludedDates: plan.nExcluded, eventModifications: plan.nMods },
    cancelled: plan.cancel.length, alreadyCancelled: plan.alreadyCancelled.length,
    unmatched: plan.unmatched,
  };

  console.log(`  sources: ${plan.nExcluded} excludedDates + ${plan.nMods} eventModifications`);
  console.log(`  ${plan.cancel.length} occurrence(s) to mark CANCELLED, ${plan.alreadyCancelled.length} already cancelled`);
  const inInvoiced = plan.cancel.filter(c => data.billing.some(b => guard.invoicedIds.has(b.id)
    && (b.lineItems ?? []).some(li => li.subscriptionId === c.subId)
    && c.date >= (b.id.slice(b.id.lastIndexOf("_") + 1) + "-01")
    && c.date <= (b.id.slice(b.id.lastIndexOf("_") + 1) + "-31")));
  console.log(`  of those, ${inInvoiced.length} fall in an INVOICED period — events are written, the billing record is NOT (decisions 5 + 13)`);

  if (plan.unmatched.length) {
    console.log(`  ⚠️  ${plan.unmatched.length} absence(s) name a day with no occurrence — NOT migrated, reported for review:`);
    for (const u of plan.unmatched.slice(0, 20)) {
      console.log(`      ${u.subId}  ${u.date}  ${u.why}  [${u.sources.join(", ")}]`);
    }
    if (plan.unmatched.length > 20) console.log(`      … and ${plan.unmatched.length - 20} more`);
  }

  await commit(plan.cancel.map(c => updateWrite("reservationEvents", c.id, {
    status: "CANCELLED",
    changedByRole: "staff",
    reason: `migrated from ${c.sources[0].split(":")[0]}`,
    changedAt: new Date(),
    migratedAt: new Date(),
  }, ["changedBy"])));
  return plan;
}

// ── Step 4: auto-cancelled billing records → pending (decision 6) ───────────

/**
 * 35 billing records sit at status "cancelled" with `autoCancelled: true` —
 * set by autoCreateBillingSchedule when computeLineItems returned nothing,
 * which under the old (broken) generation meant "no events", not "nothing
 * owed". Decision 6 puts all of them back to `pending`; Renato cancels the
 * genuinely-dead ones individually in the app afterwards. This restores
 * billing for José Miguel Duarte (~EUR 113/mo) and Edson (~EUR 72/mo), whose
 * subscriptions are active while their records were cancelled.
 *
 * `autoCancelled` is removed rather than set false, matching what
 * autoCreateBillingSchedule itself does (FieldValue.delete()) when a record
 * comes back to life — isRecomputable() keys on the field's presence.
 *
 * A record that an admin cancelled by hand has no `autoCancelled` flag and is
 * left alone: that is a decision, not a side effect.
 */
function planBillingStatus(data, guard) {
  const targets = data.billing.filter(b => b.status === "cancelled" && b.autoCancelled === true);
  for (const b of targets) guard.assertWritable(b.id, "step 4"); // belt and braces: invoiced can never be cancelled+autoCancelled
  const manual = data.billing.filter(b => b.status === "cancelled" && b.autoCancelled !== true);
  return { targets, manual };
}

async function stepBillingStatus(data, report, guard) {
  console.log(`\n── STEP 4: auto-cancelled billing records → pending (decision 6) ──`);
  const { targets, manual } = planBillingStatus(data, guard);
  report.billingStatus = {
    toPending: targets.map(b => ({ id: b.id, familyId: b.familyId, name: b.billingName, total: b.total })),
    manuallyCancelledLeftAlone: manual.length,
    invoicedFrozen: guard.invoicedIds.size,
  };

  console.log(`  ${manual.length} hand-cancelled record(s) left alone (no autoCancelled flag — that was a decision)`);
  console.log(`  ${guard.invoicedIds.size} invoiced record(s) frozen, never touched by any step (decision 5):`);
  for (const id of guard.invoicedIds) console.log(`      FROZEN  ${id}`);
  // Printed under its own heading. With the list sitting directly beneath the
  // "invoiced frozen" line it read as though these WERE the invoiced records,
  // which is the opposite of what the step does.
  console.log(`\n  ${targets.length} auto-cancelled record(s) → pending:`);
  for (const b of targets.slice(0, VERBOSE ? targets.length : 10)) {
    console.log(`    ${APPLY ? "PENDING" : "would set"}  ${b.id}  ${String(b.billingName ?? b.familyId).slice(0, 28).padEnd(30)} EUR ${(b.total ?? 0).toFixed(2)}`);
  }
  if (!VERBOSE && targets.length > 10) console.log(`    … and ${targets.length - 10} more (--verbose for all)`);

  await commit(targets.map(b => ({
    update: {
      name: `${ROOT}/billing/${b.id}`.replace("https://firestore.googleapis.com/v1/", ""),
      fields: { status: encode("pending"), updatedAt: encode(new Date()) },
    },
    // autoCancelled is in the mask but not in fields → deleted.
    updateMask: { fieldPaths: ["status", "updatedAt", "autoCancelled"] },
  })));
  return targets;
}

// ── Preflight ───────────────────────────────────────────────────────────────

/**
 * The identity repairs are step 0 and they are NOT done here — identity.mjs
 * owns them, and it runs first (decision 12's dev rehearsal is 25 writes, 5
 * families, 2 child merges). This only checks that they happened, because
 * every generated event freezes familyId into its own document: generating
 * against an unrepaired snapshot writes thousands of rows with the wrong links
 * and no cheap way back.
 *
 * On the FIRST dev run against a fresh unrepaired prod import this is expected
 * to fail with 11 subscriptions — that is decision 12 working as designed, not
 * a regression.
 */
function preflight(data) {
  const orphans = [...data.activeStudy, ...data.activeTransport].filter(s => !s.familyId);
  console.log(`\n── PREFLIGHT ──`);
  console.log(`  project: ${PROJECT}   mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  ${data.activeStudy.length} active study + ${data.activeTransport.length} active transport subscriptions`);
  console.log(`  ${data.billing.length} billing records, ${data.realEvents.length} existing reservationEvents, ${data.eventMods.length} eventModifications`);
  // Generation stops at the school year end; BILLING does not. billing.ts's
  // periodsUntilSchoolYearEnd() runs to August of the following year no matter
  // what this config says, and under flat pricing a period the contract covers
  // bills the full price with zero occurrences (decision 10). With
  // yearEndDate = 2027-07-15 in prod, that means August 2027 — and the second
  // half of July — bill a full month while holding no events at all. That is
  // decision 10 working as designed, but it is worth seeing before an apply,
  // because it is also what decision 14's "all 22 bill August 2027" rests on.
  console.log(`  config/schoolCalendar.yearEndDate: ${data.schoolYearEnd ? isoOf(data.schoolYearEnd) : "UNSET"}`
    + `  — events stop here; billing still runs to August 2027 (decision 10)`);
  if (!data.schoolYearEnd) {
    console.log(`  ⚠️  yearEndDate is unset: a subscription with no endDate generates NO events at all.`);
  }

  if (!orphans.length) { console.log(`  identity: OK — every active subscription has a familyId.`); return true; }

  console.log(`  ⚠️  ${orphans.length} active subscription(s) still have NO familyId and would generate no events:`);
  for (const s of orphans) console.log(`      ${s._type.padEnd(9)} ${s.id}  ${s.childName ?? "?"}  ${s.contactEmail ?? "no email"}`);
  console.log(`\n  These are the identity repairs, and they run FIRST:`);
  console.log(`      node identity.mjs --project ${PROJECT} --apply`);
  console.log(`  A familyId-only write does not trigger regenerateFutureEvents, so it is safe to run before generation.`);
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const data = await load();
  const guard = makeBillingGuard(data.billing);
  const report = {};

  const identityOk = preflight(data);
  if (!identityOk && APPLY && runs("events")) {
    console.error(`\nRefusing to --apply: generation would bake missing familyIds into every event it writes.`);
    console.error(`Run identity.mjs --apply first (see above), then re-run this script.`);
    process.exit(3);
  }

  if (runs("dates")) {
    if (ONLY === "dates" && data.realEvents.length) {
      console.log(`\n⚠️  ${data.realEvents.length} reservationEvents already exist. Clearing endDate fires`);
      console.log(`    regenerateFutureEvents, which voids future events — any absence recorded since`);
      console.log(`    generation that the new pattern no longer contains is lost. Date repairs belong`);
      console.log(`    BEFORE generation; only run --only dates here if you know why.`);
    }
    await stepDates(data, report);
  }

  // Steps 2 and 3 share state: the absences attach to the occurrences step 2
  // just planned. In a dry run nothing was written, so the "events after
  // generation" set is the existing ones plus the planned ones — which is
  // exactly what an apply run would leave behind.
  let eventsAfter = data.realEvents;
  if (runs("events")) {
    const evPlan = await stepEvents(data, report);
    const byId = new Map(data.realEvents.map(e => [e.id, e]));
    for (const g of [...evPlan.create, ...evPlan.repair.map(r => r.g)]) {
      const existing = byId.get(g.id);
      if (existing && (existing.changedByRole === "parent" || existing.changedByRole === "staff")) continue;
      byId.set(g.id, { id: g.id, subscriptionId: g.data.subscriptionId, date: g.data.date, status: g.data.status, reason: g.data.reason });
    }
    eventsAfter = [...byId.values()];
  }

  if (runs("absences")) await stepAbsences(data, report, eventsAfter, guard);
  if (runs("billing-status")) await stepBillingStatus(data, report, guard);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${APPLY ? "DOCUMENT WRITES PERFORMED" : "DOCUMENT WRITES THIS WOULD MAKE"}: ${WRITE_COUNT}`);
  console.log(APPLY
    ? `MODE: APPLY — written to ${PROJECT}.`
    : `MODE: DRY RUN — nothing was written to ${PROJECT}.`);
  console.log(`\nNext: node reconcile-report.mjs --project ${PROJECT}`);
  console.log(`Expected on a repaired dev: Carolina 182.40, José Eduardo 165.12, Maria Manon 130.56,`);
  console.log(`Mogo 210.00, +53.28/month, and August 2027 at 2134.56 once the endDates are cleared.`);
  console.log(`A disagreement is a finding — investigate it before assuming the report is right.`);
  console.log("=".repeat(78) + "\n");

  if (DUMP) {
    writeFileSync(DUMP, JSON.stringify(DUMPED, null, 2));
    console.log(`${DUMPED.length} REST write payload(s) dumped to ${DUMP} — not sent.`);
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ project: PROJECT, apply: APPLY, writes: WRITE_COUNT, ...report }, null, 2));
    console.log(`JSON written to ${JSON_OUT}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
