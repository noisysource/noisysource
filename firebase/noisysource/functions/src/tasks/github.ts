import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { requireKanbanCaller, requireOwner } from "../auth";
import { loadCard, log, toCard } from "./callables";
import {
  GITHUB_OWNER, mergeBlocker, prRefs, type PrCheck, type PrRef, type PrStatus,
} from "./kanban";

/**
 * A card's pull requests, from the board: their state and checks (anyone who
 * may use the kanban), and merging one (Renato only, from the app).
 *
 * GitHub's REST API is free (rate-limited, not billed), but it's still an
 * external call, so: nothing polls (the app asks when a card is opened or
 * refreshed), at most MAX_PRS PRs per call, a 10 s timeout, no retries.
 *
 * The token is a fine-grained GitHub token Renato pastes into the app
 * (kanbanSetGithubToken). It lives in `tasks_config/github`, which no rule
 * opens to any client (the rules only match tasks_boards and tasks_cards), and
 * is read here through the Admin SDK only, the way Domotics keeps its vendor
 * secrets. Only repos of the noisysource organisation are ever called.
 */

const TOKEN_DOC = "tasks_config/github";
const API = "https://api.github.com";
const MAX_PRS = 5;

async function token(): Promise<string> {
  const t = (await admin.firestore().doc(TOKEN_DOC).get()).get("token");
  if (typeof t !== "string" || !t) {
    throw new HttpsError("failed-precondition", "No GitHub token yet: add one in the Tasks app (sidebar → GitHub).");
  }
  return t;
}

async function gh<T>(path: string, tok: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "noisysource-tasks",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

interface GhPull {
  html_url: string; title: string; state: "open" | "closed"; merged: boolean; draft: boolean;
  mergeable: boolean | null; base: { ref: string }; head: { ref: string; sha: string };
  message?: string;
}
interface GhCheckRuns {
  check_runs?: { name: string; status: string; conclusion: string | null; html_url: string }[];
}

async function prStatus(pr: PrRef, tok: string): Promise<PrStatus | { error: string; repo: string; number: number }> {
  const base = `/repos/${GITHUB_OWNER}/${encodeURIComponent(pr.repo)}`;
  const p = await gh<GhPull>(`${base}/pulls/${pr.number}`, tok);
  if (p.status !== 200) {
    return { ...pr, error: p.status === 404 ? "not found (or the token can't see this repo)" : `GitHub ${p.status}: ${p.body.message ?? ""}` };
  }
  const c = await gh<GhCheckRuns>(`${base}/commits/${p.body.head.sha}/check-runs?per_page=100`, tok);
  const checks: PrCheck[] | null = c.status === 200
    ? (c.body.check_runs ?? []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url }))
    : null;
  return {
    ...pr,
    url: p.body.html_url,
    title: p.body.title,
    state: p.body.state,
    merged: p.body.merged,
    draft: p.body.draft,
    base: p.body.base.ref,
    head: p.body.head.ref,
    mergeable: p.body.mergeable,
    checks,
  };
}

export const kanbanPrs = onCall<{ cardId: string }>(async ({ auth, data }) => {
  requireKanbanCaller(auth);
  const card = toCard(await loadCard(data?.cardId));
  const refs = prRefs(card).slice(0, MAX_PRS);
  if (!refs.length) return { prs: [] };
  const tok = await token();
  return { prs: await Promise.all(refs.map((r) => prStatus(r, tok))) };
});

/**
 * Merge one of a card's PRs. Renato only: the agents can read PRs here but
 * never merge through the board. Re-checks everything on the server (the PR is
 * linked to this card, open, no conflicts, checks not failing or running)
 * rather than trusting what the app showed. When the card's last open PR is
 * merged, the card moves to Done.
 */
export const kanbanMergePr = onCall<{ cardId: string; repo: string; number: number; checksUnreadOk?: boolean }>(
  async ({ auth, data }) => {
    requireOwner(auth);
    const snap = await loadCard(data?.cardId);
    const card = toCard(snap);
    const refs = prRefs(card);
    const ref = refs.find((r) => r.repo === data?.repo && r.number === data?.number);
    if (!ref) throw new HttpsError("invalid-argument", "That PR isn't linked to this card");

    const tok = await token();
    const pr = await prStatus(ref, tok);
    if ("error" in pr) throw new HttpsError("failed-precondition", pr.error);
    const blocker = mergeBlocker(pr);
    if (blocker) throw new HttpsError("failed-precondition", `Can't merge #${pr.number}: ${blocker}`);
    if (pr.checks === null && data.checksUnreadOk !== true) {
      throw new HttpsError("failed-precondition", "Couldn't read the checks: confirm in the app to merge anyway");
    }

    const m = await gh<{ merged?: boolean; message?: string; sha?: string }>(
      `/repos/${GITHUB_OWNER}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}/merge`, tok,
      { method: "PUT", body: JSON.stringify({ merge_method: "merge" }) },
    );
    if (m.status !== 200 || !m.body.merged) {
      throw new HttpsError("aborted", `GitHub refused the merge (${m.status}): ${m.body.message ?? ""}`);
    }
    await log(card.id, "renato", "updated", `merged ${ref.repo}#${ref.number} into ${pr.base}`);

    // Done once no other linked PR is still open.
    const others = await Promise.all(refs.filter((r) => r !== ref).slice(0, MAX_PRS - 1).map((r) => prStatus(r, tok)));
    const stillOpen = others.some((o) => !("error" in o) && o.state === "open" && !o.merged);
    if (!stillOpen && card.status !== "done") {
      await snap.ref.update({
        status: "done", updatedBy: "renato", updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await log(card.id, "renato", "updated", `${card.status} → Done (all PRs merged)`);
    }
    return { merged: true, sha: m.body.sha, movedToDone: !stillOpen };
  },
);

/**
 * Save the GitHub token the board uses (Renato only). Checked against GitHub
 * first, and never sent back: the answer is only who the token belongs to.
 */
export const kanbanSetGithubToken = onCall<{ token: string }>(async ({ auth, data }) => {
  requireOwner(auth);
  const tok = typeof data?.token === "string" ? data.token.trim() : "";
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/.test(tok)) {
    throw new HttpsError("invalid-argument", "That doesn't look like a GitHub token (github_pat_… or ghp_…)");
  }
  const me = await gh<{ login?: string }>("/user", tok);
  if (me.status !== 200 || !me.body.login) throw new HttpsError("invalid-argument", `GitHub refused the token (${me.status})`);
  await admin.firestore().doc(TOKEN_DOC).set({
    token: tok, login: me.body.login, setAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { login: me.body.login };
});

/** Whether a token is saved, and whose (never the token itself). */
export const kanbanGithubInfo = onCall(async ({ auth }) => {
  requireOwner(auth);
  const d = (await admin.firestore().doc(TOKEN_DOC).get()).data();
  return { configured: !!d?.token, login: d?.login ?? null };
});
