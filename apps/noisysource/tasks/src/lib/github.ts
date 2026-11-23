import { httpsCallable } from 'firebase/functions';
import { fns } from './firebase';
import type { PrStatus } from '@shared/lib/kanban';

// The board's GitHub side (firebase/noisysource/functions/src/tasks/github.ts).
// The token stays on the server; the app only ever sees whose it is.

export type PrResult = PrStatus | { repo: string; number: number; error: string };

export const fetchPrs = (cardId: string) =>
  httpsCallable<{ cardId: string }, { prs: PrResult[] }>(fns, 'kanbanPrs')({ cardId }).then((r) => r.data.prs);

export const mergePr = (cardId: string, repo: string, number: number, checksUnreadOk = false) =>
  httpsCallable<
    { cardId: string; repo: string; number: number; checksUnreadOk: boolean },
    { merged: boolean; movedToDone: boolean }
  >(fns, 'kanbanMergePr')({ cardId, repo, number, checksUnreadOk }).then((r) => r.data);

export const setGithubToken = (token: string) =>
  httpsCallable<{ token: string }, { login: string }>(fns, 'kanbanSetGithubToken')({ token }).then((r) => r.data);

export const githubInfo = () =>
  httpsCallable<void, { configured: boolean; login: string | null }>(fns, 'kanbanGithubInfo')().then((r) => r.data);

/** A callable's error, in words. */
export function errText(e: unknown): string {
  const { code, message } = (e ?? {}) as { code?: string; message?: string };
  if (code === 'functions/internal' || code === 'functions/unavailable') {
    return "Couldn't reach the board's server (kanbanPrs). Check the connection, or that the functions are deployed.";
  }
  return message ?? String(e);
}
