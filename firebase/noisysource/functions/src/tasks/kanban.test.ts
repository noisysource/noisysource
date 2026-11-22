import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  cleanCardFields, cleanComment, describeChange, isOnRoadmap, orderAtEnd, orderBetween, sortCards,
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
      boardId: "kidclub", title: "Sibling discount", description: "", status: "backlog", priority: "p2",
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
