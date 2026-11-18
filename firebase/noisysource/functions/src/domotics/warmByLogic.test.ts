import { describe, it, expect } from "vitest";
import { nextLocalTime, offsetMinutes, parseWarmByInput, describeLocal } from "./warmByLogic";

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

describe("nextLocalTime (Europe/Lisbon)", () => {
  it("winter: Lisbon is UTC", () => {
    // 25/10 16:00, after the clocks went back that morning.
    expect(iso(nextLocalTime("07:00", Date.parse("2026-10-25T16:00:00Z")))).toBe("2026-10-26T07:00:00.000Z");
    expect(iso(nextLocalTime("18:30", Date.parse("2026-10-25T16:00:00Z")))).toBe("2026-10-25T18:30:00.000Z");
  });
  it("summer: Lisbon is UTC+1", () => {
    expect(iso(nextLocalTime("12:00", Date.parse("2026-07-01T10:00:00Z")))).toBe("2026-07-01T11:00:00.000Z");
  });
  it("across the October clock change: asked on summer time, due on winter time", () => {
    // 24/10 21:00 local (20:00Z); 07:00 on the 25th is already winter time.
    expect(iso(nextLocalTime("07:00", Date.parse("2026-10-24T20:00:00Z")))).toBe("2026-10-25T07:00:00.000Z");
    expect(offsetMinutes(Date.parse("2026-10-24T20:00:00Z"))).toBe(60);
    expect(offsetMinutes(Date.parse("2026-10-25T07:00:00Z"))).toBe(0);
  });
  it("too soon today → tomorrow", () => {
    // 11:00 local; 11:05 is under 10 minutes away.
    expect(iso(nextLocalTime("11:05", Date.parse("2026-07-01T10:00:00Z")))).toBe("2026-07-02T10:05:00.000Z");
  });
  it("rejects anything that isn't HH:MM", () => {
    expect(nextLocalTime("25:00", Date.now())).toBeNull();
    expect(nextLocalTime("7:00", Date.now())).toBeNull();
  });
});

describe("parseWarmByInput", () => {
  const now = Date.parse("2026-10-25T16:00:00Z");
  it("time + target, rounded to half a degree", () => {
    expect(parseWarmByInput({ time: "07:00", target: 24.3 }, now)).toEqual({
      clear: false, at: Date.parse("2026-10-26T07:00:00Z"), target: 24.5, source: "app",
    });
  });
  it("no target = comfort; the chat says so", () => {
    expect(parseWarmByInput({ time: "07:00", source: "chat" }, now)).toMatchObject({ target: null, source: "chat" });
  });
  it("an exact instant, within 10 min – 24 h", () => {
    expect(parseWarmByInput({ at: "2026-10-25T20:00:00Z" }, now)).toMatchObject({ at: Date.parse("2026-10-25T20:00:00Z") });
    expect(parseWarmByInput({ at: "2026-10-25T16:05:00Z" }, now)).toEqual({ error: "at least 10 minutes from now" });
    expect(parseWarmByInput({ at: "2026-10-27T16:00:00Z" }, now)).toEqual({ error: "no more than 24 hours from now" });
  });
  it("refuses bad input rather than guessing", () => {
    expect(parseWarmByInput({}, now)).toHaveProperty("error");
    expect(parseWarmByInput({ time: "07:00", target: 30 }, now)).toHaveProperty("error");
    expect(parseWarmByInput({ time: "07:00", target: "24" }, now)).toHaveProperty("error");
    expect(parseWarmByInput({ at: "tomorrow" }, now)).toHaveProperty("error");
  });
  it("clear", () => {
    expect(parseWarmByInput({ clear: true }, now)).toEqual({ clear: true });
  });
  it("describes the time for the reply", () => {
    expect(describeLocal(Date.parse("2026-10-26T07:00:00Z"), now)).toEqual({ local: "07:00", day: "amanhã" });
    expect(describeLocal(Date.parse("2026-10-25T18:30:00Z"), now)).toEqual({ local: "18:30", day: "hoje" });
  });
});
