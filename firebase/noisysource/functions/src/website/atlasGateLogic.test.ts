import { describe, it, expect } from "vitest";
import {
  normalize, saysPhrase, validateRequest, checkWorld, checkSession, newSession, systemPrompt,
  geminiRequest, parseGemini, left, LOCKED_TURNS, UNLOCKED_TURNS, OPENING, GLOBAL_LIMIT, QUIET_HOURS,
} from "./atlasGateLogic";

describe("the phrase", () => {
  it("matches whatever the case, punctuation or accents", () => {
    expect(normalize("Abre-te, SÉSAMO!")).toBe("abre te sesamo");
    expect(saysPhrase("ok... abre te sésamo", "Abre-te Sésamo")).toBe(true);
    expect(saysPhrase("ABRE-TE SESAMO", "abre-te sésamo")).toBe(true);
  });
  it("needs the whole phrase, as words", () => {
    expect(saysPhrase("abre te", "abre te sesamo")).toBe(false);
    expect(saysPhrase("xabre te sesamox", "abre te sesamo")).toBe(false);
  });
  it("never matches a missing or trivial phrase", () => {
    expect(saysPhrase("anything", undefined)).toBe(false);
    expect(saysPhrase("", "")).toBe(false);
    expect(saysPhrase("a b", "a")).toBe(false);
  });
});

describe("requests", () => {
  it("accepts a well-formed one and trims the message", () => {
    const r = validateRequest({ session: "abcd-1234-efgh", message: "  hi  ", how: "star", ref: "https://linkedin.com" });
    expect(r).toEqual({ session: "abcd-1234-efgh", message: "hi", how: "star", ref: "https://linkedin.com" });
  });
  it("rejects missing or odd sessions and empty messages", () => {
    expect(validateRequest({ session: "x", message: "hi" })).toBeNull();
    expect(validateRequest({ session: "../../etc/passwd", message: "hi" })).toBeNull();
    expect(validateRequest({ session: "abcd-1234-efgh", message: "   " })).toBeNull();
    expect(validateRequest(null)).toBeNull();
  });
  it("caps the message length and defaults how", () => {
    const r = validateRequest({ session: "abcd-1234-efgh", message: "x".repeat(2000), how: "hack" });
    expect(r?.message.length).toBe(500);
    expect(r?.how).toBe("unknown");
  });
});

describe("limits", () => {
  const H = 3_600_000;
  it("is seven times seven, then seven hours", () => {
    expect(GLOBAL_LIMIT).toBe(49);
    expect(QUIET_HOURS).toBe(7);
  });
  it("counts every message across the whole web", () => {
    expect(checkWorld({ count: 0, quietUntil: 0 }, 1000, {})).toEqual({ quiet: false, next: { count: 1, quietUntil: 0 } });
    expect(checkWorld({ count: 48, quietUntil: 0 }, 1000, {}).quiet).toBe(false);
  });
  it("goes quiet for seven hours at the limit, then wakes with a fresh count", () => {
    const hit = checkWorld({ count: 49, quietUntil: 0 }, 1000, {});
    expect(hit).toEqual({ quiet: true, next: { count: 0, quietUntil: 1000 + 7 * H } });
    expect(checkWorld(hit.next, 1000 + 7 * H - 1, {}).quiet).toBe(true);
    expect(checkWorld(hit.next, 1000 + 7 * H, {})).toEqual({ quiet: false, next: { count: 1, quietUntil: 1000 + 7 * H } });
  });
  it("takes the limit and hours from the config", () => {
    expect(checkWorld({ count: 3, quietUntil: 0 }, 0, { globalLimit: 3, quietHours: 1 }).next.quietUntil).toBe(H);
  });
  it("stops a visitor after their replies, with more once the door is open", () => {
    expect(checkSession(newSession())).toBe("ok");
    expect(checkSession({ ...newSession(), turns: LOCKED_TURNS })).toBe("session");
    const s = { ...newSession(), unlocked: true, turns: LOCKED_TURNS, unlockedTurns: 2 };
    expect(checkSession(s)).toBe("ok");
    expect(left(s)).toBe(UNLOCKED_TURNS - 2);
    expect(checkSession({ ...s, unlockedTurns: UNLOCKED_TURNS })).toBe("session");
  });
});

describe("prompts", () => {
  it("never contains the phrase or the profile while locked", () => {
    const p = systemPrompt(newSession(), { passphrase: "abre te sesamo", profile: "secret profile" });
    expect(p).not.toContain("sesamo");
    expect(p).not.toContain("secret profile");
    expect(p).toContain(`reply 1 of ${LOCKED_TURNS}`);
  });
  it("tells the last locked reply to point at the real Renato", () => {
    expect(systemPrompt({ ...newSession(), turns: LOCKED_TURNS - 1 }, {})).toContain("renato holds the words that open the door");
  });
  it("shares the profile only once unlocked, and never the phrase", () => {
    const p = systemPrompt({ ...newSession(), unlocked: true }, { passphrase: "abre te sesamo", profile: "Renato builds things." });
    expect(p).toContain("Renato builds things.");
    expect(p).not.toContain("sesamo");
  });
});

describe("gemini", () => {
  it("starts the conversation with the user and keeps Atlas's opening", () => {
    const body = geminiRequest(newSession(), {}, "I'm a recruiter");
    expect(body.contents[0].role).toBe("user");
    const all = body.contents.map((c) => c.parts[0].text).join("\n");
    for (const line of OPENING) expect(all).toContain(line);
    expect(body.contents[body.contents.length - 1]).toEqual({ role: "user", parts: [{ text: "I'm a recruiter" }] });
    // roles alternate
    body.contents.forEach((c, i) => i && expect(c.role).not.toBe(body.contents[i - 1].role));
  });
  it("parses a good answer and rejects a broken one", () => {
    const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: "who sent you?", who: "recruiter", why: "hiring" }) }] } }] };
    expect(parseGemini(ok)).toEqual({ reply: "who sent you?", who: "recruiter", why: "hiring" });
    const oddWho = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: "hm", who: "alien", why: "" }) }] } }] };
    expect(parseGemini(oddWho)?.who).toBe("unknown");
    expect(parseGemini({ candidates: [] })).toBeNull();
    expect(parseGemini({ candidates: [{ content: { parts: [{ text: "not json" }] } }] })).toBeNull();
  });
});
