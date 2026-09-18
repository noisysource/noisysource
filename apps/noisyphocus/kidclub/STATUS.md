# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-18

## Currently working on
Built a unified client-facing calendar (`/client/calendar`, nav label "Calendário") so
parents can cancel a specific study-room day or transport trip from one place, instead of
opening each subscription's own detail page. Triggered by Renato noticing transport
cancellation felt buried — investigation showed the per-trip cancel button already existed
on both `StudySubscriptionDetailPage.tsx` and `TransportSubscriptionDetailPage.tsx` (code +
Firestore rules both check out), the real problem was discoverability/clicks, not a bug.

New page: `src/pages/client/FamilyCalendarPage.tsx` — lists every active child's upcoming
study + transport occurrences for the next 4 weeks in one day-grouped agenda, with inline
Cancelar/Restaurar per occurrence and a Tudo/Sala de Estudo/Transporte filter. Reuses the
existing `eventModifications` doc shape and Firestore rules unchanged — no new write paths.

## Last completed
- Branch `agent/family-calendar` pushed, PR not yet opened (no `gh` CLI in this session —
  compare link: https://github.com/noisysource/noisysource/pull/new/agent/family-calendar).
- `pnpm --filter kidclub build` and `build:staging` both succeed. NOT deployed to kidclub-dev —
  `firebase` CLI creds were expired in this session (`firebase login --reauth` needed, which
  needs an interactive browser login only Renato can do) and NOT smoke-tested in a browser.
- Added a composite Firestore index to `firestore.indexes.json` for `eventModifications`
  (`subscriptionId`, `subscriptionType`, `modificationType`, `status`) — the new page's
  cancellation lookup batches all of a family's active subscription IDs into a single
  `subscriptionId in [...]` query (capped at 30, generous for a family), which needs this
  composite index or it will throw at runtime. **Index is committed but not deployed anywhere
  yet** — needs `firebase deploy --only firestore:indexes --project=kidclub-dev` before the
  page will actually work on dev, and again for prod before/at merge.

## Next step
1. Renato: `firebase login --reauth`, then either resume this session or a fresh one to:
   a. `firebase deploy --only firestore:indexes --project=kidclub-dev`
   b. `pnpm --filter kidclub build:staging` + `firebase deploy --only hosting:kidclub --project=kidclub-dev`
   c. Log in as a test parent with an active study + transport subscription, smoke-test
      `/client/calendar`: both show up, cancel one of each, confirm it flips to Restaurar,
      confirm admin calendar reflects the cancellation.
2. Open the PR from the link above, merge when the dev smoke test looks right.
3. Before/at merge to `main` (which auto-deploys hosting to prod): also run
   `firebase deploy --only firestore:indexes --project=rainbow-prod-2454b` — hosting deploy
   alone won't create the index on prod, and the page will throw there without it.

## Open questions for Renato
- None blocking — just needs the manual deploy + smoke test above since this session's
  Firebase CLI session was signed out.

## Anything risky in flight
- PR `agent/family-calendar` → `main` not yet opened/merged (link above). No prod impact yet —
  nothing deployed anywhere. `build-and-deploy-kidclub.yml` auto-deploys hosting to prod on
  merge to `main`, but **does not** deploy Firestore indexes — that's a separate manual step
  (see Next step #3) or this page 500s in prod for any family with subscriptions.
- Worktree `.claude/worktrees/family-calendar` still active — has its own `node_modules`
  symlinks into the main checkout's `node_modules` (root, `apps/noisyphocus/kidclub`,
  `packages/shared`), same pattern as prior sessions. Fine to leave until merged, then
  `git worktree remove .claude/worktrees/family-calendar` per CLAUDE.md.
- Unrelated: `git worktree list` currently shows several other stale worktrees
  (`claim-studyroom-fix`, `deploy-functions-workflow-fix`, `kidclub-cicd-automation`, plus a
  few outside `.claude/worktrees/` from pre-convention sessions) that don't look cleaned up.
  Not touched this session — worth Renato checking `git worktree list` and clearing out
  whichever are actually merged/abandoned.
