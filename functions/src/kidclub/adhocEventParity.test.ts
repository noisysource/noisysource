import { describe, it, expect } from "vitest";
import { dayPrice, eventTotal, seatsLeft, ADHOC_MAX_CHILDREN, ADHOC_HOLD_MINUTES, ADHOC_MAX_MBWAY_ATTEMPTS, ADHOC_VAT_CODE } from "./adhocEventLogic";
// Test-only imports from packages/shared (excluded from the functions build). The app shows
// prices with the shared copy and the server charges with this one: they must agree.
import {
  adhocDayPrice, adhocTotal, adhocSeatsLeft,
  ADHOC_MAX_CHILDREN as SHARED_MAX_CHILDREN, ADHOC_HOLD_MINUTES as SHARED_HOLD_MINUTES, ADHOC_MAX_MBWAY_ATTEMPTS as SHARED_MAX_MBWAY,
} from "../../../packages/shared/models/AdhocEvent";
import { KIDCLUB_VAT } from "../../../packages/shared/models/kidclubVat";

describe("one-off event prices: app (packages/shared) and server (functions) agree", () => {
  it("constants", () => {
    expect(SHARED_MAX_CHILDREN).toBe(ADHOC_MAX_CHILDREN);
    expect(SHARED_HOLD_MINUTES).toBe(ADHOC_HOLD_MINUTES);
    expect(SHARED_MAX_MBWAY).toBe(ADHOC_MAX_MBWAY_ATTEMPTS);
    expect(KIDCLUB_VAT.event).toBe(ADHOC_VAT_CODE);
  });

  it("day price, total and seats, over a grid of prices, tiers, children and days", () => {
    const prices = [0, 0.5, 9.99, 12.35, 25, 30, 47.5];
    const days = prices.map((price, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, price, memberPrice: i % 2 ? price * 0.8 : undefined, capacity: 10, taken: i }));
    for (const tier of ["public", "member"] as const) {
      for (const d of days) expect(adhocDayPrice(d, tier)).toBe(dayPrice(d, tier));
      for (let k = 1; k <= days.length; k++) {
        const chosen = days.slice(0, k).map(d => d.date);
        for (let n = 1; n <= 4; n++) expect(adhocTotal(days, chosen, n, tier)).toBe(eventTotal(days, chosen, n, tier));
      }
    }
    for (const d of [...days, { capacity: 3, taken: 5 }]) expect(adhocSeatsLeft(d)).toBe(seatsLeft(d));
  });
});
