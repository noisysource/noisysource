# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-29

## Background — why this branch exists
The 2026-09-21 session built a NoisyPhocus cost model on `agent/financial-events-model` (PR #20).
That PR was **closed unmerged on 2026-09-22**: its KidClub half was written against the old
`billing.ts` discount pipeline, which PR #28 replaced with event-sourced reconciliation, so it
couldn't be rebased. None of its work reached `main`. The old commits are still on
`origin/agent/financial-events-model` for reference.

The finances half never depended on the old KidClub billing code, so it was cherry-picked
cleanly onto a fresh branch off `main`: **`agent/finhub-cost-model`** (worktree
`.claude/worktrees/finhub-cost-model`).

## Currently working on
Testing `agent/finhub-cost-model` locally against `kidclub-dev` before opening a PR into
`staging`. The branch contains:

1. **CI/hosting fixes**
   - `deploy-finances.yml` dev job now runs `build:staging`. Plain `build` baked the prod
     Firebase config into the dev site, so every Firebase call 403'd.
   - `firebase.json` finances target serves `Cache-Control: no-cache` on `**`, so a fresh deploy
     is visible straight away instead of up to an hour later.
2. **Commission cost model:** `RecurringEntryDoc.costModel: 'fixed' | 'commission'` +
   `commissionPct`. The Recurring form has a Fixo/Comissão toggle for expense entries. The VAT
   page resolves commission entries against KidClub's processed volume
   (`api.kidclub.monthlyProcessedVolumeCents`, which sums `_apps/arcoiris/billing` with status
   `paid`/`invoiced` by `paidAt` month). Checked 2026-09-29: the current `Billing` model still has
   `status`, `paidAt` and `total`.
3. **Green-receipt contracts:** `EmploymentContractDoc.contractType: 'employee' | 'green_receipt'`.
   A green-receipt contract forces SS to 0 and hides Benefits. Use this for the NoisyPhocus
   teacher. `/noisyphocus/ec-contracts` is for NoisySource's client income only.
4. **Payroll scoped to entity:** the company picker used to default to NoisySource even when
   viewing NoisyPhocus.
5. **`/noisyphocus/costs` page:** computes payroll + software + IVA dedutível for the month and
   writes `finances_entities/noisyphocus/costSummary/{yyyy-mm}`. It recalculates on open (no
   publish button).

Deliberately **not** on this branch:
- The Firestore rule letting KidClub read `costSummary`. Nothing on the KidClub side reads it
  yet; add the rule together with the consumer (step 3 below).
- Any KidClub code (`financialEvents`, Resumo Financeiro changes). That has to be redesigned
  against the event-sourced billing model.

Build: `pnpm build:staging` passes. `tsc --noEmit` shows 20 errors, all pre-existing on `main`,
none in files this branch touches.

## Last completed
Cherry-picked the finance/CI commits from the closed PR #20 onto `agent/finhub-cost-model`
(2026-09-29).

## Next step
1. **Test on https://kidclub-dev-finhub.web.app** (this branch was deployed there 2026-10-01;
   `pnpm dev:finances` in the worktree also works). Check:
   - `/noisyphocus/recurring` → "+ Nova entrada": the Fixo/Comissão toggle is visible. This was
     the unresolved bug on 2026-09-21. If it shows locally, the old problem was the hosting site
     or cache, not the code.
   - Entity switch → NoisyPhocus → Payroll shows only NoisyPhocus contracts, and NoisySource
     still shows Renato/Marisa.
   - `/noisyphocus/contracts`: a green-receipt contract hides the SS fields and Benefits.
   - Existing NoisySource recurring entries and the VAT page still show the same numbers as
     before (they have no `costModel`, so they're treated as `fixed`).
2. **Enter NoisyPhocus's real numbers on dev** (nothing is seeded):
   - the driver (employee contract) and the teacher (green receipt);
   - Vendus (fixed, real IVA) and EasyPay (commission %, real IVA) as recurring expenses.
   Then open `/noisyphocus/costs` and check the current month looks right.
3. **Open a PR `agent/finhub-cost-model` → `staging`.** FinHub hosting isn't in the automatic dev
   pipeline: after merging to staging, run `deploy-finances.yml` by hand (workflow_dispatch on
   `staging`) to put it on `kidclub-dev-finhub.web.app`.
4. **Later, a separate KidClub-scoped task:** rebuild `financialEvents` and make Resumo
   Financeiro read `costSummary`, against the new event-sourced billing. Add the `costSummary`
   read rule and a Cross-App Data Contracts entry in root CLAUDE.md in that same PR.
5. After that, Phase 7 (IRC estimation) is the next untouched feature.

## Open questions for Renato
- Should `costSummary.vatCents` be only the IVA dedutível on that month's software costs (the
  current implementation), or the full quarterly net VAT position (income − deductible)?
- `softwareCostCents` counts **every** active NoisyPhocus recurring expense as software, because
  the form doesn't expose `categoryId`. Fine while the only entries are Vendus and EasyPay; it
  needs a category filter if rent or insurance ever get entered as recurring.

## Anything risky in flight
- **`kidclub-dev-finhub.web.app` is serving this unmerged branch** (`agent/finhub-cost-model`
  @ bc7813d): deployed by hand on 2026-10-01 with `build:staging` +
  `firebase deploy --only hosting:finances --project=kidclub-dev`. Hosting only, no rules or
  functions. It replaces the stale PR #20 build that was there. Checked: bundle has
  `projectId:"kidclub-dev"`, and `/` and client routes serve `cache-control: no-cache`.
- A PR into `main` deploys to prod the moment it's opened. This branch goes to `staging` first.
- No new metered API calls. Reads only existing Firestore collections.
