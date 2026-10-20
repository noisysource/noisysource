import { describe, it, expect, vi, beforeEach } from "vitest";

// Party deposit bill (ensurePartyDeposit), the booking triggers
// (partyBookings.ts) and the createPartyDeposit callable, with no Firestore.
// firebase-admin and ./db share one in-memory store. Transactions run one at a
// time and apply their writes at commit, where create() fails on an existing
// doc like Firestore's ALREADY_EXISTS. `beforeCommit` lets a test create a doc
// between a transaction's reads and its commit (a concurrent writer).
const fake = vi.hoisted(() => {
  const state = {
    docs: {} as Record<string, Record<string, any>>, // "collection/id" -> data
    autoId: 0,
    beforeCommit: null as null | (() => void),
  };
  const alreadyExists = (path: string) =>
    Object.assign(new Error(`6 ALREADY_EXISTS: Document already exists: ${path}`), { code: 6 });
  const createNow = (path: string, data: Record<string, any>) => {
    if (state.docs[path]) throw alreadyExists(path);
    state.docs[path] = { ...data };
  };
  const snapOf = (path: string) => {
    const data = state.docs[path];
    return { id: path.split("/")[1], exists: !!data, data: () => data, get: (f: string) => data?.[f], ref: ref(path) };
  };
  function ref(path: string): any {
    return {
      path,
      id: path.split("/")[1],
      get: async () => snapOf(path),
      create: async (data: Record<string, any>) => createNow(path, data),
      set: async (data: Record<string, any>) => { state.docs[path] = { ...data }; },
      update: async (data: Record<string, any>) => {
        if (!state.docs[path]) throw new Error(`NOT_FOUND ${path}`);
        state.docs[path] = { ...state.docs[path], ...data };
      },
    };
  }
  const query = (c: string, filters: [string, unknown][]): any => ({
    isQuery: true,
    where: (f: string, _op: string, v: unknown) => query(c, [...filters, [f, v]]),
    limit: () => query(c, filters),
    get: async () => {
      const docs = Object.keys(state.docs)
        .filter((p) => p.startsWith(`${c}/`))
        .filter((p) => filters.every(([f, v]) => {
          const val = f.split(".").reduce((o: any, k) => o?.[k], state.docs[p]);
          return val === v;
        }))
        .map(snapOf);
      return { empty: docs.length === 0, docs };
    },
  });
  const collection = (c: string) => ({
    doc: (id?: string) => ref(`${c}/${id ?? `auto${state.autoId++}`}`),
    add: async (data: Record<string, any>) => { const r = ref(`${c}/auto${state.autoId++}`); await r.set(data); return r; },
    ...query(c, []),
  });
  let lock: Promise<unknown> = Promise.resolve();
  const runTransaction = (fn: (tx: any) => Promise<unknown>) => {
    const run = lock.then(async () => {
      const writes: (() => void)[] = [];
      const result = await fn({
        get: (r: any) => r.get(),
        create: (r: any, data: Record<string, any>) => { writes.push(() => createNow(r.path, data)); },
        update: (r: any, data: Record<string, any>) => { writes.push(() => { state.docs[r.path] = { ...state.docs[r.path], ...data }; }); },
      });
      const hook = state.beforeCommit; state.beforeCommit = null; hook?.();
      for (const w of writes) w();
      return result;
    });
    lock = run.catch(() => {});
    return run;
  };
  return { state, collection, runTransaction };
});

vi.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: Object.assign(() => ({ runTransaction: fake.runTransaction, collection: fake.collection }), {
    FieldValue: { delete: () => "<DELETE>", serverTimestamp: () => "<NOW>", arrayUnion: (...v: unknown[]) => ({ arrayUnion: v }) },
    FieldPath: { documentId: () => "__name__" },
    Timestamp: { fromDate: (d: Date) => d, fromMillis: (m: number) => m, now: () => new Date() },
  }),
}));
vi.mock("./db", () => ({ appCol: (c: string) => fake.collection(c) }));

import { ensurePartyDeposit } from "./partyDeposit";
import { onPartyBookingCreated, onPartyBookingStatusNotify, partyEmailId } from "./partyBookings";
import { createPartyDeposit } from "./billing";
import { partyDepositBillingId } from "./partyDepositLogic";

const { state } = fake;

const booking = (overrides: Record<string, any> = {}) => ({
  familyId: "fam1",
  userId: "parent-uid",
  childId: "child1",
  childName: "Rita Silva",
  childAge: 6,
  parentName: "Ana Silva",
  email: "ana@example.com",
  partyType: "Festa B",
  date: "2026-11-21",
  time: "15:00",
  numKids: 17,
  extras: ["Cachorro"],
  extrasDetail: { Cachorro: 10 },
  total: 327, // before IVA → total €402.21, deposit €201.11
  status: "pending",
  ...overrides,
});
const family = (overrides: Record<string, any> = {}) => ({
  primaryContact: { userId: "parent-uid", email: "ana.family@example.com", name: "Ana Silva" },
  ...overrides,
});

const docsIn = (c: string) => Object.entries(state.docs)
  .filter(([p]) => p.startsWith(`${c}/`))
  .map(([p, data]) => ({ id: p.split("/")[1], ...data }));
const bills = () => docsIn("billing");
const outbox = () => docsIn("emailOutbox");

const snap = (data: Record<string, any> | undefined) => ({ data: () => data });
const statusChange = (bookingId: string, before: Record<string, any>, after: Record<string, any>) =>
  (onPartyBookingStatusNotify as any).run({ params: { bookingId }, data: { before: snap(before), after: snap(after) } });
const created = (bookingId: string, data: Record<string, any>) =>
  (onPartyBookingCreated as any).run({ params: { bookingId }, data: snap(data) });
const callDeposit = (uid: string, bookingId: string) =>
  (createPartyDeposit as any).run({ auth: { uid }, data: { bookingId } });

beforeEach(() => {
  state.docs = {};
  state.autoId = 0;
  state.beforeCommit = null;
  state.docs["families/fam1"] = family();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ensurePartyDeposit", () => {
  it("creates one deposit bill under a deterministic id: 50% com IVA, owned by the family's parent", async () => {
    const res = await ensurePartyDeposit("bk1", booking({ status: "confirmed" }), "test");
    expect(res).toEqual({ billingId: partyDepositBillingId("bk1"), created: true, total: 201.11, status: "pending" });
    expect(bills()).toHaveLength(1);
    expect(state.docs[`billing/${partyDepositBillingId("bk1")}`]).toMatchObject({
      familyId: "fam1", userId: "parent-uid", bookingId: "bk1", type: "party_deposit",
      total: 201.11, lineItems: [{ title: "Sinal 50% — Festa B", amount: 201.11 }],
      billingEmail: "ana@example.com", paymentMethod: "mbway", status: "pending", createdVia: "test",
    });
  });

  it("owner is the family's primaryContact.userId even when the booking carries someone else's uid", async () => {
    await ensurePartyDeposit("bk1", booking({ userId: "admin-uid" }), "test");
    expect(bills()[0].userId).toBe("parent-uid");
  });

  it("falls back to the booking's userId when the family has no owner, or there is no family", async () => {
    state.docs["families/fam1"] = family({ primaryContact: { email: "x@example.com" } });
    await ensurePartyDeposit("bk1", booking(), "test");
    expect(bills()[0].userId).toBe("parent-uid");

    await ensurePartyDeposit("bk2", booking({ familyId: "", userId: "lonely-uid" }), "test");
    expect(state.docs[`billing/${partyDepositBillingId("bk2")}`].userId).toBe("lonely-uid");
  });

  it("uses the family's payment method when it chose one", async () => {
    state.docs["families/fam1"] = family({ paymentMethod: "bank_transfer" });
    await ensurePartyDeposit("bk1", booking(), "test");
    expect(bills()[0].paymentMethod).toBe("bank_transfer");
  });

  it("a second call returns the same bill and writes nothing", async () => {
    await ensurePartyDeposit("bk1", booking(), "test");
    const before = JSON.stringify(state.docs);
    const again = await ensurePartyDeposit("bk1", booking({ total: 999 }), "test");
    expect(again).toEqual({ billingId: partyDepositBillingId("bk1"), created: false, total: 201.11, status: "pending" });
    expect(JSON.stringify(state.docs)).toBe(before);
  });

  it("returns a deposit the old callable created under a random id, and creates nothing", async () => {
    state.docs["billing/RandomOldId123"] = { bookingId: "bk1", type: "party_deposit", total: 92.25, status: "paid", userId: "parent-uid" };
    const res = await ensurePartyDeposit("bk1", booking(), "test");
    expect(res).toEqual({ billingId: "RandomOldId123", created: false, total: 92.25, status: "paid" });
    expect(bills()).toHaveLength(1);
  });

  it("ignores other bills of the booking's family (monthly bills, camp deposits)", async () => {
    state.docs["billing/fam1_2026-10"] = { familyId: "fam1", total: 120, status: "pending" };
    state.docs["billing/camp1"] = { familyId: "fam1", bookingId: "bk1", type: "camp_deposit", total: 50 };
    const res = await ensurePartyDeposit("bk1", booking(), "test");
    expect(res.created).toBe(true);
    expect(bills()).toHaveLength(3);
  });

  it("concurrent calls (trigger + callable at once) make one bill", async () => {
    const results = await Promise.all([
      ensurePartyDeposit("bk1", booking(), "a"),
      ensurePartyDeposit("bk1", booking(), "b"),
      ensurePartyDeposit("bk1", booking(), "c"),
    ]);
    expect(bills()).toHaveLength(1);
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.billingId))).toEqual(new Set([partyDepositBillingId("bk1")]));
  });

  it("when another writer creates the bill between the reads and the commit, returns that one (ALREADY_EXISTS)", async () => {
    state.beforeCommit = () => {
      state.docs[`billing/${partyDepositBillingId("bk1")}`] = { bookingId: "bk1", type: "party_deposit", total: 201.11, status: "pending", createdVia: "other" };
    };
    const res = await ensurePartyDeposit("bk1", booking(), "test");
    expect(res).toEqual({ billingId: partyDepositBillingId("bk1"), created: false, total: 201.11, status: "pending" });
    expect(bills()).toHaveLength(1);
    expect(bills()[0].createdVia).toBe("other");
  });
});

describe("onPartyBookingStatusNotify", () => {
  it("pending → confirmed: creates the deposit bill and emails the parent once, with amount and link", async () => {
    await statusChange("bk1", booking(), booking({ status: "confirmed" }));
    expect(bills()).toHaveLength(1);
    expect(bills()[0]).toMatchObject({ id: partyDepositBillingId("bk1"), total: 201.11, userId: "parent-uid", createdVia: "onPartyBookingStatusNotify" });

    const mails = outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      id: partyEmailId("confirmed", "bk1"), to: "ana@example.com", subject: "Festa confirmada — Rita Silva",
      status: "queued", bookingId: "bk1", familyId: "fam1", billingId: partyDepositBillingId("bk1"),
    });
    expect(mails[0].html).toContain("€201.11");
    expect(mails[0].html).toContain("IVA incluído");
    expect(mails[0].html).toContain("https://kidclub.pt/client/parties/bk1");
    expect(mails[0].html).toContain("Pagamentos");
    expect(mails[0].html).toContain("às 15:00");
  });

  it("a redelivered confirmation event makes no second bill and no second email", async () => {
    await statusChange("bk1", booking(), booking({ status: "confirmed" }));
    await statusChange("bk1", booking(), booking({ status: "confirmed" }));
    expect(bills()).toHaveLength(1);
    expect(outbox()).toHaveLength(1);
  });

  it("editing a confirmed booking (status unchanged) does nothing", async () => {
    await statusChange("bk1", booking({ status: "confirmed" }), booking({ status: "confirmed", numKids: 20, total: 400 }));
    expect(bills()).toHaveLength(0);
    expect(outbox()).toHaveLength(0);
  });

  it("an update that leaves a pending booking pending does nothing", async () => {
    await statusChange("bk1", booking(), booking({ numKids: 12 }));
    expect(bills()).toHaveLength(0);
    expect(outbox()).toHaveLength(0);
  });

  it("a booking confirmed before this shipped (old random-id deposit, already paid): no new bill; email says it's paid", async () => {
    state.docs["billing/RandomOldId123"] = { bookingId: "bk1", type: "party_deposit", total: 92.25, status: "invoiced", userId: "parent-uid" };
    await statusChange("bk1", booking({ status: "rejected" }), booking({ status: "confirmed" }));
    expect(bills()).toHaveLength(1);
    expect(outbox()[0].html).toContain("já está pago");
    expect(outbox()[0].html).toContain("€92.25");
    expect(outbox()[0].billingId).toBe("RandomOldId123");
  });

  it("emails the family's contact when the booking has no email", async () => {
    await statusChange("bk1", booking({ email: "" }), booking({ status: "confirmed", email: "" }));
    expect(outbox()[0].to).toBe("ana.family@example.com");
    expect(bills()[0].billingEmail).toBe("ana.family@example.com");
  });

  it("pending → rejected: emails the reason, creates no bill", async () => {
    await statusChange("bk1", booking(), booking({ status: "rejected", statusReason: "Já temos uma festa nesse dia <b>" }));
    expect(bills()).toHaveLength(0);
    const mails = outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ id: partyEmailId("rejected", "bk1"), to: "ana@example.com", subject: "Reserva de festa — Rita Silva" });
    expect(mails[0].html).toContain("Motivo: Já temos uma festa nesse dia &lt;b&gt;");
    expect(mails[0].html).toContain("não foi possível confirmar");
  });

  it("pending → rejected without a reason still emails, without the reason box", async () => {
    await statusChange("bk1", booking(), booking({ status: "rejected" }));
    expect(outbox()).toHaveLength(1);
    expect(outbox()[0].html).not.toContain("Motivo:");
  });

  it("confirmed → pending, or confirmed → rejected: nothing", async () => {
    await statusChange("bk1", booking({ status: "confirmed" }), booking({ status: "pending" }));
    await statusChange("bk1", booking({ status: "confirmed" }), booking({ status: "rejected" }));
    expect(bills()).toHaveLength(0);
    expect(outbox()).toHaveLength(0);
  });
});

describe("onPartyBookingCreated", () => {
  it("emails the admin once per booking, com IVA total and the admin link", async () => {
    await created("bk1", booking());
    await created("bk1", booking()); // redelivered
    const mails = outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ id: partyEmailId("request", "bk1"), to: "admin@kidclub.pt", subject: "Novo pedido — Festa: Rita Silva" });
    expect(mails[0].html).toContain("€402.21");
    expect(mails[0].html).toContain("sem IVA €327.00");
    expect(mails[0].html).toContain("10 × Cachorro");
    expect(mails[0].html).toContain("https://kidclub.pt/admin/parties");
    expect(bills()).toHaveLength(0);
  });
});

describe("createPartyDeposit (callable)", () => {
  beforeEach(() => {
    state.docs["bookings/bk1"] = booking({ status: "confirmed" });
    state.docs["users/admin-uid"] = { roles: { rainbowAdmin: true } };
  });

  it("returns the bill the confirmation trigger already created", async () => {
    await statusChange("bk1", booking(), booking({ status: "confirmed" }));
    const res = await callDeposit("parent-uid", "bk1");
    expect(res).toEqual({ billingId: partyDepositBillingId("bk1") });
    expect(bills()).toHaveLength(1);
  });

  it("creates it (same id, owner = family parent) for a booking confirmed before the trigger existed", async () => {
    const res = await callDeposit("parent-uid", "bk1");
    expect(res).toEqual({ billingId: partyDepositBillingId("bk1") });
    expect(bills()[0]).toMatchObject({ userId: "parent-uid", total: 201.11, createdVia: "createPartyDeposit" });
  });

  it("lets an admin (impersonating) create it, still owned by the family's parent", async () => {
    await callDeposit("admin-uid", "bk1");
    expect(bills()[0].userId).toBe("parent-uid");
  });

  it("refuses someone else, and an unconfirmed booking", async () => {
    await expect(callDeposit("stranger-uid", "bk1")).rejects.toMatchObject({ code: "permission-denied" });
    state.docs["bookings/bk1"] = booking({ status: "pending" });
    await expect(callDeposit("parent-uid", "bk1")).rejects.toMatchObject({ code: "failed-precondition" });
    expect(bills()).toHaveLength(0);
  });
});
