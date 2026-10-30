import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The study events trigger end to end, against an in-memory Firestore, with
// billing's recompute mocked. Covers what the pure planner tests can't: the
// pre-start absences are committed BEFORE the family's bills are recomputed,
// the recompute runs once per trigger run (not once per event), and a rerun
// doesn't recompute again.
const fake = vi.hoisted(() => {
  const state = { docs: {} as Record<string, Record<string, any>> }; // "collection/id" -> data
  const DELETE = "<DELETE>";
  const write = (path: string, data: Record<string, any>, merge: boolean) => {
    const next = merge ? { ...(state.docs[path] ?? {}) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v === DELETE) delete next[k]; else next[k] = v;
    }
    state.docs[path] = next;
  };
  const snapOf = (path: string) => ({
    id: path.split("/")[1], exists: !!state.docs[path],
    data: () => (state.docs[path] ? { ...state.docs[path] } : undefined),
  });
  const ref = (path: string) => ({ path, id: path.split("/")[1], get: async () => snapOf(path) });
  const matches = (x: any, op: string, v: any) =>
    op === "==" ? x === v : op === ">=" ? x >= v : op === "<=" ? x <= v : op === "in" ? (v as any[]).includes(x) : false;
  const collection = (c: string) => {
    const query = (filters: [string, string, unknown][]) => ({
      where: (f: string, op: string, v: unknown) => query([...filters, [f, op, v]]),
      get: async () => {
        const docs = Object.keys(state.docs)
          .filter(p => p.startsWith(`${c}/`))
          .filter(p => filters.every(([f, op, v]) => matches(state.docs[p][f], op, v)))
          .map(snapOf);
        return { empty: docs.length === 0, docs };
      },
    });
    return { doc: (id: string) => ref(`${c}/${id}`), ...query([]) };
  };
  const batch = () => {
    const ops: (() => void)[] = [];
    return {
      set: (r: { path: string }, data: Record<string, any>, opts?: { merge?: boolean }) => { ops.push(() => write(r.path, data, !!opts?.merge)); },
      update: (r: { path: string }, data: Record<string, any>) => {
        ops.push(() => {
          if (!state.docs[r.path]) throw new Error(`NOT_FOUND ${r.path}`);
          write(r.path, data, true);
        });
      },
      commit: async () => { for (const op of ops) op(); },
    };
  };
  return { state, collection, batch, DELETE };
});

vi.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: Object.assign(() => ({ batch: fake.batch, collection: fake.collection }), {
    FieldValue: { delete: () => fake.DELETE, serverTimestamp: () => "<NOW>" },
  }),
}));
vi.mock("./db", () => ({ appCol: (c: string) => fake.collection(c) }));
vi.mock("./billing", () => ({ autoCreateBillingSchedule: vi.fn() }));

import { onStudyroomReservationEventsSync, REASON_BEFORE_START } from "./reservationEvents";
import { autoCreateBillingSchedule } from "./billing";

const { state } = fake;
const recompute = vi.mocked(autoCreateBillingSchedule);

const ts = (d: Date) => ({ toDate: () => d });
// Laura Silva's subscription as a parent creates it: startDate = the moment of enrollment.
const laura = (o: Record<string, any> = {}) => ({
  familyId: "famL", childId: "cL", status: "pending", weekPattern: "all",
  days: [{ day: "monday", hour: "16:00" }, { day: "friday", hour: "16:00" }],
  startDate: ts(new Date(2026, 9, 16, 10, 30)),
  ...o,
});
const run = (before: any, after: any) => (onStudyroomReservationEventsSync as any).run({
  data: { before: { data: () => before }, after: { data: () => after } },
  params: { entryId: "s1" },
});
const event = (date: string) => state.docs[`reservationEvents/s1_${date}`];
const eventDates = () => Object.keys(state.docs)
  .filter(p => p.startsWith("reservationEvents/"))
  .map(p => state.docs[p].date as string)
  .sort();

beforeEach(() => {
  state.docs = {
    "config/studyCenter": { pricePerDayPerWeek: 6 },
    "config/transportation": { flatRatePerTrip: 4 },
    "config/schoolCalendar": { yearEndDate: "2027-07-15" },
  };
  recompute.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 16, 11, 0)); // Fri 16 Oct 2026, the day Laura enrolled
});
afterEach(() => { vi.useRealTimers(); });

describe("onStudyroomReservationEventsSync — pre-start absences reach billing", () => {
  it("writes the elapsed pre-start days, then recomputes the family's bills exactly once", async () => {
    let seenAtRecompute: string[] = [];
    recompute.mockImplementation(async () => {
      seenAtRecompute = eventDates().filter(d => d < "2026-10-16");
    });

    await run(undefined, laura());

    for (const d of ["2026-10-02", "2026-10-05", "2026-10-09", "2026-10-12"]) {
      expect(event(d)).toMatchObject({ status: "CANCELLED", changedByRole: "system", reason: REASON_BEFORE_START, familyId: "famL" });
    }
    expect(event("2026-10-16")).toMatchObject({ status: "EXPECTED" });
    // One recompute for the whole run (which wrote a school year of events), for this family,
    // and only after the absences were committed.
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledWith("famL");
    expect(seenAtRecompute).toEqual(["2026-10-02", "2026-10-05", "2026-10-09", "2026-10-12"]);
  });

  it("a later write (approval) changes none of them and doesn't recompute again", async () => {
    await run(undefined, laura());
    const before = Object.fromEntries(["2026-10-02", "2026-10-05", "2026-10-09", "2026-10-12"].map(d => [d, { ...event(d) }]));
    recompute.mockReset();

    vi.setSystemTime(new Date(2026, 9, 22, 9, 0)); // approved six days later
    await run(laura(), laura({ status: "active" }));

    for (const [d, data] of Object.entries(before)) expect(event(d)).toEqual(data);
    expect(recompute).not.toHaveBeenCalled();
  });

  it("approved later with no events at all: writes only the pre-start days, never 16-21 Oct, and keeps a human's record", async () => {
    vi.setSystemTime(new Date(2026, 9, 22, 9, 0));
    const staffAbsence = { subscriptionId: "s1", familyId: "famL", date: "2026-10-05", status: "CANCELLED", changedByRole: "staff", changedBy: "staff1", reason: "doente" };
    state.docs["reservationEvents/s1_2026-10-05"] = { ...staffAbsence };

    await run(laura(), laura({ status: "active" }));

    expect(event("2026-10-05")).toEqual(staffAbsence);
    for (const d of ["2026-10-02", "2026-10-09", "2026-10-12"]) {
      expect(event(d)).toMatchObject({ status: "CANCELLED", changedByRole: "system", reason: REASON_BEFORE_START });
    }
    expect(eventDates().filter(d => d >= "2026-10-16" && d < "2026-10-22")).toEqual([]);
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it("a subscription that started in an earlier month: nothing before today, no recompute", async () => {
    await run(undefined, laura({ startDate: ts(new Date(2026, 8, 21)) }));
    expect(eventDates().filter(d => d < "2026-10-16")).toEqual([]);
    expect(recompute).not.toHaveBeenCalled();
  });
});
