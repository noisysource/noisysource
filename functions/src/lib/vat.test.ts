import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  VAT_CODES,
  formatVatBreakdown,
  grossFromNet,
  parseVatCode,
  splitGross,
  vatCodeChargesVat,
  vatRatePct,
} from "./vat";

const MARKER = "// ---- mirrored below:";

function mirroredPart(path: string): string {
  const src = readFileSync(path, "utf8");
  const at = src.indexOf(MARKER);
  if (at < 0) throw new Error(`${path} has no "${MARKER}" line`);
  return src.slice(at);
}

describe("vat.ts mirror", () => {
  it("is identical to packages/shared/lib/vat.ts below the marker", () => {
    const shared = mirroredPart(join(__dirname, "../../../packages/shared/lib/vat.ts"));
    const mirror = mirroredPart(join(__dirname, "vat.ts"));
    expect(mirror).toBe(shared);
  });
});

describe("splitGross", () => {
  it("splits a VAT-inclusive amount", () => {
    expect(splitGross(12300, 23)).toEqual({ grossCents: 12300, netCents: 10000, vatCents: 2300 });
    expect(splitGross(10600, 6)).toEqual({ grossCents: 10600, netCents: 10000, vatCents: 600 });
    expect(splitGross(11300, 13)).toEqual({ grossCents: 11300, netCents: 10000, vatCents: 1300 });
  });
  it("rounds the VAT to the cent", () => {
    // 10.00 € with 23% inside: 10 × 23 / 123 = 1.8699… → 1.87
    expect(splitGross(1000, 23)).toEqual({ grossCents: 1000, netCents: 813, vatCents: 187 });
  });
  it("has no VAT for 0, isento and autoliquidacao", () => {
    for (const code of [0, "isento", "autoliquidacao"] as const) {
      expect(splitGross(5000, code)).toEqual({ grossCents: 5000, netCents: 5000, vatCents: 0 });
    }
  });
  it("never treats por_confirmar as 0", () => {
    expect(splitGross(5000, "por_confirmar")).toBeNull();
    expect(grossFromNet(5000, "por_confirmar")).toBeNull();
    expect(vatRatePct("por_confirmar")).toBeNull();
  });
  it("splits a refund like the matching charge", () => {
    expect(splitGross(-1000, 23)).toEqual({ grossCents: -1000, netCents: -813, vatCents: -187 });
  });
});

describe("grossFromNet", () => {
  it("adds VAT on top", () => {
    expect(grossFromNet(10000, 23)).toEqual({ grossCents: 12300, netCents: 10000, vatCents: 2300 });
    // 1.4% of 1 234.56 € = 17.28 € fee → + 3.97 € IVA
    expect(grossFromNet(1728, 23)).toEqual({ grossCents: 2125, netCents: 1728, vatCents: 397 });
  });
  it("round-trips through splitGross for every rate", () => {
    for (const rate of [23, 13, 6, 0] as const) {
      for (let net = 0; net <= 20000; net += 7) {
        const gross = grossFromNet(net, rate)!.grossCents;
        expect(splitGross(gross, rate)!.netCents).toBe(net);
      }
    }
  });
});

describe("codes", () => {
  it("lists exactly the agreed cases", () => {
    expect(VAT_CODES.map(c => c.code)).toEqual([23, 13, 6, 0, "isento", "autoliquidacao", "por_confirmar"]);
  });
  it("parses stored values", () => {
    expect(parseVatCode(23)).toBe(23);
    expect(parseVatCode("isento")).toBe("isento");
    expect(parseVatCode("23")).toBeUndefined();
    expect(parseVatCode(undefined)).toBeUndefined();
    expect(parseVatCode(21)).toBeUndefined();
  });
  it("only 23, 13 and 6 charge VAT", () => {
    expect(VAT_CODES.filter(c => vatCodeChargesVat(c.code)).map(c => c.code)).toEqual([23, 13, 6]);
  });
});

describe("formatVatBreakdown", () => {
  // Intl may use a narrow no-break space before €; compare with plain spaces.
  const plain = (s: string) => s.replace(/\s/g, " ");
  it("shows net and VAT for a charged rate", () => {
    expect(plain(formatVatBreakdown(12300, 23))).toBe("sem IVA 100,00 € · IVA 23% 23,00 €");
  });
  it("shows only the label otherwise", () => {
    expect(formatVatBreakdown(5000, "isento")).toBe("Isento de IVA");
    expect(formatVatBreakdown(5000, "autoliquidacao")).toBe("Autoliquidação");
    expect(formatVatBreakdown(5000, "por_confirmar")).toBe("IVA por confirmar");
    expect(formatVatBreakdown(5000, 0)).toBe("IVA 0%");
  });
});
