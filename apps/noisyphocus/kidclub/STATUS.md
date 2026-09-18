# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-18

## Currently working on
Fixed a real bug found while investigating "Marisa Pratas can't see her billing records":
impersonating a family in the admin panel and then visiting the client billing pages showed
nothing, regardless of what records actually existed for that family.

Root cause: `PaymentsPage.tsx` and `InvoiceListPage.tsx` query Firestore directly by
`user.uid` (the real logged-in admin's own uid) instead of going through `familyService.ts`,
which is the thing that actually knows how to resolve the impersonated family. Every other
client page (dashboard, children, subscriptions) already switches to querying by `familyId`
while impersonating — these two just never got that treatment.

Fixed both to query `familyId` when `impersonation` is active, same pattern as
`familyService.ts` (`apps/noisyphocus/kidclub/src/services/familyService.ts:72-73`). No
Firestore rules change needed — admins already have blanket read on `billing`/`invoices`.

**Renato is already aware of the invoices/payments split** — noted here as a feature to
implement, not a new finding: `InvoiceListPage.tsx` ("As minhas faturas" nav item) reads from
an `invoices` Firestore collection that **nothing in the codebase writes to** — no Cloud
Function, no admin page. It's empty for every family, not just Marisa. The billing system
that's actually alive is `PaymentsPage.tsx` ("Pagamentos"), backed by the `billing`
collection and `autoCreateBillingSchedule()` in `functions/src/kidclub/billing.ts`.

**TODO / feature to implement:** wire "As minhas faturas" up to real invoice data (or decide
to retire it and redirect to Pagamentos instead) — needs a decision on which, then either a
Cloud Function that populates `invoices` (e.g. from Vendus documents) or removing the page.
Not done in this session — separate scope from the impersonation fix below.

## Last completed
- Branch `agent/impersonation-billing-fix` pushed, PR not yet opened (no `gh` CLI in this
  session — compare link: https://github.com/noisysource/noisysource/pull/new/agent/impersonation-billing-fix).
- `pnpm --filter kidclub build` and `build:staging` both succeed, no new type errors.
- Deployed to **kidclub-dev** (build:staging) — https://kidclub-dev-arcoiris.web.app, 200 OK.
  NOT smoke-tested behind login in that environment.
- **Deployed straight to prod hosting** (`pnpm --filter kidclub build` — plain, not
  build:staging — + `firebase deploy --only hosting:kidclub --project=rainbow-prod-2454b`),
  at Renato's explicit request, bypassing the usual PR-merge-triggers-deploy flow. Confirmed
  both https://kidclub.pt and https://rainbow-prod-2454b-arcoiris.web.app respond 200.
  NOT smoke-tested behind login on prod either.

## Next step
1. **`main` on GitHub does NOT have this commit yet** — prod hosting was pushed straight from
   the branch, so the deployed bundle and the `main` branch are now out of sync. Renato:
   open the PR from the link above and merge it, so the next person/CI that touches `main`
   doesn't auto-deploy an older build over this fix (`build-and-deploy-kidclub.yml` deploys
   hosting on every push to `main`).
2. Smoke test on prod: impersonate a family with real `billing` records, open
   `/client/payments`, confirm records show up.
3. Separately, decide on the "As minhas faturas" feature work (see above) and scope it as
   its own task when ready.

## Open questions for Renato
- None blocking — just the `main` merge (to resync source with what's live) and a prod
  smoke test.

## Anything risky in flight
- **Prod hosting was deployed ahead of `main`** — `agent/impersonation-billing-fix` is live
  on kidclub.pt but not merged. Until merged, `main` doesn't reflect what's actually running
  in prod, and the next push-to-main deploy will silently revert this fix unless that push
  also contains it. Merge the PR (link above) to close this gap.
- Unrelated, still open from a prior session: `git worktree list` shows several stale
  worktrees not cleaned up (`claim-studyroom-fix`, `deploy-functions-workflow-fix`,
  `kidclub-cicd-automation`, plus some pre-convention ones outside `.claude/worktrees/`).
  Worth Renato clearing out whichever are merged/abandoned.
- Also unrelated, paused mid-session on 2026-09-18: a unified client calendar
  (`agent/family-calendar` branch, `/client/calendar`) for cancelling study/transport days
  in one place instead of per-subscription. Built, builds clean, not deployed/reviewed yet.
  Needs a Firestore composite index deployed (`firestore.indexes.json`, committed on that
  branch) before it's usable — see that branch's own state for details, picking back up was
  put on hold to investigate the Marisa billing issue.
