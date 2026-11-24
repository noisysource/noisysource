// Club-wide closures: the admin callable and the sync that applies a closure
// list to every family's reservation events. The rules are in closureLogic.ts.
//
// Flow (setClubClosures): validate -> write config/closures -> syncClubClosures:
//   1. every event dated inside a closure becomes a closure absence;
//   2. every closure absence no longer inside one is put back;
//   3. each family with a changed event has its bills recomputed ONCE.
// The event writes carry a fresh `closureSyncId`, which is how
// onReservationEventBillingSync knows not to recompute per event (billing.ts,
// eventChangeNeedsBillingSync). New and edited subscriptions get their closure
// days from the generators (reservationEvents.ts), which read the same list.

import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { appCol } from "./db";
import { autoCreateBillingSchedule } from "./billing";
import { REASON_AFTER_END, REASON_BEFORE_START, coerceEndDate, coerceStartDate } from "./reservationEvents";
import { Closure, ClosureSyncEvent, ClosureSyncSub, REASON_CLOSED, closureSyncAction, validateClosures } from "./closureLogic";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const REGION = "europe-west3";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const CANCELLED_SUB_STATUSES = new Set(["cancelled", "canceled"]);

/** What restoring a day needs to know about its subscription (closureLogic.ts). */
export function subForClosureSync(sub: any | undefined): ClosureSyncSub | undefined {
  if (!sub) return undefined;
  const active = !CANCELLED_SUB_STATUSES.has(sub.status);
  const start = coerceStartDate(sub.startDate);
  // A cancelled subscription was served up to the day before it was cancelled
  // (reservationEvents.ts closes it out from the cancellation day on).
  const cancelledAt = active ? null : coerceStartDate(sub.cancelledAt);
  const lastServed = cancelledAt ? new Date(cancelledAt.getFullYear(), cancelledAt.getMonth(), cancelledAt.getDate() - 1) : null;
  const ownEnd = coerceEndDate(sub.endDate);
  const end = lastServed && ownEnd ? (lastServed < ownEnd ? lastServed : ownEnd) : (lastServed ?? ownEnd);
  return { active, ...(start ? { start: iso(start) } : {}), ...(end ? { end: iso(end) } : {}) };
}

export interface ClosureSyncResult {
  /** Events turned into closure days. */
  closed: number;
  /** Closure days put back (the closure was removed or shortened). */
  reopened: number;
  /** Families whose bills were recomputed. */
  families: number;
  /** Families whose recompute failed: their events are right, their bills are not yet. */
  failedFamilies: string[];
}

// How many families are recomputed at the same time. Each recompute reads and
// writes about a dozen bills; a handful in parallel keeps a whole club (some
// tens of families) well inside the function's time limit without a burst of
// writes.
const RECOMPUTE_CONCURRENCY = 4;

async function loadSubs(collection: "studyroom" | "transportationSubscriptions", ids: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 100) {
    const snaps = await Promise.all(ids.slice(i, i + 100).map(id => appCol(collection).doc(id).get()));
    for (const s of snaps) if (s.exists) out.set(s.id, s.data());
  }
  return out;
}

export async function syncClubClosures(closures: Closure[]): Promise<ClosureSyncResult> {
  // Everything that might change: the events inside each closure, and the
  // events currently marked closed (to reopen the ones no longer covered).
  const snaps = await Promise.all([
    ...closures.map(c => appCol("reservationEvents").where("date", ">=", c.from).where("date", "<=", c.to).get()),
    appCol("reservationEvents").where("reason", "==", REASON_CLOSED).get(),
  ]);
  const events = new Map<string, any>();
  for (const snap of snaps) for (const d of snap.docs) events.set(d.id, { id: d.id, ...d.data() });

  // Subscriptions are only needed to reopen a day.
  const toReopen = [...events.values()].filter(e => e.reason === REASON_CLOSED);
  const idsOf = (type: string) => [...new Set(toReopen.filter(e => e.subscriptionType === type).map(e => String(e.subscriptionId)))];
  const [study, transport] = await Promise.all([
    loadSubs("studyroom", idsOf("study")),
    loadSubs("transportationSubscriptions", idsOf("transport")),
  ]);

  const syncId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const del = admin.firestore.FieldValue.delete();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const writes: { id: string; data: Record<string, unknown> }[] = [];
  const families = new Set<string>();
  let closed = 0, reopened = 0;

  for (const e of events.values()) {
    const sub = (e.subscriptionType === "study" ? study : transport).get(String(e.subscriptionId));
    const action = closureSyncAction(e as ClosureSyncEvent, closures, subForClosureSync(sub),
      { beforeStart: REASON_BEFORE_START, afterEnd: REASON_AFTER_END });
    if (action.kind === "none") continue;
    if (action.kind === "close") {
      writes.push({
        id: e.id,
        data: {
          status: "CANCELLED", changedByRole: "system", reason: REASON_CLOSED, changedBy: del, changedAt: now,
          preClosure: action.keep ?? del, closureSyncId: syncId,
        },
      });
      closed++;
    } else {
      writes.push({
        id: e.id,
        data: {
          status: action.status,
          changedByRole: action.changedByRole ?? del,
          changedBy: action.changedBy ?? del,
          reason: action.reason ?? del,
          changedAt: action.changedAt ?? (action.changedByRole ? now : del),
          preClosure: del, closureSyncId: syncId,
        },
      });
      reopened++;
    }
    if (e.familyId) families.add(String(e.familyId));
  }

  const CHUNK = 400; // Firestore batch limit is 500
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) batch.update(appCol("reservationEvents").doc(w.id), w.data);
    await batch.commit();
  }

  // One recompute per family, after every event is in place.
  const failedFamilies: string[] = [];
  const queue = [...families];
  const worker = async () => {
    for (let familyId = queue.shift(); familyId; familyId = queue.shift()) {
      try {
        await autoCreateBillingSchedule(familyId);
      } catch (err) {
        failedFamilies.push(familyId);
        console.error(`[closures] recomputing family ${familyId}'s bills failed; its events are already updated.`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECOMPUTE_CONCURRENCY, queue.length) }, worker));

  console.log(`[closures] sync ${syncId}: ${closed} closed, ${reopened} reopened, ${families.size} families, ${failedFamilies.length} failed`);
  return { closed, reopened, families: families.size, failedFamilies };
}

/**
 * Admin: replace the list of closures and apply it. Sending the list unchanged
 * is the "apply again" button: the sync is idempotent, and it is how a run that
 * was cut short is finished.
 */
export const setClubClosures = onCall(
  { region: REGION, invoker: "public", timeoutSeconds: 540, memory: "512MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new HttpsError("permission-denied", "Unauthorized");

    const checked = validateClosures(request.data?.closures);
    if ("error" in checked) throw new HttpsError("invalid-argument", checked.error);

    await appCol("config").doc("closures").set({
      closures: checked.closures,
      updatedBy: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const result = await syncClubClosures(checked.closures);
    return { closures: checked.closures, ...result };
  }
);
