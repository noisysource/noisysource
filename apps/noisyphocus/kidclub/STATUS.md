# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-17

## Currently working on
Refactoring `FinancialSummaryPage.tsx` (Resumo Financeiro, admin) from two hardcoded
revenue scenarios ("Receita Estimada" = active+pending, "Receita Realidade" = active-only)
to a live filter bar (status checkboxes + service toggle + presets) driving all figures
on the page. This was phase 1 of a 2-phase plan — see "Next step".

Also found and fixed in passing: `packages/shared/package.json` declared `zod` as a
dependency but it was never actually installed (missing from `pnpm-lock.yaml`/`node_modules`),
which broke `pnpm --filter kidclub build:staging` for the whole app, not just this page.
Fixed with a plain `pnpm install` at the repo root — worth checking other worktrees/checkouts
don't have a stale `node_modules` that needs the same refresh.

## Last completed
- Branch `agent/financial-summary-filters` pushed, PR not yet opened (no `gh` CLI available
  in that session — PR compare link: https://github.com/noisysource/noisysource/pull/new/agent/financial-summary-filters).
- Deployed the branch's build to **kidclub-dev** (`pnpm --filter kidclub build:staging` +
  `firebase deploy --only hosting:kidclub --project=kidclub-dev`) for visual review at
  https://kidclub-dev-arcoiris.web.app/admin/financial-summary — NOT smoke-tested behind
  login (no dev-admin credentials available in that session), only confirmed the site
  responds 200.

## Next step
1. Renato: open the PR from the link above, eyeball the filter bar on dev while logged in
   as admin, merge when happy.
2. Phase 2 (discussed, not started): wire in real paid/unpaid filtering. Today neither
   "Receita Estimada" nor "Receita Realidade" (nor the new filter bar) reflects actual
   payment collected — both are purely subscription-status-based. Real paid/invoiced
   status already exists in `BillingAdminPage.tsx` (Vendus/EasyPay-backed) but isn't wired
   into this page. Needs a decision on what "paid" means for a recurring monthly sub
   (paid for the current period? ever invoiced?) before implementing — see open question below.

## Open questions for Renato
- For phase 2 (payment filter): what should "paid" mean for a subscription — paid for the
  *current billing period*, or *has at least one invoice ever*? This determines whether the
  filter needs a period selector or is a simple boolean per subscription.

## Anything risky in flight
- PR `agent/financial-summary-filters` → `main` not yet opened/merged (link above). No prod
  impact either way — only a dev deploy was done, and the auto-deploy-on-push-to-main workflow
  (`build-and-deploy-kidclub.yml`) means merging this PR will auto-deploy to prod hosting, so
  give the dev preview a real look before merging.
- Worktree `.claude/worktrees/financial-summary-filters` is still active (not cleaned up) —
  it has its own `node_modules` symlinks pointing at the main checkout's `node_modules`
  (root, `apps/noisyphocus/kidclub`, `packages/shared`) since the worktree had none of its
  own. Fine to leave until the branch is merged, then `git worktree remove` it per CLAUDE.md.
