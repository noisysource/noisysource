import { describe, it, expect } from "vitest";
import { checkPartyRequest, lisbonToday, partySubtotal, publicBookingView, recentAttempts, tokenMatches, partyLinkUrl } from "./partyRequestLogic";
// Test-only import from packages/shared (tests are excluded from the functions
// build): the booking pages price with this, the server with partySubtotal.
import { computePartyPrice } from "../../../packages/shared/models/partyPricing";

const config = {
  partyTypes: [
    { id: "a", name: "Festa A", description: "", basePrice: 180, includedKids: 10, pricePerExtraChild: 8.5 },
    { id: "b", name: "Festa B", description: "", basePrice: "250" as any, includedKids: "15" as any, pricePerExtraChild: 10 },
  ],
  extras: [
    { id: "x", name: "Cachorro", price: 2.35, perUnit: true },
    { id: "y", name: "Pinhata", price: "30" as any },
    { id: "z", name: "Bolo", price: 41.9 },
  ],
};

const now = new Date("2026-10-21T10:00:00Z");
const valid = {
  parentName: "Marta Costa", email: "Marta@Example.com", phone: "+351 912 345 678",
  childName: "Tomás", childAge: "7", partyType: "Festa B", date: "2026-11-21", time: "15:00",
  numKids: 17, extras: ["Cachorro"], extrasDetail: { Cachorro: 10 },
};

describe("partySubtotal matches the booking pages' computePartyPrice", () => {
  it("to the cent, across party types, kid counts and extra quantities", () => {
    const diffs: string[] = [];
    for (const partyType of ["Festa A", "Festa B", "Festa Z"]) {
      for (let numKids = 0; numKids <= 40; numKids++) {
        for (const extras of [[], ["Pinhata"], ["Cachorro", "Bolo"], ["Cachorro", "Pinhata", "Bolo"]]) {
          for (const q of [1, 3, 7, 12, 25]) {
            const sel = { partyType, numKids, extras, extrasDetail: { Cachorro: q, Bolo: 2 } };
            const shared = computePartyPrice(config as any, sel);
            const server = partySubtotal(config, sel);
            if ((shared?.subtotal ?? null) !== server) diffs.push(`${JSON.stringify(sel)}: ${shared?.subtotal} != ${server}`);
          }
        }
      }
    }
    expect(diffs).toEqual([]);
  });
});

describe("checkPartyRequest", () => {
  it("accepts a valid request, normalises it and prices it", () => {
    const r = checkPartyRequest(valid, config, now);
    expect(r).toMatchObject({ ok: true, value: {
      email: "marta@example.com", phone: "+351912345678", childAge: 7, nif: "",
      extras: ["Cachorro"], extrasDetail: { Cachorro: 10 },
      total: 250 + 2 * 10 + 23.5,
    } });
  });

  it("drops unknown extras and caps quantities", () => {
    const r = checkPartyRequest({ ...valid, extras: ["Cachorro", "Cachorro", "Nope", 5], extrasDetail: { Cachorro: 5000 } }, config, now);
    expect(r).toMatchObject({ ok: true, value: { extras: ["Cachorro"], extrasDetail: { Cachorro: 999 } } });
  });

  it("child age is optional", () => {
    expect(checkPartyRequest({ ...valid, childAge: "" }, config, now)).toMatchObject({ ok: true, value: { childAge: 0 } });
  });

  it.each([
    [{ parentName: "" }, "Indique o seu nome."],
    [{ email: "a@b" }, "Indique um email válido."],
    [{ phone: "91234" }, "Indique um telemóvel válido."],
    [{ nif: "12345678X" }, "O NIF tem 9 dígitos."],
    [{ childName: "" }, "Indique o nome da criança."],
    [{ childAge: 30 }, "A idade da criança deve estar entre 1 e 18 anos."],
    [{ partyType: "Festa Z" }, "Escolha o tipo de festa."],
    [{ date: "21/11/2026" }, "Escolha a data da festa."],
    [{ date: "2026-10-20" }, "A data da festa já passou."],
    [{ date: "2029-01-01" }, "Só aceitamos pedidos até dois anos de antecedência."],
    [{ time: "25:00" }, "Escolha a hora da festa."],
    [{ numKids: 0 }, "Indique o número de crianças convidadas."],
  ])("refuses %j", (patch, error) => {
    expect(checkPartyRequest({ ...valid, ...patch }, config, now)).toEqual({ ok: false, error });
  });

  it("today counts in Lisbon: a party today is fine late in the evening UTC", () => {
    const lateEvening = new Date("2026-10-21T23:30:00Z"); // 00:30 on the 22nd in Lisbon (WEST, UTC+1)
    expect(lisbonToday(lateEvening)).toBe("2026-10-22");
    expect(checkPartyRequest({ ...valid, date: "2026-10-21" }, config, lateEvening)).toMatchObject({ ok: false });
    expect(checkPartyRequest({ ...valid, date: "2026-10-22" }, config, lateEvening)).toMatchObject({ ok: true });
  });
});

describe("booking link", () => {
  it("tokenMatches: only the exact token", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(tokenMatches("abc", undefined)).toBe(false);
  });

  it("partyLinkUrl", () => {
    expect(partyLinkUrl("https://kidclub.pt", "bk1", "a-b_c")).toBe("https://kidclub.pt/festas/reserva/bk1?t=a-b_c");
  });

  it("recentAttempts keeps the last window only", () => {
    expect(recentAttempts([1000, 5000, 9000, "x", 20000], 10000, 6000)).toEqual([5000, 9000]);
    expect(recentAttempts(undefined, 10000, 6000)).toEqual([]);
  });
});

describe("publicBookingView", () => {
  const b = { status: "rejected", statusReason: "Dia ocupado", email: "x@y.pt", userId: "u", familyId: "f",
    childName: "Rita", partyType: "Festa B", date: "2026-11-21", time: "15:00", numKids: 17,
    extras: ["Cachorro"], extrasDetail: { Cachorro: 10 }, total: 327, phone: "912345678", notes: "internal" };

  it("shows only what the parent needs", () => {
    const v = publicBookingView(b, null);
    expect(v).toMatchObject({ status: "rejected", statusReason: "Dia ocupado", total: 402.21, depositAmount: 201.11, depositStatus: "none",
      extras: [{ name: "Cachorro", qty: 10 }] });
    const json = JSON.stringify(v);
    for (const hidden of ["x@y.pt", "\"u\"", "internal", "familyId", "userId"]) expect(json).not.toContain(hidden);
  });

  it("uses the bill's amount and maps paid/invoiced to paid", () => {
    expect(publicBookingView({ ...b, status: "confirmed" }, { total: 150, status: "invoiced" })).toMatchObject({ depositAmount: 150, depositStatus: "paid", statusReason: "" });
    expect(publicBookingView({ ...b, status: "confirmed" }, { total: 150, status: "processing" }).depositStatus).toBe("processing");
  });
});
