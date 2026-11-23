import { describe, it, expect } from "vitest";
import {
  normalize, saysPhrase, validateRequest, checkWorld, checkSession, newSession, systemPrompt,
  geminiRequest, parseGemini, left, LOCKED_TURNS, UNLOCKED_TURNS, OPENING, GLOBAL_LIMIT, QUIET_HOURS,
  cleanAccess, matchKey, roleOf, topicsFor, emptyAccess,
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
    expect(systemPrompt({ ...newSession(), turns: LOCKED_TURNS - 1 }, {})).toContain("your maker holds the words that open the door");
  });
  it("never gives the model the maker's name, in any state", () => {
    const states = [newSession(), { ...newSession(), turns: LOCKED_TURNS - 1 }, { ...newSession(), turns: LOCKED_TURNS - 2 }, { ...newSession(), unlocked: true }];
    for (const s of states) expect(systemPrompt(s, {})).not.toMatch(/renato|lopes/i);
    expect(systemPrompt(newSession(), {})).toContain("Never say, spell, hint at or confirm any name");
  });
  it("shares only the topics switched on for the role, and never the phrase", () => {
    const access = cleanAccess({
      topics: { profile: "PROFILE TEXT", infrastructure: "INFRA TEXT", business: "BUSINESS TEXT", apps: "APPS TEXT" },
      roles: { investor: ["business", "product"], recruiter: ["profile"] },
    })!;
    const investor = systemPrompt({ ...newSession(), unlocked: true, role: "investor" }, { passphrase: "abre te sesamo" }, access);
    expect(investor).toContain("BUSINESS TEXT");
    expect(investor).not.toMatch(/PROFILE TEXT|INFRA TEXT|APPS TEXT|sesamo/);
    expect(investor).toContain("still never your maker's name");
    const recruiter = systemPrompt({ ...newSession(), unlocked: true, role: "recruiter" }, {}, access);
    expect(recruiter).toContain("PROFILE TEXT");
    expect(recruiter).not.toMatch(/BUSINESS TEXT|INFRA TEXT|APPS TEXT/);
    const manager = systemPrompt({ ...newSession(), unlocked: true, role: "manager" }, {}, access);
    expect(manager).toContain("not allowed to share anything");
  });
  it("never shares a topic while locked, whatever the switches", () => {
    const access = cleanAccess({ topics: { profile: "PROFILE TEXT" }, roles: { curious: ["profile"] } })!;
    expect(systemPrompt({ ...newSession(), who: "curious" }, {}, access)).not.toContain("PROFILE TEXT");
  });
});

describe("access", () => {
  it("cleans what it's given: known topics and roles only, valid keys only", () => {
    const a = cleanAccess({
      topics: { profile: "p", secrets: "nope" },
      roles: { investor: ["business", "business", "secrets"], hacker: ["profile"] },
      keys: [{ phrase: "blue door", role: "investor", label: "VC" }, { phrase: "x", role: "investor" }, { phrase: "ok then", role: "god" }],
    })!;
    expect(a.topics).toEqual({ profile: "p" });
    expect(a.roles).toEqual({ investor: ["business"] });
    expect(a.keys).toEqual([{ phrase: "blue door", role: "investor", label: "VC", enabled: true }]);
    expect(cleanAccess("nope")).toBeNull();
  });
  it("opens with a personal key as its role, with the shared phrase as Atlas's guess", () => {
    const a = cleanAccess({ keys: [{ phrase: "Blue Door", role: "investor", label: "VC" }, { phrase: "red door", role: "manager", enabled: false }] })!;
    expect(matchKey("the blue door?", { passphrase: "abre te sesamo" }, a)).toEqual({ role: "investor", label: "VC" });
    expect(matchKey("red door", {}, a)).toBeNull();
    expect(matchKey("abre te sesamo", { passphrase: "abre te sesamo" }, a)).toEqual({ role: "auto", label: "shared phrase" });
    expect(matchKey("hello", { passphrase: "abre te sesamo" }, a)).toBeNull();
  });
  it("works out the role: the key's, or Atlas's guess for the shared phrase", () => {
    expect(roleOf({ ...newSession(), role: "manager", who: "investor" })).toBe("manager");
    expect(roleOf({ ...newSession(), role: "auto", who: "investor" })).toBe("investor");
    expect(roleOf({ ...newSession(), role: "auto", who: "unknown" })).toBe("unknown");
    expect(topicsFor("unknown", cleanAccess({ topics: { profile: "p" }, roles: {} })!)).toEqual([]);
    expect(topicsFor("recruiter", cleanAccess({ topics: { profile: "p", apps: "" }, roles: { recruiter: ["apps", "profile"] } })!)).toEqual(["profile"]);
    expect(topicsFor("recruiter", emptyAccess())).toEqual([]);
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
