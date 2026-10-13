import { describe, it, expect } from "vitest";
import {
  vendusClientFieldsChanged, vendusSyncFields, vendusSyncWriteback, VENDUS_SYNC_ERROR_MAX_LENGTH,
  familyInvoiceNif, realNif, vendusSkipWriteback,
} from "./vendusClientLogic";

const family = (overrides: Record<string, any> = {}) => ({
  profileComplete: true,
  nif: "",
  primaryContact: { name: "Thaise", email: "t@example.com", phone: "912345678", userId: "u1" },
  billingAddress: { street: "Rua A", city: "Coimbra" },
  ...overrides,
});

describe("vendusClientFieldsChanged", () => {
  it("syncs a newly created doc (no before)", () => {
    expect(vendusClientFieldsChanged(undefined, family())).toBe(true);
    expect(vendusClientFieldsChanged(null, family())).toBe(true);
  });

  it("skips a write that only sets vendusClientId (the trigger's own write-back)", () => {
    const before = family();
    const after = { ...before, vendusClientId: 123456 };
    expect(vendusClientFieldsChanged(before, after)).toBe(false);
    // and a later write-back replacing one id with another
    expect(vendusClientFieldsChanged({ ...before, vendusClientId: 1 }, { ...before, vendusClientId: 2 })).toBe(false);
  });

  it("skips a write that only sets or clears vendusSyncError (the trigger's own error record)", () => {
    const before = family({ vendusClientId: 1 });
    const withError = { ...before, vendusSyncError: { message: "NIF duplicado", at: 1 } };
    expect(vendusClientFieldsChanged(before, withError)).toBe(false);                 // set
    expect(vendusClientFieldsChanged(withError, before)).toBe(false);                 // cleared
    expect(vendusClientFieldsChanged(withError, { ...withError, vendusSyncError: { message: "x", at: 2 } })).toBe(false);
    // success write-back: new id + error cleared, in one write
    expect(vendusClientFieldsChanged(withError, { ...before, vendusClientId: 2 })).toBe(false);
  });

  it("skips writes to unrelated fields", () => {
    const before = family();
    expect(vendusClientFieldsChanged(before, { ...before, paymentMethod: "bank_transfer", updatedAt: 99 })).toBe(false);
    expect(vendusClientFieldsChanged(before, { ...before, billingAddress: { street: "Rua B" } })).toBe(false);
    expect(vendusClientFieldsChanged(before, {
      ...before, primaryContact: { ...before.primaryContact, userId: "u2" },
    })).toBe(false);
  });

  it("skips an unchanged re-save", () => {
    expect(vendusClientFieldsChanged(family(), family())).toBe(false);
  });

  it("syncs when profileComplete changes", () => {
    expect(vendusClientFieldsChanged(family({ profileComplete: false }), family())).toBe(true);
    expect(vendusClientFieldsChanged(family({ profileComplete: undefined }), family())).toBe(true);
  });

  it("syncs when the NIF changes", () => {
    expect(vendusClientFieldsChanged(family(), family({ nif: "123456789" }))).toBe(true);
  });

  it("syncs when the contact name, email or phone changes", () => {
    const before = family();
    const withContact = (c: Record<string, any>) => ({ ...before, primaryContact: { ...before.primaryContact, ...c } });
    expect(vendusClientFieldsChanged(before, withContact({ name: "Thaise S." }))).toBe(true);
    expect(vendusClientFieldsChanged(before, withContact({ email: "new@example.com" }))).toBe(true);
    expect(vendusClientFieldsChanged(before, withContact({ phone: "934567890" }))).toBe(true);
  });

  it("treats missing, null and empty-string fields as the same value", () => {
    expect(vendusClientFieldsChanged(family({ nif: undefined }), family({ nif: "" }))).toBe(false);
    expect(vendusClientFieldsChanged(family({ nif: null }), family({ nif: "" }))).toBe(false);
    expect(vendusClientFieldsChanged({ profileComplete: false }, { profileComplete: false, primaryContact: {} })).toBe(false);
    expect(vendusClientFieldsChanged({ profileComplete: false }, { profileComplete: false, primaryContact: { name: "A" } })).toBe(true);
  });
});

describe("vendusSyncFields", () => {
  it("extracts the synced fields with empty-string defaults", () => {
    expect(vendusSyncFields(family())).toEqual({
      profileComplete: true, nif: "", name: "Thaise", email: "t@example.com", phone: "912345678",
    });
    expect(vendusSyncFields(undefined)).toEqual({ profileComplete: false, nif: "", name: "", email: "", phone: "" });
  });
});

describe("vendusSyncWriteback", () => {
  const sentinels = { del: "<DELETE>", now: "<NOW>" };

  it("success with a new client id writes only vendusClientId", () => {
    expect(vendusSyncWriteback(family({ vendusClientId: 1 }), { clientId: 2 }, sentinels)).toEqual({ vendusClientId: 2 });
    expect(vendusSyncWriteback(family(), { clientId: 2 }, sentinels)).toEqual({ vendusClientId: 2 });
  });

  it("success with the same id and no error on file writes nothing", () => {
    expect(vendusSyncWriteback(family({ vendusClientId: 2 }), { clientId: 2 }, sentinels)).toBeNull();
  });

  it("success clears a previous vendusSyncError (with or without an id change)", () => {
    const err = { vendusSyncError: { message: "old", at: 1 } };
    expect(vendusSyncWriteback(family({ vendusClientId: 2, ...err }), { clientId: 2 }, sentinels))
      .toEqual({ vendusSyncError: "<DELETE>" });
    expect(vendusSyncWriteback(family({ vendusClientId: 1, ...err }), { clientId: 2 }, sentinels))
      .toEqual({ vendusClientId: 2, vendusSyncError: "<DELETE>" });
  });

  it("failure records vendusSyncError { message, at } and leaves vendusClientId alone", () => {
    const update = vendusSyncWriteback(
      family({ vendusClientId: 365352238 }),
      { error: new Error('Vendus PATCH /clients/365352238/ failed (400): {"errors":[{"message":"NIF duplicado"}]}') },
      sentinels,
    );
    expect(update).toEqual({
      vendusSyncError: { message: 'Vendus PATCH /clients/365352238/ failed (400): {"errors":[{"message":"NIF duplicado"}]}', at: "<NOW>" },
    });
  });

  it("failure with a non-Error value, and a very long message, still records a bounded string", () => {
    expect(vendusSyncWriteback(family(), { error: "boom" }, sentinels)).toEqual({ vendusSyncError: { message: "boom", at: "<NOW>" } });
    const long = vendusSyncWriteback(family(), { error: new Error("x".repeat(5000)) }, sentinels) as any;
    expect(long.vendusSyncError.message).toHaveLength(VENDUS_SYNC_ERROR_MAX_LENGTH);
  });
});

describe("familyInvoiceNif / realNif", () => {
  it("returns the NIF without spaces", () => {
    expect(familyInvoiceNif(family({ nif: "123456789" }))).toBe("123456789");
    expect(familyInvoiceNif(family({ nif: " 123 456 789 " }))).toBe("123456789");
  });

  it("null when the family has no NIF: missing, null, blank, or the Consumidor final NIF", () => {
    for (const nif of [undefined, null, "", "   ", "999999990", "999 999 990"]) {
      expect(familyInvoiceNif(family({ nif }))).toBeNull();
    }
    expect(familyInvoiceNif(undefined)).toBeNull();
  });

  it("the opt-out flag alone doesn't decide: only `nif` does", () => {
    expect(familyInvoiceNif(family({ nif: "", nifOptOut: true }))).toBeNull();
    expect(familyInvoiceNif(family({ nif: "", nifOptOut: false }))).toBeNull();
  });

  it("realNif: '' for a client with no NIF of its own", () => {
    expect(realNif("")).toBe("");
    expect(realNif(null)).toBe("");
    expect(realNif("999999990")).toBe("");
    expect(realNif("123456789")).toBe("123456789");
  });
});

describe("vendusSkipWriteback (family skipped for having no NIF)", () => {
  it("clears a stale vendusSyncError, and touches nothing else", () => {
    expect(vendusSkipWriteback(family({ vendusClientId: 1, vendusSyncError: { message: "x", at: 1 } }), "<DELETE>"))
      .toEqual({ vendusSyncError: "<DELETE>" });
  });

  it("writes nothing when there's no error on file (keeps an old vendusClientId as is)", () => {
    expect(vendusSkipWriteback(family({ vendusClientId: 1 }), "<DELETE>")).toBeNull();
    expect(vendusSkipWriteback(family(), "<DELETE>")).toBeNull();
  });
});
