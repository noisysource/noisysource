import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  checkoutCommands, checksVerdict, cleanCardFields, cleanComment, describeChange, isOnRoadmap, mergeBlocker,
  mergeWarning, orderAtEnd, orderBetween, parsePrUrl, prRefs, sortCards, type PrStatus,
} from "./kanban";

const MARKER = "// ---- mirrored below:";
const mirroredPart = (path: string) => {
  const src = readFileSync(path, "utf8");
  const at = src.indexOf(MARKER);
  if (at < 0) throw new Error(`${path} has no "${MARKER}" line`);
  return src.slice(at);
};

describe("kanban.ts mirror", () => {
  it("is identical to packages/shared/lib/kanban.ts below the marker", () => {
    const shared = mirroredPart(join(__dirname, "../../../../../packages/shared/lib/kanban.ts"));
    expect(mirroredPart(join(__dirname, "kanban.ts"))).toBe(shared);
  });
});

const err = (fn: () => unknown) => {
  try { fn(); return ""; } catch (e) { return (e as Error).message; }
};

describe("cleanCardFields", () => {
  it("fills the defaults for a new card", () => {
    expect(cleanCardFields({ boardId: "kidclub", title: "  Sibling discount  " })).toEqual({
      boardId: "kidclub", title: "Sibling discount", description: "", testPlan: "", status: "backlog", priority: "p2",
      assignee: null, roadmap: false, labels: [], links: [],
    });
  });
  it("lists every problem at once", () => {
    const m = err(() => cleanCardFields({ boardId: "Kid Club", title: "", status: "doing", priority: "high" }));
    expect(m).toContain("boardId");
    expect(m).toContain("title");
    expect(m).toContain("status");
    expect(m).toContain("priority");
  });
  it("returns only the given fields for an update", () => {
    expect(cleanCardFields({ status: "review", ignored: 1 }, true)).toEqual({ status: "review" });
    expect(cleanCardFields({}, true)).toEqual({});
  });
  it("normalises labels and checks links", () => {
    expect(cleanCardFields({ labels: ["Bug", "bug", " UI "] }, true)).toEqual({ labels: ["bug", "ui"] });
    expect(err(() => cleanCardFields({ links: [{ label: "PR", url: "javascript:alert(1)" }] }, true))).toContain("links");
    expect(cleanCardFields({ links: [{ label: "PR #170", url: "https://github.com/x/y/pull/170" }] }, true).links)
      .toHaveLength(1);
  });
  it("takes null or a known assignee", () => {
    expect(cleanCardFields({ assignee: null }, true)).toEqual({ assignee: null });
    expect(cleanCardFields({ assignee: "claude-code" }, true)).toEqual({ assignee: "claude-code" });
    expect(err(() => cleanCardFields({ assignee: "bob" }, true))).toContain("assignee");
  });
});

describe("ordering", () => {
  it("places cards between, before, after and at the end", () => {
    expect(orderBetween()).toBe(1000);
    expect(orderBetween(1000, 2000)).toBe(1500);
    expect(orderBetween(undefined, 1000)).toBe(0);
    expect(orderBetween(3000)).toBe(4000);
    expect(orderAtEnd([])).toBe(1000);
    expect(orderAtEnd([1000, 5000, 2000])).toBe(6000);
  });
  it("sorts by order, then age", () => {
    const s = sortCards([{ order: 2, createdAt: 1 }, { order: 1, createdAt: 5 }, { order: 1, createdAt: 2 }]);
    expect(s.map((c) => c.createdAt)).toEqual([2, 5, 1]);
  });
});

describe("roadmap and activity", () => {
  it("puts systems cards and flagged cards on the roadmap", () => {
    expect(isOnRoadmap({ boardId: "systems", roadmap: false })).toBe(true);
    expect(isOnRoadmap({ boardId: "kidclub", roadmap: true })).toBe(true);
    expect(isOnRoadmap({ boardId: "kidclub", roadmap: false })).toBe(false);
  });
  it("describes a change, or nothing when nothing changed", () => {
    const before = cleanCardFields({ boardId: "kidclub", title: "A" });
    expect(describeChange(before, { status: "in_progress", assignee: "atlas" }))
      .toBe("Backlog → In progress, assignee atlas");
    expect(describeChange(before, { title: "A", status: "backlog" })).toBe("");
  });
  it("checks comments", () => {
    expect(cleanComment("  done, PR #12  ")).toBe("done, PR #12");
    expect(err(() => cleanComment(""))).toContain("text");
  });
});

describe("pull requests", () => {
  const pr = (over: Partial<PrStatus> = {}): PrStatus => ({
    owner: "noisysource", repo: "noisysource", number: 1, url: "", title: "", state: "open", merged: false,
    draft: false, base: "staging", head: "agent/x", mergeable: true,
    checks: [{ name: "deploy", status: "completed", conclusion: "success", url: "" }], ...over,
  });
  it("reads PR links of the organisation only", () => {
    expect(parsePrUrl("https://github.com/noisysource/noisysource/pull/168")).toEqual({ owner: "noisysource", repo: "noisysource", number: 168 });
    expect(parsePrUrl("https://github.com/noisysource/Atlas/pull/12/files")).toEqual({ owner: "noisysource", repo: "Atlas", number: 12 });
    expect(parsePrUrl("https://github.com/someone/noisysource/pull/1")).toBeNull();
    expect(parsePrUrl("https://github.com/noisysource/noisysource/issues/1")).toBeNull();
    const card = { links: [
      { label: "PR", url: "https://github.com/noisysource/noisysource/pull/168" },
      { label: "same", url: "https://github.com/noisysource/noisysource/pull/168#discussion" },
      { label: "docs", url: "https://example.com" },
    ] };
    expect(prRefs(card)).toHaveLength(1);
  });
  it("checks out in a worktree in the monorepo", () => {
    expect(checkoutCommands("noisysource", "agent/tasks-kanban")).toContain(
      "git worktree add .claude/worktrees/test-tasks-kanban origin/agent/tasks-kanban");
    expect(checkoutCommands("Atlas", "feat/x")).toContain("git switch --track origin/feat/x");
  });
  it("judges checks, counting skipped as passed", () => {
    const c = (status: string, conclusion: string | null) => ({ name: "", status, conclusion, url: "" });
    expect(checksVerdict(null)).toBe("unknown");
    expect(checksVerdict([])).toBe("none");
    expect(checksVerdict([c("completed", "success"), c("completed", "skipped")])).toBe("passed");
    expect(checksVerdict([c("completed", "success"), c("in_progress", null)])).toBe("pending");
    expect(checksVerdict([c("completed", "failure"), c("in_progress", null)])).toBe("failed");
  });
  it("blocks a merge until it's safe", () => {
    expect(mergeBlocker(pr())).toBeNull();
    expect(mergeBlocker(pr({ checks: null }))).toBeNull();
    expect(mergeBlocker(pr({ merged: true }))).toBe("already merged");
    expect(mergeBlocker(pr({ draft: true }))).toContain("draft");
    expect(mergeBlocker(pr({ mergeable: null }))).toContain("refresh");
    expect(mergeBlocker(pr({ mergeable: false }))).toContain("conflicts");
    expect(mergeBlocker(pr({ checks: [{ name: "d", status: "completed", conclusion: "failure", url: "" }] }))).toContain("failed");
  });
  it("warns what a merge releases", () => {
    expect(mergeWarning("noisysource", "staging")).toContain("noisysource-prod");
    expect(mergeWarning("noisysource", "main")).toContain("production");
    expect(mergeWarning("Atlas", "main")).toBeNull();
  });
  it("carries the test plan", () => {
    expect(cleanCardFields({ boardId: "tasks", title: "x" }).testPlan).toBe("");
    expect(describeChange(cleanCardFields({ boardId: "tasks", title: "x" }), { testPlan: "open /", status: "testing" }))
      .toBe("Backlog → Testing, test plan");
  });
});
