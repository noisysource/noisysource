/**
 * Exercises the PARENT path end to end without a browser.
 *
 * Worth keeping and re-running: this is the check that would have caught the
 * original blocker — every parent in prod receives permission-denied, because
 * setReservationEventStatus authorised against a top-level `userId` that no
 * family document has. Nothing in the test suite covers it, because the bug is
 * in the interaction between Auth, the callable and real data, not in any pure
 * function.
 *
 * Run it whenever auth, firestore.rules or the callable changes:
 *
 *   PARENT_TEST_PASSWORD=... node scripts/kidclub-migration/parent-path-test.mjs
 *
 * It needs a roleless dev account, because setReservationEventStatus checks
 * staff before it ever reaches the family check — all five human dev accounts
 * are staff, so none of them can exercise this path.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const env = readFileSync(`${ROOT}/apps/noisyphocus/kidclub/.env.staging`, "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const KEY = pick("VITE_FIREBASE_API_KEY");
const PROJECT = pick("VITE_FIREBASE_PROJECT_ID");
// Never hardcoded and never on a command line: export it for the run, or put
// it in a gitignored file you point PARENT_PASSWORD_FILE at.
const PASSWORD = process.env.PARENT_TEST_PASSWORD
  ?? (process.env.PARENT_PASSWORD_FILE ? readFileSync(process.env.PARENT_PASSWORD_FILE, "utf8").split("=").slice(1).join("=").trim() : null);
if (!PASSWORD) {
  console.error("Set PARENT_TEST_PASSWORD (or PARENT_PASSWORD_FILE) for parent-test@kidclub.pt.");
  process.exit(1);
}
const EMAIL = "parent-test@kidclub.pt";

console.log(`.env.staging project: ${PROJECT}`);
if (PROJECT !== "kidclub-dev") {
  console.error(`REFUSING: expected kidclub-dev, got ${PROJECT}. Not signing in against another project.`);
  process.exit(1);
}

const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
});
const auth = await signIn.json();
if (auth.error) { console.error("SIGN-IN FAILED:", auth.error.message); process.exit(1); }
console.log(`✅ signed in as ${auth.email} (uid ${auth.localId})`);
const ID = auth.idToken;

// Admin token, used only to READ back what the parent's call did.
const ADMIN = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const FS = `https://firestore.googleapis.com/v1/projects/kidclub-dev/databases/(default)/documents/_apps/arcoiris`;

async function readEvent(id) {
  const r = await fetch(`${FS}/reservationEvents/${id}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  if (!r.ok) return null;
  const f = (await r.json()).fields ?? {};
  return { status: f.status?.stringValue, role: f.changedByRole?.stringValue, date: f.date?.stringValue };
}

async function callAsParent(eventId, status) {
  const r = await fetch(`https://europe-west3-kidclub-dev.cloudfunctions.net/setReservationEventStatus`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ID}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { eventId, status } }),
  });
  const body = await r.json().catch(() => ({}));
  return { http: r.status, body };
}

// ── 1. The parent cancels a day on their OWN subscription ──────────────────
const OWN = "TEST-SUB-TR-ANA_2026-10-21_2";
console.log(`\n── Test 1: parent cancels their own occurrence (${OWN})`);
console.log("   before:", await readEvent(OWN));
let res = await callAsParent(OWN, "CANCELLED");
console.log(`   callable -> HTTP ${res.http}`, JSON.stringify(res.body).slice(0, 160));
const after = await readEvent(OWN);
console.log("   after :", after);
console.log(after?.status === "CANCELLED" && after?.role === "parent"
  ? "   ✅ PASS — stored as CANCELLED with changedByRole 'parent'"
  : "   ❌ FAIL");

// ── 2. The parent restores it ──────────────────────────────────────────────
console.log(`\n── Test 2: parent restores the same occurrence`);
res = await callAsParent(OWN, "EXPECTED");
console.log(`   callable -> HTTP ${res.http}`, JSON.stringify(res.body).slice(0, 160));
const restored = await readEvent(OWN);
console.log("   after :", restored);
console.log(restored?.status === "EXPECTED" ? "   ✅ PASS — restored" : "   ❌ FAIL");

// ── 3. 🔴 The parent tries ANOTHER family's occurrence ─────────────────────
// Carolina Almeida's real transport subscription. This must be refused.
const OTHER = "XiblZZlEVZHsSLFdN5z5_2026-10-21_2";
console.log(`\n── Test 3: parent attacks another family's occurrence (${OTHER})`);
const before3 = await readEvent(OTHER);
console.log("   before:", before3);
res = await callAsParent(OTHER, "CANCELLED");
console.log(`   callable -> HTTP ${res.http}`, JSON.stringify(res.body).slice(0, 200));
const after3 = await readEvent(OTHER);
console.log("   after :", after3);
const refused = res.http >= 400 && after3?.status === before3?.status;
console.log(refused
  ? "   ✅ PASS — refused, and the other family's data is unchanged"
  : "   ❌❌ CRITICAL FAIL — a parent modified another family's booking");

// ── 4. Firestore READ rules: can the parent read another family's events? ──
console.log(`\n── Test 4: parent tries to READ another family's events directly`);
const r4 = await fetch(`${FS}/reservationEvents/${OTHER}`, { headers: { Authorization: `Bearer ${ID}` } });
console.log(`   direct Firestore read -> HTTP ${r4.status}`);
console.log(r4.status === 403 || r4.status === 401
  ? "   ✅ PASS — read denied by firestore.rules"
  : `   ⚠️  read ALLOWED (HTTP ${r4.status}) — rules let any authenticated user read this`);
