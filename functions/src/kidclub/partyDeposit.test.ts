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
    return { id: path.split("/")[1], exists: !!data, data: () => data, get: (f: string) => f.split(".").reduce((o: any, k) => o?.[k], data), ref: ref(path) };
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
  // Dates compare as ms whether stored as a Date, a number or a Timestamp-like.
  const ms = (x: any) => (x instanceof Date ? x.getTime() : typeof x === "number" ? x : x?.toMillis?.() ?? NaN);
  const query = (c: string, filters: [string, string, unknown][]): any => ({
    isQuery: true,
    where: (f: string, op: string, v: unknown) => query(c, [...filters, [f, op, v]]),
    limit: () => query(c, filters),
    get: async () => {
      const docs = Object.keys(state.docs)
        .filter((p) => p.startsWith(`${c}/`))
        .filter((p) => filters.every(([f, op, v]) => {
          const val = f.split(".").reduce((o: any, k) => o?.[k], state.docs[p]);
          return op === ">=" ? ms(val) >= ms(v) : val === v;
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
        set: (r: any, data: Record<string, any>) => { writes.push(() => { state.docs[r.path] = { ...state.docs[r.path], ...data }; }); },
        update: (r: any, data: Record<string, any>) => { writes.push(() => { state.docs[r.path] = { ...state.docs[r.path], ...data }; }); },
      });
      const hook = state.beforeCommit; state.beforeCommit = null; hook?.();
      for (const w of writes) w();
      return result;
    });
    lock = run.catch(() => {});
    return run;
  };
  const batch = () => {
    const ops: (() => void)[] = [];
    return {
      set: (r: any, data: Record<string, any>) => { ops.push(() => { state.docs[r.path] = { ...data }; }); },
      update: (r: any, data: Record<string, any>) => { ops.push(() => { state.docs[r.path] = { ...state.docs[r.path], ...data }; }); },
      commit: async () => { for (const op of ops) op(); },
    };
  };
  return { state, collection, runTransaction, batch };
});

vi.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: Object.assign(() => ({ runTransaction: fake.runTransaction, collection: fake.collection, batch: fake.batch }), {
    FieldValue: { delete: () => "<DELETE>", serverTimestamp: () => "<NOW>", arrayUnion: (...v: unknown[]) => ({ arrayUnion: v }) },
    FieldPath: { documentId: () => "__name__" },
    Timestamp: { fromDate: (d: Date) => d, fromMillis: (m: number) => m, now: () => new Date() },
  }),
}));
vi.mock("./db", () => ({ appCol: (c: string) => fake.collection(c) }));
// The only external call on these paths: an MB WAY request to EasyPay.
const easypay = vi.hoisted(() => ({ createMbwayPayment: vi.fn() }));
vi.mock("./easypay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./easypay")>()),
  createMbwayPayment: easypay.createMbwayPayment,
}));

import { ensurePartyDeposit } from "./partyDeposit";
import { onPartyBookingCreated, onPartyBookingStatusNotify, partyEmailId } from "./partyBookings";
import { createPartyDeposit } from "./billing";
import { partyDepositBillingId } from "./partyDepositLogic";
import { requestPartyBooking, getPartyBookingByLink, payPartyDepositByLink } from "./partyPublic";

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
    const token = state.docs["partyLinks/bk1"].token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(mails[0].html).toContain(`https://kidclub.pt/festas/reserva/bk1?t=${token}`);
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
  it("emails the admin and the parent once per booking; the parent's links to the booking page", async () => {
    await created("bk1", booking());
    await created("bk1", booking()); // redelivered
    const mails = outbox();
    expect(mails).toHaveLength(2);
    const admin = mails.find(m => m.id === partyEmailId("request", "bk1"))!;
    expect(admin).toMatchObject({ to: "admin@kidclub.pt", subject: "Novo pedido — Festa: Rita Silva" });
    expect(admin.html).toContain("€402.21");
    expect(admin.html).toContain("sem IVA €327.00");
    expect(admin.html).toContain("10 × Cachorro");
    expect(admin.html).toContain("https://kidclub.pt/admin/parties");
    const parent = mails.find(m => m.id === partyEmailId("received", "bk1"))!;
    expect(parent).toMatchObject({ to: "ana@example.com", subject: "Pedido de festa recebido — Rita Silva" });
    expect(parent.html).toContain("€402.21");
    expect(parent.html).toContain("€201.11");
    expect(parent.html).toContain(`https://kidclub.pt/festas/reserva/bk1?t=${state.docs["partyLinks/bk1"].token}`);
    expect(bills()).toHaveLength(0);
  });

  it("keeps the token a public request already stored, so the emailed link matches the one the browser got", async () => {
    state.docs["partyLinks/bk1"] = { token: "tok-from-request", bookingId: "bk1" };
    await created("bk1", booking());
    expect(outbox().find(m => m.id === partyEmailId("received", "bk1"))!.html).toContain("?t=tok-from-request");
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

// ── Parties without an account (partyPublic.ts) ──────────────────────────────

const partyConfig = {
  partyTypes: [{ name: "Festa B", basePrice: 250, includedKids: 15, pricePerExtraChild: 10 }],
  extras: [{ name: "Cachorro", price: 2.5, perUnit: true }, { name: "Pinhata", price: 30 }],
};
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const request = (overrides: Record<string, any> = {}) => ({
  parentName: "Marta Costa",
  email: "  Marta.Costa@Example.com ",
  phone: "912 345 678",
  childName: "Tomás",
  childAge: 7,
  partyType: "Festa B",
  date: inDays(30),
  time: "15:00",
  numKids: 17,
  extras: ["Cachorro", "Não existe"],
  extrasDetail: { Cachorro: 10 },
  total: 1, // whatever the page sends, the server prices it
  ...overrides,
});
const callRequest = (data: Record<string, any>) => (requestPartyBooking as any).run({ data });
const callView = (bookingId: string, token: string) => (getPartyBookingByLink as any).run({ data: { bookingId, token } });
const callPay = (bookingId: string, token: string, phone = "912345678") =>
  (payPartyDepositByLink as any).run({ data: { bookingId, token, phone } });

describe("requestPartyBooking (public form)", () => {
  beforeEach(() => { state.docs["config/party"] = partyConfig; });

  it("saves a pending booking priced by the server, a lead family with no owner, and the booking link", async () => {
    const res = await callRequest(request());
    expect(res).toMatchObject({ ok: true });
    const b = state.docs[`bookings/${res.bookingId}`];
    // 250 + 2 extra kids × 10 + 10 × 2.5 = 295; the unknown extra is dropped.
    expect(b).toMatchObject({
      status: "pending", source: "public", total: 295, userId: "", email: "marta.costa@example.com",
      extras: ["Cachorro"], extrasDetail: { Cachorro: 10 }, childName: "Tomás", childAge: 7, phone: "912345678",
    });
    const fam = state.docs[`families/${b.familyId}`];
    expect(fam).toMatchObject({ source: "party_request", primaryContact: { email: "marta.costa@example.com", userId: "", name: "Marta Costa" } });
    expect(state.docs[`partyLinks/${res.bookingId}`].token).toBe(res.token);
  });

  it("joins the existing family with that email, owned by its parent, and makes no new family", async () => {
    state.docs["families/famX"] = { primaryContact: { email: "marta.costa@example.com", userId: "marta-uid" } };
    const familiesBefore = docsIn("families").length;
    const res = await callRequest(request());
    expect(state.docs[`bookings/${res.bookingId}`]).toMatchObject({ familyId: "famX", userId: "marta-uid" });
    expect(docsIn("families")).toHaveLength(familiesBefore);
  });

  it("stores a NIF on a new family only, never over an existing family's", async () => {
    const res = await callRequest(request({ nif: "123 456 789" }));
    expect(state.docs[`families/${state.docs[`bookings/${res.bookingId}`].familyId}`].nif).toBe("123456789");
    await expect(callRequest(request({ email: "x@example.com", nif: "12345" }))).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("a filled honeypot gets a normal answer and saves nothing", async () => {
    const familiesBefore = docsIn("families").length;
    expect(await callRequest(request({ website: "http://spam" }))).toEqual({ ok: true });
    expect(docsIn("bookings")).toHaveLength(0);
    expect(docsIn("families")).toHaveLength(familiesBefore);
  });

  it("refuses bad input with a message the page can show", async () => {
    await expect(callRequest(request({ email: "nope" }))).rejects.toMatchObject({ code: "invalid-argument", message: "Indique um email válido." });
    await expect(callRequest(request({ date: inDays(-1) }))).rejects.toMatchObject({ message: "A data da festa já passou." });
    await expect(callRequest(request({ partyType: "Festa Z" }))).rejects.toMatchObject({ message: "Escolha o tipo de festa." });
    await expect(callRequest(request({ childName: " " }))).rejects.toMatchObject({ message: "Indique o nome da criança." });
    expect(docsIn("bookings")).toHaveLength(0);
  });

  it("caps requests per email per day", async () => {
    for (let i = 0; i < 3; i++) state.docs[`bookings/old${i}`] = { email: "marta.costa@example.com", createdAt: new Date() };
    await expect(callRequest(request())).rejects.toMatchObject({ code: "resource-exhausted" });
    // Two days ago doesn't count.
    for (let i = 0; i < 3; i++) state.docs[`bookings/old${i}`].createdAt = new Date(Date.now() - 2 * 86400000);
    await expect(callRequest(request())).resolves.toMatchObject({ ok: true });
  });

  it("caps public requests from everyone per day; bookings made in the app don't count", async () => {
    for (let i = 0; i < 20; i++) state.docs[`bookings/p${i}`] = { email: `p${i}@example.com`, source: "public", createdAt: new Date() };
    state.docs["bookings/app1"] = { email: "app@example.com", createdAt: new Date() };
    await expect(callRequest(request())).rejects.toMatchObject({ code: "resource-exhausted" });
    delete state.docs["bookings/p0"];
    await expect(callRequest(request())).resolves.toMatchObject({ ok: true });
  });

  it("refuses when parties aren't configured", async () => {
    delete state.docs["config/party"];
    await expect(callRequest(request())).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

describe("booking link (getPartyBookingByLink / payPartyDepositByLink)", () => {
  beforeEach(() => {
    easypay.createMbwayPayment.mockReset();
    easypay.createMbwayPayment.mockResolvedValue({ id: "ep-1", method: { status: "pending" } });
    state.docs["partyLinks/bk1"] = { token: "good-token", bookingId: "bk1" };
  });

  it("a wrong token or booking id gets the same not-found", async () => {
    state.docs["bookings/bk1"] = booking();
    await expect(callView("bk1", "bad-token")).rejects.toMatchObject({ code: "not-found" });
    await expect(callView("bk2", "good-token")).rejects.toMatchObject({ code: "not-found" });
    await expect(callView("../bk1", "good-token")).rejects.toMatchObject({ code: "not-found" });
  });

  it("shows the booking and what the deposit will be, without the email", async () => {
    state.docs["bookings/bk1"] = booking();
    const v = await callView("bk1", "good-token");
    expect(v).toMatchObject({ status: "pending", childName: "Rita Silva", total: 402.21, depositAmount: 201.11, depositStatus: "none" });
    expect(JSON.stringify(v)).not.toContain("ana@example.com");
  });

  it("won't take a payment before the booking is confirmed", async () => {
    state.docs["bookings/bk1"] = booking();
    await expect(callPay("bk1", "good-token")).rejects.toMatchObject({ code: "failed-precondition" });
    expect(easypay.createMbwayPayment).not.toHaveBeenCalled();
    expect(bills()).toHaveLength(0);
  });

  it("confirmed with no bill yet (confirmed before this shipped): creates it, then asks EasyPay once", async () => {
    state.docs["bookings/bk1"] = booking({ status: "confirmed" });
    state.docs["families/fam1"] = family();
    await expect(callPay("bk1", "good-token")).resolves.toEqual({ ok: true });
    expect(easypay.createMbwayPayment).toHaveBeenCalledTimes(1);
    expect(easypay.createMbwayPayment.mock.calls[0][1]).toBe(201.11);
    expect(bills()).toHaveLength(1);
    expect(bills()[0]).toMatchObject({ id: partyDepositBillingId("bk1"), status: "processing", easypayId: "ep-1", userId: "parent-uid", createdVia: "payPartyDepositByLink" });
    expect((await callView("bk1", "good-token")).depositStatus).toBe("processing");
  });

  it("a paid deposit isn't charged again", async () => {
    state.docs["bookings/bk1"] = booking({ status: "confirmed" });
    state.docs[`billing/${partyDepositBillingId("bk1")}`] = { bookingId: "bk1", type: "party_deposit", status: "invoiced", total: 201.11 };
    await expect(callPay("bk1", "good-token")).rejects.toMatchObject({ code: "failed-precondition" });
    expect(easypay.createMbwayPayment).not.toHaveBeenCalled();
    expect((await callView("bk1", "good-token")).depositStatus).toBe("paid");
  });

  it("at most 5 MB WAY requests per link per hour", async () => {
    state.docs["bookings/bk1"] = booking({ status: "confirmed" });
    state.docs[`billing/${partyDepositBillingId("bk1")}`] = { bookingId: "bk1", type: "party_deposit", status: "pending", total: 201.11 };
    for (let i = 0; i < 5; i++) {
      await callPay("bk1", "good-token");
      state.docs[`billing/${partyDepositBillingId("bk1")}`].status = "failed"; // refused on the phone, tries again
    }
    await expect(callPay("bk1", "good-token")).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(easypay.createMbwayPayment).toHaveBeenCalledTimes(5);
  });

  it("asks for a phone number", async () => {
    state.docs["bookings/bk1"] = booking({ status: "confirmed" });
    await expect(callPay("bk1", "good-token", "12")).rejects.toMatchObject({ code: "invalid-argument" });
  });
});
