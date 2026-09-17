// functions/src/orgDataTools.ts
import * as admin from "firebase-admin";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";

if (!admin.apps.length) admin.initializeApp();
// Terraform's region (functions.tf) only defines an infrastructure shell with
// dummy source — it is NOT where these functions actually run. They were
// first deployed via `firebase deploy` with no region in code, which silently
// defaulted them to us-central1; that's the real, live deployment (confirmed
// via `firebase functions:list`). Explicit us-central1 below matches reality,
// not Terraform's europe-west3, which is an inert placeholder for these three.
setGlobalOptions({ maxInstances: 5 });
const db = admin.firestore();

const ALL_COLLECTIONS = [
  "people",
  "companies",
  "accounts",
  "categories",
  "templates",
  "plannedInstances",
  "ledgerTransactions",
] as const;
type Col = (typeof ALL_COLLECTIONS)[number];

const colRef = (orgId: string, col: Col) =>
  db.collection("orgs").doc(orgId).collection(col);

const settingsRef = (orgId: string) =>
  db.collection("orgs").doc(orgId).collection("settings").doc("globals");

function ensureAuth(req: CallableRequest<unknown>) {
  // If you want to allow unauthenticated, remove this.
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "Sign in required.");
}

function isWireTimestamp(v: any): v is { seconds: number; nanoseconds: number } {
  return v && typeof v === "object" &&
    typeof v.seconds === "number" &&
    typeof v.nanoseconds === "number";
}

/** Deep convert wire timestamps back to admin.firestore.Timestamp */
function reviveTimestamps(input: any): any {
  if (Array.isArray(input)) return input.map(reviveTimestamps);
  if (isWireTimestamp(input)) {
    return new admin.firestore.Timestamp(input.seconds, input.nanoseconds);
  }
  if (input && typeof input === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(input)) out[k] = reviveTimestamps(v);
    return out;
  }
  return input;
}

/** Remove undefined recursively (Firestore rejects undefined) */
function pruneUndefined(input: any): any {
  if (Array.isArray(input)) return input.map(pruneUndefined);
  if (input && typeof input === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) out[k] = pruneUndefined(v);
    }
    return out;
  }
  return input;
}

/* --------------------------------- EXPORT --------------------------------- */
export const exportOrgData = onCall<{ orgId?: string; collections?: Col[] }>(
  { region: "us-central1" },
  async (req) => {
    ensureAuth(req);
    const { orgId, collections } = req.data || {};
    if (!orgId) throw new HttpsError("invalid-argument", "orgId is required");

    const cols: Col[] =
      collections && collections.length
        ? (collections.filter((c: any) =>
          (ALL_COLLECTIONS as readonly string[]).includes(c)
        ) as Col[])
        : [...ALL_COLLECTIONS]; // <-- spread to turn readonly tuple into mutable array

    const result: Record<string, any[]> = {};
    for (const c of cols) {
      const snap = await colRef(orgId, c).get();
      result[c] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
    const s = await settingsRef(orgId).get();
    result["__settings__"] = s.exists ? [{ id: "globals", ...s.data() }] : [];
    return result;
  }
);

/* --------------------------------- IMPORT --------------------------------- */
export const importOrgData = onCall<{
  orgId?: string;
  data?: Record<string, any[]>;
  options?: { keepIds?: boolean; merge?: boolean; collections?: Col[] };
}>({ region: "us-central1" }, async (req) => {
  ensureAuth(req);

  const orgId = req.data?.orgId;
  const payload = req.data?.data;
  const options = req.data?.options;
  if (!orgId) throw new HttpsError("invalid-argument", "orgId is required");
  if (!payload || typeof payload !== "object")
    throw new HttpsError("invalid-argument", "data (JSON) is required");

  const keepIds = !!options?.keepIds;
  const merge = options?.merge ?? true;
  const onlyCols: Col[] | null = options?.collections
    ? (options.collections.filter((c: any) =>
      (ALL_COLLECTIONS as readonly string[]).includes(c)
    ) as Col[])
    : null;

  const imported: Col[] = [];

  for (const c of ALL_COLLECTIONS) {
    if (!(c in payload)) continue;
    if (onlyCols && !onlyCols.includes(c)) continue;

    const rows: any[] = Array.isArray(payload[c]) ? payload[c] : [];
    if (!rows.length) continue;

    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const batch = db.batch();
      for (const raw of chunk) {
        const { id, ...rest } = raw || {};
        const revived = reviveTimestamps(rest);
        const clean = pruneUndefined(revived);

        if (keepIds && id) {
          const ref = colRef(orgId, c).doc(id);
          if (merge) batch.set(ref, clean, { merge: true });
          else batch.set(ref, clean, { merge: false });
        } else {
          const ref = colRef(orgId, c).doc();
          batch.set(ref, clean, { merge: false });
        }
      }
      await batch.commit();
    }

    imported.push(c);
  }

  if (payload["__settings__"]?.[0]) {
    const { id, ...rest } = payload["__settings__"][0];
    const revived = reviveTimestamps(rest);
    const clean = pruneUndefined(revived);
    await settingsRef(orgId).set(clean, { merge: true });
  }

  return { imported };
});

/* ---------------------------------- WIPE ---------------------------------- */
export const wipeOrgData = onCall<{ orgId?: string; collections?: Col[]; alsoSettings?: boolean }>(
  { region: "us-central1" },
  async (req) => {
    ensureAuth(req);

    const { orgId, collections, alsoSettings } = req.data || {};
    if (!orgId) throw new HttpsError("invalid-argument", "orgId is required");
    const cols = (collections || []).filter((c): c is Col =>
      (ALL_COLLECTIONS as readonly string[]).includes(c as string)
    );
    if (!cols.length)
      throw new HttpsError("invalid-argument", "Pick at least one collection to delete");

    for (const c of cols) {
      const snap = await colRef(orgId, c).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const chunk = snap.docs.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }

    if (alsoSettings) {
      await settingsRef(orgId).delete().catch(() => { });
    }

    return { wiped: cols, settingsDeleted: !!alsoSettings };
  }
);