#!/usr/bin/env node
/**
 * Places absences on the QA family either side of the >=3 credit threshold, so
 * both states are observable at once:
 *
 *   TEST-SUB-TR-ANA    2 absences  -> credit OFF. One more click turns it ON.
 *   TEST-SUB-ST-BRUNO  3 absences  -> credit ON, already crediting.
 *
 * DEV ONLY, same refusal as seed-test-family.mjs.
 *
 * Absences are written with changedByRole "parent", which is what a parent
 * marking a day actually produces — and what isHumanRecorded() protects from
 * being voided by a later regeneration. Writing them as "system" would leave
 * them one schedule edit away from silently disappearing, which is the whole
 * bug class this rewrite exists to fix.
 */

import { execSync } from "node:child_process";

const DEV = "kidclub-dev";
const args = process.argv.slice(2);
const PROJECT = args.includes("--project") ? args[args.indexOf("--project") + 1] : DEV;
const APPLY = args.includes("--apply");
const RESET = args.includes("--reset");
// Absences must land in ONE billing period or the >=3 threshold test is
// meaningless: the credit is evaluated per subscription per month, so 2 in
// September plus 1 in October is two sub-threshold months, not one qualifying
// one. Defaults to the next full month, which is always safely in the future.
const PERIOD = args.includes("--period")
  ? args[args.indexOf("--period") + 1]
  : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().slice(0, 7);

if (APPLY && PROJECT !== DEV) {
  console.error(`Refusing to --apply against "${PROJECT}". ${DEV} only.`);
  process.exit(1);
}

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/_apps/arcoiris`;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const WANT = { "TEST-SUB-TR-ANA": 2, "TEST-SUB-ST-BRUNO": 3 };

async function eventsFor(subId) {
  const res = await fetch(`${ROOT}:runQuery`, {
    method: "POST", headers: H,
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "reservationEvents" }],
      where: { fieldFilter: { field: { fieldPath: "subscriptionId" }, op: "EQUAL", value: { stringValue: subId } } },
    } }),
  });
  return (await res.json()).filter(r => r.document).map(r => ({
    id: r.document.name.split("/").pop(),
    date: r.document.fields?.date?.stringValue,
    status: r.document.fields?.status?.stringValue,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

let n = 0;
for (const [subId, want] of Object.entries(WANT)) {
  const all = await eventsFor(subId);
  if (!all.length) {
    console.log(`  ${subId}: no events yet — the trigger may still be generating. Wait and re-run.`);
    continue;
  }
  const cancelled = all.filter(e => e.status === "CANCELLED");
  // Future days only: an absence is a cancellation, and cancelling a day that
  // has already passed is a different (and currently unguarded) operation.
  const todayIso = new Date().toISOString().slice(0, 10);
  const future = all.filter(e => e.status === "EXPECTED" && e.date > todayIso && e.date.startsWith(PERIOD));

  if (RESET) {
    console.log(`  ${subId}: restoring ${cancelled.length} cancelled event(s) to EXPECTED`);
    for (const e of cancelled) {
      n++;
      if (APPLY) await fetch(`${ROOT}/reservationEvents/${e.id}?updateMask.fieldPaths=status&updateMask.fieldPaths=changedByRole&updateMask.fieldPaths=reason`,
        { method: "PATCH", headers: H, body: JSON.stringify({ fields: { status: { stringValue: "EXPECTED" } } }) });
    }
    continue;
  }

  const inPeriod = cancelled.filter(e => e.date.startsWith(PERIOD));
  const need = want - inPeriod.length;
  console.log(`  ${subId}: ${all.length} events, ${inPeriod.length} cancelled in ${PERIOD}, target ${want} -> ${need > 0 ? `marking ${need}` : "nothing to do"}`);
  for (const e of future.slice(0, Math.max(0, need))) {
    n++;
    console.log(`      ${APPLY ? "CANCEL" : "would cancel"}  ${e.date}  (${e.id})`);
    if (APPLY) {
      const res = await fetch(`${ROOT}/reservationEvents/${e.id}?updateMask.fieldPaths=status&updateMask.fieldPaths=changedByRole&updateMask.fieldPaths=reason&updateMask.fieldPaths=changedAt`,
        { method: "PATCH", headers: H, body: JSON.stringify({ fields: {
          status: { stringValue: "CANCELLED" },
          changedByRole: { stringValue: "parent" },
          reason: { stringValue: "QA seed — parent-recorded absence" },
          changedAt: { timestampValue: new Date().toISOString() },
        } }) });
      if (!res.ok) throw new Error(`${e.id}: ${res.status} ${await res.text()}`);
    }
  }
}
console.log(`\n${n} event(s) ${APPLY ? "updated" : "planned"}.${APPLY ? "" : " DRY RUN."}`);
