import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// setClubClosures end to end against an in-memory Firestore, with billing's
// recompute mocked: which events a closure changes, that each family is
// recomputed once (not once per event), and that removing or shortening a
// closure puts the days back. The same store runs the subscription trigger, to
// check that a subscription created after the closure gets its closed days.
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
  const ref = (path: string) => ({
    path, id: path.split("/")[1], get: async () => snapOf(path),
    set: async (data: Record<string, any>) => write(path, data, false),
    update: async (data: Record<string, any>) => {
      if (!state.docs[path]) throw new Error(`NOT_FOUND ${path}`);
      write(path, data, true);
    },
  });
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

import { setClubClosures, subForClosureSync } from "./closures";
import { onStudyroomReservationEventsSync, onTransportReservationEventsSync, setReservationEventStatus, REASON_AFTER_END, REASON_BEFORE_START } from "./reservationEvents";
import { REASON_CLOSED } from "./closureLogic";
import { autoCreateBillingSchedule } from "./billing";

const { state } = fake;
const recompute = vi.mocked(autoCreateBillingSchedule);

const XMAS = { id: "x", from: "2026-12-16", to: "2026-12-31", label: "Férias de Natal" };
const save = (closures: unknown[], uid = "admin1") => (setClubClosures as any).run({ auth: { uid }, data: { closures } });
const studySub = (familyId: string, days: string[], o: Record<string, any> = {}) =>
  ({ familyId, childId: `c_${familyId}`, status: "active", weekPattern: "all", days: days.map(day => ({ day, hour: "16:00" })), ...o });
const transportSub = (familyId: string, schedule: any[], o: Record<string, any> = {}) =>
  ({ familyId, childId: `c_${familyId}`, status: "active", weekPattern: "all", schedule, ...o });
const createStudy = async (id: string, sub: any) => {
  state.docs[`studyroom/${id}`] = { ...sub };
  await (onStudyroomReservationEventsSync as any).run({ data: { before: { data: () => undefined }, after: { data: () => sub } }, params: { entryId: id } });
};
const createTransport = async (id: string, sub: any) => {
  state.docs[`transportationSubscriptions/${id}`] = { ...sub };
  await (onTransportReservationEventsSync as any).run({ data: { before: { data: () => undefined }, after: { data: () => sub } }, params: { subId: id } });
};
const ev = (id: string) => state.docs[`reservationEvents/${id}`];
const eventsOf = (subId: string, from: string, to: string) => Object.entries(state.docs)
  .filter(([p, d]) => p.startsWith("reservationEvents/") && d.subscriptionId === subId && d.date >= from && d.date <= to)
  .map(([, d]) => d).sort((a, b) => a.date.localeCompare(b.date));
const isClosed = (e: any) => e.status === "CANCELLED" && e.changedByRole === "system" && e.reason === REASON_CLOSED;

beforeEach(async () => {
  state.docs = {
    "config/studyCenter": { pricePerDayPerWeek: 6 },
    "config/transportation": { flatRatePerTrip: 4 },
    "config/schoolCalendar": { yearEndDate: "2027-07-15" },
    "users/admin1": { roles: { rainbowAdmin: true } },
    "users/parentA": { roles: {} },
    "families/famA": { primaryContact: { userId: "parentA" } },
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 24, 10, 0)); // Tue 24 Nov 2026
  // Two families: A has study Mon/Fri and transport with two trips on Mondays; B has study on Wednesdays.
  await createStudy("sA", studySub("famA", ["monday", "friday"]));
  await createTransport("tA", transportSub("famA", [
    { dayOfWeek: "monday", direction: "pickup", pickupTime: "08:00" }, { dayOfWeek: "monday", direction: "dropoff", pickupTime: "17:00" },
  ]));
  await createStudy("sB", studySub("famB", ["wednesday"]));
  recompute.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe("setClubClosures — KidClub closes 16-31 December 2026", () => {
  it("every study day and every trip in the range becomes a closure absence; nothing outside it changes", async () => {
    const result = await save([XMAS]);

    // December 2026: Mon 21, 28; Wed 16, 23, 30; Fri 18, 25.
    expect(eventsOf("sA", "2026-12-16", "2026-12-31").map(e => e.date)).toEqual(["2026-12-18", "2026-12-21", "2026-12-25", "2026-12-28"]);
    expect(eventsOf("sA", "2026-12-16", "2026-12-31").every(isClosed)).toBe(true);
    expect(eventsOf("tA", "2026-12-16", "2026-12-31")).toHaveLength(4); // two trips on each of two Mondays
    expect(eventsOf("tA", "2026-12-16", "2026-12-31").every(isClosed)).toBe(true);
    expect(eventsOf("sB", "2026-12-16", "2026-12-31").map(e => e.date)).toEqual(["2026-12-16", "2026-12-23", "2026-12-30"]);
    expect(eventsOf("sB", "2026-12-16", "2026-12-31").every(isClosed)).toBe(true);
    expect(eventsOf("sA", "2026-12-01", "2026-12-15").every(e => e.status === "EXPECTED")).toBe(true);
    expect(eventsOf("sA", "2027-01-01", "2027-01-31").every(e => e.status === "EXPECTED")).toBe(true);

    expect(result).toMatchObject({ closed: 11, reopened: 0, families: 2, failedFamilies: [] });
    expect(state.docs["config/closures"].closures).toEqual([XMAS]);
  });

  it("recomputes each family's bills once, after all its events are written", async () => {
    const seen: Record<string, number> = {};
    recompute.mockImplementation(async (familyId: string) => {
      seen[familyId] = Object.values(state.docs).filter(d => d.familyId === familyId && d.reason === REASON_CLOSED).length;
    });
    await save([XMAS]);
    expect(recompute).toHaveBeenCalledTimes(2);
    expect(seen).toEqual({ famA: 8, famB: 3 });
  });

  it("its writes are marked, so the per-event billing trigger stays out of it", async () => {
    await save([XMAS]);
    const ids = new Set(eventsOf("sA", "2026-12-16", "2026-12-31").map(e => e.closureSyncId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    expect(ev("sA_2026-12-14").closureSyncId).toBeUndefined();
  });

  it("saving the same list again changes nothing and recomputes nobody", async () => {
    await save([XMAS]);
    const snapshot = JSON.stringify(state.docs);
    recompute.mockReset();
    const result = await save([XMAS]);
    expect(result).toMatchObject({ closed: 0, reopened: 0, families: 0 });
    expect(JSON.stringify(state.docs)).toBe(snapshot);
    expect(recompute).not.toHaveBeenCalled();
  });

  it("changing only the percentage changes no event but recomputes every family with a day in that closure, once", async () => {
    await save([XMAS]);
    const events = JSON.stringify(Object.entries(state.docs).filter(([p]) => p.startsWith("reservationEvents/")));
    recompute.mockReset();

    const result = await save([{ ...XMAS, percent: 50 }]);
    expect(result).toMatchObject({ closed: 0, reopened: 0, families: 2 });
    expect(recompute).toHaveBeenCalledTimes(2);
    expect(recompute.mock.calls.map(c => c[0]).sort()).toEqual(["famA", "famB"]);
    expect(JSON.stringify(Object.entries(state.docs).filter(([p]) => p.startsWith("reservationEvents/")))).toBe(events);
    expect(state.docs["config/closures"].closures).toEqual([{ ...XMAS, percent: 50 }]);

    // Same again: nothing to do. Removing the percentage: recomputed again.
    recompute.mockReset();
    await save([{ ...XMAS, percent: 50 }]);
    expect(recompute).not.toHaveBeenCalled();
    await save([XMAS]);
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it("a percentage change on one closure leaves the families of another alone", async () => {
    const formation = { id: "w", from: "2026-12-09", to: "2026-12-09", label: "Formação" }; // a Wednesday: family B only
    await save([formation, { ...XMAS, from: "2026-12-18", to: "2026-12-18" }]);          // a Friday: family A only
    recompute.mockReset();
    await save([{ ...formation, percent: 10 }, { ...XMAS, from: "2026-12-18", to: "2026-12-18" }]);
    expect(recompute.mock.calls.map(c => c[0])).toEqual(["famB"]);
  });

  it("a bad percentage, or one on a closure across two months, is refused before anything is written", async () => {
    await expect(save([{ ...XMAS, percent: 0 }])).rejects.toThrow(/percentagem/);
    await expect(save([{ ...XMAS, percent: 120 }])).rejects.toThrow(/percentagem/);
    await expect(save([{ id: "y", from: "2026-12-28", to: "2027-01-08", label: "Fim de ano", percent: 25 }])).rejects.toThrow(/um só mês/);
    expect(state.docs["config/closures"]).toBeUndefined();
  });

  it("a family whose recompute fails is reported; the others still go through", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    recompute.mockImplementation(async (familyId: string) => { if (familyId === "famA") throw new Error("boom"); });
    const result = await save([XMAS]);
    expect(result.failedFamilies).toEqual(["famA"]);
    expect(recompute).toHaveBeenCalledWith("famB");
    expect(eventsOf("sA", "2026-12-16", "2026-12-31").every(isClosed)).toBe(true);
    err.mockRestore();
  });

  it("a past closure is applied the same way (entered after the fact)", async () => {
    vi.setSystemTime(new Date(2027, 0, 11, 10, 0));
    await save([{ id: "s", from: "2027-01-04", to: "2027-01-04", label: "Tempestade" }]);
    expect(isClosed(ev("sA_2027-01-04"))).toBe(true);
    expect(isClosed(ev("tA_2027-01-04_0"))).toBe(true);
    expect(isClosed(ev("tA_2027-01-04_1"))).toBe(true);
  });

  it("only staff may do it, and a bad range is refused before anything is written", async () => {
    await expect(save([XMAS], "parentA")).rejects.toThrow();
    await expect((setClubClosures as any).run({ data: { closures: [XMAS] } })).rejects.toThrow();
    await expect(save([{ from: "2026-12-31", to: "2026-12-16", label: "x" }])).rejects.toThrow(/anterior/);
    expect(state.docs["config/closures"]).toBeUndefined();
    expect(recompute).not.toHaveBeenCalled();
  });
});

describe("setClubClosures — shortening and removing a closure", () => {
  it("shortened to 21-31: the 16th and 18th are served again, the rest stays closed", async () => {
    await save([XMAS]);
    recompute.mockReset();
    const result = await save([{ ...XMAS, from: "2026-12-21" }]);

    expect(ev("sA_2026-12-18")).toMatchObject({ status: "EXPECTED" });
    expect(ev("sA_2026-12-18").reason).toBeUndefined();
    expect(ev("sA_2026-12-18").changedByRole).toBeUndefined();
    expect(ev("sB_2026-12-16")).toMatchObject({ status: "EXPECTED" });
    expect(isClosed(ev("sA_2026-12-21"))).toBe(true);
    expect(isClosed(ev("sB_2026-12-23"))).toBe(true);
    expect(result).toMatchObject({ closed: 0, reopened: 2, families: 2 });
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it("removed: every closed day is back, and only the families that had one are recomputed", async () => {
    await save([{ id: "w", from: "2026-12-16", to: "2026-12-16", label: "Formação" }]); // a Wednesday: family B only
    recompute.mockReset();
    const result = await save([]);
    expect(Object.values(state.docs).some(d => d.reason === REASON_CLOSED)).toBe(false);
    expect(result).toMatchObject({ reopened: 1, families: 1 });
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledWith("famB");
  });

  it("an absence the parent had recorded before the closure comes back as that absence", async () => {
    Object.assign(ev("sA_2026-12-18"), { status: "CANCELLED", changedByRole: "parent", changedBy: "parentA", changedAt: "T1" });
    await save([XMAS]);
    expect(isClosed(ev("sA_2026-12-18"))).toBe(true);
    expect(ev("sA_2026-12-18").changedBy).toBeUndefined();
    expect(ev("sA_2026-12-18").preClosure).toEqual({ status: "CANCELLED", changedByRole: "parent", changedBy: "parentA", changedAt: "T1" });

    await save([]);
    expect(ev("sA_2026-12-18")).toMatchObject({ status: "CANCELLED", changedByRole: "parent", changedBy: "parentA", changedAt: "T1" });
    expect(ev("sA_2026-12-18").preClosure).toBeUndefined();
    expect(ev("sA_2026-12-18").reason).toBeUndefined();
  });

  it("a day of a subscription cancelled in the meantime doesn't come back as a served day", async () => {
    await save([XMAS]);
    state.docs["studyroom/sB"] = { ...state.docs["studyroom/sB"], status: "cancelled", cancelledAt: { toDate: () => new Date(2026, 11, 20, 9, 0) } };
    await save([]);
    expect(ev("sB_2026-12-16")).toMatchObject({ status: "EXPECTED" }); // before the cancellation: it was a served day
    expect(ev("sB_2026-12-23")).toMatchObject({ status: "CANCELLED", changedByRole: "system", reason: REASON_AFTER_END });
  });

  it("subForClosureSync: the contract as restoring needs it", () => {
    expect(subForClosureSync(undefined)).toBeUndefined();
    expect(subForClosureSync({ status: "active", startDate: "2026-12-21", endDate: "2027-06-30" })).toEqual({ active: true, start: "2026-12-21", end: "2027-06-30" });
    expect(subForClosureSync({ status: "cancelled", cancelledAt: { toDate: () => new Date(2026, 11, 20, 9, 0) } })).toEqual({ active: false, end: "2026-12-19" });
    expect(subForClosureSync({ status: "cancelled" })).toEqual({ active: false });
  });
});

describe("closures and the rest of the event lifecycle", () => {
  it("a subscription created after the closure exists gets its closed days, and its bills are recomputed once", async () => {
    await save([XMAS]);
    recompute.mockReset();
    await createStudy("sC", studySub("famC", ["tuesday", "thursday"]));

    // Tue 22, 29; Thu 17, 24, 31.
    const closed = eventsOf("sC", "2026-12-16", "2026-12-31");
    expect(closed.map(e => e.date)).toEqual(["2026-12-17", "2026-12-22", "2026-12-24", "2026-12-29", "2026-12-31"]);
    expect(closed.every(isClosed)).toBe(true);
    expect(eventsOf("sC", "2026-12-01", "2026-12-15").every(e => e.status === "EXPECTED")).toBe(true);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledWith("famC");
  });

  it("a schedule edit keeps the closure: new days inside it are closed, and removing the closure later reopens them", async () => {
    await save([XMAS]);
    const before = state.docs["studyroom/sB"];
    const after = { ...before, days: [{ day: "wednesday", hour: "16:00" }, { day: "thursday", hour: "16:00" }] };
    state.docs["studyroom/sB"] = after;
    await (onStudyroomReservationEventsSync as any).run({ data: { before: { data: () => before }, after: { data: () => after } }, params: { entryId: "sB" } });

    expect(isClosed(ev("sB_2026-12-17"))).toBe(true); // the new Thursday
    expect(isClosed(ev("sB_2026-12-23"))).toBe(true); // the Wednesday it already had
    expect(ev("sB_2026-12-10")).toMatchObject({ status: "EXPECTED" });

    await save([]);
    expect(ev("sB_2026-12-17")).toMatchObject({ status: "EXPECTED" });
  });

  it("a day before the subscription starts is 'not enrolled', not 'closed'", async () => {
    await save([XMAS]);
    await createStudy("sD", studySub("famD", ["monday"], { startDate: "2026-12-28" }));
    expect(ev("sD_2026-12-21")).toMatchObject({ status: "CANCELLED", changedByRole: "system", reason: REASON_BEFORE_START });
    expect(isClosed(ev("sD_2026-12-28"))).toBe(true);
  });

  it("nobody can change a closed day: not the parent, not staff, in either direction", async () => {
    await save([XMAS]);
    const call = (uid: string, status: string) => (setReservationEventStatus as any).run({ auth: { uid }, data: { eventId: "sA_2026-12-18", status } });
    for (const uid of ["parentA", "admin1"]) {
      await expect(call(uid, "EXPECTED")).rejects.toThrow(/encerrado/);
      await expect(call(uid, "CANCELLED")).rejects.toThrow(/encerrado/);
    }
    expect(isClosed(ev("sA_2026-12-18"))).toBe(true);
    // A day outside the closure is still the parent's to change.
    await call("parentA", "CANCELLED").catch(() => {});
    await (setReservationEventStatus as any).run({ auth: { uid: "parentA" }, data: { eventId: "sA_2026-12-14", status: "CANCELLED" } });
    expect(ev("sA_2026-12-14")).toMatchObject({ status: "CANCELLED", changedByRole: "parent" });
  });
});
