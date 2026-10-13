import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Invoicing (billing.ts) with no Firestore and no Vendus: firebase-admin and
// ./db are in-memory fakes, and ./vendus's createInvoice/createOrUpdateClient
// are mocks (its constants stay real).
const state = vi.hoisted(() => ({
  docs: {} as Record<string, Record<string, any>>,          // "collection/id" → data
  updates: [] as { path: string; data: Record<string, any> }[],
  added: [] as { collection: string; data: Record<string, any> }[],
}));

vi.mock("firebase-admin", () => {
  const ref = (path: string) => ({
    path,
    get: async () => ({ exists: !!state.docs[path], data: () => state.docs[path] }),
  });
  return {
    apps: [{}],
    initializeApp: vi.fn(),
    firestore: Object.assign(() => ({
      runTransaction: async (fn: (tx: any) => any) => fn({
        get: (r: ReturnType<typeof ref>) => r.get(),
        update: (r: ReturnType<typeof ref>, data: Record<string, any>) => { state.updates.push({ path: r.path, data }); },
      }),
      collection: (c: string) => ({ doc: (id: string) => ref(`${c}/${id}`) }),
    }), {
      FieldValue: { delete: () => "<DELETE>", serverTimestamp: () => "<NOW>", arrayUnion: (...v: unknown[]) => ({ arrayUnion: v }) },
      FieldPath: { documentId: () => "__name__" },
      Timestamp: { fromDate: (d: Date) => d, fromMillis: (m: number) => m },
    }),
  };
});
vi.mock("./db", () => ({
  appCol: (c: string) => ({
    doc: (id: string) => {
      const path = `${c}/${id}`;
      return {
        path,
        get: async () => ({ exists: !!state.docs[path], data: () => state.docs[path] }),
        update: async (data: Record<string, any>) => { state.updates.push({ path, data }); },
      };
    },
    add: async (data: Record<string, any>) => { state.added.push({ collection: c, data }); return { id: "new" }; },
  }),
}));
vi.mock("./vendus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vendus")>()),
  createInvoice: vi.fn(),
  createOrUpdateClient: vi.fn(),
}));

import { issueVendusInvoice, createVendusInvoiceForBilling } from "./billing";
import { createInvoice, createOrUpdateClient } from "./vendus";

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
const VENDUS_DOC = { id: 5550001, number: "FR 01P2026/300", date: "2026-10-13", atcud: "ABCD-300" };

beforeEach(() => {
  state.docs = {};
  state.updates = [];
  state.added = [];
  vi.mocked(createInvoice).mockReset().mockResolvedValue(VENDUS_DOC);
  vi.mocked(createOrUpdateClient).mockReset();
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

      expect(res).toEqual({ vendusDoc: VENDUS_DOC, consumidorFinal: true });
      expect(createInvoice).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createInvoice).mock.calls[0][0]).toBeNull();
    }
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("family without a NIF but an old NIF-less vendusClientId: still Consumidor final, the old client isn't used", async () => {
    state.docs["families/fam1"] = { nifOptOut: true, vendusClientId: 365352238 };

    const res = await issueVendusInvoice(bill());

    expect(res.consumidorFinal).toBe(true);
    expect(vi.mocked(createInvoice).mock.calls[0][0]).toBeNull();
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("family with a NIF and a vendusClientId: invoices that client, no client call (as before)", async () => {
    state.docs["families/fam1"] = { nif: "123456789", vendusClientId: 364285165 };

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
      name: "Ana Silva", email: "ana@example.com", send_email: "yes", fiscal_id: "123456789",
    }, null);
    expect(state.updates).toEqual([{ path: "families/fam1", data: { vendusClientId: 777 } }]);
    expect(vi.mocked(createInvoice).mock.calls[0][0]).toEqual({ id: 777 });
  });

  it("still refuses to invoice on kidclub-dev, before reading anything", async () => {
    vi.stubEnv("GCLOUD_PROJECT", "kidclub-dev");
    await expect(issueVendusInvoice(bill())).rejects.toThrow(/disabled on kidclub-dev/);
    expect(createInvoice).not.toHaveBeenCalled();
  });
});

describe("createVendusInvoiceForBilling — 'fatura disponível' email", () => {
  const outbox = () => state.added.filter((a) => a.collection === "emailOutbox").map((a) => a.data);

  it("Consumidor final invoice: records it, then queues one email to the parent with the portal link", async () => {
    state.docs["billing/b1"] = bill();
    state.docs["families/fam1"] = { nifOptOut: true };

    await createVendusInvoiceForBilling("b1");

    expect(state.updates.find((u) => u.path === "billing/b1" && u.data.status === "invoiced")?.data)
      .toMatchObject({ invoiceNumber: "FR 01P2026/300", vendusId: 5550001 });
    const mails = outbox();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "ana@example.com", status: "queued" });
    expect(mails[0].subject).toContain("Fatura disponível");
    expect(mails[0].html).toContain("https://kidclub.pt/client/payments");
    expect(mails[0].html).toContain("FR 01P2026/300");
    expect(mails[0].html).toContain("Consumidor final");
  });

  it("invoice to a client (family with a NIF): no email from us (Vendus handles its clients)", async () => {
    state.docs["billing/b1"] = bill();
    state.docs["families/fam1"] = { nif: "123456789", vendusClientId: 364285165 };

    await createVendusInvoiceForBilling("b1");

    expect(outbox()).toEqual([]);
  });

  it("no email when the bill has no billingEmail, and none when Vendus fails", async () => {
    state.docs["billing/b1"] = bill({ billingEmail: "" });
    state.docs["families/fam1"] = {};
    await createVendusInvoiceForBilling("b1");
    expect(outbox()).toEqual([]);

    state.docs["billing/b2"] = bill();
    vi.mocked(createInvoice).mockRejectedValueOnce(new Error("Vendus POST /documents/ failed (500)"));
    await expect(createVendusInvoiceForBilling("b2")).rejects.toThrow(/failed \(500\)/);
    expect(outbox()).toEqual([]);
  });

  it("escapes the parent's name in the email", async () => {
    state.docs["billing/b1"] = bill({ billingName: "<b>Ana</b>" });
    state.docs["families/fam1"] = {};

    await createVendusInvoiceForBilling("b1");

    expect(outbox()[0].html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(outbox()[0].html).not.toContain("<b>Ana</b>");
  });
});
