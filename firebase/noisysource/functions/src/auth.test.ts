import { describe, it, expect } from "vitest";
import { AGENT_EMAIL, CODE_AGENT_EMAIL, requireKanbanCaller, requireOwner, requireOwnerOrAgent } from "./auth";

const as = (email: string, verified?: boolean) => ({ token: { email, email_verified: verified } });
const code = (fn: () => unknown) => {
  try { fn(); return "ok"; } catch (e) { return (e as { code?: string }).code; }
};

describe("requireOwnerOrAgent", () => {
  it("accepts the owner", () => {
    expect(requireOwnerOrAgent(as("admin@noisysource.com", true))).toBe("owner");
  });
  it("accepts Atlas", () => {
    expect(AGENT_EMAIL).toBe("atlas@kidclub.pt");
    expect(requireOwnerOrAgent(as(AGENT_EMAIL, true))).toBe("agent");
  });
  it("refuses either address when it isn't verified", () => {
    expect(code(() => requireOwnerOrAgent(as(AGENT_EMAIL, false)))).toBe("permission-denied");
    expect(code(() => requireOwnerOrAgent(as(AGENT_EMAIL)))).toBe("permission-denied");
    expect(code(() => requireOwnerOrAgent(as("admin@noisysource.com", false)))).toBe("permission-denied");
  });
  it("refuses someone else, verified or not", () => {
    expect(code(() => requireOwnerOrAgent(as("someone@example.com", true)))).toBe("permission-denied");
    expect(code(() => requireOwnerOrAgent(as("domotics-bridge@kidclub.pt", true)))).toBe("permission-denied");
    expect(code(() => requireOwnerOrAgent({}))).toBe("permission-denied");
  });
  it("refuses a call without sign-in", () => {
    expect(code(() => requireOwnerOrAgent(undefined))).toBe("unauthenticated");
  });
});

describe("requireOwner", () => {
  it("still refuses Atlas", () => {
    expect(code(() => requireOwner(as(AGENT_EMAIL, true)))).toBe("permission-denied");
    expect(code(() => requireOwner(as("admin@noisysource.com", true)))).toBe("ok");
  });
});

describe("requireKanbanCaller", () => {
  it("names Renato, Atlas and Claude Code", () => {
    expect(requireKanbanCaller(as("admin@noisysource.com", true))).toBe("renato");
    expect(requireKanbanCaller(as(AGENT_EMAIL, true))).toBe("atlas");
    expect(CODE_AGENT_EMAIL).toBe("claude-code@kidclub.pt");
    expect(requireKanbanCaller(as(CODE_AGENT_EMAIL, true))).toBe("claude-code");
  });
  it("refuses unverified addresses, strangers and no sign-in", () => {
    expect(code(() => requireKanbanCaller(as(CODE_AGENT_EMAIL, false)))).toBe("permission-denied");
    expect(code(() => requireKanbanCaller(as("domotics-bridge@kidclub.pt", true)))).toBe("permission-denied");
    expect(code(() => requireKanbanCaller(undefined))).toBe("unauthenticated");
  });
  it("keeps Claude Code out of the house callables", () => {
    expect(code(() => requireOwnerOrAgent(as(CODE_AGENT_EMAIL, true)))).toBe("permission-denied");
  });
});
