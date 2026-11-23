import { describe, expect, it } from "vitest";
import { underCap, usageDay } from "./usage";
import { requireFinhubUser } from "./access";

describe("FinHub AI daily cap", () => {
  it("lets calls through until the cap, then refuses", () => {
    expect(underCap(0, 400)).toBe(true);
    expect(underCap(399, 400)).toBe(true);
    expect(underCap(400, 400)).toBe(false);
  });
  it("refuses everything when the cap is 0 or not a number", () => {
    expect(underCap(0, 0)).toBe(false);
    expect(underCap(0, Number.NaN)).toBe(false);
  });
  it("counts per UTC day", () => {
    expect(usageDay(new Date("2026-11-23T23:59:59Z"))).toBe("2026-11-23");
    expect(usageDay(new Date("2026-11-24T00:00:00Z"))).toBe("2026-11-24");
  });
});

describe("who may use FinHub", () => {
  const user = (email?: string, email_verified?: boolean) => ({ token: { email, email_verified } });
  it("accepts the owner's verified address", () => {
    expect(() => requireFinhubUser(user("admin@noisysource.com", true))).not.toThrow();
  });
  it("refuses anonymous, unverified and other callers", () => {
    expect(() => requireFinhubUser(undefined)).toThrow(/Sign-in/);
    expect(() => requireFinhubUser(user("admin@noisysource.com", false))).toThrow(/private/);
    expect(() => requireFinhubUser(user("admin@noisysource.com"))).toThrow(/private/);
    expect(() => requireFinhubUser(user("someone@gmail.com", true))).toThrow(/private/);
  });
});
