import { describe, it, expect } from "vitest";
import { AGENT_EMAIL, requireOwner, requireOwnerOrAgent } from "./auth";

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
