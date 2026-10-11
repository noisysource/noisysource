import { describe, it, expect } from "vitest";
import { vendusClientFieldsChanged, vendusSyncFields } from "./vendusClientLogic";

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
