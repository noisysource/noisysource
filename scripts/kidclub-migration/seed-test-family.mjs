#!/usr/bin/env node
/**
 * Seeds a synthetic QA family on kidclub-dev that exercises every discount and
 * credit rule at once, so Phase 4 validation does not have to borrow a real
 * family (and then remember to put it back).
 *
 * DEV ONLY. --apply against any other project is refused outright, with no
 * override flag. Nothing here should ever exist in prod.
 *
 *   node seed-test-family.mjs                 # dry run
 *   node seed-test-family.mjs --apply         # create
 *   node seed-test-family.mjs --delete --apply  # remove every TEST- document
 *
 * ── Why every document is marked, and why the ids start with TEST- ──
 *
 * Decision 16 is "import dev into prod". Synthetic data is exactly what must
 * not travel that path, and "we'll remember to exclude it" is not a control.
 * So every document this creates carries `isTestData: true` AND a document id
 * prefixed `TEST-`: one is queryable, the other is visible in any console
 * listing and in an export's file names. Either alone is enough to exclude
 * them; both together make an accidental promotion hard to do quietly.
 *
 * ── What it covers ──
 *
 *   Ana   (enrolled first)  transport 5 legs, 2 on Monday  -> multi-trip, school
 *                           study 2 days                    -> no sibling (rank 1)
 *   Bruno (enrolled second) transport 4 legs, 2 on Monday  -> multi-trip, school, sibling
 *                           study 2 days + manual 15%       -> manual vs returningStudent
 *   Carla (enrolled third)  transport starts mid-October    -> decision 8 boundary month
 *
 * Absences are pre-set deliberately either side of the >=3 threshold: Ana's
 * transport gets 2 (one more click turns the credit ON) and Bruno's study gets
 * 3 (already crediting). Both states are then observable at the same time.
 */

import { execSync } from "node:child_process";

const DEV = "kidclub-dev";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const PROJECT = opt("--project", DEV);
const APPLY = flag("--apply");
const DELETE = flag("--delete");
const PARENT_UID = opt("--parent-uid", "M1Hp6oQo6yUaGBLCszouR5o0Heq2");
const PARENT_EMAIL = "parent-test@kidclub.pt";

if (APPLY && PROJECT !== DEV) {
  console.error(`Refusing to --apply against "${PROJECT}". This seeds synthetic data; it is ${DEV} only.`);
  process.exit(1);
}

const TOKEN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/_apps/arcoiris`;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
  return { stringValue: String(v) };
}

let n = 0;
async function put(coll, id, obj) {
  n++;
  console.log(`  ${APPLY ? "WRITE " : "would write"}  ${coll}/${id}`);
  if (!APPLY) return;
  const body = JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encode(v)])) });
  const res = await fetch(`${ROOT}/${coll}?documentId=${encodeURIComponent(id)}`, { method: "POST", headers: H, body });
  if (res.status === 409) {                                   // already exists -> overwrite
    const r2 = await fetch(`${ROOT}/${coll}/${id}`, { method: "PATCH", headers: H, body });
    if (!r2.ok) throw new Error(`PATCH ${coll}/${id}: ${r2.status} ${await r2.text()}`);
    return;
  }
  if (!res.ok) throw new Error(`CREATE ${coll}/${id}: ${res.status} ${await res.text()}`);
}

const SCHOOL = "Colégio Bissaya Barreto";           // matches the auto_school rule exactly
const PICKUP = "Lidl Santa Clara, Rua Lagar, Coimbra, Portugal";
const MARK = { isTestData: true, testNote: "SYNTHETIC — Phase 4 QA. Never promote to prod." };

const FAMILY = "TEST-FAMILY-QA";
const KIDS = {
  ana:   { id: "TEST-CHILD-ANA",   first: "Ana",   last: "Teste", age: 10, dob: new Date("2016-03-04T00:00:00Z"), enrolled: new Date("2026-09-01T09:00:00Z") },
  bruno: { id: "TEST-CHILD-BRUNO", first: "Bruno", last: "Teste", age: 8,  dob: new Date("2018-06-11T00:00:00Z"), enrolled: new Date("2026-09-02T09:00:00Z") },
  carla: { id: "TEST-CHILD-CARLA", first: "Carla", last: "Teste", age: 12, dob: new Date("2014-01-20T00:00:00Z"), enrolled: new Date("2026-09-03T09:00:00Z") },
};

const leg = (dayOfWeek, pickupTime, toSchool = true) => ({
  dayOfWeek, pickupTime,
  pickupLocation: toSchool ? PICKUP : SCHOOL,
  dropoffLocation: toSchool ? SCHOOL : PICKUP,
});

async function seed() {
  console.log(`\nSeeding QA family on ${PROJECT} — parent ${PARENT_EMAIL} (${PARENT_UID})\n`);

  await put("families", FAMILY, {
    ...MARK,
    primaryContact: { name: "Família Teste QA", email: PARENT_EMAIL, phone: "910000000", userId: PARENT_UID },
    status: "active", profileComplete: true,
    nif: "999999990",
    billingAddress: { street: "Rua de Teste 1", city: "Coimbra", postalCode: "3000-000", country: "Portugal" },
    createdAt: new Date(), updatedAt: new Date(),
    notes: "Synthetic QA family for Phase 4 validation. Every document is marked isTestData.",
  });

  for (const k of Object.values(KIDS)) {
    await put("children", k.id, {
      ...MARK,
      firstName: k.first, lastName: k.last, age: k.age, dateOfBirth: k.dob,
      familyId: FAMILY, schoolName: SCHOOL, schoolYear: "2026/2027", status: "active",
      contactEmail: PARENT_EMAIL, userId: PARENT_UID,
      homeAddress: { street: "Rua de Teste 1", city: "Coimbra", postalCode: "3000-000", country: "Portugal" },
      createdAt: k.enrolled, updatedAt: k.enrolled,
    });
  }

  const commonSub = (kid) => ({
    ...MARK,
    familyId: FAMILY, childId: kid.id, childName: `${kid.first} ${kid.last}`,
    contactEmail: PARENT_EMAIL, contactName: "Família Teste QA",
    schoolName: SCHOOL, status: "active", weekPattern: "all",
    userId: PARENT_UID, source: "web", enrollmentFeeBilled: true,
    createdAt: kid.enrolled, updatedAt: new Date(),
    approvedAt: kid.enrolled, acceptedAt: kid.enrolled,
  });

  // Two legs on Monday and on Wednesday: a genuine pickup AND return, which is
  // what makes multi-trip fire marginally (first leg of a day full price, the
  // rest discounted) rather than discounting the whole day.
  await put("transportationSubscriptions", "TEST-SUB-TR-ANA", {
    ...commonSub(KIDS.ana),
    contactMobile: "910000000",
    startDate: "2026-09-01",
    schedule: [leg("monday", "08:00"), leg("monday", "17:00", false),
               leg("wednesday", "08:00"), leg("wednesday", "17:00", false),
               leg("friday", "08:00")],
    monthlyFee: 120, childAge: KIDS.ana.age,
  });

  await put("transportationSubscriptions", "TEST-SUB-TR-BRUNO", {
    ...commonSub(KIDS.bruno),
    contactMobile: "910000000",
    startDate: "2026-09-02",
    schedule: [leg("monday", "08:00"), leg("monday", "17:00", false),
               leg("wednesday", "08:00"), leg("wednesday", "17:00", false)],
    monthlyFee: 96, childAge: KIDS.bruno.age,
  });

  // Decision 8: a subscription starting mid-month bills the full month, with
  // the pre-start occurrences written as system CANCELLED so the >=3-absence
  // credit pro-rates it. Mid-October start makes that visible in one screen.
  await put("transportationSubscriptions", "TEST-SUB-TR-CARLA", {
    ...commonSub(KIDS.carla),
    contactMobile: "910000000",
    startDate: "2026-10-15",
    schedule: [leg("tuesday", "08:00"), leg("thursday", "08:00")],
    monthlyFee: 48, childAge: KIDS.carla.age,
  });

  await put("studyroom", "TEST-SUB-ST-ANA", {
    ...commonSub(KIDS.ana),
    studentName: `${KIDS.ana.first} ${KIDS.ana.last}`, guardianName: "Família Teste QA",
    email: PARENT_EMAIL, contactPhone: "910000000", phone: "910000000",
    schoolYear: "2026/2027", startDate: new Date("2026-09-01T09:00:00Z"),
    days: [{ day: "tuesday", hour: "16:00" }, { day: "thursday", hour: "16:00" }],
    basePrice: 48, monthlyPrice: 48, canceled: false,
    appliedDiscounts: [], entryHistory: [], statusHistory: [], uploadedFiles: [],
  });

  // The manual "Aluno do ano anterior" 15%: reconcileService takes max() of it
  // and returningStudentDiscountPct rather than summing, which is the latent
  // 30% stack that was closed. This subscription is where that stays honest.
  await put("studyroom", "TEST-SUB-ST-BRUNO", {
    ...commonSub(KIDS.bruno),
    studentName: `${KIDS.bruno.first} ${KIDS.bruno.last}`, guardianName: "Família Teste QA",
    email: PARENT_EMAIL, contactPhone: "910000000", phone: "910000000",
    schoolYear: "2026/2027", startDate: new Date("2026-09-02T09:00:00Z"),
    days: [{ day: "tuesday", hour: "16:00" }, { day: "thursday", hour: "16:00" }],
    basePrice: 48, monthlyPrice: 48, canceled: false,
    appliedDiscounts: [{ ruleId: "s30pd55f", name: "Aluno do ano anterior", percentage: 0.15,
                         appliedBy: "admin", appliedAt: new Date() }],
    entryHistory: [], statusHistory: [], uploadedFiles: [],
  });

  console.log(`\n${n} document(s) ${APPLY ? "written" : "planned"}.`);
  console.log(APPLY
    ? `\nThe subscription triggers now generate reservationEvents. Wait ~60s, then run:\n`
      + `  node set-test-absences.mjs --apply\n`
      + `to place absences either side of the >=3 threshold.`
    : `\nDRY RUN — nothing written.`);
}

async function wipe() {
  console.log(`\nDeleting TEST- documents from ${PROJECT}\n`);
  const targets = [
    ["families", [FAMILY]],
    ["children", Object.values(KIDS).map(k => k.id)],
    ["transportationSubscriptions", ["TEST-SUB-TR-ANA", "TEST-SUB-TR-BRUNO", "TEST-SUB-TR-CARLA"]],
    ["studyroom", ["TEST-SUB-ST-ANA", "TEST-SUB-ST-BRUNO"]],
  ];
  // Subscriptions first: deleting one fires voidFutureEvents, and the billing
  // records follow from the family. Events themselves are cleaned below.
  for (const [coll, ids] of targets.reverse()) {
    for (const id of ids) {
      n++;
      console.log(`  ${APPLY ? "DELETE" : "would delete"}  ${coll}/${id}`);
      if (APPLY) await fetch(`${ROOT}/${coll}/${id}`, { method: "DELETE", headers: H });
    }
  }
  for (const coll of ["reservationEvents", "billing"]) {
    const res = await fetch(`${ROOT}:runQuery`, {
      method: "POST", headers: H,
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: coll }],
        where: { fieldFilter: { field: { fieldPath: "familyId" }, op: "EQUAL", value: { stringValue: FAMILY } } },
      } }),
    });
    const rows = (await res.json()).filter(r => r.document).map(r => r.document.name);
    console.log(`  ${APPLY ? "DELETE" : "would delete"}  ${rows.length} ${coll} document(s) for ${FAMILY}`);
    for (const name of rows) {
      n++;
      if (APPLY) await fetch(`https://firestore.googleapis.com/v1/${name.replace("https://firestore.googleapis.com/v1/", "")}`, { method: "DELETE", headers: H });
    }
  }
  console.log(`\n${n} deletion(s) ${APPLY ? "performed" : "planned"}.`);
}

await (DELETE ? wipe() : seed());
