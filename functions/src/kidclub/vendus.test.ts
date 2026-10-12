import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No real Vendus or Firestore here: the external guard and the daily-cap
// counter are mocked, and global fetch is replaced by a stub per test.
vi.mock("../externalGuard", () => ({ assertExternalCallsAllowed: vi.fn() }));
vi.mock("./vendusClientCap", () => ({ reserveVendusClientCreation: vi.fn(async () => {}) }));

import { createOrUpdateClient } from "./vendus";
import { reserveVendusClientCreation } from "./vendusClientCap";

type Reply = { status?: number; body: unknown };
interface Call { method: string; url: string; body?: any }

/** Stubs fetch with one queued reply per call; records every call. */
function stubFetch(replies: Reply[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected fetch: ${init.method} ${url}`);
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body };
  }));
  return calls;
}

beforeEach(() => {
  vi.stubEnv("VENDUS_API_KEY", "test-key-not-real");
  vi.mocked(reserveVendusClientCreation).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createOrUpdateClient", () => {
  it("creates a missing client WITH external_reference family:<id>, so the next lookup finds it", async () => {
    const calls = stubFetch([
      { body: [] },                     // GET by external_reference: not found
      { status: 201, body: { id: 555 } }, // POST /clients/
    ]);

    const id = await createOrUpdateClient("qgQTaxxSpsUJl5bVpVR5", { name: "thaise.ps07", email: "t@example.com" });

    expect(id).toBe(555);
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/clients/?external_reference=family%3AqgQTaxxSpsUJl5bVpVR5");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toMatch(/\/clients\/$/);
    expect(calls[1].body).toEqual({
      name: "thaise.ps07",
      email: "t@example.com",
      external_reference: "family:qgQTaxxSpsUJl5bVpVR5",
    });
    expect(reserveVendusClientCreation).toHaveBeenCalledTimes(1);
  });

  it("the family ref wins over any external_reference the caller passed", async () => {
    const calls = stubFetch([{ body: [] }, { body: { id: 1 } }]);
    await createOrUpdateClient("fam1", { name: "A", external_reference: "something-else" });
    expect(calls[1].body.external_reference).toBe("family:fam1");
  });

  it("updates (PATCH) an existing client found by ref, without creating or touching the cap", async () => {
    const calls = stubFetch([
      { body: [{ id: 42, name: "A", email: "", fiscal_id: "", external_reference: "family:fam1" }] },
      { body: { id: 42 } },
    ]);

    const id = await createOrUpdateClient("fam1", { name: "A", phone: "912345678" });

    expect(id).toBe(42);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1].url).toMatch(/\/clients\/42\/$/);
    expect(reserveVendusClientCreation).not.toHaveBeenCalled();
  });

  it("fails closed: over the daily cap it never POSTs to Vendus", async () => {
    vi.mocked(reserveVendusClientCreation).mockRejectedValueOnce(new Error("[Vendus] daily client-creation cap reached"));
    const calls = stubFetch([{ body: [] }]); // only the lookup may happen

    await expect(createOrUpdateClient("fam1", { name: "A" })).rejects.toThrow(/cap reached/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("duplicate NIF: re-links the existing client by NIF with the family ref", async () => {
    const calls = stubFetch([
      { body: [] },                                                         // GET by ref
      { status: 400, body: { errors: [{ message: "NIF duplicado" }] } },    // POST rejected
      { body: [{ id: 77, name: "B", email: "", fiscal_id: "123456789", external_reference: "" }] }, // GET by NIF
      { body: { id: 77 } },                                                 // PATCH
    ]);

    const id = await createOrUpdateClient("fam2", { name: "B", fiscal_id: "123456789" });

    expect(id).toBe(77);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "PATCH"]);
    expect(calls[1].body.external_reference).toBe("family:fam2");
    expect(calls[3].body.external_reference).toBe("family:fam2");
  });
});
