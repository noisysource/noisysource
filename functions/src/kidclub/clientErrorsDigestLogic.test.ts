import { describe, it, expect } from "vitest";
import { buildDigest, parentFacing, DIGEST_MAX_ROWS, ClientErrorReport } from "./clientErrorsDigestLogic";

const report = (overrides: Partial<ClientErrorReport> = {}): ClientErrorReport => ({
  userId: "u1",
  email: "parent@example.com",
  impersonatingFamilyId: null,
  action: "[enroll/transport] submit failed",
  code: "permission-denied",
  message: "Missing or insufficient permissions.",
  route: "/client/enroll/transport?childId=c1",
  createdAt: new Date("2026-10-16T21:52:00Z"),
  ...overrides,
});

describe("parentFacing", () => {
  it("keeps client-portal failures", () => {
    expect(parentFacing([report()])).toHaveLength(1);
  });
  it("drops the admin area and impersonation sessions", () => {
    expect(parentFacing([
      report({ route: "/admin/billing" }),
      report({ impersonatingFamilyId: "fam1" }),
    ])).toHaveLength(0);
  });
});

describe("buildDigest", () => {
  it("sends nothing on a quiet day", () => {
    expect(buildDigest([], "https://x")).toBeNull();
  });

  it("counts failures and distinct people in the subject", () => {
    const d = buildDigest([report(), report(), report({ userId: "u2" })], "https://x")!;
    expect(d.subject).toBe("[KidClub] 3 falhas de clientes nas últimas 24h (2 pessoas)");
    const one = buildDigest([report()], "https://x")!;
    expect(one.subject).toBe("[KidClub] 1 falha de clientes nas últimas 24h (1 pessoa)");
  });

  it("escapes report content — it's user-controlled", () => {
    const d = buildDigest([report({ message: '<img src=x onerror="alert(1)">' })], "https://x")!;
    expect(d.html).not.toContain("<img");
    expect(d.html).toContain("&lt;img");
  });

  it("caps the table and says how many were left out", () => {
    const many = Array.from({ length: DIGEST_MAX_ROWS + 5 }, (_, i) => report({ userId: `u${i}` }));
    const d = buildDigest(many, "https://x")!;
    expect(d.html.match(/<tr>\n<td/g)).toHaveLength(DIGEST_MAX_ROWS);
    expect(d.html).toContain("… e mais 5.");
  });
});
