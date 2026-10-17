import { describe, it, expect } from "vitest";
import { partyDepositAmount } from "./partyDepositLogic";

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
