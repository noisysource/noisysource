// ---- mirrored below: packages/shared/lib/kanban.ts = firebase/noisysource/functions/src/tasks/kanban.ts ----
// The Tasks app's kanban: one board per app plus "All systems", the roadmap.
// Pure logic only (no Firebase), shared by the app (apps/noisysource/tasks)
// and the agents' callables (firebase/noisysource/functions/src/tasks/).
// Edit this file, then copy it there: a test fails when the two differ.

export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
};

export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = {
  p0: 'P0 · urgent',
  p1: 'P1 · high',
  p2: 'P2 · normal',
  p3: 'P3 · low',
};

/** Who can hold a card. */
export const ASSIGNEES = ['renato', 'marisa', 'atlas', 'claude-code'] as const;
export type Assignee = (typeof ASSIGNEES)[number];

/** Who can change a card: Renato in the app, or one of the agents. */
export type Actor = 'renato' | 'atlas' | 'claude-code';

/** The roadmap board. Every other board is one app. */
export const SYSTEMS_BOARD_ID = 'systems';

export interface Board {
  id: string;
  name: string;
  /** Tailwind-friendly hex, for the app chip on the roadmap. */
  color: string;
  order: number;
  /** Optional: the repo path the app lives in, so agents know where to work. */
  path?: string;
}

export interface CardLink {
  label: string;
  url: string;
}

export interface Card {
  id: string;
  boardId: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string[];
  assignee: Assignee | null;
  /** Shown on the "All systems" roadmap too. Cards on that board always are. */
  roadmap: boolean;
  links: CardLink[];
  /**
   * How Renato tests it: what to check, on which preview, and anything to
   * set up first. The checkout commands come from the linked PRs
   * (checkoutCommands), so this holds only what a branch name can't say.
   */
  testPlan: string;
  /** Position inside its column, smallest first. */
  order: number;
  createdBy: Actor;
  updatedBy: Actor;
  /** Epoch ms (Firestore timestamps converted at the edges). */
  createdAt: number;
  updatedAt: number;
}

export type CardFields = Pick<
  Card,
  'boardId' | 'title' | 'description' | 'status' | 'priority' | 'labels' | 'assignee' | 'roadmap' | 'links' | 'testPlan'
>;

export const DEFAULT_BOARDS: Board[] = [
  { id: SYSTEMS_BOARD_ID, name: 'All systems', color: '#a1a1aa', order: 0 },
  { id: 'kidclub', name: 'KidClub', color: '#f472b6', order: 1, path: 'apps/noisyphocus/kidclub' },
  { id: 'finhub', name: 'FinHub', color: '#34d399', order: 2, path: 'apps/noisysource/finances' },
  { id: 'domotics', name: 'Domotics', color: '#fbbf24', order: 3, path: 'apps/noisysource/domotics' },
  { id: 'atlas', name: 'Atlas', color: '#818cf8', order: 4, path: 'github.com/noisysource/Atlas' },
  { id: 'website', name: 'noisysource.com', color: '#38bdf8', order: 5 },
  { id: 'tasks', name: 'Tasks (this board)', color: '#fb923c', order: 6, path: 'apps/noisysource/tasks' },
];

export const LIMITS = {
  title: 200,
  description: 10_000,
  testPlan: 10_000,
  labels: 10,
  label: 40,
  links: 10,
  linkLabel: 80,
  url: 500,
  comment: 4_000,
} as const;

export function isOnRoadmap(card: Pick<Card, 'boardId' | 'roadmap'>): boolean {
  return card.boardId === SYSTEMS_BOARD_ID || card.roadmap === true;
}

/** Position for a card dropped between two others (either may be missing). */
export function orderBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return (after as number) - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

/** Position at the bottom of a column. */
export function orderAtEnd(orders: number[]): number {
  return orders.length ? Math.max(...orders) + 1000 : 1000;
}

export function sortCards<T extends Pick<Card, 'order' | 'createdAt'>>(cards: T[]): T[] {
  return [...cards].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function isValidBoardId(id: unknown): id is string {
  return typeof id === 'string' && BOARD_ID.test(id);
}

/**
 * Cleans what a caller sent for a card. With `partial`, only the fields given
 * are checked and returned (an update); otherwise the missing ones get their
 * defaults (a new card). Unknown fields are ignored. Throws an Error whose
 * message lists every problem, so an agent can fix its call in one go.
 */
export function cleanCardFields(input: unknown, partial: true): Partial<CardFields>;
export function cleanCardFields(input: unknown, partial?: false): CardFields;
export function cleanCardFields(input: unknown, partial = false): Partial<CardFields> {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Partial<CardFields> = {};
  const problems: string[] = [];
  const given = (k: string) => raw[k] !== undefined;

  if (given('boardId') || !partial) {
    if (isValidBoardId(raw.boardId)) out.boardId = raw.boardId;
    else problems.push('boardId: required, lowercase letters, digits and dashes');
  }
  if (given('title') || !partial) {
    const t = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (t && t.length <= LIMITS.title) out.title = t;
    else problems.push(`title: required, at most ${LIMITS.title} characters`);
  }
  if (given('description')) {
    if (typeof raw.description === 'string' && raw.description.length <= LIMITS.description) {
      out.description = raw.description;
    } else problems.push(`description: text, at most ${LIMITS.description} characters`);
  } else if (!partial) out.description = '';
  if (given('testPlan')) {
    if (typeof raw.testPlan === 'string' && raw.testPlan.length <= LIMITS.testPlan) out.testPlan = raw.testPlan;
    else problems.push(`testPlan: text, at most ${LIMITS.testPlan} characters`);
  } else if (!partial) out.testPlan = '';
  if (given('status')) {
    if ((STATUSES as readonly unknown[]).includes(raw.status)) out.status = raw.status as Status;
    else problems.push(`status: one of ${STATUSES.join(', ')}`);
  } else if (!partial) out.status = 'backlog';
  if (given('priority')) {
    if ((PRIORITIES as readonly unknown[]).includes(raw.priority)) out.priority = raw.priority as Priority;
    else problems.push(`priority: one of ${PRIORITIES.join(', ')}`);
  } else if (!partial) out.priority = 'p2';
  if (given('assignee')) {
    if (raw.assignee === null || (ASSIGNEES as readonly unknown[]).includes(raw.assignee)) {
      out.assignee = raw.assignee as Assignee | null;
    } else problems.push(`assignee: null or one of ${ASSIGNEES.join(', ')}`);
  } else if (!partial) out.assignee = null;
  if (given('roadmap')) {
    if (typeof raw.roadmap === 'boolean') out.roadmap = raw.roadmap;
    else problems.push('roadmap: true or false');
  } else if (!partial) out.roadmap = false;
  if (given('labels')) {
    const l = raw.labels;
    if (Array.isArray(l) && l.length <= LIMITS.labels &&
        l.every((x) => typeof x === 'string' && x.trim() && x.trim().length <= LIMITS.label)) {
      out.labels = [...new Set(l.map((x: string) => x.trim().toLowerCase()))];
    } else problems.push(`labels: at most ${LIMITS.labels} short texts`);
  } else if (!partial) out.labels = [];
  if (given('links')) {
    const l = raw.links;
    const okLink = (x: unknown) => {
      if (!x || typeof x !== 'object') return false;
      const { label, url } = x as Record<string, unknown>;
      return typeof label === 'string' && label.trim() !== '' && label.length <= LIMITS.linkLabel &&
        typeof url === 'string' && url.length <= LIMITS.url && /^https?:\/\/\S+$/.test(url);
    };
    if (Array.isArray(l) && l.length <= LIMITS.links && l.every(okLink)) {
      out.links = l.map((x: CardLink) => ({ label: x.label.trim(), url: x.url }));
    } else problems.push(`links: at most ${LIMITS.links} of {label, url} with an http(s) url`);
  } else if (!partial) out.links = [];

  if (problems.length) throw new Error(problems.join('; '));
  return out;
}

export function cleanComment(text: unknown): string {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > LIMITS.comment) throw new Error(`text: required, at most ${LIMITS.comment} characters`);
  return t;
}

/** One line for the activity log, describing what an update changed. */
export function describeChange(before: CardFields, patch: Partial<CardFields>): string {
  const parts: string[] = [];
  if (patch.boardId !== undefined && patch.boardId !== before.boardId) parts.push(`board ${before.boardId} → ${patch.boardId}`);
  if (patch.status !== undefined && patch.status !== before.status) {
    parts.push(`${STATUS_LABEL[before.status]} → ${STATUS_LABEL[patch.status]}`);
  }
  if (patch.title !== undefined && patch.title !== before.title) parts.push('title');
  if (patch.description !== undefined && patch.description !== before.description) parts.push('description');
  if (patch.testPlan !== undefined && patch.testPlan !== (before.testPlan ?? '')) parts.push('test plan');
  if (patch.priority !== undefined && patch.priority !== before.priority) parts.push(`priority ${patch.priority}`);
  if (patch.assignee !== undefined && patch.assignee !== before.assignee) parts.push(`assignee ${patch.assignee ?? 'none'}`);
  if (patch.roadmap !== undefined && patch.roadmap !== before.roadmap) parts.push(patch.roadmap ? 'on roadmap' : 'off roadmap');
  if (patch.labels !== undefined && patch.labels.join() !== before.labels.join()) parts.push('labels');
  if (patch.links !== undefined && JSON.stringify(patch.links) !== JSON.stringify(before.links)) parts.push('links');
  return parts.join(', ');
}

// ---- Pull requests ----
// A card's PRs are its links that point at a pull request on GitHub. Only the
// noisysource organisation's repos: the callables refuse any other owner, so a
// link can't be used to act on someone else's repository.

export const GITHUB_OWNER = 'noisysource';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function parsePrUrl(url: string): PrRef | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d{1,7})(?:[/?#].*)?$/.exec(url);
  if (!m || m[1].toLowerCase() !== GITHUB_OWNER) return null;
  return { owner: GITHUB_OWNER, repo: m[2], number: Number(m[3]) };
}

export function prRefs(card: Pick<Card, 'links'>): PrRef[] {
  const seen = new Set<string>();
  const out: PrRef[] = [];
  for (const l of card.links) {
    const pr = parsePrUrl(l.url);
    const key = pr && `${pr.repo}#${pr.number}`;
    if (pr && !seen.has(key!)) {
      seen.add(key!);
      out.push(pr);
    }
  }
  return out;
}

/**
 * Commands to test a PR's branch locally, the repo's way: its own worktree
 * (root CLAUDE.md, "One task, one git worktree, one branch"), never a branch
 * switch in the main checkout.
 */
export function checkoutCommands(repo: string, branch: string): string {
  const dir = branch.replace(/^[^/]+\//, '').replace(/[^A-Za-z0-9._-]+/g, '-');
  if (repo === 'noisysource') {
    return [
      `git fetch origin ${branch}`,
      `git worktree add .claude/worktrees/test-${dir} origin/${branch}`,
      `cd .claude/worktrees/test-${dir} && pnpm install`,
      `# when done: git worktree remove .claude/worktrees/test-${dir}`,
    ].join('\n');
  }
  return [`git fetch origin ${branch}`, `git switch --track origin/${branch}`].join('\n');
}

export interface PrCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface PrStatus extends PrRef {
  url: string;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  base: string;
  head: string;
  /** null while GitHub is still working it out: ask again in a moment. */
  mergeable: boolean | null;
  checks: PrCheck[] | null;
}

export type ChecksVerdict = 'passed' | 'failed' | 'pending' | 'none' | 'unknown';

/** Skipped and neutral jobs count as passed (the deploy workflow skips parts it doesn't touch). */
export function checksVerdict(checks: PrCheck[] | null): ChecksVerdict {
  if (checks === null) return 'unknown';
  if (!checks.length) return 'none';
  if (checks.some((c) => c.status === 'completed' && !['success', 'skipped', 'neutral'].includes(c.conclusion ?? ''))) {
    return 'failed';
  }
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  return 'passed';
}

/**
 * Why a PR can't be merged from the board, or null if it can. Failing or
 * running checks block it: the repo has no branch protection (root CLAUDE.md),
 * so this is the gate that makes sure the deploy is green first. Checks that
 * couldn't be read don't block, but the app asks again before merging.
 */
export function mergeBlocker(pr: PrStatus): string | null {
  if (pr.merged) return 'already merged';
  if (pr.state !== 'open') return 'closed';
  if (pr.draft) return 'still a draft';
  if (pr.mergeable === null) return 'GitHub is still checking for conflicts, refresh in a moment';
  if (!pr.mergeable) return 'has conflicts with its base branch';
  const v = checksVerdict(pr.checks);
  if (v === 'failed') return 'a check failed';
  if (v === 'pending') return 'checks are still running';
  return null;
}

/** What merging into this base does, said before the button is pressed. */
export function mergeWarning(repo: string, base: string): string | null {
  if (repo !== 'noisysource') return null;
  if (base === 'staging') {
    return 'Merging into staging releases the NoisySource apps (Domotics, Tasks…) to noisysource-prod, and updates dev.';
  }
  if (base === 'main') return 'Merging into main deploys KidClub and FinHub to production.';
  return null;
}
