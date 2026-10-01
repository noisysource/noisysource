import { describe, it, expect } from "vitest";
import { canAccessBilling, invoicePdfFilename, dayKey } from "./invoicePdfLogic";

describe("canAccessBilling", () => {
  it("allows the bill's own user", () => {
    expect(canAccessBilling({ uid: "u1", billingUserId: "u1" })).toBe(true);
  });
  it("allows the family's primary contact when the bill's userId differs", () => {
    expect(canAccessBilling({ uid: "u1", billingUserId: "other", familyPrimaryUserId: "u1" })).toBe(true);
  });
  it("allows owner and rainbowAdmin (impersonation)", () => {
    expect(canAccessBilling({ uid: "a", billingUserId: "u1", roles: { owner: true } })).toBe(true);
    expect(canAccessBilling({ uid: "a", billingUserId: "u1", roles: { rainbowAdmin: true } })).toBe(true);
  });
  it("denies anyone else, including other roles and missing fields", () => {
    expect(canAccessBilling({ uid: "x", billingUserId: "u1", familyPrimaryUserId: "u2", roles: { finhubAdmin: true } })).toBe(false);
    expect(canAccessBilling({ uid: "x" })).toBe(false);
    expect(canAccessBilling({ uid: "", billingUserId: "" })).toBe(false);
  });
});

describe("invoicePdfFilename", () => {
  it("slugs the Vendus document number", () => {
    expect(invoicePdfFilename("FR 01P2026/12", 5)).toBe("Fatura-FR-01P2026-12.pdf");
  });
  it("falls back to the Vendus id", () => {
    expect(invoicePdfFilename(undefined, 287000123)).toBe("Fatura-287000123.pdf");
    expect(invoicePdfFilename("  / ", 7)).toBe("Fatura-7.pdf");
  });
});

describe("dayKey", () => {
  it("uses the UTC date", () => {
    expect(dayKey(new Date("2026-09-29T23:30:00Z"))).toBe("2026-09-29");
  });
});
