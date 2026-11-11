import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Invoicing (billing.ts) with no Firestore and no Vendus. firebase-admin and
// ./db share one in-memory store: writes are applied, create() fails on an
// existing doc (like Firestore's ALREADY_EXISTS), and transactions run one at
// a time (Firestore serializes conflicting ones). ./vendus's createInvoice and
// createOrUpdateClient are mocks; its constants stay real.
const fake = vi.hoisted(() => {
  const state = {
    docs: {} as Record<string, Record<string, any>>, // "collection/id" -> data
    log: [] as { op: "update" | "create" | "add" | "set"; path: string; data: Record<string, any> }[],
    failCreate: null as Error | null,                // makes the next outbox create() throw
  };
  const DELETE = "<DELETE>";
  const write = (path: string, data: Record<string, any>) => {
    const next = { ...(state.docs[path] ?? {}) };
    for (const [k, v] of Object.entries(data)) {
      if (v === DELETE) delete next[k]; else next[k] = v;
    }
    state.docs[path] = next;
  };
  const snapOf = (path: string) => ({
    id: path.split("/")[1], exists: !!state.docs[path], data: () => state.docs[path], ref: ref(path),
  });
  function ref(path: string): any {
    return {
      path,
      id: path.split("/")[1],
      get: async () => snapOf(path),
      update: async (data: Record<string, any>) => {
        if (!state.docs[path]) throw new Error(`NOT_FOUND ${path}`);
        state.log.push({ op: "update", path, data });
        write(path, data);
      },
      set: async (data: Record<string, any>) => {
        state.log.push({ op: "set", path, data });
        state.docs[path] = {};
        write(path, data);
      },
      create: async (data: Record<string, any>) => {
        if (state.failCreate) { const e = state.failCreate; state.failCreate = null; throw e; }
        if (state.docs[path]) throw Object.assign(new Error(`6 ALREADY_EXISTS: Document already exists: ${path}`), { code: 6 });
        state.log.push({ op: "create", path, data });
        write(path, data);
      },
    };
  }
  const collection = (c: string) => {
    const query = (filters: [string, string, unknown][]) => ({
      where: (f: string, op: string, v: unknown) => query([...filters, [f, op, v]]),
      limit: () => query(filters),
      get: async () => {
        const docs = Object.keys(state.docs)
          .filter((p) => p.startsWith(`${c}/`))
          .filter((p) => filters.every(([f, op, v]) => {
            const x = state.docs[p][f];
            return op === "array-contains" ? Array.isArray(x) && x.includes(v) : x === v;
          }))
          .map(snapOf);
        return { empty: docs.length === 0, docs };
      },
    });
    return {
      doc: (id: string) => ref(`${c}/${id}`),
      add: async (data: Record<string, any>) => {
        const path = `${c}/auto${state.log.length}`;
        state.log.push({ op: "add", path, data });
        write(path, data);
        return ref(path);
      },
      ...query([]),
    };
  };
  let lock: Promise<unknown> = Promise.resolve();
  const runTransaction = (fn: (tx: any) => Promise<unknown>) => {
    const run = lock.then(() => fn({
      get: (r: any) => r.get(),
      update: (r: any, data: Record<string, any>) => { state.log.push({ op: "update", path: r.path, data }); write(r.path, data); },
    }));
    lock = run.catch(() => {});
    return run;
  };
  return { state, collection, runTransaction, DELETE };
});

vi.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: Object.assign(() => ({ runTransaction: fake.runTransaction, collection: fake.collection }), {
    FieldValue: { delete: () => fake.DELETE, serverTimestamp: () => "<NOW>", arrayUnion: (...v: unknown[]) => ({ arrayUnion: v }) },
    FieldPath: { documentId: () => "__name__" },
    Timestamp: { fromDate: (d: Date) => d, fromMillis: (m: number) => m },
  }),
}));
vi.mock("./db", () => ({ appCol: (c: string) => fake.collection(c) }));
vi.mock("./vendus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vendus")>()),
  createInvoice: vi.fn(),
  createOrUpdateClient: vi.fn(),
  findOrCreateClientByNif: vi.fn(),
}));

import { issueVendusInvoice, createVendusInvoiceForBilling, easypayWebhook, retryVendusInvoice, invoiceReadyEmailId, onAdhocRegistrationBillingSync } from "./billing";
import { createInvoice, createOrUpdateClient, findOrCreateClientByNif, PRODUCT_STUDY } from "./vendus";

const { state } = fake;

const bill = (overrides: Record<string, any> = {}) => ({
  familyId: "fam1",
  userId: "u1",
  lineItems: [{ title: "Sala de estudo — Rita", amount: 120 }, { title: "Transporte — Rita", amount: 40 }],
  total: 160,
  billingName: "Ana Silva",
  billingEmail: "ana@example.com",
  periodLabel: "Outubro 2026",
  paymentMethod: "mbway",
  status: "paid",
  ...overrides,
});
const NIF_FAMILY = { nif: "123456789", vendusClientId: 364285165 };
const NO_NIF_FAMILY = { nifOptOut: true };

let nextVendusId = 5550001;
const invoiceReplies = () => vi.mocked(createInvoice).mockImplementation(async () => {
  const id = nextVendusId++;
  return { id, number: `FR 01P2026/${id - 5550000}`, date: "2026-10-14", atcud: `ABCD-${id}` };
});

/** The "Fatura disponível" emails queued so far. */
const outbox = () => Object.entries(state.docs)
  .filter(([p]) => p.startsWith("emailOutbox/"))
  .map(([p, data]) => ({ id: p.split("/")[1], ...data }));

beforeEach(() => {
  state.docs = {};
  state.log = [];
  state.failCreate = null;
  nextVendusId = 5550001;
  vi.mocked(createInvoice).mockReset();
  invoiceReplies();
  vi.mocked(createOrUpdateClient).mockReset();
  vi.mocked(findOrCreateClientByNif).mockReset();
  vi.stubEnv("GCLOUD_PROJECT", "test-project");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("issueVendusInvoice — who the invoice goes to", () => {
  it("family without a NIF: createInvoice gets no client (Consumidor final); no client created or updated, family untouched", async () => {
    for (const nif of [undefined, "", "  ", "999999990"]) {
      vi.mocked(createInvoice).mockClear();
      state.docs["families/fam1"] = { nif, primaryContact: { name: "Ana Silva" } };

      const res = await issueVendusInvoice(bill());

      expect(res.consumidorFinal).toBe(true);
      expect(createInvoice).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createInvoice).mock.calls[0][0]).toBeNull();
    }
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(state.log).toEqual([]);
  });

  it("family without a NIF but an old NIF-less vendusClientId: still Consumidor final, the old client isn't used", async () => {
    state.docs["families/fam1"] = { nifOptOut: true, vendusClientId: 365352238 };

    const res = await issueVendusInvoice(bill());

    expect(res.consumidorFinal).toBe(true);
    expect(vi.mocked(createInvoice).mock.calls[0][0]).toBeNull();
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(state.log).toEqual([]);
  });

  it("family with a NIF and a vendusClientId: invoices that client, no client call (as before)", async () => {
    state.docs["families/fam1"] = NIF_FAMILY;

    const res = await issueVendusInvoice(bill());

    expect(res.consumidorFinal).toBe(false);
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    const [client, items, , paymentMethodId, amount, notes] = vi.mocked(createInvoice).mock.calls[0];
    expect(client).toEqual({ id: 364285165 });
    expect(items.map((i) => i.gross_price)).toEqual([120, 40]);
    expect(paymentMethodId).toBe(286783134);
    expect(amount).toBe(160);
    expect(notes).toBe("Período: Outubro 2026");
  });

  it("family with a NIF and no vendusClientId: ensures the client with the NIF, links it, and invoices it", async () => {
    state.docs["families/fam1"] = { nif: "123 456 789" };
    vi.mocked(createOrUpdateClient).mockResolvedValue(777);

    const res = await issueVendusInvoice(bill());

    expect(res.consumidorFinal).toBe(false);
    expect(createOrUpdateClient).toHaveBeenCalledWith("fam1", {
      name: "Ana Silva", email: "ana@example.com", fiscal_id: "123456789",
    }, null);
    // Vendus's own invoice emails stay off: the app emails instead (no double email).
    expect(vi.mocked(createOrUpdateClient).mock.calls[0][1]).not.toHaveProperty("send_email");
    expect(state.log).toEqual([{ op: "update", path: "families/fam1", data: { vendusClientId: 777 } }]);
    expect(vi.mocked(createInvoice).mock.calls[0][0]).toEqual({ id: 777 });
  });

  it("still refuses to invoice on kidclub-dev, before reading anything", async () => {
    vi.stubEnv("GCLOUD_PROJECT", "kidclub-dev");
    await expect(issueVendusInvoice(bill())).rejects.toThrow(/disabled on kidclub-dev/);
    expect(createInvoice).not.toHaveBeenCalled();
  });
});

describe("issueVendusInvoice — one-off event bills (adhocEvents.ts)", () => {
  const guestBill = (overrides: Record<string, any> = {}) => bill({
    type: "event", familyId: "", userId: "", eventRegistrationId: "reg1",
    lineItems: [{ title: "Halloween — Rita (31/10)", amount: 25, type: "event" }], total: 25, periodLabel: "Halloween — 31/10",
    ...overrides,
  });

  it("guest without a NIF: Consumidor final, no family read, no client found or created", async () => {
    const res = await issueVendusInvoice(guestBill());

    expect(res.consumidorFinal).toBe(true);
    expect(vi.mocked(createInvoice).mock.calls[0][0]).toBeNull();
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(findOrCreateClientByNif).not.toHaveBeenCalled();
    expect(state.log).toEqual([]);
  });

  it("guest with a NIF: the client for that NIF (found or created, never updated), nothing written", async () => {
    vi.mocked(findOrCreateClientByNif).mockResolvedValue(888);

    const res = await issueVendusInvoice(guestBill({ guestNif: "123 456 789" }));

    expect(res.consumidorFinal).toBe(false);
    expect(findOrCreateClientByNif).toHaveBeenCalledWith({ name: "Ana Silva", email: "ana@example.com", fiscal_id: "123456789" }, "event-guest:reg1");
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(vi.mocked(createInvoice).mock.calls[0][0]).toEqual({ id: 888 });
    expect(state.log).toEqual([]);
  });

  it("event lines are PRODUCT_STUDY (23%) whatever the event is called, also on a monthly bill", async () => {
    state.docs["families/fam1"] = NIF_FAMILY;
    await issueVendusInvoice(bill({
      lineItems: [{ title: "Transporte Escolar — Rita (2ª) — Outubro 2026", amount: 40, type: "transport" }, { title: "Transporte ao museu — Rita (31/10)", amount: 25, type: "event" }],
      total: 65,
    }));
    const items = vi.mocked(createInvoice).mock.calls[0][1];
    expect(items[0].id).not.toBe(PRODUCT_STUDY);
    expect(items[1].id).toBe(PRODUCT_STUDY);
  });

  it("guest's 'Fatura disponível' email links to the registration page, not the client area", async () => {
    state.docs["billing/b1"] = guestBill();
    state.docs["adhocEventRegistrations/reg1"] = { accessToken: "tok_123" };

    await createVendusInvoiceForBilling("b1");

    const html = outbox()[0].html;
    expect(html).toContain("https://kidclub.pt/eventos/inscricao/reg1?t=tok_123");
    expect(html).not.toContain("/client/payments");
    expect(html).not.toContain("/client/account");
  });
});

describe("createVendusInvoiceForBilling — 'Fatura disponível' email for every invoice", () => {
  it("family with a NIF: one email with the portal link, and no NIF request", async () => {
    state.docs["billing/b1"] = bill();
    state.docs["families/fam1"] = NIF_FAMILY;

    await createVendusInvoiceForBilling("b1");

    expect(state.docs["billing/b1"]).toMatchObject({ status: "invoiced", invoiceNumber: "FR 01P2026/1", vendusId: 5550001 });
    const mails = outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      id: invoiceReadyEmailId(5550001), to: "ana@example.com", status: "queued", billingId: "b1", familyId: "fam1",
    });
    expect(mails[0].subject).toBe("Fatura disponível — Arco-Íris da Pequenada — Outubro 2026");
    expect(mails[0].html).toContain("https://kidclub.pt/client/payments");
    expect(mails[0].html).toContain("FR 01P2026/1");
    expect(mails[0].html).not.toContain("Consumidor final");
    expect(mails[0].html).not.toContain("/client/account");
  });

  it("family without a NIF (Consumidor final): one email, which also asks for the NIF", async () => {
    state.docs["billing/b1"] = bill();
    state.docs["families/fam1"] = NO_NIF_FAMILY;

    await createVendusInvoiceForBilling("b1");

    const mails = outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0].id).toBe(invoiceReadyEmailId(5550001));
    expect(mails[0].html).toContain("https://kidclub.pt/client/payments");
    expect(mails[0].html).toContain("Consumidor final");
    expect(mails[0].html).toContain("https://kidclub.pt/client/account");
  });

  it("no email when the bill has no billingEmail, and none when Vendus fails", async () => {
    state.docs["billing/b1"] = bill({ billingEmail: "" });
    state.docs["families/fam1"] = NIF_FAMILY;
    await createVendusInvoiceForBilling("b1");
    expect(state.docs["billing/b1"].status).toBe("invoiced");
    expect(outbox()).toEqual([]);

    state.docs["billing/b2"] = bill();
    vi.mocked(createInvoice).mockRejectedValueOnce(new Error("Vendus POST /documents/ failed (500)"));
    await expect(createVendusInvoiceForBilling("b2")).rejects.toThrow(/failed \(500\)/);
    expect(outbox()).toEqual([]);
  });

  it("an email failure doesn't fail the invoice: recorded as invoiced, no error, no invoiceError", async () => {
    state.docs["billing/b1"] = bill();
    state.docs["families/fam1"] = NIF_FAMILY;
    state.failCreate = new Error("14 UNAVAILABLE: firestore down");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createVendusInvoiceForBilling("b1")).resolves.toBeUndefined();

    expect(state.docs["billing/b1"]).toMatchObject({ status: "invoiced", invoiceNumber: "FR 01P2026/1" });
    expect(state.docs["billing/b1"]).not.toHaveProperty("invoiceError");
    expect(state.docs["billing/b1"]).not.toHaveProperty("invoiceClaimedAt");
    expect(outbox()).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("could not be queued"), expect.anything());
  });

  it("escapes the parent's name in the email", async () => {
    state.docs["billing/b1"] = bill({ billingName: "<b>Ana</b>" });
    state.docs["families/fam1"] = NIF_FAMILY;

    await createVendusInvoiceForBilling("b1");

    expect(outbox()[0].html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(outbox()[0].html).not.toContain("<b>Ana</b>");
  });
});

describe("one email per invoice — no duplicates", () => {
  it("the same invoice reaching the email step again: the outbox doc already exists, nothing new is queued, no error", async () => {
    // As if an earlier run had already queued the email for Vendus document 5550001.
    state.docs[`emailOutbox/${invoiceReadyEmailId(5550001)}`] = { to: "ana@example.com", status: "sent" };
    state.docs["billing/b1"] = bill();
    state.docs["families/fam1"] = NIF_FAMILY;

    await expect(createVendusInvoiceForBilling("b1")).resolves.toBeUndefined();

    expect(state.docs["billing/b1"].status).toBe("invoiced");
    expect(outbox()).toHaveLength(1);
    expect(outbox()[0].status).toBe("sent"); // untouched
    expect(state.log.filter((l) => l.path.startsWith("emailOutbox/"))).toEqual([]);
  });

  it("two invoice runs for the same bill at once: one invoice, one email (the claim lets one through)", async () => {
    state.docs["billing/b1"] = bill();
    state.docs["families/fam1"] = NIF_FAMILY;

    await Promise.all([createVendusInvoiceForBilling("b1"), createVendusInvoiceForBilling("b1")]);
    await createVendusInvoiceForBilling("b1"); // and a later one: already invoiced

    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(outbox()).toHaveLength(1);
  });

  it("EasyPay's two webhook calls for one payment, at once: one invoice, one email", async () => {
    state.docs["billing/b1"] = bill({ status: "processing", easypayId: "ep-1" });
    state.docs["families/fam1"] = NO_NIF_FAMILY;
    const call = (body: unknown) => new Promise<void>((resolve) => {
      const res = { status: () => res, send: () => { resolve(); return res; } };
      (easypayWebhook as any)({ method: "POST", body, headers: {}, header: () => undefined, get: () => undefined }, res);
    });

    await Promise.all([
      call({ id: "ep-1", type: "capture", status: "success" }),
      call({ id: "ep-1", value: 160, method: "mbw", transaction: { type: "capture", values: { paid: 160 } } }),
    ]);

    expect(state.docs["billing/b1"]).toMatchObject({ status: "invoiced", paidEasypayId: "ep-1" });
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(outbox()).toHaveLength(1);
  });

  it("retryVendusInvoice on an invoiced bill is refused (no new invoice, no email); after a failed invoice it emails the new one once", async () => {
    state.docs["users/admin1"] = { roles: { rainbowAdmin: true } };
    state.docs["families/fam1"] = NIF_FAMILY;
    const retry = (billingId: string) => (retryVendusInvoice as any).run({ auth: { uid: "admin1" }, data: { billingId } });

    // Already invoiced (and emailed): the retry is refused.
    state.docs["billing/b1"] = bill();
    await createVendusInvoiceForBilling("b1");
    await expect(retry("b1")).rejects.toThrow(/already created/i);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(outbox()).toHaveLength(1);

    // Paid, first invoice attempt failed: the retry issues it and emails it, once.
    state.docs["billing/b2"] = bill({ periodLabel: "Novembro 2026" });
    vi.mocked(createInvoice).mockRejectedValueOnce(new Error("Vendus POST /documents/ failed (500)"));
    await expect(createVendusInvoiceForBilling("b2")).rejects.toThrow(/failed \(500\)/);
    expect(outbox()).toHaveLength(1);
    await retry("b2");
    await expect(retry("b2")).rejects.toThrow(/already created/i);

    expect(state.docs["billing/b2"].status).toBe("invoiced");
    expect(outbox()).toHaveLength(2);
    expect(outbox().filter((m) => m.billingId === "b2")).toHaveLength(1);
  });
});

describe("retryVendusInvoice — never a second invoice for a bill that already has one", () => {
  const retry = (billingId: string, extra: Record<string, unknown> = {}) =>
    (retryVendusInvoice as any).run({ auth: { uid: "admin1" }, data: { billingId, ...extra } });

  beforeEach(() => {
    state.docs["users/admin1"] = { roles: { rainbowAdmin: true } };
    state.docs["families/fam1"] = NIF_FAMILY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("an invoiced bill with a stale invoiceError (prod oK6GHA7D0f4cRVM3RNZW_2026-09) is refused and left untouched", async () => {
    state.docs["billing/b1"] = bill({
      status: "invoiced",
      invoiceNumber: "FR 01P2026/226",
      vendusId: 9001,
      atcud: "ABCD-9001",
      invoiceError: "Vendus POST /documents/ failed (400): A001 You are trying to generate too many documents simultaneously",
    });
    const before = structuredClone(state.docs["billing/b1"]);

    await expect(retry("b1")).rejects.toMatchObject({ code: "already-exists", message: expect.stringContaining("FR 01P2026/226") });

    expect(createInvoice).not.toHaveBeenCalled();
    expect(state.docs["billing/b1"]).toEqual(before);
    expect(state.log.filter((l) => l.path === "billing/b1")).toEqual([]);
    expect(outbox()).toEqual([]);
  });

  it("a paid bill with an invoiceError and no invoice recorded is still retried, once", async () => {
    state.docs["billing/b2"] = bill({ invoiceError: "Vendus POST /documents/ failed (500)" });

    await retry("b2");

    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(state.docs["billing/b2"]).toMatchObject({ status: "invoiced", invoiceNumber: "FR 01P2026/1" });
    expect(state.docs["billing/b2"]).not.toHaveProperty("invoiceError");
    await expect(retry("b2")).rejects.toMatchObject({ code: "already-exists" });
    expect(createInvoice).toHaveBeenCalledTimes(1);
  });

  it("force still re-invoices a bill that has an invoice (explicit override, unchanged)", async () => {
    state.docs["billing/b3"] = bill({ status: "invoiced", invoiceNumber: "FR 01P2026/226", vendusId: 9001 });

    await retry("b3", { force: true });

    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(state.docs["billing/b3"]).toMatchObject({ status: "invoiced", invoiceNumber: "FR 01P2026/1", vendusId: 5550001 });
  });

  it("recording an invoice clears an invoiceError written while Vendus was issuing it", async () => {
    state.docs["billing/b4"] = bill();
    vi.mocked(createInvoice).mockImplementationOnce(async () => {
      // As the losing webhook call did before the claim existed.
      state.docs["billing/b4"] = { ...state.docs["billing/b4"], invoiceError: "A001 You are trying to generate too many documents simultaneously" };
      return { id: 5550001, number: "FR 01P2026/1", date: "2026-10-17", atcud: "ABCD-5550001" };
    });

    await createVendusInvoiceForBilling("b4");

    expect(state.docs["billing/b4"]).toMatchObject({ status: "invoiced", invoiceNumber: "FR 01P2026/1", vendusId: 5550001 });
    expect(state.docs["billing/b4"]).not.toHaveProperty("invoiceError");
  });
});

describe("one-off events on the monthly bill (onAdhocRegistrationBillingSync → fetchEventLines)", () => {
  // A family with no subscriptions at all, so the recompute skips every
  // ReservationEvent/children query the fake can't run.
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const billId = `billing/famE_${period}`;
  const reg = (o: Record<string, any> = {}) => ({
    familyId: "famE", payment: "monthly", status: "confirmed", billingPeriod: period, createdAt: { toMillis: () => 1 },
    lines: [{ title: "Halloween — Rita (31/10)", amount: 20 }, { title: "Halloween — Tomás (31/10)", amount: 20 }],
    ...o,
  });
  const run = (before: any, after: any) => (onAdhocRegistrationBillingSync as any).run({
    data: { before: { data: () => before }, after: { data: () => after } },
  });

  beforeEach(() => {
    state.docs["families/famE"] = { primaryContact: { userId: "uE", name: "Eva", email: "eva@example.com" }, paymentMethod: "mbway" };
  });

  it("a confirmed monthly registration creates that month's bill with one line per child", async () => {
    state.docs["adhocEventRegistrations/r1"] = reg();
    await run(undefined, reg());
    const bill = state.docs[billId];
    expect(bill).toMatchObject({ familyId: "famE", userId: "uE", status: "pending", total: 40, billingEmail: "eva@example.com" });
    expect(bill.lineItems).toEqual([
      { title: "Halloween — Rita (31/10)", amount: 20, grossAmount: 20, subscriptionId: "event:r1:0", type: "event", appliedDiscounts: [] },
      { title: "Halloween — Tomás (31/10)", amount: 20, grossAmount: 20, subscriptionId: "event:r1:1", type: "event", appliedDiscounts: [] },
    ]);
    // No payment notice is emailed for a bill created by the sync.
    expect(Object.keys(state.docs).some(p => p.startsWith("emailOutbox/"))).toBe(false);
  });

  it("adds to an existing pending bill; cancelling takes it off again (auto-cancelled when nothing is left)", async () => {
    state.docs["adhocEventRegistrations/r1"] = reg();
    await run(undefined, reg());
    state.docs["adhocEventRegistrations/r2"] = reg({ lines: [{ title: "Greve — Rita (14/11)", amount: 15.5 }], createdAt: { toMillis: () => 2 } });
    await run(undefined, state.docs["adhocEventRegistrations/r2"]);
    expect(state.docs[billId].total).toBe(55.5);
    expect(state.docs[billId].lineItems.map((l: any) => l.subscriptionId)).toEqual(["event:r1:0", "event:r1:1", "event:r2:0"]);

    state.docs["adhocEventRegistrations/r1"] = reg({ status: "cancelled" });
    await run(reg(), reg({ status: "cancelled" }));
    expect(state.docs[billId].total).toBe(15.5);

    state.docs["adhocEventRegistrations/r2"] = { ...state.docs["adhocEventRegistrations/r2"], status: "cancelled" };
    await run(reg(), reg({ status: "cancelled" }));
    expect(state.docs[billId]).toMatchObject({ status: "cancelled", autoCancelled: true });
  });

  it("never touches a bill that's already paid", async () => {
    state.docs[billId] = { familyId: "famE", status: "paid", total: 99, lineItems: [{ title: "x", amount: 99 }] };
    state.docs["adhocEventRegistrations/r1"] = reg();
    await run(undefined, reg());
    expect(state.docs[billId]).toEqual({ familyId: "famE", status: "paid", total: 99, lineItems: [{ title: "x", amount: 99 }] });
  });

  it("ignores pay-now registrations and edits that change neither status nor month", async () => {
    state.docs["adhocEventRegistrations/r1"] = reg({ payment: "now" });
    await run(undefined, reg({ payment: "now" }));
    await run(reg(), reg({ pickupNotes: "Avó" }));
    expect(state.docs[billId]).toBeUndefined();
  });
});
