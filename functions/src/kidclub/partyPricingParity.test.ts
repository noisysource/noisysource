import { describe, it, expect } from "vitest";
import { partyDepositAmount, partyPriceBreakdown, PARTY_VAT_CODE } from "./partyDepositLogic";
// Test-only imports from packages/shared (tests are excluded from the functions build, so this
// never reaches runtime). The KidClub app has no test runner; these pin the shared side too.
import { partyVatBreakdown } from "../../../packages/shared/models/partyPricing";
import { KIDCLUB_VAT, kidclubVatNote, kidclubVatNoteMixed, kidclubVatSplit } from "../../../packages/shared/models/kidclubVat";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** partyVatBreakdown as it was before it used lib/vat.ts (VAT convention PR 2). */
function partyVatBreakdownBefore(subtotal: number) {
  const net = round2(Number(subtotal) || 0);
  const vat = round2(net * 0.23);
  const total = round2(net + vat);
  return { subtotal: net, vat, total, deposit: round2(total * 0.5) };
}

describe("party prices after moving to lib/vat.ts", () => {
  it("don't move by a cent, for every subtotal from €0.00 to €5000.00", () => {
    const moved: string[] = [];
    for (let cents = 0; cents <= 500000; cents++) {
      const subtotal = cents / 100;
      const before = partyVatBreakdownBefore(subtotal);
      const now = partyVatBreakdown(subtotal);
      if (now.vat !== before.vat || now.total !== before.total || now.deposit !== before.deposit) {
        moved.push(`${subtotal}: ${JSON.stringify(before)} -> ${JSON.stringify(now)}`);
      }
      if (partyDepositAmount(subtotal) !== now.deposit) {
        moved.push(`${subtotal}: functions deposit ${partyDepositAmount(subtotal)} != shared ${now.deposit}`);
      }
      const fn = partyPriceBreakdown(subtotal);
      if (fn.subtotal !== now.subtotal || fn.vat !== now.vat || fn.total !== now.total || fn.deposit !== now.deposit) {
        moved.push(`${subtotal}: functions breakdown ${JSON.stringify(fn)} != shared ${JSON.stringify(now)}`);
      }
      if (moved.length > 5) break;
    }
    expect(moved).toEqual([]);
  });

  it("keeps the release test plan's K5 party", () => {
    // Festa B, 17 children, 10 cachorros, decoração: subtotal €327
    expect(partyVatBreakdown(327)).toEqual({ subtotal: 327, vat: 75.21, total: 402.21, deposit: 201.11 });
  });

  it("uses the same rate on both sides", () => {
    expect(PARTY_VAT_CODE).toBe(KIDCLUB_VAT.party);
  });
});

describe("KidClub VAT per service", () => {
  it("matches the Vendus products (invoice FR 01P2026/202, 2026-10-12)", () => {
    // event: one-off events (AdhocEvent.ts) are invoiced as PRODUCT_STUDY, like camps and party deposits.
    expect(KIDCLUB_VAT).toEqual({ study: 23, transport: 6, enrollment: 23, insurance: 23, party: 23, event: 23 });
  });

  it("takes the VAT out of a price, it doesn't add it", () => {
    expect(kidclubVatSplit(100, "transport")).toEqual({ gross: 100, net: 94.34, vat: 5.66 });
    expect(kidclubVatNote(100, "transport")).toBe("sem IVA €94.34 · IVA 6% €5.66");
    expect(kidclubVatNote(48, "study")).toBe("sem IVA €39.02 · IVA 23% €8.98");
    expect(kidclubVatNote(35, "enrollment")).toBe("sem IVA €28.46 · IVA 23% €6.54");
    expect(kidclubVatNote(0, "transport")).toBe("sem IVA €0.00 · IVA 6% €0.00");
  });

  it("splits a mixed total per rate, like the Vendus invoice", () => {
    // FR 01P2026/202: study 24 + enrollment 35 + insurance 25 at 23% = 84 → IVA 15.71;
    // transport 6 at 6% → IVA 0.34. Invoice: base 68.29 + 5.66, IVA 15.71 + 0.34.
    const note = kidclubVatNoteMixed([
      { grossEur: 24, service: "study" },
      { grossEur: 35, service: "enrollment" },
      { grossEur: 25, service: "insurance" },
      { grossEur: 6, service: "transport" },
    ]);
    expect(note).toBe("sem IVA €73.95 · IVA €16.05");
  });
});
