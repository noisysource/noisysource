import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// autoCreateBillingSchedule end to end against an in-memory Firestore: a paid
// October whose days change afterwards carries its credit onto the next open
// bill of the same subscription, and the paid bill is never touched. The pure
// ledger is tested in absenceCarryOver.test.ts; this checks the wiring.
const fake = vi.hoisted(() => {
  const state = { docs: {} as Record<string, Record<string, any>> }; // "collection/id" -> data
  const DELETE = "<DELETE>";
  // Deep copy that keeps functions (the fake Timestamps' toDate) by reference.
  const clone = (v: any): any => Array.isArray(v) ? v.map(clone)
    : v && typeof v === "object" && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
    : v;
  const write = (path: string, data: Record<string, any>, merge: boolean) => {
    const next = merge ? { ...(state.docs[path] ?? {}) } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v === DELETE) delete next[k]; else next[k] = v;
    }
    state.docs[path] = next;
  };
  const snapOf = (path: string) => ({
    id: path.split("/")[1], exists: !!state.docs[path], ref: ref(path),
    data: () => (state.docs[path] ? clone(state.docs[path]) : undefined),
  });
  function ref(path: string): any {
    return {
      path, id: path.split("/")[1],
      get: async () => snapOf(path),
      set: async (data: Record<string, any>) => write(path, data, false),
      update: async (data: Record<string, any>) => {
        if (!state.docs[path]) throw new Error(`NOT_FOUND ${path}`);
        write(path, data, true);
      },
    };
  }
  const value = (p: string, f: string) => (f === "__name__" ? p.split("/")[1] : state.docs[p][f]);
  const matches = (x: any, op: string, v: any) =>
    op === "==" ? x === v : op === ">=" ? x >= v : op === "<=" ? x <= v : op === "in" ? (v as any[]).includes(x) : false;
  const collection = (c: string) => {
    const query = (filters: [string, string, unknown][]) => ({
      where: (f: string, op: string, v: unknown) => query([...filters, [f, op, v]]),
      get: async () => {
        const docs = Object.keys(state.docs)
          .filter(p => p.startsWith(`${c}/`))
          .filter(p => filters.every(([f, op, v]) => matches(value(p, f), op, v)))
          .map(snapOf);
        return { empty: docs.length === 0, docs };
      },
    });
    return { doc: (id: string) => ref(`${c}/${id}`), ...query([]) };
  };
  const ts = (d: Date) => ({ toDate: () => new Date(d), toMillis: () => d.getTime() });
  return { state, collection, DELETE, ts, clone };
});

vi.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: Object.assign(() => ({ collection: fake.collection }), {
    FieldValue: { delete: () => fake.DELETE, serverTimestamp: () => "<NOW>", arrayUnion: (...v: unknown[]) => ({ arrayUnion: v }) },
    FieldPath: { documentId: () => "__name__" },
    Timestamp: { fromDate: (d: Date) => fake.ts(d), fromMillis: (m: number) => fake.ts(new Date(m)) },
  }),
}));
vi.mock("./db", () => ({ appCol: (c: string) => fake.collection(c) }));

import { autoCreateBillingSchedule, carriedCreditText, closureCreditText } from "./billing";

const { state, ts, clone } = fake;

// Rita: study Mon/Fri, EUR 6/day, every week = EUR 48 a month, new pricing.
// October 2026: Fri 2, 9, 16, 23, 30; Mon 5, 12, 19, 26.
const OCT_DAYS = ["02", "05", "09", "12", "16", "19", "23", "26", "30"].map(d => `2026-10-${d}`);
const octLine = (o: Record<string, any> = {}) => ({
  title: "Sala de Estudo — Rita (2ª, 6ª) — Outubro 2026", amount: 48, grossAmount: 48,
  subscriptionId: "s1", type: "study", appliedDiscounts: [], scheduleDays: ["monday", "friday"],
  multiTripDiscountAmount: 0, siblingDiscountAmount: 0, institutionalDiscountAmount: 0, institutionalDiscountPct: 0,
  absenceCount: 0, absenceCreditAmount: 0, // the shape October bills were paid with: no notionalOccurrences yet
  ...o,
});
const setDay = (date: string, status: "EXPECTED" | "CANCELLED") => { state.docs[`reservationEvents/s1_${date}`].status = status; };
const bill = (month: string) => state.docs[`billing/famA_${month}`];
const studyLine = (month: string) => bill(month).lineItems.find((l: any) => l.type === "study");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0)); // 5 Nov 2026: October is paid, November open
  state.docs = {
    "families/famA": { primaryContact: { userId: "uA", name: "Ana", email: "ana@example.com" }, paymentMethod: "mbway" },
    "config/studyCenter": { pricePerDayPerWeek: 6, registrationFee: 35, insuranceFee: 25 },
    "config/transportation": { flatRatePerTrip: 4 },
    "config/discounts": { rules: [] },
    "children/c1": {},
    "studyroom/s1": {
      familyId: "famA", childId: "c1", childName: "Rita", status: "active", weekPattern: "all",
      days: [{ day: "monday", hour: "16:00" }, { day: "friday", hour: "16:00" }],
      startDate: ts(new Date(2026, 8, 1)), createdAt: ts(new Date(2026, 9, 2)), enrollmentFeeBilled: true,
    },
    "billing/famA_2026-10": {
      familyId: "famA", userId: "uA", status: "paid", total: 48, periodLabel: "Outubro 2026",
      periodStart: ts(new Date(2026, 9, 1)), periodEnd: ts(new Date(2026, 9, 31)), lineItems: [octLine()],
    },
  };
  for (const date of OCT_DAYS) {
    state.docs[`reservationEvents/s1_${date}`] = {
      subscriptionId: "s1", subscriptionType: "study", familyId: "famA", childId: "c1", date, basePriceCents: 600, status: "EXPECTED",
    };
  }
});
afterEach(() => { vi.useRealTimers(); });

describe("autoCreateBillingSchedule — absences in a paid month carry to the next open bill", () => {
  it("credits November, leaves the paid October bill untouched, and a rerun changes nothing", async () => {
    const octBefore = clone(bill("2026-10"));
    for (const d of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]) setDay(d, "CANCELLED");

    await autoCreateBillingSchedule("famA");

    expect(bill("2026-10")).toEqual(octBefore);
    expect(studyLine("2026-11")).toMatchObject({
      amount: 24, grossAmount: 48, absenceCount: 0, notionalOccurrences: 8,
      title: "Sala de Estudo — Rita (2ª, 6ª) — Novembro 2026", // title unchanged: Vendus maps products by title
      carriedAbsenceCredits: [{ fromPeriod: "2026-10", amount: 24 }],
    });
    expect(bill("2026-11")).toMatchObject({ status: "pending", total: 24 });
    expect(studyLine("2026-12").amount).toBe(48);
    expect(studyLine("2026-12").carriedAbsenceCredits).toBeUndefined();

    const snapshot = clone(state.docs);
    await autoCreateBillingSchedule("famA");
    expect(state.docs).toEqual(snapshot);
  });

  it("once November is paid, a further October change goes to December", async () => {
    for (const d of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]) setDay(d, "CANCELLED");
    await autoCreateBillingSchedule("famA");
    bill("2026-11").status = "paid";
    const novPaid = clone(bill("2026-11"));

    setDay("2026-10-02", "CANCELLED"); // 5 absences now: EUR 30 owed, 24 already given
    await autoCreateBillingSchedule("famA");

    expect(bill("2026-11")).toEqual(novPaid);
    expect(studyLine("2026-12")).toMatchObject({ amount: 42, carriedAbsenceCredits: [{ fromPeriod: "2026-10", amount: 6 }] });
    expect(bill("2026-12").total).toBe(42);
  });

  it("days restored after the credit was paid out are charged back on the next open bill", async () => {
    for (const d of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]) setDay(d, "CANCELLED");
    await autoCreateBillingSchedule("famA");
    bill("2026-11").status = "paid";

    setDay("2026-10-19", "EXPECTED");
    setDay("2026-10-26", "EXPECTED"); // 2 absences: under the 3 minimum, nothing was owed after all
    await autoCreateBillingSchedule("famA");

    expect(studyLine("2026-12")).toMatchObject({ amount: 72, carriedAbsenceCredits: [{ fromPeriod: "2026-10", amount: -24 }] });
  });

  it("a subscription that's no longer active has nowhere to take it: unapplied and logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const d of ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]) setDay(d, "CANCELLED");
    state.docs["studyroom/s1"].status = "cancelled";

    await autoCreateBillingSchedule("famA");

    expect(warn.mock.calls.some(c => String(c[0]).includes("EUR 24.00 from 2026-10 for subscription s1 has no open bill"))).toBe(true);
    warn.mockRestore();
  });

  it("formats the credit the way the bill shows it", () => {
    expect(carriedCreditText({ fromPeriod: "2026-10", amount: 24 })).toBe("Crédito de faltas de Outubro 2026: −€24.00");
    expect(carriedCreditText({ fromPeriod: "2026-10", amount: -6 })).toBe("Acerto de faltas de Outubro 2026: +€6.00");
  });
});

// ── Club closure on the bill (2026-11-24) ──────────────────────────────────
// KidClub closes after 15 December 2026. Rita's December (Mon/Fri): Fri 4, 11,
// 18, 25; Mon 7, 14, 21, 28. Closed 16-31 = 18, 21, 25, 28: 4 of a notional 8.
describe("autoCreateBillingSchedule — a club closure is credited on the bill", () => {
  const DEC_DAYS = ["04", "07", "11", "14", "18", "21", "25", "28"].map(d => `2026-12-${d}`);
  const CLOSED = ["2026-12-18", "2026-12-21", "2026-12-25", "2026-12-28"];
  const close = (dates: string[]) => {
    for (const d of dates) Object.assign(state.docs[`reservationEvents/s1_${d}`], { status: "CANCELLED", changedByRole: "system", reason: "club closed" });
  };

  beforeEach(() => {
    vi.setSystemTime(new Date(2026, 10, 24, 10, 0)); // 24 Nov 2026
    state.docs["config/closures"] = { closures: [{ id: "x", from: "2026-12-16", to: "2026-12-31", label: "Férias de Natal" }] };
    for (const date of DEC_DAYS) {
      state.docs[`reservationEvents/s1_${date}`] = {
        subscriptionId: "s1", subscriptionType: "study", familyId: "famA", childId: "c1", date, basePriceCents: 600, status: "EXPECTED",
      };
    }
  });

  it("December still open: half the month off, shown as a closure and not as absences", async () => {
    close(CLOSED);
    await autoCreateBillingSchedule("famA");

    expect(bill("2026-12")).toMatchObject({ status: "pending", total: 24 });
    expect(studyLine("2026-12")).toMatchObject({
      amount: 24, grossAmount: 48,
      closureCount: 4, closureCreditAmount: 24, closureDates: CLOSED, closureLabel: "Férias de Natal",
      absenceCount: 0, absenceCreditAmount: 0,
      title: "Sala de Estudo — Rita (2ª, 6ª) — Dezembro 2026", // unchanged: Vendus maps products by title
    });
    expect(studyLine("2026-12").absenceDates).toBeUndefined();
    expect(closureCreditText(studyLine("2026-12"))).toBe("KidClub encerrado (Férias de Natal), 4 dias: −€24.00");
    // Other months are untouched.
    expect(studyLine("2026-11").amount).toBe(48);
    expect(studyLine("2026-11").closureCount).toBeUndefined();
    expect(studyLine("2027-01").amount).toBe(48);
  });

  it("an absence of the family's own in the same month is still just an absence (under 3: no credit)", async () => {
    close(CLOSED);
    setDay("2026-12-04", "CANCELLED");
    await autoCreateBillingSchedule("famA");
    expect(studyLine("2026-12")).toMatchObject({ amount: 24, closureCount: 4, closureCreditAmount: 24, absenceCount: 1, absenceCreditAmount: 0 });
  });

  it("December already paid when the closure is entered: the paid bill stays, January carries the credit", async () => {
    await autoCreateBillingSchedule("famA");
    bill("2026-12").status = "paid";
    const decPaid = clone(bill("2026-12"));
    expect(decPaid.total).toBe(48);

    close(CLOSED);
    await autoCreateBillingSchedule("famA");

    expect(bill("2026-12")).toEqual(decPaid);
    expect(studyLine("2027-01")).toMatchObject({ amount: 24, carriedAbsenceCredits: [{ fromPeriod: "2026-12", amount: 24, closure: true }] });
    expect(bill("2027-01").total).toBe(24);
    expect(carriedCreditText(studyLine("2027-01").carriedAbsenceCredits[0])).toBe("Crédito de Dezembro 2026 (KidClub encerrado): −€24.00");
    expect(studyLine("2027-02").amount).toBe(48);

    const snapshot = clone(state.docs);
    await autoCreateBillingSchedule("famA");
    expect(state.docs).toEqual(snapshot);
  });

  for (const status of ["invoiced", "processing"]) {
    it(`December ${status}: same, the bill is not touched`, async () => {
      await autoCreateBillingSchedule("famA");
      bill("2026-12").status = status;
      const before = clone(bill("2026-12"));
      close(CLOSED);
      await autoCreateBillingSchedule("famA");
      expect(bill("2026-12")).toEqual(before);
      expect(studyLine("2027-01").carriedAbsenceCredits).toEqual([{ fromPeriod: "2026-12", amount: 24, closure: true }]);
    });
  }

  it("the closure is removed again while December is open: the bill goes back to the full month", async () => {
    close(CLOSED);
    await autoCreateBillingSchedule("famA");
    for (const d of CLOSED) state.docs[`reservationEvents/s1_${d}`] = { subscriptionId: "s1", subscriptionType: "study", familyId: "famA", childId: "c1", date: d, basePriceCents: 600, status: "EXPECTED" };
    await autoCreateBillingSchedule("famA");
    expect(studyLine("2026-12").amount).toBe(48);
    expect(studyLine("2026-12").closureCount).toBeUndefined();
    expect(studyLine("2026-12").closureCreditAmount).toBeUndefined();
  });
});
