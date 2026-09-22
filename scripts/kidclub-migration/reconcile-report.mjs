#!/usr/bin/env node
/**
 * KidClub reconciliation report — Phase 3 of the prod data migration.
 *
 * Answers one question, per family and per month: what does this family pay
 * today, what would they pay under the event-sourced pipeline, and exactly
 * which step of the pipeline accounts for the difference.
 *
 * READ-ONLY, ALWAYS. There is no --apply and no write path: the Firestore
 * handle handed to the imported production code is a stub that throws on any
 * use (see makeAdminStub), so this script cannot write to any project even by
 * mistake. Renato signs the output off before anything touches prod.
 *
 *   node reconcile-report.mjs                          # all periods, prod
 *   node reconcile-report.mjs --period 2026-10         # one month
 *   node reconcile-report.mjs --project kidclub-dev
 *   node reconcile-report.mjs --changed-only --json out.json
 *
 * Auth: `gcloud auth print-access-token` against the Firestore REST API — no
 * service-account key, matching the org policy that blocks them. Same pattern
 * as identity.mjs; do not provision new prod credentials for this.
 *
 * ── Why this compiles the real functions/src instead of reimplementing it ──
 *
 * The point of the report is to predict what the deployed pipeline will do. A
 * second implementation of the money math would only ever prove that the copy
 * agrees with itself, and the two would drift the moment either changed. So
 * this script compiles reconciliation.ts and reservationEvents.ts out of
 * functions/src and calls reconcileService() / generateStudyEvents() /
 * generateTransportEvents() directly — the same functions billing.ts calls in
 * production. If those change, this report changes with them.
 *
 * ── Why events are simulated ──
 *
 * Prod holds ZERO reservationEvents (verified 2026-09-22): Phase 2 has not run
 * there yet. So for each period this script generates the events that Phase 2
 * would write, using the shipped generators and the same window/bounds rules
 * ensureEventsExist() applies, then overlays (a) any reservationEvents that do
 * already exist — which is what makes this script equally valid on dev after
 * an import — and (b) the historical absences decision 4 migrates: 75
 * billing-line excludedDates and 13 eventModifications, as CANCELLED.
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

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const PROJECT = opt("--project", PROD);
const ONLY_PERIOD = opt("--period", null);
const ONLY_FAMILY = opt("--family", null);
const CHANGED_ONLY = flag("--changed-only");
const JSON_OUT = opt("--json", null);

if (flag("--apply") || flag("--write")) {
  console.error("This script has no write mode. It is a report; Phase 5 applies changes.");
  process.exit(1);
}

// ── Load the production money math ──────────────────────────────────────────

/**
 * firebase-admin stand-in. Generation only needs FieldValue.serverTimestamp()
 * for the payload it builds; everything else throws, so any accidental attempt
 * to reach a real database from imported code fails loudly here rather than
 * silently touching a project.
 */
function makeAdminStub() {
  const refuse = () => { throw new Error("reconcile-report is read-only: imported code tried to use Firestore."); };
  const firestore = () => new Proxy({}, { get: refuse });
  firestore.FieldValue = { serverTimestamp: () => "__serverTimestamp__", delete: () => "__delete__" };
  firestore.FieldPath = { documentId: () => "__documentId__" };
  return { apps: [{}], initializeApp: () => {}, firestore };
}

function loadProductionModules() {
  const out = mkdtempSync(join(tmpdir(), "kidclub-recon-"));
  // reconciliation.ts is import-free; reservationEvents.ts pulls in
  // firebase-admin/functions and ./db, all stubbed below. Compiled rather than
  // transpiled-in-memory so the output is ordinary CJS with no extra dep.
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
    "./db": { APP_ROOT: null, appCol: () => { throw new Error("reconcile-report is read-only."); } },
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
const { reconcileService, studyPerDayRate, resolveSchoolName, contractCoversPeriod,
        buildReconciliationConfig, manualDiscountPctFor } = recon;
const {
  generateStudyEvents, generateTransportEvents,
  resolveGenerationWindowStart, resolveGenerationWindowEnd,
  coerceStartDate, coerceEndDate,
} = ev;

// ── Firestore REST, read-only ───────────────────────────────────────────────

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/_apps/arcoiris`;

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
  return (await res.json()).filter(r => r.document).map(r => ({
    id: r.document.name.split("/").pop(),
    ...Object.fromEntries(Object.entries(r.document.fields ?? {}).map(([a, b]) => [a, decode(b)])),
  }));
}

async function getDoc(path) {
  const res = await fetch(`${ROOT}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) return {};
  return Object.fromEntries(Object.entries((await res.json()).fields ?? {}).map(([a, b]) => [a, decode(b)]));
}

// ── Dates ───────────────────────────────────────────────────────────────────

/**
 * A stored timestamp back to the CALENDAR day it was meant to represent.
 *
 * eventModifications.date is a timestamp written from a local Date, so
 * 2026-09-24T23:00:00Z is 2026-09-25 in Portugal (WEST, UTC+1) — the same
 * off-by-one that commit eb905ed fixed in the admin exclusion calendar.
 * Slicing the ISO string would silently credit the wrong day, and a wrong day
 * that still lands in the month is invisible in a total. Europe/Lisbon is
 * named explicitly rather than relying on the machine's timezone, so the
 * report reads the same from anywhere.
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
const eur = (cents) => (cents / 100).toFixed(2);

const MONTHS_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
function periodFromKey(key) {
  const [y, m] = key.split("-").map(Number);
  return {
    key,
    label: `${MONTHS_PT[m - 1]} ${y}`,
    start: new Date(y, m - 1, 1, 0, 0, 0, 0),
    end: new Date(y, m, 0, 23, 59, 59, 999),
  };
}

// ── Event simulation ────────────────────────────────────────────────────────

/**
 * Mirrors resolveGenerationEnd() in reservationEvents.ts, which is not
 * exported: the contract end is the earlier of the subscription's own endDate
 * and the school year end, and the generation window runs to the end of that
 * month only when the subscription's own end is what binds.
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
 * The events this subscription would hold for this period, as
 * ReservationEventLite rows. Generated with the shipped generators over the
 * same window ensureEventsExist() would use, then overlaid with real events
 * and migrated historical absences.
 */
function eventsForPeriod(sub, type, rate, period, ctx) {
  const ends = generationEnd(sub, ctx.schoolYearEnd);
  if (!ends) return { list: [], noEndDate: true };
  const from = resolveGenerationWindowStart(sub, period.start);
  const to = ends.windowEnd < period.end ? ends.windowEnd : period.end;
  if (from > to) return { list: [], outOfContract: true };

  const bounds = { start: coerceStartDate(sub.startDate), end: ends.contractEnd };
  const generated = type === "study"
    ? generateStudyEvents(sub, sub.id, rate, from, to, bounds)
    : generateTransportEvents(sub, sub.id, rate, from, to, bounds);

  const byId = new Map();
  for (const g of generated) {
    byId.set(g.id, { date: g.data.date, basePriceCents: g.data.basePriceCents, status: g.data.status, source: "generated" });
  }
  // A reservationEvent that already exists wins over the generated one — it
  // may carry a recorded absence. None exist in prod today; this is what keeps
  // the report correct on dev after Phase 2 has run.
  for (const e of ctx.realEventsBySub.get(sub.id) ?? []) {
    if (e.date < isoOf(period.start) || e.date > isoOf(period.end)) continue;
    byId.set(e.id, { date: e.date, basePriceCents: e.basePriceCents, status: e.status, source: "existing" });
  }
  // Decision 4: historical absences become CANCELLED events. Applied by DATE,
  // because an excludedDate covers the whole day — both legs of a transport
  // day, which is how the old excludedDates model counted it.
  const absent = ctx.historicalAbsencesBySub.get(sub.id);
  if (absent) {
    for (const [id, e] of byId) {
      if (absent.has(e.date) && e.status === "EXPECTED") {
        byId.set(id, { ...e, status: "CANCELLED", source: `${e.source}+migrated-absence` });
      }
    }
  }
  return { list: [...byId.values()] };
}

// ── Building one family-period comparison ───────────────────────────────────

const asDate = (raw) => { if (!raw) return null; const d = new Date(raw); return Number.isNaN(d.getTime()) ? null : d; };

const subForRecon = (sub, type, childRec, rate, rules, period) => ({
  id: sub.id,
  childId: sub.childId,
  schoolName: resolveSchoolName(childRec?.schoolName, sub.schoolName),
  returningStudent: sub.returningStudent,
  manualDiscountPct: manualDiscountPctFor(sub, rules),
  enrollmentDate: enrollmentDateOf(sub),
  childBirthDate: childRec?.birthDate,
  scheduleWeekdays: type === "study"
    ? (sub.days ?? []).map(d => d.day)
    : (sub.schedule ?? []).map(s => s.dayOfWeek),
  weekPattern: sub.weekPattern,
  ratePerOccurrenceCents: Math.round(rate * 100),
  coversPeriod: contractCoversPeriod(asDate(sub.startDate), asDate(sub.endDate), period.start, period.end),
});

// enrollmentDateOf mirrors billing.ts. manualDiscountPctFor and
// buildReconciliationConfig are imported from reconciliation.ts rather than
// copied — an earlier copy of manualDiscountPctFor here silently kept the
// appliedBy double-count alive after billing.ts had been fixed.
function enrollmentDateOf(sub) {
  const raw = sub.createdAt ?? sub.startDate;
  const d = raw ? new Date(raw) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/** Why a subscription's amount moved, in the pipeline's own terms. */
function explainDelta(before, after) {
  if (!before) return "new line — no current billing line for this subscription";
  if (!after) return "line disappears — subscription no longer bills this period";
  const reasons = [];
  const d = (a, b, label) => { if (Math.abs((a ?? 0) - (b ?? 0)) >= 0.005) reasons.push(`${label} ${(a ?? 0).toFixed(2)} → ${(b ?? 0).toFixed(2)}`); };
  d(before.grossAmount, after.grossAmount, "gross");
  d(before.multiTripDiscountAmount, after.multiTripDiscountAmount, "multi-trip");
  d(before.siblingDiscountAmount, after.siblingDiscountAmount, "sibling");
  d(before.institutionalDiscountAmount, after.institutionalDiscountAmount, "institutional");
  d(before.absenceCreditAmount, after.absenceCreditAmount, "absence credit");
  if ((before.absenceCount ?? 0) !== (after.absenceCount ?? 0)) reasons.push(`absences ${before.absenceCount ?? 0} → ${after.absenceCount ?? 0}`);
  return reasons.length ? reasons.join("; ") : "rounding only";
}

async function main() {
  const [families, children, transport, study, billing, realEvents, eventMods, transportConfig, studyConfig, discountsDoc] =
    await Promise.all([
      listAll("families"), listAll("children"), listAll("transportationSubscriptions"),
      listAll("studyroom"), listAll("billing"), listAll("reservationEvents"),
      listAll("eventModifications"), getDoc("config/transportation"),
      getDoc("config/studyCenter"), getDoc("config/discounts"),
    ]);
  const schoolCalendar = await getDoc("config/schoolCalendar");
  const rules = discountsDoc?.rules ?? [];
  const schoolYearEnd = schoolCalendar?.yearEndDate ? new Date(`${schoolCalendar.yearEndDate}T23:59:59`) : null;
  const tripRate = transportConfig?.flatRatePerTrip ?? 0;
  const studyRate = studyPerDayRate(studyConfig);

  const familyById = new Map(families.map(f => [f.id, f]));
  const childById = new Map(children.map(c => [c.id, {
    schoolName: c.schoolName ?? undefined,
    birthDate: c.dateOfBirth ? new Date(c.dateOfBirth) : undefined,
  }]));

  // Same status filters billing.ts queries with.
  const activeStudy = study.filter(s => ["active", "confirmed"].includes(s.status));
  const activeTransport = transport.filter(s => s.status === "active");

  const realEventsBySub = new Map();
  for (const e of realEvents) {
    if (!realEventsBySub.has(e.subscriptionId)) realEventsBySub.set(e.subscriptionId, []);
    realEventsBySub.get(e.subscriptionId).push(e);
  }

  // Decision 4's two historical sources, keyed subscriptionId -> Set<iso date>.
  const historicalAbsencesBySub = new Map();
  const addAbsence = (subId, iso) => {
    if (!subId || !iso) return;
    if (!historicalAbsencesBySub.has(subId)) historicalAbsencesBySub.set(subId, new Set());
    historicalAbsencesBySub.get(subId).add(iso);
  };
  let nExcluded = 0, nMods = 0;
  for (const b of billing) for (const li of b.lineItems ?? []) for (const x of li.excludedDates ?? []) { addAbsence(li.subscriptionId, x); nExcluded++; }
  for (const m of eventMods) {
    if (m.status && m.status !== "approved") continue;
    if (m.modificationType && m.modificationType !== "cancelled") continue;
    addAbsence(m.subscriptionId, tsToLocalIso(m.date)); nMods++;
  }

  const ctx = { realEventsBySub, historicalAbsencesBySub, schoolYearEnd };

  const billingByFamilyPeriod = new Map();
  for (const b of billing) {
    const key = b.id.includes("_") ? b.id.slice(b.id.lastIndexOf("_") + 1) : null;
    if (!key) continue;
    billingByFamilyPeriod.set(`${b.familyId}|${key}`, b);
  }

  const periodKeys = ONLY_PERIOD ? [ONLY_PERIOD]
    : [...new Set([...billingByFamilyPeriod.keys()].map(k => k.split("|")[1]))].sort();
  const familyIds = ONLY_FAMILY ? [ONLY_FAMILY]
    : [...new Set([...activeStudy, ...activeTransport].map(s => s.familyId).filter(Boolean))].sort();

  const rows = [];
  const warnZeroEvents = [], warnReprice = [], warnInvoiced = [], warnNoFamily = [], warnDoubleCount = [];

  for (const subs of [activeStudy, activeTransport]) {
    for (const s of subs) if (!s.familyId) warnNoFamily.push({ id: s.id, childName: s.childName, contactEmail: s.contactEmail, type: subs === activeStudy ? "study" : "transport" });
  }

  for (const periodKey of periodKeys) {
    const period = periodFromKey(periodKey);
    for (const familyId of familyIds) {
      const gStudy = activeStudy.filter(s => s.familyId === familyId);
      const gTransport = activeTransport.filter(s => s.familyId === familyId);
      if (!gStudy.length && !gTransport.length) continue;

      const record = billingByFamilyPeriod.get(`${familyId}|${periodKey}`);
      const newLines = [];

      for (const [type, group, rate, serviceCfg] of [
        ["study", gStudy, studyRate, studyConfig],
        ["transport", gTransport, tripRate, transportConfig],
      ]) {
        if (!group.length) continue;
        const eventsBySub = new Map();
        for (const sub of group) {
          const { list, outOfContract, noEndDate } = eventsForPeriod(sub, type, rate, period, ctx);
          eventsBySub.set(sub.id, list);

          // FLAG (a): an active subscription with no occurrences at all in a
          // period bills EUR 0 under flat pricing, silently — "no events ->
          // EUR 0" is the only thing standing between a failed generation and
          // a EUR 0 invoice.
          //
          // "Billable" is taken from the data rather than from the contract:
          // if a billing record exists for this family and period, the system
          // considers the period billable, so a EUR 0 computation against it
          // is a divergence worth reporting whatever the cause. Suppressing
          // every out-of-contract EUR 0 would hide the August 2027 cliff,
          // which is a real one (see below) rather than a quiet non-event.
          // A period with no events that nonetheless bills the flat price is
          // now the correct August case, not a warning. Only a subscription
          // whose contract does NOT cover the period is silently EUR 0.
          const covers = contractCoversPeriod(asDate(sub.startDate), asDate(sub.endDate), period.start, period.end);
          if (!list.length && !covers && record) {
            const why = "a billing record exists but the subscription's contract does not cover this period";
            warnZeroEvents.push({ periodKey, familyId, subId: sub.id, type, childName: sub.childName,
              hasRecord: !!record, why });
          }

          // FLAG (b): gross reads the LIVE config rate while each event froze
          // basePriceCents at creation. A divergence means the rate was
          // repriced after these events were written, and old unpaid periods
          // would be silently recomputed at the new rate.
          const frozen = [...new Set(list.filter(e => e.source !== "generated").map(e => e.basePriceCents))];
          for (const f of frozen) {
            if (f !== Math.round(rate * 100)) {
              warnReprice.push({ periodKey, familyId, subId: sub.id, type, frozenCents: f, liveCents: Math.round(rate * 100) });
            }
          }
        }
        // FLAG (e): an AUTO rule stored with appliedBy "admin". Harmless now
        // that manualDiscountPctFor() keys on the rule's trigger — the
        // discount is applied once, by the pipeline step that owns it — but
        // still reported, because the label is wrong in the data and it is
        // what caused the double-count this report originally found. If the
        // percentage ever goes back to being read off appliedBy, these are the
        // subscriptions that would silently double-discount again.
        for (const sub of group) {
          for (const ad of sub.appliedDiscounts ?? []) {
            const rule = rules.find(r => r.id === ad.ruleId);
            if (rule && rule.trigger !== "manual" && ad.appliedBy === "admin") {
              warnDoubleCount.push({ periodKey, familyId, subId: sub.id, type, childName: sub.childName,
                ruleId: ad.ruleId, ruleName: ad.name, trigger: rule.trigger, pct: ad.percentage });
            }
          }
        }

        const cfg = buildReconciliationConfig(type, rules, serviceCfg);
        const forRecon = group.map(sub => subForRecon(sub, type, childById.get(sub.childId), rate, rules, period));
        for (const r of reconcileService(forRecon, eventsBySub, cfg)) {
          const sub = group.find(s => s.id === r.subscriptionId);
          newLines.push({
            subscriptionId: r.subscriptionId, type, childName: sub.childName,
            amount: Math.round(r.finalCents) / 100,
            grossAmount: r.grossCents / 100,
            multiTripDiscountAmount: r.multiTripDiscountCents / 100,
            siblingDiscountAmount: r.siblingDiscountCents / 100,
            institutionalDiscountAmount: r.institutionalDiscountCents / 100,
            absenceCount: r.absenceCount,
            absenceCreditAmount: r.absenceCreditCents / 100,
          });
        }
      }

      // Service lines only on both sides — enrollment fees (registration,
      // insurance) are one-off, are carried forward untouched by
      // computeLineItems, and are not what this migration changes.
      const curLines = (record?.lineItems ?? []).filter(li => li.type === "study" || li.type === "transport");
      const curTotal = curLines.reduce((s, li) => s + (li.amount ?? 0), 0);
      const newTotal = newLines.reduce((s, li) => s + li.amount, 0);

      // FLAG (c): an invoiced period is a fiscal document. Decision 5 —
      // reported, NEVER recomputed.
      if (record?.status === "invoiced" && Math.abs(newTotal - curTotal) >= 0.005) {
        warnInvoiced.push({ periodKey, familyId, name: record.billingName, curTotal, newTotal, delta: newTotal - curTotal });
      }

      const perSub = [];
      for (const id of new Set([...curLines.map(l => l.subscriptionId), ...newLines.map(l => l.subscriptionId)])) {
        const before = curLines.find(l => l.subscriptionId === id);
        const after = newLines.find(l => l.subscriptionId === id);
        const delta = (after?.amount ?? 0) - (before?.amount ?? 0);
        if (Math.abs(delta) < 0.005 && before && after) continue;
        perSub.push({ subscriptionId: id, childName: after?.childName ?? before?.title, before: before?.amount ?? null, after: after?.amount ?? null, delta, reason: explainDelta(before, after) });
      }

      rows.push({
        periodKey, familyId,
        name: record?.billingName ?? familyById.get(familyId)?.primaryContact?.name ?? familyId,
        status: record?.status ?? "(no billing record)",
        curTotal, newTotal, delta: newTotal - curTotal, perSub,
      });
    }
  }

  report({ rows, warnZeroEvents, warnReprice, warnInvoiced, warnNoFamily, warnDoubleCount,
    meta: { PROJECT, periodKeys, nExcluded, nMods, tripRate, studyRate,
      schoolYearEnd: schoolYearEnd ? isoOf(schoolYearEnd) : null, realEvents: realEvents.length } });

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ rows, warnZeroEvents, warnReprice, warnInvoiced, warnNoFamily, warnDoubleCount }, null, 2));
    console.log(`\nJSON written to ${JSON_OUT}`);
  }
}

function report({ rows, warnZeroEvents, warnReprice, warnInvoiced, warnNoFamily, warnDoubleCount, meta }) {
  const line = (s = "") => console.log(s);
  line("=".repeat(80));
  line(`RECONCILIATION REPORT — DRY RUN, READ-ONLY — project: ${meta.PROJECT}`);
  line("=".repeat(80));
  line(`trip rate EUR ${meta.tripRate}/occurrence | study rate EUR ${meta.studyRate}/occurrence`);
  line(`school year end: ${meta.schoolYearEnd ?? "UNSET"} | existing reservationEvents: ${meta.realEvents}`);
  line(`historical absences migrated into the simulation: ${meta.nExcluded} excludedDates + ${meta.nMods} eventModifications`);
  line(`periods: ${meta.periodKeys.join(", ")}`);

  for (const periodKey of meta.periodKeys) {
    const pr = rows.filter(r => r.periodKey === periodKey);
    if (!pr.length) continue;
    const changed = pr.filter(r => Math.abs(r.delta) >= 0.005);
    const shown = CHANGED_ONLY ? changed : pr;
    line(`\n${"─".repeat(80)}`);
    line(`## ${periodKey} — ${pr.length} families, ${changed.length} change, ${pr.length - changed.length} unchanged`);
    line("─".repeat(80));
    line(`${"Family".padEnd(30)}${"current".padStart(10)}${"new".padStart(10)}${"delta".padStart(10)}  status`);
    for (const r of shown.sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name))) {
      line(`${String(r.name).slice(0, 29).padEnd(30)}${r.curTotal.toFixed(2).padStart(10)}${r.newTotal.toFixed(2).padStart(10)}${(r.delta >= 0 ? "+" : "") + r.delta.toFixed(2)}`.padEnd(60) + `  ${r.status}`);
      for (const s of r.perSub) {
        line(`    ${(s.childName ?? s.subscriptionId).toString().slice(0, 28).padEnd(30)}`
          + `${s.before == null ? "—" : s.before.toFixed(2)} → ${s.after == null ? "—" : s.after.toFixed(2)}`.padStart(18)
          + `   ${s.reason}`);
      }
    }
    const tc = pr.reduce((s, r) => s + r.curTotal, 0), tn = pr.reduce((s, r) => s + r.newTotal, 0);
    line(`${"TOTAL".padEnd(30)}${tc.toFixed(2).padStart(10)}${tn.toFixed(2).padStart(10)}${((tn - tc >= 0 ? "+" : "") + (tn - tc).toFixed(2)).padStart(10)}`);
  }

  line(`\n${"=".repeat(80)}`);
  line("FLAGS");
  line("=".repeat(80));

  line(`\n(a) Active subscription with ZERO events in a billable period — bills EUR 0 silently (${warnZeroEvents.length})`);
  // Grouped by period+cause: one school-year-end cliff is 28 identical rows
  // that say one thing, and printing them one per line buries it.
  const zeroGroups = new Map();
  for (const w of warnZeroEvents) {
    const k = `${w.periodKey}|${w.why}`;
    if (!zeroGroups.has(k)) zeroGroups.set(k, { ...w, subs: [], withRecord: 0 });
    const g = zeroGroups.get(k);
    g.subs.push(w.subId);
    if (w.hasRecord) g.withRecord++;
  }
  for (const g of [...zeroGroups.values()].sort((a, b) => b.subs.length - a.subs.length)) {
    line(`    ${g.periodKey}  ${g.subs.length} subscription(s), ${g.withRecord} with an existing billing record — ${g.why}`);
    if (g.subs.length <= 6) for (const id of g.subs) line(`        ${id}`);
  }
  if (!warnZeroEvents.length) line("    none.");

  line(`\n(b) Frozen basePriceCents diverges from the live config rate — a mid-year reprice (${warnReprice.length})`);
  for (const w of warnReprice.slice(0, 40)) line(`    ${w.periodKey}  ${w.type.padEnd(9)} ${w.subId}  frozen ${eur(w.frozenCents)} vs live ${eur(w.liveCents)}`);
  if (!warnReprice.length) {
    line(meta.realEvents === 0
      ? "    not applicable yet — there are no reservationEvents in this project, so no frozen price exists"
      + " to diverge. This check goes live once Phase 2 has generated events."
      : "    none — every existing event's frozen price matches the live rate.");
  }

  line(`\n(c) INVOICED periods that diverge — FROZEN, reported only, never recomputed (${warnInvoiced.length})`);
  for (const w of warnInvoiced) line(`    ${w.periodKey}  ${w.name ?? w.familyId}  invoiced ${w.curTotal.toFixed(2)} vs computed ${w.newTotal.toFixed(2)}  (${(w.delta >= 0 ? "+" : "") + w.delta.toFixed(2)})`);
  if (!warnInvoiced.length) line("    none.");

  const dcSeen = new Set();
  const dcUnique = warnDoubleCount.filter(w => { const k = `${w.subId}|${w.ruleId}`; if (dcSeen.has(k)) return false; dcSeen.add(k); return true; });
  line(`\n(e) AUTO rule stored with appliedBy "admin" — applied once (label is wrong, arithmetic is not) (${dcUnique.length} subscription/rule pairs)`);
  for (const w of dcUnique) line(`    ${w.type.padEnd(9)} ${w.subId}  ${w.childName ?? "?"} — "${w.ruleName}" (${w.trigger}, ${(w.pct * 100).toFixed(0)}%)`);
  if (!dcUnique.length) line("    none.");

  line(`\n(d) Active subscriptions with no familyId — generate no events at all (${warnNoFamily.length})`);
  for (const w of warnNoFamily) line(`    ${w.type.padEnd(9)} ${w.id}  ${w.childName ?? "?"}  ${w.contactEmail ?? "no email"}`);

  line(`\nNothing was written. This report is advisory; Phase 5 applies changes.`);
}

main().catch(e => { console.error(e); process.exit(1); });
