import { describe, it, expect } from "vitest";
import { partyDepositAmount, partyDepositBillingId, partyDepositOwner, buildPartyDepositRecord, partyStatusEvent, partyPriceBreakdown } from "./partyDepositLogic";

describe("partyDepositAmount", () => {
  it("takes 50% of the IVA-inclusive total", () => {
    // €150 + 23% IVA = €184.50 → deposit €92.25 (was €75 before the fix)
    expect(partyDepositAmount(150)).toBe(92.25);
    expect(partyDepositAmount(210)).toBe(129.15);
    expect(partyDepositAmount(240)).toBe(147.6);
  });
  it("rounds to cents", () => {
    // 157 + 36.11 = 193.11 → 96.555 → 96.56
    expect(partyDepositAmount(157)).toBe(96.56);
  });
  it("treats a missing or non-numeric total as zero", () => {
    expect(partyDepositAmount(undefined)).toBe(0);
    expect(partyDepositAmount("abc")).toBe(0);
    expect(partyDepositAmount("150")).toBe(92.25);
  });
});

describe("partyPriceBreakdown", () => {
  it("gives subtotal, IVA, total and deposit from the pre-IVA total", () => {
    expect(partyPriceBreakdown(327)).toEqual({ subtotal: 327, vat: 75.21, total: 402.21, deposit: 201.11 });
    expect(partyPriceBreakdown(150)).toEqual({ subtotal: 150, vat: 34.5, total: 184.5, deposit: 92.25 });
    expect(partyPriceBreakdown(undefined)).toEqual({ subtotal: 0, vat: 0, total: 0, deposit: 0 });
  });
});

describe("partyDepositBillingId", () => {
  it("is deterministic per booking and never looks like a monthly bill id", () => {
    expect(partyDepositBillingId("AbC123xyz")).toBe("partyDeposit_AbC123xyz");
    expect(partyDepositBillingId("AbC123xyz")).toBe(partyDepositBillingId("AbC123xyz"));
    expect(/_\d{4}-\d{2}$/.test(partyDepositBillingId("Q8f2kLm0Zx9PqRs7TuVw"))).toBe(false);
  });
});

describe("partyDepositOwner", () => {
  it("is the family's primaryContact.userId, not the booking's userId", () => {
    expect(partyDepositOwner("parent-uid", "admin-uid")).toBe("parent-uid");
  });
  it("falls back to the booking's userId when the family has no owner", () => {
    expect(partyDepositOwner("", "parent-uid")).toBe("parent-uid");
    expect(partyDepositOwner(undefined, "parent-uid")).toBe("parent-uid");
  });
  it("is empty when neither has one", () => {
    expect(partyDepositOwner("", undefined)).toBe("");
    expect(partyDepositOwner(null, 42)).toBe("");
  });
});

describe("buildPartyDepositRecord", () => {
  const now = new Date("2026-10-20T10:00:00Z");
  const booking = {
    familyId: "fam1", userId: "booking-uid", childName: "Rita Silva", partyType: "Festa B",
    date: "2026-11-21", time: "15:00", total: 327, parentName: "Ana Silva", email: "ana@example.com",
  };
  const base = { bookingId: "bk1", booking, familyOwnerUid: "owner-uid", createdVia: "test", now };

  it("bills 50% of the IVA-inclusive total to the family's owner, as a party_deposit", () => {
    const r = buildPartyDepositRecord(base);
    expect(r).toMatchObject({
      familyId: "fam1",
      userId: "owner-uid",
      bookingId: "bk1",
      type: "party_deposit",
      total: 201.11,
      lineItems: [{ title: "Sinal 50% — Festa B", amount: 201.11 }],
      periodLabel: "Sinal — Festa de Rita Silva — 21/11/2026",
      billingName: "Ana Silva",
      billingEmail: "ana@example.com",
      status: "pending",
      createdVia: "test",
    });
    expect(r.periodStart).toEqual(now);
    expect(r.periodEnd).toEqual(new Date("2026-11-21T00:00:00Z"));
    expect(r.dueDate).toEqual(new Date("2026-10-27T10:00:00Z"));
  });

  it("takes the family's payment method, else mbway", () => {
    expect(buildPartyDepositRecord({ ...base, familyPaymentMethod: "bank_transfer" }).paymentMethod).toBe("bank_transfer");
    expect(buildPartyDepositRecord(base).paymentMethod).toBe("mbway");
  });

  it("falls back to the family contact when the booking has no email or name", () => {
    const r = buildPartyDepositRecord({
      ...base, booking: { ...booking, email: "", parentName: "" },
      familyContactEmail: "fam@example.com", familyContactName: "Família Silva",
    });
    expect(r.billingEmail).toBe("fam@example.com");
    expect(r.billingName).toBe("Família Silva");
  });

  it("copes with a missing date", () => {
    const r = buildPartyDepositRecord({ ...base, booking: { ...booking, date: "" } });
    expect(r.periodLabel).toBe("Sinal — Festa de Rita Silva");
    expect(r.periodEnd).toEqual(now);
  });
});

describe("partyStatusEvent", () => {
  it("fires 'confirmed' when the status becomes confirmed", () => {
    expect(partyStatusEvent("pending", "confirmed")).toBe("confirmed");
    expect(partyStatusEvent(undefined, "confirmed")).toBe("confirmed");
    expect(partyStatusEvent("rejected", "confirmed")).toBe("confirmed");
  });
  it("fires 'rejected' only from pending", () => {
    expect(partyStatusEvent("pending", "rejected")).toBe("rejected");
    expect(partyStatusEvent(undefined, "rejected")).toBe("rejected");
    expect(partyStatusEvent("confirmed", "rejected")).toBeNull();
  });
  it("does nothing when the status doesn't change (an edit of a confirmed booking)", () => {
    expect(partyStatusEvent("confirmed", "confirmed")).toBeNull();
    expect(partyStatusEvent("pending", "pending")).toBeNull();
    expect(partyStatusEvent(undefined, "pending")).toBeNull();
    expect(partyStatusEvent("rejected", "rejected")).toBeNull();
  });
  it("does nothing on other transitions", () => {
    expect(partyStatusEvent("confirmed", "pending")).toBeNull();
    expect(partyStatusEvent("rejected", "pending")).toBeNull();
  });
});
