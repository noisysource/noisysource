import { describe, it, expect } from "vitest";
import {
  ChildRow, FormEventRow, FunnelReport, FormSummary, RequestRow,
  buildFunnelEmail, countChildrenAdded, countNewAccounts, countProfilesCompleted,
  countWithoutSubscription, familiesWithRecentChild, hasStaffRole, isParentRequest,
  leftState, summarizeForms, summarizeRequests, toDate,
} from "./enrollFunnelWeeklyLogic";

const NOW = new Date("2026-11-09T08:00:00Z");
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const NO_STAFF = new Set<string>();
const STAFF = new Set(["staff-uid"]);

const emptyForm: FormSummary = {
  opened: 0, submitted: 0, left: 0, noExitRecorded: 0, blocked: {}, leftStates: [], medianSecondsBeforeLeaving: null,
};
const zeroReport = (overrides: Partial<FunnelReport> = {}): FunnelReport => ({
  now: NOW,
  requests: {
    lastAt: daysBefore(3),
    limitHit: false,
    lastWeek: { study: { count: 0, capped: false }, transport: { count: 0, capped: false } },
  },
  newAccounts: { count: 0, capped: false },
  profilesCompleted: { count: 0, capped: false },
  childrenAdded: { count: 0, capped: false },
  forms: { byService: { study: emptyForm, transport: emptyForm }, capped: false },
  familiesWithoutSubscription: { count: 0, capped: false },
  adminUrl: "https://kidclub.pt/admin/subscriptions",
  ...overrides,
});

describe("toDate", () => {
  it("reads a Firestore Timestamp, a Date and an ISO string", () => {
    expect(toDate({ toDate: () => NOW })).toEqual(NOW);
    expect(toDate(NOW)).toEqual(NOW);
    expect(toDate(NOW.toISOString())).toEqual(NOW);
  });
  it("gives null for what old docs may hold instead", () => {
    expect(toDate(undefined)).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate("not a date")).toBeNull();
  });
});

describe("hasStaffRole", () => {
  it("is true for any role that's set", () => {
    expect(hasStaffRole({ rainbowAdmin: true })).toBe(true);
    expect(hasStaffRole({ driver: true, owner: false })).toBe(true);
  });
  it("is false for a parent's empty or all-false roles and for a missing field", () => {
    expect(hasStaffRole({})).toBe(false);
    expect(hasStaffRole({ rainbowAdmin: false, finhubAdmin: false })).toBe(false);
    expect(hasStaffRole(undefined)).toBe(false);
  });
});

describe("countNewAccounts", () => {
  it("counts last week's accounts, without staff or the admin email", () => {
    const counted = countNewAccounts([
      { uid: "a", email: "parent@example.com", createdAt: daysBefore(2) },
      { uid: "b", email: "old@example.com", createdAt: daysBefore(8) },
      { uid: "staff-uid", email: "teacher@example.com", createdAt: daysBefore(1) },
      { uid: "c", email: "ADMIN@kidclub.pt", createdAt: daysBefore(1) },
      { uid: "d", createdAt: null },
    ], STAFF, "admin@kidclub.pt", NOW);
    expect(counted).toEqual({ count: 1, capped: false });
  });
});

describe("countProfilesCompleted", () => {
  it("counts this week's families with a completed profile, without staff", () => {
    expect(countProfilesCompleted([
      { profileComplete: true, primaryContact: { userId: "a" }, createdAt: daysBefore(1) },
      { profileComplete: false, primaryContact: { userId: "b" }, createdAt: daysBefore(1) },
      { profileComplete: true, primaryContact: { userId: "staff-uid" }, createdAt: daysBefore(1) },
      { profileComplete: true, primaryContact: { userId: "c" }, createdAt: daysBefore(9) },
      { profileComplete: true, primaryContact: { userId: "d" } },
    ], STAFF, NOW).count).toBe(1);
  });
});

describe("children", () => {
  const children: ChildRow[] = [
    { familyId: "f1", userId: "a", createdAt: daysBefore(2) },
    { familyId: "f1", userId: "a", createdAt: daysBefore(3) },
    { familyId: "f2", userId: "b", createdAt: daysBefore(20) },
    { familyId: "f3", userId: "staff-uid", createdAt: daysBefore(2) },
    { familyId: "", contactEmail: "x" } as ChildRow, // admin-created, unclaimed, no date
    { familyId: "", createdAt: daysBefore(1) }, // admin-created, unclaimed
    { familyId: "f4", userId: "c", status: "merged", createdAt: daysBefore(1) },
    { familyId: "f5", userId: "d", createdAt: daysBefore(40) },
  ];

  it("counts only a parent's children from the last 7 days", () => {
    expect(countChildrenAdded(children, STAFF, NOW).count).toBe(2);
  });

  it("is capped only when the read limit cut into the 7-day window", () => {
    const recent = [{ userId: "a", createdAt: daysBefore(1) }];
    expect(countChildrenAdded(recent, NO_STAFF, NOW, true).capped).toBe(true);
    expect(countChildrenAdded(children, STAFF, NOW, true).capped).toBe(false);
  });

  it("lists each family with a parent's child in the last 30 days once", () => {
    expect(familiesWithRecentChild(children, STAFF, NOW).sort()).toEqual(["f1", "f2"]);
  });
});

describe("countWithoutSubscription", () => {
  it("counts families with no subscription or only cancelled ones", () => {
    expect(countWithoutSubscription(["none", "pending", "active", "cancelled", "flagged", "legacy"], [
      { familyId: "pending", status: "pending" },
      { familyId: "active", status: "active" },
      { familyId: "cancelled", status: "cancelled" },
      { familyId: "flagged", status: "pending", canceled: true },
      { familyId: "legacy", status: "archived" },
    ])).toBe(4);
  });
  it("a cancelled subscription doesn't hide another live one", () => {
    expect(countWithoutSubscription(["f"], [
      { familyId: "f", status: "cancelled" },
      { familyId: "f", status: "active" },
    ])).toBe(0);
  });
});

describe("parent requests", () => {
  it("counts a parent's own form, which writes no source", () => {
    expect(isParentRequest({ userId: "a" }, NO_STAFF)).toBe(true);
  });
  it("leaves out the admin's, claimed ones, staff's and docs with no owner", () => {
    expect(isParentRequest({ userId: "a", source: "manual" }, NO_STAFF)).toBe(false);
    expect(isParentRequest({ userId: "a", source: "admin_correction" }, NO_STAFF)).toBe(false);
    expect(isParentRequest({ userId: "a", source: "web" }, NO_STAFF)).toBe(false);
    expect(isParentRequest({ userId: "staff-uid" }, STAFF)).toBe(false);
    expect(isParentRequest({ source: "" }, NO_STAFF)).toBe(false);
  });

  const none = { rows: [] as RequestRow[], limitHit: false };

  it("takes the newest parent request across both services", () => {
    const summary = summarizeRequests({
      study: { rows: [
        { userId: "a", source: "manual", createdAt: daysBefore(1) },
        { userId: "a", createdAt: daysBefore(20) },
      ], limitHit: false },
      transport: { rows: [{ userId: "b", createdAt: daysBefore(10) }], limitHit: false },
    }, NO_STAFF, NOW);
    expect(summary.lastAt).toEqual(daysBefore(10));
  });

  it("counts last week per service", () => {
    const summary = summarizeRequests({
      study: { rows: [
        { userId: "a", createdAt: daysBefore(1) },
        { userId: "b", createdAt: daysBefore(6) },
        { userId: "c", createdAt: daysBefore(8) },
        { userId: "d", source: "manual", createdAt: daysBefore(1) },
      ], limitHit: false },
      transport: none,
    }, NO_STAFF, NOW);
    expect(summary.lastWeek.study).toEqual({ count: 2, capped: false });
    expect(summary.lastWeek.transport).toEqual({ count: 0, capped: false });
  });

  it("skips old docs with no createdAt instead of failing", () => {
    const summary = summarizeRequests({ study: { rows: [{ userId: "a" }], limitHit: false }, transport: none }, NO_STAFF, NOW);
    expect(summary.lastAt).toBeNull();
    expect(summary.lastWeek.study.count).toBe(0);
  });

  it("marks a week's count capped only if the read limit cut into that week", () => {
    const summary = summarizeRequests({
      study: { rows: [{ userId: "a", createdAt: daysBefore(1) }], limitHit: true },
      transport: { rows: [{ userId: "b", createdAt: daysBefore(9) }], limitHit: true },
    }, NO_STAFF, NOW);
    expect(summary.lastWeek.study.capped).toBe(true);
    expect(summary.lastWeek.transport.capped).toBe(false);
    expect(summary.limitHit).toBe(true);
  });
});

describe("leftState", () => {
  it("names the state this form's bug would have shown", () => {
    expect(leftState({ studyDays: 2, transportDays: 0, tripsMissingAddress: 0, submitEnabled: false }))
      .toBe("só Sala de Estudo, sem viagens");
  });
  it("names the other states", () => {
    expect(leftState({ studyDays: 0, transportDays: 0, tripsMissingAddress: 0, submitEnabled: false })).toBe("sem dias escolhidos");
    expect(leftState({ studyDays: 1, transportDays: 1, tripsMissingAddress: 2, submitEnabled: false })).toBe("viagens sem morada");
    expect(leftState({ studyDays: 1, transportDays: 1, tripsMissingAddress: 0, submitEnabled: true })).toBe("pronto a enviar, não enviou");
    expect(leftState({ studyDays: 1, transportDays: 1, tripsMissingAddress: 0, submitEnabled: false })).toBe("botão desativado, outro motivo");
  });
  it("copes with a missing data map", () => {
    expect(leftState()).toBe("sem dias escolhidos");
  });
});

describe("summarizeForms", () => {
  const ev = (event: string, service: string, overrides: Partial<FormEventRow> = {}): FormEventRow =>
    ({ userId: "a", impersonatingFamilyId: null, event, service, ...overrides });

  it("counts per service and works out forms with no recorded exit", () => {
    const { study, transport } = summarizeForms([
      ev("enroll_form_opened", "transport"), ev("enroll_form_opened", "transport"),
      ev("enroll_form_opened", "transport"), ev("enroll_form_opened", "study"),
      ev("enroll_submitted", "transport"),
      ev("enroll_left", "transport", { data: { studyDays: 1, transportDays: 0, seconds: 40 } }),
      ev("enroll_days_chosen", "transport"),
    ], NO_STAFF);
    expect(transport).toMatchObject({ opened: 3, submitted: 1, left: 1, noExitRecorded: 1 });
    expect(study).toMatchObject({ opened: 1, submitted: 0, left: 0, noExitRecorded: 1 });
  });

  it("never reports a negative when an event's opening fell outside the window", () => {
    expect(summarizeForms([ev("enroll_submitted", "study")], NO_STAFF).study.noExitRecorded).toBe(0);
  });

  it("orders the states when leaving, most common first, with the median time", () => {
    const { transport } = summarizeForms([
      ev("enroll_left", "transport", { data: { seconds: 10 } }),
      ev("enroll_left", "transport", { data: { studyDays: 1, seconds: 20 } }),
      ev("enroll_left", "transport", { data: { studyDays: 2, seconds: 300 } }),
    ], NO_STAFF);
    expect(transport.leftStates).toEqual([
      { label: "só Sala de Estudo, sem viagens", count: 2 },
      { label: "sem dias escolhidos", count: 1 },
    ]);
    expect(transport.medianSecondsBeforeLeaving).toBe(20);
  });

  it("leaves out staff and an admin acting for a family", () => {
    const { study } = summarizeForms([
      ev("enroll_form_opened", "study", { userId: "staff-uid" }),
      ev("enroll_form_opened", "study", { impersonatingFamilyId: "fam1" }),
    ], STAFF);
    expect(study.opened).toBe(0);
  });

  it("groups blocked attempts by their fixed reason, anything else as other", () => {
    const { transport } = summarizeForms([
      ev("enroll_blocked", "transport", { data: { reason: "duplicate_transport" } }),
      ev("enroll_blocked", "transport", { data: { reason: "duplicate_transport" } }),
      ev("enroll_blocked", "transport", { data: { reason: "<b>anything</b>" } }),
    ], NO_STAFF);
    expect(transport.blocked).toEqual({ duplicate_transport: 2, other: 1 });
  });
});

describe("buildFunnelEmail", () => {
  it("always returns an email, also when every number is 0", () => {
    const { subject, html } = buildFunnelEmail(zeroReport());
    expect(subject).toBe("[KidClub] Inscrições: último pedido há 3 dias");
    expect(html).toContain("Contas novas");
    expect(html).toContain("<b>0</b>");
    expect(html).toContain("https://kidclub.pt/admin/subscriptions");
    expect(html).toContain("Mostrar famílias sem inscrições");
  });

  it("puts the last request at the very top, with its date and age", () => {
    const { html } = buildFunnelEmail(zeroReport());
    expect(html.indexOf("Último pedido de inscrição criado por um encarregado")).toBeLessThan(html.indexOf("Contas novas"));
    expect(html).toContain("06/11/2026 (há 3 dias)");
  });

  it("uses the Lisbon date, not UTC, right after midnight", () => {
    const requests = { ...zeroReport().requests!, lastAt: new Date("2026-07-01T23:30:00Z") };
    expect(buildFunnelEmail(zeroReport({ requests })).html).toContain("02/07/2026");
  });

  it("says today and one day in plain words", () => {
    const at = (lastAt: Date) => zeroReport({ requests: { ...zeroReport().requests!, lastAt } });
    expect(buildFunnelEmail(at(new Date(NOW.getTime() - 3_600_000))).html).toContain("(hoje)");
    expect(buildFunnelEmail(at(daysBefore(1))).html).toContain("(há 1 dia)");
  });

  it("warns only when it's over 14 days", () => {
    const at = (days: number) => zeroReport({ requests: { ...zeroReport().requests!, lastAt: daysBefore(days) } });
    expect(buildFunnelEmail(at(14)).html).not.toContain("ATENÇÃO");
    const stale = buildFunnelEmail(at(15));
    expect(stale.html).toContain("ATENÇÃO: passaram mais de 14 dias");
    expect(stale.subject).toBe("[KidClub] ATENÇÃO: último pedido de inscrição há 15 dias");
  });

  it("warns when no parent request was found at all", () => {
    const { subject, html } = buildFunnelEmail(zeroReport({ requests: { ...zeroReport().requests!, lastAt: null } }));
    expect(subject).toBe("[KidClub] ATENÇÃO: nenhum pedido de inscrição encontrado");
    expect(html).toContain("nenhum encontrado");
  });

  it("doesn't claim there are none when it only read the newest docs", () => {
    const { html } = buildFunnelEmail(zeroReport({ requests: { ...zeroReport().requests!, lastAt: null, limitHit: true } }));
    expect(html).toContain("nenhum entre os pedidos mais recentes");
  });

  it("shows a failed read as unavailable, never as a 0, and still sends", () => {
    const { subject, html } = buildFunnelEmail(zeroReport({
      requests: null, newAccounts: null, profilesCompleted: null, childrenAdded: null, forms: null,
      familiesWithoutSubscription: null,
    }));
    expect(subject).toBe("[KidClub] ATENÇÃO: relatório semanal de inscrições incompleto");
    expect(html).toContain("indisponível (erro de leitura)");
    expect(html).not.toContain("<b>0</b>");
  });

  it("marks a capped number with a plus", () => {
    const { html } = buildFunnelEmail(zeroReport({ newAccounts: { count: 7, capped: true } }));
    expect(html).toContain("<b>7+</b>");
  });

  it("shows the form table per service with the state when leaving", () => {
    const byService = summarizeForms([
      { userId: "a", event: "enroll_form_opened", service: "transport" },
      { userId: "a", event: "enroll_left", service: "transport", data: { studyDays: 2, transportDays: 0, seconds: 45 } },
      { userId: "a", event: "enroll_blocked", service: "study", data: { reason: "duplicate_study" } },
    ], NO_STAFF);
    const { html } = buildFunnelEmail(zeroReport({ forms: { byService, capped: false } }));
    expect(html).toContain("1 só Sala de Estudo, sem viagens");
    expect(html).toContain("45 s");
    expect(html).toContain("1 (1 já inscrito na Sala de Estudo)");
  });

  it("prints no uid, family id or unknown reason from the events", () => {
    const byService = summarizeForms([
      { userId: "uid-secret", impersonatingFamilyId: null, event: "enroll_form_opened", service: "study" },
      { userId: "uid-secret", event: "enroll_blocked", service: "study", data: { reason: "free text from somewhere" } },
    ], NO_STAFF);
    const { subject, html } = buildFunnelEmail(zeroReport({ forms: { byService, capped: false } }));
    expect(subject + html).not.toContain("uid-secret");
    expect(subject + html).not.toContain("free text");
  });

  it("escapes what it prints", () => {
    const { html } = buildFunnelEmail(zeroReport({ warnings: ["<script>x</script>"] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
