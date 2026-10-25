import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No real Vendus or Firestore here: the external guard and the daily-cap
// counter are mocked, and global fetch is replaced by a stub per test.
vi.mock("../externalGuard", () => ({ assertExternalCallsAllowed: vi.fn() }));
vi.mock("./vendusClientCap", () => ({ reserveVendusClientCreation: vi.fn(async () => {}) }));

import { createInvoice, createOrUpdateClient, listDocuments, VendusClientPayload } from "./vendus";
import { reserveVendusClientCreation } from "./vendusClientCap";

type Reply = { status?: number; body: unknown };
interface Call { method: string; url: string; body?: any }

// Every fetch made in the current test, checked in afterEach.
let recorded: Call[] = [];

/** Stubs fetch with one queued reply per call; records every call. */
function stubFetch(replies: Reply[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    const call = { method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    recorded.push(call);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected fetch: ${init.method} ${url}`);
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body };
  }));
  return calls;
}

const NOT_FOUND: Reply = { status: 404, body: { errors: [{ code: "A001", message: "Not found" }] } };
const client = (id: number, fiscal_id = "") => ({ id, name: "X", email: "", fiscal_id, external_reference: "" });

beforeEach(() => {
  recorded = [];
  vi.stubEnv("VENDUS_API_KEY", "test-key-not-real");
  vi.stubEnv("VENDUS_REGISTER_ID", "123");
  vi.mocked(reserveVendusClientCreation).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  // Vendus prints external_reference on invoices: no path may send it, and
  // nothing may look clients up by it any more.
  for (const c of recorded) {
    expect(c.url).not.toContain("external_reference");
    if (c.body !== undefined) expect(c.body).not.toHaveProperty("external_reference");
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createOrUpdateClient", () => {
  it("known vendusClientId: PATCHes that client only (no lookup, no create, no cap)", async () => {
    const calls = stubFetch([{ body: { id: 42 } }]);

    const id = await createOrUpdateClient("fam1", { name: "A", phone: "912345678" }, 42);

    expect(id).toBe(42);
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(calls[0].url).toMatch(/\/clients\/42\/$/);
    expect(calls[0].body).toEqual({ name: "A", phone: "912345678" });
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId already holding the same NIF: reads it, then PATCHes it (no NIF lookup, no create)", async () => {
    const calls = stubFetch([{ body: client(42, "123456789") }, { body: { id: 42 } }]);

    const id = await createOrUpdateClient("fam1", { name: "A", fiscal_id: "123 456 789" }, 42);

    expect(id).toBe(42);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[0].url).toMatch(/\/clients\/42\/$/);
    expect(calls[1].url).toMatch(/\/clients\/42\/$/);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId, any non-404 error: throws and never creates", async () => {
    const calls = stubFetch([{ status: 500, body: { errors: [{ message: "boom" }] } }]);

    await expect(createOrUpdateClient("fam1", { name: "A" }, 42)).rejects.toThrow(/failed \(500\)/);
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  // Real case (family 8pPhu4JCvGUrpBxsaOeY): linked to a no-NIF client, then
  // added a NIF that an older client already held.
  const DUPLICATE_NIF: Reply = { status: 400, body: { errors: [{ code: "A002", message: "NIF duplicado" }] } };

  // Real case (family 8pPhu4JCvGUrpBxsaOeY, 2026-10): linked to a NIF-less
  // client, then added a NIF that an older client already held. Since
  // 2026-10-13 a NIF is never PATCHed onto a NIF-less client: it's looked up.
  it("late NIF, known client has no NIF, another client holds it: re-links to that client, never PATCHes the known one", async () => {
    const calls = stubFetch([
      { body: client(365352238, "") },            // GET /clients/365352238/: no NIF
      { body: [client(364285165, "123456789")] }, // GET by NIF
      { body: { id: 364285165 } },                // PATCH /clients/364285165/
    ]);

    const id = await createOrUpdateClient("8pPhu4JCvGUrpBxsaOeY", { name: "C", fiscal_id: "123456789" }, 365352238);

    expect(id).toBe(364285165);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls[0].url).toMatch(/\/clients\/365352238\/$/);
    expect(calls[1].url).toContain("/clients/?fiscal_id=123456789");
    expect(calls[2].url).toMatch(/\/clients\/364285165\/$/);
    expect(calls[2].body).toEqual({ name: "C", fiscal_id: "123456789" });
    expect(calls.some((c) => c.method === "PATCH" && /\/clients\/365352238\/$/.test(c.url))).toBe(false);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("late NIF, known client has no NIF, nobody holds it: creates a client with the NIF and returns the new id (no PATCH at all)", async () => {
    for (const lookup of [{ body: [] }, NOT_FOUND]) {
      vi.mocked(reserveVendusClientCreation).mockClear();
      const calls = stubFetch([
        { body: client(365352238, "") },       // GET known: no NIF
        lookup,                                // GET by NIF: none
        { status: 201, body: { id: 900 } },    // POST /clients/
      ]);

      const id = await createOrUpdateClient("famLate", { name: "C", email: "c@example.com", fiscal_id: "123456789" }, 365352238);

      expect(id).toBe(900);
      expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
      expect(calls[2].url).toMatch(/\/clients\/$/);
      expect(calls[2].body).toEqual({ name: "C", email: "c@example.com", fiscal_id: "123456789" });
      expect(reserveVendusClientCreation).toHaveBeenCalledTimes(1);
    }
  });

  it("known client shows the Consumidor final NIF (999999990): treated as no NIF, never PATCHed", async () => {
    const calls = stubFetch([
      { body: client(42, "999999990") },
      { body: [] },
      { status: 201, body: { id: 901 } },
    ]);

    const id = await createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42);

    expect(id).toBe(901);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
  });

  it("known client holds a different NIF: not changed; links/creates the client for the new NIF", async () => {
    const calls = stubFetch([
      { body: client(42, "111111111") },       // GET known: other NIF
      { body: [client(77, "123456789")] },     // GET by NIF
      { body: { id: 77 } },                    // PATCH /clients/77/
    ]);

    const id = await createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42);

    expect(id).toBe(77);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls[2].url).toMatch(/\/clients\/77\/$/);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("reading the known client fails with a non-404 error: throws, no lookup, no create", async () => {
    const calls = stubFetch([{ status: 500, body: { errors: [{ message: "boom" }] } }]);

    await expect(createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42)).rejects.toThrow(/GET \/clients\/42\/ failed \(500\)/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  // Defensive path from #91, kept: the known client holds the NIF and Vendus
  // still answers "duplicado" on the PATCH.
  it("known client holds the NIF, PATCH still says duplicado: re-links to the client holding the NIF (no create, no cap)", async () => {
    const calls = stubFetch([
      { body: client(42, "123456789") },  // GET known
      DUPLICATE_NIF,                      // PATCH /clients/42/ rejected
      { body: [client(77, "123456789")] }, // GET by NIF
      { body: { id: 77 } },               // PATCH /clients/77/
    ]);

    const id = await createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42);

    expect(id).toBe(77);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known client holds the NIF, duplicado but no other client with that NIF found (empty list or 404): throws, never creates", async () => {
    for (const lookup of [{ body: [] }, NOT_FOUND]) {
      const calls = stubFetch([{ body: client(42, "123456789") }, DUPLICATE_NIF, lookup]);

      await expect(createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42)).rejects.toThrow(/duplicado/);
      expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]);
    }
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known client holds the NIF, duplicado and the NIF lookup returns that same client: throws, never creates", async () => {
    const calls = stubFetch([{ body: client(42, "123456789") }, DUPLICATE_NIF, { body: [client(42, "123456789")] }]);

    await expect(createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42)).rejects.toThrow(/duplicado/);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known client holds the NIF, PATCH rejected for another reason: throws, no lookup, no create", async () => {
    const calls = stubFetch([{ body: client(42, "123456789") }, { status: 400, body: { errors: [{ message: "Erro" }] } }]);

    await expect(createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42)).rejects.toThrow(/failed \(400\)/);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId 404 (deleted), with NIF: falls through to NIF lookup and PATCHes that client", async () => {
    const calls = stubFetch([
      NOT_FOUND,                          // GET /clients/42/
      { body: [client(77, "123456789")] }, // GET by NIF
      { body: { id: 77 } },               // PATCH /clients/77/
    ]);

    const id = await createOrUpdateClient("fam1", { name: "A", fiscal_id: "123456789" }, 42);

    expect(id).toBe(77);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls[1].url).toContain("/clients/?fiscal_id=123456789");
    expect(calls[2].url).toMatch(/\/clients\/77\/$/);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId 404 (deleted), no NIF: falls through to create", async () => {
    const calls = stubFetch([NOT_FOUND, { status: 201, body: { id: 555 } }]);

    const id = await createOrUpdateClient("fam1", { name: "A" }, 42);

    expect(id).toBe(555);
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    expect(reserveVendusClientCreation).toHaveBeenCalledTimes(1);
  });

  it("no known id, NIF found in Vendus: PATCHes that client, no create", async () => {
    const calls = stubFetch([{ body: [client(77, "123456789")] }, { body: { id: 77 } }]);

    const id = await createOrUpdateClient("fam2", { name: "B", fiscal_id: "123456789", send_email: "yes" }, null);

    expect(id).toBe(77);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1].url).toMatch(/\/clients\/77\/$/);
    expect(calls[1].body).toEqual({ name: "B", fiscal_id: "123456789", send_email: "yes" });
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("no known id, NIF not in Vendus (empty list or 404): creates", async () => {
    for (const lookup of [{ body: [] }, NOT_FOUND]) {
      vi.mocked(reserveVendusClientCreation).mockClear();
      const calls = stubFetch([lookup, { status: 201, body: { id: 600 } }]);

      const id = await createOrUpdateClient("fam2", { name: "B", fiscal_id: "123456789" });

      expect(id).toBe(600);
      expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
      expect(calls[1].body).toEqual({ name: "B", fiscal_id: "123456789" });
      expect(reserveVendusClientCreation).toHaveBeenCalledTimes(1);
    }
  });

  it("no known id, no NIF: creates without external_reference; cap label is family:<id>", async () => {
    const calls = stubFetch([{ status: 201, body: { id: 555 } }]);

    const id = await createOrUpdateClient("qgQTaxxSpsUJl5bVpVR5", { name: "thaise.ps07", email: "t@example.com" });

    expect(id).toBe(555);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(calls[0].url).toMatch(/\/clients\/$/);
    expect(calls[0].body).toEqual({ name: "thaise.ps07", email: "t@example.com" });
    expect(reserveVendusClientCreation).toHaveBeenCalledWith("family:qgQTaxxSpsUJl5bVpVR5");
  });

  it("duplicate NIF on create: re-links the existing client found by NIF, without external_reference", async () => {
    const calls = stubFetch([
      { body: [] },                                                      // GET by NIF: not found (yet)
      { status: 400, body: { errors: [{ message: "NIF duplicado" }] } }, // POST rejected
      { body: [client(77, "123456789")] },                               // GET by NIF again
      { body: { id: 77 } },                                              // PATCH
    ]);

    const id = await createOrUpdateClient("fam2", { name: "B", fiscal_id: "123456789" });

    expect(id).toBe(77);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "PATCH"]);
    expect(calls[3].url).toMatch(/\/clients\/77\/$/);
    expect(calls[3].body).toEqual({ name: "B", fiscal_id: "123456789" });
  });

  it("fails closed: over the daily cap it never POSTs to Vendus", async () => {
    vi.mocked(reserveVendusClientCreation).mockRejectedValueOnce(new Error("[Vendus] daily client-creation cap reached"));
    const calls = stubFetch([]);

    await expect(createOrUpdateClient("fam1", { name: "A" })).rejects.toThrow(/cap reached/);
    expect(calls).toHaveLength(0);
  });

  it("strips an external_reference smuggled in by an untyped caller, on create and on PATCH", async () => {
    const sneaky = { name: "A", external_reference: "family:fam1" } as unknown as VendusClientPayload;

    const created = stubFetch([{ status: 201, body: { id: 1 } }]);
    await createOrUpdateClient("fam1", sneaky);
    expect(created[0].body).toEqual({ name: "A" });

    const patched = stubFetch([{ body: { id: 2 } }]);
    await createOrUpdateClient("fam1", sneaky, 2);
    expect(patched[0].body).toEqual({ name: "A" });
  });
});

describe("createInvoice", () => {
  const items = [{ id: 286916222, title: "Sala de estudo", qty: 1, gross_price: 100 }];

  it("no client (family without a NIF): the body has no client field at all, so Vendus issues it to Consumidor final", async () => {
    const calls = stubFetch([{ status: 201, body: { id: 1, number: "FR T01P2026/1" } }]);

    await createInvoice(null, items, "2026-10-13", 286783134, 100, "Período: Outubro 2026");

    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(calls[0].url).toMatch(/\/documents\/$/);
    expect(calls[0].body).not.toHaveProperty("client");
    expect(calls[0].body).toMatchObject({ type: "FR", date: "2026-10-13", register_id: 123, items, payments: [{ id: 286783134, amount: 100 }] });
  });

  it("with a client: sends it as given", async () => {
    const calls = stubFetch([{ status: 201, body: { id: 2, number: "FR 01P2026/2" } }]);

    await createInvoice({ id: 42 }, items, "2026-10-13", 286783130, 100);

    expect(calls[0].body.client).toEqual({ id: 42 });
    expect(calls[0].body).not.toHaveProperty("notes");
  });
});

describe("listDocuments", () => {
  const doc = (id: number) => ({ id, number: `FR 01P2026/${id}`, date: "2026-10-12" });
  const docs = (from: number, n: number) => Array.from({ length: n }, (_, i) => doc(from + i));
  const pageOf = (url: string) => new URL(url).searchParams.get("page");

  it("filters with since/until (date_from/date_to get a 403 from Vendus), type=FR, explicit per_page=50", async () => {
    const calls = stubFetch([{ body: docs(1, 3) }]);

    const result = await listDocuments("2026-10-01", "2026-12-31");

    expect(result.map((d) => d.id)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls[0].url).toBe(
      "https://www.vendus.pt/ws/v1.1/documents/?since=2026-10-01&until=2026-12-31&type=FR&per_page=50&page=1",
    );
    expect(calls[0].url).not.toMatch(/date_from|date_to/);
  });

  it("follows pages while they're full (50), stops at the first short one", async () => {
    const calls = stubFetch([{ body: docs(1, 50) }, { body: { data: docs(51, 7) } }]);

    const result = await listDocuments("2026-07-01", "2026-09-30");

    expect(result).toHaveLength(57);
    expect(calls.map((c) => pageOf(c.url))).toEqual(["1", "2"]);
    for (const c of calls) expect(new URL(c.url).searchParams.get("per_page")).toBe("50");
  });

  it("an exact multiple of 50: the next, empty page ends the list", async () => {
    const calls = stubFetch([{ body: docs(1, 50) }, { body: [] }]);

    expect(await listDocuments("2026-07-01", "2026-09-30")).toHaveLength(50);
    expect(calls.map((c) => pageOf(c.url))).toEqual(["1", "2"]);
  });

  it("bounded: stops after 40 full pages and throws instead of returning a partial list", async () => {
    const calls = stubFetch(Array.from({ length: 41 }, (_, i) => ({ body: docs(i * 50 + 1, 50) })));

    await expect(listDocuments("2026-01-01", "2026-12-31")).rejects.toThrow(/still full after 40 pages \(2000 documents\)/);
    expect(calls).toHaveLength(40);
    expect(pageOf(calls[39].url)).toBe("40");
  });

  it("a Vendus error is not swallowed (the old date_from 403 surfaced to getKidclubVatSummary's caller)", async () => {
    stubFetch([{ status: 403, body: { errors: [{ code: "P001", message: "O campo date_from não é permitido." }] } }]);

    await expect(listDocuments("2026-10-01", "2026-12-31")).rejects.toThrow(/failed \(403\)/);
  });
});
