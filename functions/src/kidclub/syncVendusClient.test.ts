import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The trigger's own handler (CloudFunction.run), with no Firestore and no
// Vendus: firebase-admin, ./db and ./vendus are mocked.
const state = vi.hoisted(() => ({ updates: [] as { id: string; data: Record<string, unknown> }[] }));

vi.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: Object.assign(() => ({}), {
    FieldValue: { delete: () => "<DELETE>", serverTimestamp: () => "<NOW>" },
  }),
}));
vi.mock("./db", () => ({
  appCol: () => ({
    doc: (id: string) => ({
      update: async (data: Record<string, unknown>) => { state.updates.push({ id, data }); },
    }),
  }),
}));
vi.mock("./vendus", () => ({ createOrUpdateClient: vi.fn() }));

import { syncVendusClient } from "./syncVendusClient";
import { createOrUpdateClient } from "./vendus";

const snap = (data: Record<string, any> | undefined) => ({ exists: !!data, data: () => data });
const family = (overrides: Record<string, any> = {}) => ({
  profileComplete: true,
  primaryContact: { name: "Ana", email: "ana@example.com", phone: "912345678", userId: "u1" },
  ...overrides,
});

/** Runs the trigger for a write from `before` to `after` on families/fam1. */
const write = (before: Record<string, any> | undefined, after: Record<string, any>) =>
  (syncVendusClient as any).run({ params: { familyId: "fam1" }, data: { before: snap(before), after: snap(after) } });

beforeEach(() => {
  state.updates = [];
  vi.mocked(createOrUpdateClient).mockReset();
  vi.stubEnv("GCLOUD_PROJECT", "test-project");
});

afterEach(() => vi.unstubAllEnvs());

describe("syncVendusClient", () => {
  it("skips a family without a NIF entirely: no Vendus call, no write", async () => {
    for (const nif of [undefined, "", "999999990"]) {
      await write(undefined, family({ nif }));                                      // created
      await write(family({ profileComplete: false, nif }), family({ nif }));        // profile completed
      await write(family({ nif: "123456789" }), family({ nif, nifOptOut: true }));  // NIF removed (opt-out)
    }
    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("skips a NIF-less family that holds an old NIF-less vendusClientId (no PATCH, the id is left alone)", async () => {
    const before = family({ vendusClientId: 365352238 });
    await write(before, { ...before, primaryContact: { ...before.primaryContact, phone: "934567890" } });

    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("no NIF and a stale vendusSyncError: only clears the error, still no Vendus call", async () => {
    const before = family({ nif: "123456789", vendusClientId: 1, vendusSyncError: { message: "x", at: 1 } });
    await write(before, { ...before, nif: "" });

    expect(createOrUpdateClient).not.toHaveBeenCalled();
    expect(state.updates).toEqual([{ id: "fam1", data: { vendusSyncError: "<DELETE>" } }]);
  });

  it("with a NIF: syncs with the NIF and the known client id, and writes back a new id", async () => {
    vi.mocked(createOrUpdateClient).mockResolvedValue(900);
    const before = family({ vendusClientId: 365352238 });
    await write(before, { ...before, nif: "123 456 789" });

    expect(createOrUpdateClient).toHaveBeenCalledTimes(1);
    expect(createOrUpdateClient).toHaveBeenCalledWith("fam1", {
      name: "Ana", email: "ana@example.com", fiscal_id: "123456789", phone: "912345678",
    }, 365352238);
    expect(state.updates).toEqual([{ id: "fam1", data: { vendusClientId: 900 } }]);
  });

  it("with a NIF but no synced field changed (e.g. its own write-back): no Vendus call", async () => {
    const before = family({ nif: "123456789", vendusClientId: 1 });
    await write(before, { ...before, vendusClientId: 2 });

    expect(createOrUpdateClient).not.toHaveBeenCalled();
  });

  it("with a NIF, a Vendus failure is recorded as vendusSyncError", async () => {
    vi.mocked(createOrUpdateClient).mockRejectedValue(new Error("Vendus GET /clients/1/ failed (500): boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await write(family(), family({ nif: "123456789", vendusClientId: 1 }));
    errSpy.mockRestore();

    expect(state.updates).toEqual([{
      id: "fam1",
      data: { vendusSyncError: { message: "Vendus GET /clients/1/ failed (500): boom", at: "<NOW>" } },
    }]);
  });
});
