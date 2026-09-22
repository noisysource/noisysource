import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const REGION = "europe-west3";

// ── Pure helpers ────────────────────────────────────────────────────────────
// Duplicated from packages/shared/models/weekPattern.ts — functions/ deploys
// as an isolated directory with no monorepo/pnpm-workspace context, so a real
// "@shared" runtime dependency isn't possible here (see billing.ts's own note
// on this). Keep in sync if that file's logic ever changes.

type WeekPattern = "all" | "odd" | "even";

export function weekOfMonthOccurrence(date: Date): number {
  return Math.ceil(date.getDate() / 7);
}

export function isActiveThisWeek(date: Date, pattern: WeekPattern): boolean {
  if (pattern === "all") return true;
  const occ = weekOfMonthOccurrence(date);
  if (occ === 5) return false;
  return pattern === "odd" ? occ % 2 === 1 : occ % 2 === 0;
}

const WEEKDAY_NUM: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const NUM_TO_WEEKDAY = Object.fromEntries(Object.entries(WEEKDAY_NUM).map(([k, v]) => [v, k]));

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Same per-occurrence rate convention used everywhere else in this codebase
// (StudyCenterConfig.pricePerDayPerWeek / TransportationConfig.flatRatePerTrip).
function studyPerDayRate(cfg: any): number {
  if (cfg?.pricePerDayPerWeek != null) return cfg.pricePerDayPerWeek;
  if (cfg?.monthlyPricePerWeekday != null) return cfg.monthlyPricePerWeekday / (cfg?.weeksPerMonth ?? 4);
  return 0;
}

// The two subscription collections disagree on how endDate is stored:
// StudyRoomEntry.endDate is a Date (a Firestore Timestamp once read back),
// TransportationSubscription.endDate is a "YYYY-MM-DD" string. Handle all
// three shapes. Getting this wrong is not loud: `new Date(timestampObject)`
// yields Invalid Date, every `cursor <= to` comparison against it is false,
// and generation returns zero events without throwing — which is exactly
// what shipped and left every study subscription with no occurrences.
// `startDate` has exactly the same three-way inconsistency, so both go through
// one coercer. The only difference is what a date-only "YYYY-MM-DD" string
// means: end-of-day for an end date (last day inclusive), start-of-day for a
// start date (first day inclusive).
export function coerceDate(raw: any, dateOnlyTime: "start" | "end"): Date | null {
  if (!raw) return null;
  // Firestore Timestamp (Admin SDK or client), duck-typed to avoid importing it
  if (typeof raw?.toDate === "function") {
    const d = raw.toDate();
    return isNaN(d.getTime()) ? null : d;
  }
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "string") {
    const suffix = dateOnlyTime === "end" ? "T23:59:59" : "T00:00:00";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}${suffix}`) : new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "number") {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  // Raw Firestore REST/JSON shape: { _seconds, _nanoseconds }
  if (typeof raw?._seconds === "number") {
    const d = new Date(raw._seconds * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function coerceEndDate(raw: any): Date | null {
  return coerceDate(raw, "end");
}

export function coerceStartDate(raw: any): Date | null {
  return coerceDate(raw, "start");
}

// Generation must never begin before the subscription itself starts. Without
// this, a study subscription starting 2026-10-01 picked up September
// occurrences (backfill starts at the current month's 1st) and was billed a
// month before the child ever attends. 19 of 21 active transport subs in prod
// carry no startDate at all — those must keep behaving exactly as before, i.e.
// fall back to the requested `from`.
export function resolveGenerationStart(sub: any, from: Date): Date {
  const subStart = coerceStartDate(sub?.startDate);
  return subStart && subStart > from ? subStart : from;
}

async function getSchoolYearEnd(): Promise<Date | null> {
  const snap = await appCol("config").doc("schoolCalendar").get();
  const yearEndDate = snap.data()?.yearEndDate;
  return yearEndDate ? new Date(`${yearEndDate}T23:59:59`) : null;
}

interface NewEvent {
  subscriptionId: string;
  subscriptionType: "study" | "transport";
  familyId: string;
  childId: string;
  date: string;
  direction?: "pickup" | "dropoff" | "both";
  legIndex?: number;
  basePriceCents: number;
  status: "EXPECTED";
  createdAt: admin.firestore.FieldValue;
}

// Deterministic doc ID so regeneration can never create a duplicate for the
// same occurrence — a rerun just overwrites (merge:false is fine, EXPECTED
// events are never hand-edited before their status is changed via the
// callable below).
// Transport ids are keyed by the schedule entry's INDEX, not its direction.
// No schedule entry in real data actually carries a `direction` field (0 of
// 109 on dev), so every leg falls back to "both" — and two legs on the same
// weekday then produce an identical id, where batch.set() silently overwrites
// one with the other. That left a two-leg day with a single occurrence:
// cancelling one leg cancelled both, and gross billed at half the trips with
// the multi-trip discount never firing. The index is stable because any
// schedule change regenerates all future events anyway.
export function eventDocId(subscriptionId: string, date: string, legIndex?: number): string {
  return legIndex === undefined ? `${subscriptionId}_${date}` : `${subscriptionId}_${date}_${legIndex}`;
}

// Every generated event copies `familyId` off the subscription, and
// onReservationEventBillingSync silently skips any event whose familyId is
// falsy. 6 active transport + 5 active study subscriptions in prod have no
// familyId at all, so they would have written a full school year of events
// that never bill and never surface anywhere. Refuse loudly instead — those
// subscriptions are being repaired separately.
function hasFamilyId(sub: any, subId: string, type: "study" | "transport"): boolean {
  if (sub?.familyId) return true;
  console.error(
    `[reservationEvents] ${type} subscription ${subId} has no familyId `
    + `(familyId=${JSON.stringify(sub?.familyId)}) — no events generated. `
    + `Events without a familyId are silently skipped by billing sync. `
    + `Link this subscription to a family.`
  );
  return false;
}

export function generateStudyEvents(sub: any, subId: string, ratePerDay: number, from: Date, to: Date): { id: string; data: NewEvent }[] {
  const out: { id: string; data: NewEvent }[] = [];
  if (!hasFamilyId(sub, subId, "study")) return out;
  const days: { day: string; hour: string }[] = sub.days ?? [];
  if (!days.length || ratePerDay <= 0) return out;
  const cursor = new Date(from);
  while (cursor <= to) {
    const weekday = NUM_TO_WEEKDAY[cursor.getDay()];
    if (days.some(d => d.day === weekday) && isActiveThisWeek(cursor, sub.weekPattern ?? "all")) {
      const date = isoDate(cursor);
      out.push({
        id: eventDocId(subId, date),
        data: {
          subscriptionId: subId, subscriptionType: "study", familyId: sub.familyId, childId: sub.childId,
          date, basePriceCents: Math.round(ratePerDay * 100), status: "EXPECTED",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function generateTransportEvents(sub: any, subId: string, ratePerTrip: number, from: Date, to: Date): { id: string; data: NewEvent }[] {
  const out: { id: string; data: NewEvent }[] = [];
  if (!hasFamilyId(sub, subId, "transport")) return out;
  const schedule: { dayOfWeek: string; direction?: string }[] = sub.schedule ?? [];
  if (!schedule.length || ratePerTrip <= 0) return out;
  // Keep each entry's position in the original schedule array — it's what
  // makes two same-day legs distinguishable (see eventDocId).
  const indexed = schedule.map((s, legIndex) => ({ ...s, legIndex }));
  const cursor = new Date(from);
  while (cursor <= to) {
    const weekday = NUM_TO_WEEKDAY[cursor.getDay()];
    const matches = indexed.filter(s => s.dayOfWeek === weekday);
    if (matches.length && isActiveThisWeek(cursor, sub.weekPattern ?? "all")) {
      const date = isoDate(cursor);
      for (const m of matches) {
        const direction = (m.direction ?? "both") as "pickup" | "dropoff" | "both";
        out.push({
          id: eventDocId(subId, date, m.legIndex),
          data: {
            subscriptionId: subId, subscriptionType: "transport", familyId: sub.familyId, childId: sub.childId,
            date, direction, legIndex: m.legIndex,
            basePriceCents: Math.round(ratePerTrip * 100), status: "EXPECTED",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

async function commitInChunks(writes: { id: string; data: any }[] | { id: string; status: string }[], mode: "create" | "void"): Promise<void> {
  const CHUNK = 400; // Firestore batch limit is 500 — leave headroom
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) {
      const ref = appCol("reservationEvents").doc(w.id);
      if (mode === "create") batch.set(ref, (w as any).data, { merge: true });
      else batch.update(ref, { status: (w as any).status, changedByRole: "system", changedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }
}

// Future (not-yet-elapsed) events for a subscription — regardless of current
// status — get voided when the subscription's schedule changes or it's
// cancelled. Already-elapsed events are never touched: this is precisely
// what lets a mid-month cancellation stop billing future occurrences without
// erasing what already happened earlier in the same month.
async function voidFutureEvents(subscriptionId: string, fromIso: string): Promise<void> {
  const snap = await appCol("reservationEvents")
    .where("subscriptionId", "==", subscriptionId)
    .where("date", ">=", fromIso)
    .get();
  if (snap.empty) return;
  await commitInChunks(snap.docs.map(d => ({ id: d.id, status: "VOIDED" })), "void");
}

// Resolves how far forward to generate: the earlier of the subscription's own
// end and the school year end; a missing endDate means "to the school year
// end" (see the fallback note above). Null when neither is knowable.
async function resolveGenerationEnd(sub: any, subId: string, type: string): Promise<Date | null> {
  const schoolYearEnd = await getSchoolYearEnd();
  const subEnd = coerceEndDate(sub.endDate);
  const to = subEnd && schoolYearEnd
    ? (subEnd < schoolYearEnd ? subEnd : schoolYearEnd)
    : (subEnd ?? schoolYearEnd);
  if (!to) {
    console.error(
      `[reservationEvents] ${type} subscription ${subId} has no usable end date `
      + `(endDate=${JSON.stringify(sub.endDate)}) and config/schoolCalendar.yearEndDate is unset `
      + `— no events generated. Set the school year end date.`
    );
    return null;
  }
  return to;
}

// Creates only the occurrences that don't exist yet, and never touches one
// that does. The backfill uses this rather than regenerateFutureEvents:
// commitInChunks writes with { merge: true } and a hardcoded status of
// "EXPECTED", so re-running a regenerate would quietly reset every CANCELLED
// day back to EXPECTED and wipe real absences.
async function ensureEventsExist(
  sub: any, subId: string, type: "study" | "transport",
  configs: { studyConfig: any; transportConfig: any }, requestedFrom: Date,
): Promise<number> {
  const from = resolveGenerationStart(sub, requestedFrom);
  const to = await resolveGenerationEnd(sub, subId, type);
  if (!to || to < from) return 0;

  const events = type === "study"
    ? generateStudyEvents(sub, subId, studyPerDayRate(configs.studyConfig), from, to)
    : generateTransportEvents(sub, subId, configs.transportConfig?.flatRatePerTrip ?? 0, from, to);
  if (!events.length) return 0;

  const existing = await appCol("reservationEvents")
    .where("subscriptionId", "==", subId)
    .where("date", ">=", isoDate(from))
    .where("date", "<=", isoDate(to))
    .get();
  const seen = new Set(existing.docs.map(d => d.id));
  const missing = events.filter(e => !seen.has(e.id));
  if (missing.length) await commitInChunks(missing, "create");
  return missing.length;
}

async function regenerateFutureEvents(
  sub: any, subId: string, type: "study" | "transport", configs: { studyConfig: any; transportConfig: any },
): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = resolveGenerationStart(sub, today);
  const to = await resolveGenerationEnd(sub, subId, type);
  if (!to || to < from) return;

  // Voiding still starts at today, not at `from`: anything already written
  // between today and a later startDate is exactly the bad data this fix
  // prevents, and it should be cleared rather than left behind.
  await voidFutureEvents(subId, isoDate(today));

  const events = type === "study"
    ? generateStudyEvents(sub, subId, studyPerDayRate(configs.studyConfig), from, to)
    : generateTransportEvents(sub, subId, configs.transportConfig?.flatRatePerTrip ?? 0, from, to);
  if (events.length) await commitInChunks(events, "create");
}

async function loadConfigs(): Promise<{ studyConfig: any; transportConfig: any }> {
  const [s, t] = await Promise.all([
    appCol("config").doc("studyCenter").get(),
    appCol("config").doc("transportation").get(),
  ]);
  return { studyConfig: s.data() ?? {}, transportConfig: t.data() ?? {} };
}

const CANCELLED_SUB_STATUSES = new Set(["cancelled", "canceled"]);

// ── Triggers: keep ReservationEvents in sync with the blueprint ─────────────
// Schedule/weekPattern/status changes only ever touch FUTURE events (see
// voidFutureEvents above) — already-elapsed occurrences are immutable facts
// once their date has passed, regardless of what happens to the subscription
// afterward.

export const onStudyroomReservationEventsSync = onDocumentWritten(
  { document: "_apps/arcoiris/studyroom/{entryId}", region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    const subId = event.params.entryId;
    if (!after) { await voidFutureEvents(subId, isoDate(new Date())); return; } // deleted
    if (CANCELLED_SUB_STATUSES.has(after.status)) { await voidFutureEvents(subId, isoDate(new Date())); return; }
    const scheduleChanged = !before
      || JSON.stringify(before.days) !== JSON.stringify(after.days)
      || before.weekPattern !== after.weekPattern
      || before.startDate !== after.startDate
      || before.endDate !== after.endDate
      || before.status !== after.status;
    if (!scheduleChanged) return;
    const configs = await loadConfigs();
    await regenerateFutureEvents(after, subId, "study", configs);
  }
);

export const onTransportReservationEventsSync = onDocumentWritten(
  { document: "_apps/arcoiris/transportationSubscriptions/{subId}", region: REGION },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    const subId = event.params.subId;
    if (!after) { await voidFutureEvents(subId, isoDate(new Date())); return; } // deleted
    if (CANCELLED_SUB_STATUSES.has(after.status)) { await voidFutureEvents(subId, isoDate(new Date())); return; }
    const scheduleChanged = !before
      || JSON.stringify(before.schedule) !== JSON.stringify(after.schedule)
      || before.weekPattern !== after.weekPattern
      || before.startDate !== after.startDate
      || before.endDate !== after.endDate
      || before.status !== after.status;
    if (!scheduleChanged) return;
    const configs = await loadConfigs();
    await regenerateFutureEvents(after, subId, "transport", configs);
  }
);

// ── Callable: parent or staff marks/restores a specific occurrence ─────────
// Same path for both actors — closes the gap where staff previously had no
// way to record an absence except the disconnected billing-page day-picker.
// No approval workflow, no notice-period distinction: every cancellation
// counts the same, effective immediately, per the agreed policy.

export const setReservationEventStatus = onCall(
  { region: REGION, invoker: "public" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const { eventId, status, reason } = request.data ?? {};
    if (status !== "EXPECTED" && status !== "CANCELLED") {
      throw new HttpsError("invalid-argument", "status must be EXPECTED or CANCELLED");
    }

    const ref = appCol("reservationEvents").doc(eventId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Reservation event not found");
    const data = snap.data()!;
    if (data.status === "VOIDED") {
      throw new HttpsError("failed-precondition", "This subscription has ended — this occurrence can no longer be changed");
    }

    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    const isStaff = !!(roles.owner || roles.rainbowAdmin);
    if (!isStaff) {
      // The login link lives at `primaryContact.userId` — verified against prod,
      // where all 36 family documents carry it and ZERO carry a top-level
      // `userId`. Reading only the top-level field meant every parent got
      // permission-denied and only staff could mark an absence, which defeats
      // the point of this shared write path. Top-level is still accepted as a
      // fallback because dev/test fixtures carry either shape.
      const famSnap = data.familyId ? await appCol("families").doc(data.familyId).get() : null;
      const fam = famSnap?.exists ? famSnap.data() : null;
      const familyUserId = fam?.primaryContact?.userId ?? fam?.userId;
      if (!familyUserId || familyUserId !== uid) {
        throw new HttpsError("permission-denied", "This occurrence does not belong to your family");
      }
    }

    await ref.update({
      status,
      changedBy: uid,
      changedByRole: isStaff ? "staff" : "parent",
      changedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(reason ? { reason } : { reason: admin.firestore.FieldValue.delete() }),
    });
    return { ok: true };
  }
);

// ── Callable: generate a subscription's events on demand ───────────────────
// Normally handled automatically by the two triggers above on create — this
// exists for backfilling subscriptions that existed before this system
// shipped, and as a manual repair tool, same role as billing's own
// backfillBillingSchedules.

export const backfillReservationEvents = onCall(
  { region: REGION, invoker: "public", timeoutSeconds: 300 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Unauthenticated");
    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) throw new HttpsError("permission-denied", "Unauthorized");

    const configs = await loadConfigs();
    const [studySnap, transportSnap] = await Promise.all([
      appCol("studyroom").where("status", "in", ["active", "confirmed"]).get(),
      appCol("transportationSubscriptions").where("status", "==", "active").get(),
    ]);

    // Start at the beginning of the CURRENT billing month, not today.
    // Generation from "today" leaves the already-elapsed part of this month
    // with no occurrences, and billing derives gross from occurrences — so
    // the month this system ships in bills short for everyone. Matilde's
    // transport billed EUR 0.00 for September precisely this way: a biweekly
    // subscription whose only September service days (7th, 16th, 21st) had
    // already passed by the time generation first ran.
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let studySubscriptions = 0, transportSubscriptions = 0, created = 0;
    for (const d of studySnap.docs) {
      created += await ensureEventsExist({ id: d.id, ...d.data() }, d.id, "study", configs, monthStart);
      studySubscriptions++;
    }
    for (const d of transportSnap.docs) {
      created += await ensureEventsExist({ id: d.id, ...d.data() }, d.id, "transport", configs, monthStart);
      transportSubscriptions++;
    }
    return { studySubscriptions, transportSubscriptions, created };
  }
);
