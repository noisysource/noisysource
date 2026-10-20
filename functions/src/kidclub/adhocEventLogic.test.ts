import { describe, it, expect } from "vitest";
import {
  parseRegistrationInput, signupRefusal, takeSeats, releaseSeats, mergeDayEdits, periodCandidates, pickBillingPeriod,
  registrationLines, eventTotal, dayPrice, eventLineId, isEventLineOf, tokenMatches, newAccessToken, normalizePhone,
  isValidNif, lisbonDate, buildConfirmationEmail, dayLine, periodLabelPt, EventDay, EventDoc, ADHOC_MAX_CHILDREN,
} from "./adhocEventLogic";

const day = (date: string, o: Partial<EventDay> = {}): EventDay => ({ date, capacity: 10, price: 25, taken: 0, ...o });

const guestRaw = (o: Record<string, any> = {}) => ({
  eventId: "ev1",
  days: ["2026-10-31"],
  guardian: { name: "Ana Silva", email: "Ana@Example.com ", phone: "912 345 678" },
  children: [{ name: "Rita", birthDate: "2018-05-02", healthNotes: "Alergia a frutos secos" }],
  photoConsent: true,
  acceptTerms: true,
  payment: "monthly", // ignored for guests
  ...o,
});

describe("parseRegistrationInput", () => {
  it("guest: normalizes email/phone, always pays now, keeps the child's details", () => {
    const r = parseRegistrationInput(guestRaw(), false);
    if ("error" in r) throw new Error(r.error);
    expect(r.input.guardian).toEqual({ name: "Ana Silva", email: "ana@example.com", phone: "912345678", nif: undefined });
    expect(r.input.payment).toBe("now");
    expect(r.input.guestChildren).toEqual([{ name: "Rita", birthDate: "2018-05-02", healthNotes: "Alergia a frutos secos" }]);
    expect(r.input.photoConsent).toBe(true);
  });

  it("member: children by id, may choose the monthly bill, no guardian name/email needed", () => {
    const r = parseRegistrationInput({ ...guestRaw(), guardian: { phone: "+351 912345678" }, children: [{ childId: "c1" }, { childId: "c2", healthNotes: "asma" }] }, true);
    if ("error" in r) throw new Error(r.error);
    expect(r.input.payment).toBe("monthly");
    expect(r.input.memberChildren).toEqual([{ childId: "c1" }, { childId: "c2", healthNotes: "asma" }]);
    expect(r.input.guardian.phone).toBe("912345678");
  });

  it("refuses what it must", () => {
    const err = (raw: any, member = false) => ("error" in parseRegistrationInput(raw, member) ? (parseRegistrationInput(raw, member) as any).error : null);
    expect(err(guestRaw({ acceptTerms: false }))).toMatch(/termos/);
    expect(err(guestRaw({ days: [] }))).toMatch(/dia/);
    expect(err(guestRaw({ days: ["31/10/2026"] }))).toMatch(/dia/);
    expect(err(guestRaw({ guardian: { name: "Ana", email: "ana@x.pt", phone: "123" } }))).toMatch(/telemóvel/);
    expect(err(guestRaw({ guardian: { name: "Ana", email: "not-an-email", phone: "912345678" } }))).toMatch(/email/);
    expect(err(guestRaw({ guardian: { name: "Ana", email: "ana@x.pt", phone: "912345678", nif: "123456780" } }))).toMatch(/NIF/);
    expect(err(guestRaw({ children: [] }))).toMatch(/criança/);
    expect(err(guestRaw({ children: Array.from({ length: ADHOC_MAX_CHILDREN + 1 }, () => ({ name: "Rita" })) }))).toMatch(/máximo/);
    expect(err(guestRaw({ children: [{ name: "R" }] }))).toMatch(/nome/);
    expect(err({ ...guestRaw(), children: [{ childId: "c1" }, { childId: "c1" }] }, true)).toMatch(/duas vezes/);
  });

  it("accepts a valid NIF, and treats the Consumidor final NIF as none", () => {
    const ok = parseRegistrationInput(guestRaw({ guardian: { name: "Ana", email: "ana@x.pt", phone: "912345678", nif: "123 456 789" } }), false);
    expect("input" in ok && ok.input.guardian.nif).toBe("123456789");
    const cf = parseRegistrationInput(guestRaw({ guardian: { name: "Ana", email: "ana@x.pt", phone: "912345678", nif: "999999990" } }), false);
    expect("input" in cf && cf.input.guardian.nif).toBeUndefined();
  });

  it("dedupes and sorts days", () => {
    const r = parseRegistrationInput(guestRaw({ days: ["2026-11-02", "2026-10-31", "2026-11-02"] }), false);
    expect("input" in r && r.input.days).toEqual(["2026-10-31", "2026-11-02"]);
  });
});

describe("normalizePhone / isValidNif", () => {
  it("phones", () => {
    expect(normalizePhone("912345678")).toBe("912345678");
    expect(normalizePhone("+351 912 345 678")).toBe("912345678");
    expect(normalizePhone("00351912345678")).toBe("912345678");
    expect(normalizePhone("239123456")).toBe("239123456");
    expect(normalizePhone("812345678")).toBe("");
    expect(normalizePhone("91234567")).toBe("");
  });
  it("NIF checksum (same as the app's lib/nif.ts)", () => {
    expect(isValidNif("123456789")).toBe(true);
    expect(isValidNif("123456780")).toBe(false);
    expect(isValidNif("12345678")).toBe(false);
  });
});

describe("prices", () => {
  const days = [day("2026-10-31", { price: 25, memberPrice: 20 }), day("2026-11-02", { price: 30 })];
  it("member price where set, public price otherwise", () => {
    expect(dayPrice(days[0], "member")).toBe(20);
    expect(dayPrice(days[1], "member")).toBe(30);
    expect(dayPrice(days[0], "public")).toBe(25);
    expect(dayPrice(day("x", { price: 25, memberPrice: 0 }), "member")).toBe(0); // free for members
  });
  it("total = children × chosen days, to the cent", () => {
    expect(eventTotal(days, ["2026-10-31", "2026-11-02"], 2, "member")).toBe(100);
    expect(eventTotal(days, ["2026-10-31"], 3, "public")).toBe(75);
    expect(eventTotal([day("d", { price: 12.35 })], ["d"], 3, "public")).toBe(37.05);
  });
  it("lines: one per child, frozen title and per-child amount", () => {
    expect(registrationLines("Halloween", days, ["2026-10-31", "2026-11-02"], [{ name: "Rita" }, { name: "Tomás" }], "member")).toEqual([
      { title: "Halloween — Rita (31/10, 02/11)", amount: 50 },
      { title: "Halloween — Tomás (31/10, 02/11)", amount: 50 },
    ]);
  });
  it("line ids match only their own registration", () => {
    expect(isEventLineOf(eventLineId("abc", 0), "abc")).toBe(true);
    expect(isEventLineOf(eventLineId("abcd", 0), "abc")).toBe(false);
    expect(isEventLineOf("subscription123", "abc")).toBe(false);
  });
});

describe("seats", () => {
  const days = [day("2026-10-31", { capacity: 3, taken: 2 }), day("2026-11-02", { capacity: 3, taken: 0 })];
  it("takes seats on the chosen days only", () => {
    const r = takeSeats(days, ["2026-11-02"], 3);
    expect("days" in r && r.days.map(d => d.taken)).toEqual([2, 3]);
  });
  it("refuses with the full days, taking nothing", () => {
    expect(takeSeats(days, ["2026-10-31", "2026-11-02"], 2)).toEqual({ full: ["2026-10-31"] });
  });
  it("releases, never below 0", () => {
    expect(releaseSeats(days, ["2026-10-31", "2026-11-02"], 3).map(d => d.taken)).toEqual([0, 0]);
  });
});

describe("signupRefusal", () => {
  const ev: EventDoc = { name: "Greve", published: true, registrationOpen: true, closesOn: "2026-10-30", days: [day("2026-10-31"), day("2026-11-02")] };
  it("open", () => expect(signupRefusal(ev, ["2026-10-31"], "2026-10-20", false)).toBeNull());
  it("unpublished, closed, past the deadline, unknown or past day", () => {
    expect(signupRefusal(undefined, ["2026-10-31"], "2026-10-20", false)).toMatch(/não encontrado/);
    expect(signupRefusal({ ...ev, published: false }, ["2026-10-31"], "2026-10-20", false)).toMatch(/não encontrado/);
    expect(signupRefusal({ ...ev, registrationOpen: false }, ["2026-10-31"], "2026-10-20", false)).toMatch(/fechadas/);
    expect(signupRefusal(ev, ["2026-10-31"], "2026-10-31", false)).toMatch(/já fecharam/);
    expect(signupRefusal(ev, ["2026-11-05"], "2026-10-20", false)).toMatch(/não faz parte/);
    expect(signupRefusal({ ...ev, closesOn: undefined }, ["2026-10-31"], "2026-11-01", false)).toMatch(/já passou/);
  });
  it("an admin walk-in ignores published/open/deadline, never a past day", () => {
    const closed = { ...ev, published: false, registrationOpen: false };
    expect(signupRefusal(closed, ["2026-10-31"], "2026-10-31", true)).toBeNull();
    expect(signupRefusal(closed, ["2026-10-31"], "2026-11-01", true)).toMatch(/já passou/);
  });
});

describe("mergeDayEdits", () => {
  const current = [day("2026-10-31", { taken: 4 }), day("2026-11-02", { taken: 0 })];
  it("keeps the server's seat counts, sorts, parses numbers", () => {
    const r = mergeDayEdits(current, [
      { date: "2026-11-03", capacity: "12", price: "20", memberPrice: "", startTime: "09:00", endTime: "17:30" },
      { date: "2026-10-31", capacity: 15, price: 25.5, memberPrice: 20, taken: 999 },
    ]);
    expect(r).toEqual({ days: [
      { date: "2026-10-31", capacity: 15, price: 25.5, memberPrice: 20, taken: 4 },
      { date: "2026-11-03", capacity: 12, price: 20, startTime: "09:00", endTime: "17:30", taken: 0 },
    ] });
  });
  it("won't drop a day with seats taken, or accept nonsense", () => {
    expect(mergeDayEdits(current, [{ date: "2026-11-02", capacity: 10, price: 25 }])).toEqual({ error: expect.stringMatching(/31\/10.*inscrições/) });
    expect(mergeDayEdits([], [])).toEqual({ error: expect.stringMatching(/pelo menos um dia/) });
    expect(mergeDayEdits([], [{ date: "2026-11-02", capacity: -1, price: 25 }])).toEqual({ error: expect.stringMatching(/Capacidade/) });
    expect(mergeDayEdits([], [{ date: "2026-11-02", capacity: 5, price: "abc" }])).toEqual({ error: expect.stringMatching(/Preço/) });
    expect(mergeDayEdits([], [{ date: "2026-11-02", capacity: 5, price: 1 }, { date: "2026-11-02", capacity: 5, price: 1 }])).toEqual({ error: expect.stringMatching(/duas vezes/) });
  });
});

describe("which monthly bill", () => {
  it("candidates: the event's month, then the next 11 (across the year end)", () => {
    const c = periodCandidates("2026-12-15");
    expect(c[0]).toBe("2026-12");
    expect(c[1]).toBe("2027-01");
    expect(c).toHaveLength(12);
  });
  it("the event's month when its bill can change (or doesn't exist yet), else the next that can", () => {
    const c = ["2026-10", "2026-11", "2026-12"];
    expect(pickBillingPeriod(c, new Map())).toBe("2026-10");
    expect(pickBillingPeriod(c, new Map([["2026-10", { status: "pending" }]]))).toBe("2026-10");
    expect(pickBillingPeriod(c, new Map([["2026-10", { status: "cancelled", autoCancelled: true }]]))).toBe("2026-10");
    for (const status of ["paid", "invoiced", "processing", "failed"]) {
      expect(pickBillingPeriod(c, new Map([["2026-10", { status }]]))).toBe("2026-11");
    }
    expect(pickBillingPeriod(c, new Map([["2026-10", { status: "cancelled" }]]))).toBe("2026-11"); // cancelled by an admin
    expect(pickBillingPeriod(c, new Map(c.map(p => [p, { status: "paid" }])))).toBeNull();
  });
  it("labels the month like the monthly bill does", () => {
    expect(periodLabelPt("2026-11")).toBe("Novembro 2026");
    expect(periodLabelPt("2027-03")).toBe("Março 2027");
  });
});

describe("tokens, dates, email", () => {
  it("tokens: random, compared exactly", () => {
    const t = newAccessToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newAccessToken()).not.toBe(t);
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(t, t.slice(0, -1) + (t.endsWith("a") ? "b" : "a"))).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
    expect(tokenMatches(undefined, undefined)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
  it("Lisbon dates around midnight UTC", () => {
    expect(lisbonDate(new Date("2026-07-31T23:30:00Z"))).toBe("2026-08-01"); // WEST, UTC+1
    expect(lisbonDate(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31"); // WET, UTC+0
  });
  it("day line", () => {
    expect(dayLine({ date: "2026-10-30", startTime: "09:00", endTime: "17:30" })).toBe("sexta-feira, 30/10 · 09:00–17:30");
    expect(dayLine({ date: "2026-10-31" })).toBe("sábado, 31/10");
  });
  it("confirmation email escapes what parents typed", () => {
    const html = buildConfirmationEmail({
      companyName: "Arco-Íris da Pequenada", guardianName: "<b>Ana</b>", eventName: "Halloween", days: [{ date: "2026-10-31" }],
      childNames: ["<script>x</script>"], total: 25, paidNote: "Pagamento recebido.", link: "https://kidclub.pt/eventos/inscricao/r1?t=abc",
    });
    expect(html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("€25.00");
    expect(html).toContain("https://kidclub.pt/eventos/inscricao/r1?t=abc");
  });
});
