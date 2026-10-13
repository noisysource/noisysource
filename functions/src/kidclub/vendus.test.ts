import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No real Vendus or Firestore here: the external guard and the daily-cap
// counter are mocked, and global fetch is replaced by a stub per test.
vi.mock("../externalGuard", () => ({ assertExternalCallsAllowed: vi.fn() }));
vi.mock("./vendusClientCap", () => ({ reserveVendusClientCreation: vi.fn(async () => {}) }));

import { createOrUpdateClient, VendusClientPayload } from "./vendus";
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

  it("known vendusClientId with a NIF still PATCHes it directly (no NIF lookup)", async () => {
    const calls = stubFetch([{ body: { id: 42 } }]);

    const id = await createOrUpdateClient("fam1", { name: "A", fiscal_id: "123456789" }, 42);

    expect(id).toBe(42);
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
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

  it("known vendusClientId, PATCH with NIF says duplicado: re-links to the client holding the NIF (no create, no cap)", async () => {
    const calls = stubFetch([
      DUPLICATE_NIF,                             // PATCH /clients/365352238/ rejected
      { body: [client(364285165, "123456789")] }, // GET by NIF
      { body: { id: 364285165 } },              // PATCH /clients/364285165/
    ]);

    const id = await createOrUpdateClient("8pPhu4JCvGUrpBxsaOeY", { name: "C", fiscal_id: "123456789" }, 365352238);

    expect(id).toBe(364285165);
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET", "PATCH"]);
    expect(calls[0].url).toMatch(/\/clients\/365352238\/$/);
    expect(calls[1].url).toContain("/clients/?fiscal_id=123456789");
    expect(calls[2].url).toMatch(/\/clients\/364285165\/$/);
    expect(calls[2].body).toEqual({ name: "C", fiscal_id: "123456789" });
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId, duplicado but no client with that NIF found (empty list or 404): throws, never creates", async () => {
    for (const lookup of [{ body: [] }, NOT_FOUND]) {
      const calls = stubFetch([DUPLICATE_NIF, lookup]);

      await expect(createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42)).rejects.toThrow(/duplicado/);
      expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
    }
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId, duplicado and the NIF lookup returns that same client: throws, never creates", async () => {
    const calls = stubFetch([DUPLICATE_NIF, { body: [client(42, "123456789")] }]);

    await expect(createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42)).rejects.toThrow(/duplicado/);
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId, PATCH rejected for another reason (e.g. NIF change refused): throws, no lookup, no create", async () => {
    const calls = stubFetch([{ status: 400, body: { errors: [{ message: "Não é possível alterar o NIF" }] } }]);

    await expect(createOrUpdateClient("fam1", { name: "C", fiscal_id: "123456789" }, 42)).rejects.toThrow(/failed \(400\)/);
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("known vendusClientId 404 (deleted), with NIF: falls through to NIF lookup and PATCHes that client", async () => {
    const calls = stubFetch([
      NOT_FOUND,                          // PATCH /clients/42/
      { body: [client(77, "123456789")] }, // GET by NIF
      { body: { id: 77 } },               // PATCH /clients/77/
    ]);

    const id = await createOrUpdateClient("fam1", { name: "A", fiscal_id: "123456789" }, 42);

    expect(id).toBe(77);
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET", "PATCH"]);
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
