# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-06

## Background — why this branch exists
The 2026-09-21 session built a NoisyPhocus cost model on `agent/financial-events-model` (PR #20).
That PR was **closed unmerged on 2026-09-22**: its KidClub half was written against the old
`billing.ts` discount pipeline, which PR #28 replaced with event-sourced reconciliation, so it
couldn't be rebased. None of its work reached `main`. The old commits are still on
`origin/agent/financial-events-model` for reference.

The finances half never depended on the old KidClub billing code, so it was cherry-picked
cleanly onto a fresh branch off `main`: **`agent/finhub-cost-model`** (worktree
`.claude/worktrees/finhub-cost-model`).

## Next feature: emails → expenses → invoices (decided 2026-10-06)
Takes priority over redesign steps 3–5 below. **Read `HANDOFF-email-expenses.md` (same folder)
before starting.** It has the design, the traps already found (e.g. confirmed events would
double-count balances) and the questions Renato must answer first. Start it in a fresh session,
on a new `agent/` branch, once #75 and #76 are merged.

## Redesign plan (agreed 2026-10-05)
Companies share one structure; only the income source differs. Steps, each its own branch + dev
deploy:
1. **Cost model** — `agent/finhub-cost-model` (described below). Test, then PR → `staging`.
2. **Navigation** — `agent/finhub-nav` (worktree `.claude/worktrees/finhub-nav`), **stacked on
   `agent/finhub-cost-model`** because both touch the sidebar and routes. Done, commit a855d6c:
   - one "A ver" picker (Casa / NoisySource / NoisyPhocus); one menu config in
     `src/components/layout/nav.ts`, grouped Receitas / Equipa / Despesas / Dinheiro /
     Impostos, showing only items that apply to the picked entity;
   - Visão geral, Previsão, Créditos above the picker (they already show every entity);
   - Cash Flow removed (`/:entity/cashflow` → Contas): balances are edited in the account form,
     and its projection read `forecastEvents`, which nothing writes;
   - "Private" shown as "Casa"; English headings translated.
   - "Clientes" (today's EC page) is NoisySource-only until step 3: Forecast/Dashboard treat the
     first active `ecContract` found as *the* EC contract.
3. **Clientes** — reuse `ecContracts`, add a billing type (`por dia` timesheet / `mensal fixo` /
   `avulso` / `kidclub`; existing docs default to `por dia`, no data move). One "Folha de horas"
   per client per month replaces editing days off in two places (EC form + Dashboard calendar).
   Ad hoc invoices as a list under the client. Then show Clientes for NoisyPhocus too.
4. **Equipa** — merge Contratos + Salários into one page; implement hourly pay (the model has
   `paymentType: 'hourly'` + `hourlyRateCents`, but nothing calculates it).
5. **Resumo do mês** — generalise `/noisyphocus/costs` to every company (income − team − fixed
   costs − taxes).

Known bugs to fix along the way: Dashboard + Forecast load employment contracts from NoisySource
only (NoisyPhocus salaries missing from the forecast); `api.setEntity` is one shared global that
the Dashboard flips while loading (pass the entity explicitly instead).

## Currently working on (step 1)
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
0. Done 2026-10-05: `agent/finhub-nav` @ a855d6c deployed to dev (includes step 1).
1. **Test on https://kidclub-dev-finhub.web.app** (`pnpm dev:finances` in the worktree also
   works). Check:
   - The "A ver" picker: switching keeps you on the same page when the new entity has it; Casa
     shows no Equipa/IVA, companies show no Rendimento/IRS/Empréstimos.
   - NoisyPhocus → Despesas → Recorrentes → "+ Nova entrada": the Fixo/Comissão toggle is
     visible. This was the unresolved bug on 2026-09-21.
   - NoisyPhocus → Equipa → Salários shows only NoisyPhocus contracts; NoisySource still shows
     Renato/Marisa.
   - NoisyPhocus → Equipa → Contratos: a green-receipt contract hides the SS fields and Benefits.
   - Existing NoisySource recurring entries and the VAT page still show the same numbers as
     before (they have no `costModel`, so they're treated as `fixed`).
2. **Enter NoisyPhocus's real numbers on dev** (nothing is seeded):
   - the driver (employee contract) and the teacher (green receipt);
   - Vendus (fixed, real IVA) and EasyPay (commission %, real IVA) as recurring expenses.
   Then open `/noisyphocus/costs` and check the current month looks right.
3. **PRs open (2026-10-06):** #75 `agent/finhub-cost-model` → `staging`, and #76
   `agent/finhub-nav`, stacked with base `agent/finhub-cost-model`. Merge #75 first, then
   retarget #76 to `staging` and merge it. FinHub hosting isn't in the automatic dev
   pipeline: after merging to staging, run `deploy-finances.yml` by hand (workflow_dispatch on
   `staging`) to put it on `kidclub-dev-finhub.web.app`.
4. **Later, a separate KidClub-scoped task:** rebuild `financialEvents` and make Resumo
   Financeiro read `costSummary`, against the new event-sourced billing. Add the `costSummary`
   read rule and a Cross-App Data Contracts entry in root CLAUDE.md in that same PR.
5. After that, Phase 7 (IRC estimation) is the next untouched feature.

## Open questions for Renato
- **Decided 2026-10-09 (VAT):** Renato wants every cost shown **with VAT and without VAT**, side
  by side, ideally on one summary page (fold into "Resumo do mês", redesign step 5). Amounts are
  typed as they appear on the invoice, **VAT included**.
- **Bug found 2026-10-09, fix next (follow-up PR off `staging`):** a recurring entry's `amountCents`
  means two different things. `RecurringEntry.ts` documents it as VAT-exclusive, and the IVA page
  + Custos do mês add `ivaRatePct` on top. But the forecast (`generateRecurringEvents`) uses it
  as the cash leaving the account, i.e. VAT-inclusive. The form never says which. Fix: amount =
  invoice total with VAT; derive VAT as `total × rate / (100 + rate)` and net as `total − VAT`
  everywhere (`recurringSchedule.ts`, `costSummary.ts`, form label). Questions before fixing:
  (1) were NoisySource's existing recurring amounts typed with or without VAT? If without, they
  need a one-off conversion, confirmed by Renato entry by entry; (2) is EasyPay's commission %
  quoted before VAT (fee = volume × % × 1.23) or with VAT included?
- Also noticed: the forecast uses a commission entry's fallback `amountCents`, not
  `commissionPct` × KidClub volume, so EasyPay's forecast is the typed estimate.
- `softwareCostCents` counts **every** active NoisyPhocus recurring expense as software, because
  the form doesn't expose `categoryId`. Fine while the only entries are Vendus and EasyPay; it
  needs a category filter if rent or insurance ever get entered as recurring.

## Anything risky in flight
- **`kidclub-dev-finhub.web.app` is serving the unmerged `agent/finhub-nav`** (@ a855d6c, which
  includes `agent/finhub-cost-model`), deployed by hand 2026-10-05 with `build:staging` +
  `firebase deploy --only hosting:finances --project=kidclub-dev`. Hosting only, no rules or
  functions. Checked: bundle has `projectId:"kidclub-dev"`; `/` and client routes serve
  `cache-control: no-cache`.
- A PR into `main` deploys to prod the moment it's opened. This branch goes to `staging` first.
- Two open, unmerged PRs: #75 and #76 (stacked). Opening #75 ran `deploy-dev.yml` against the
  shared `kidclub-dev`. It changes no KidClub code, but it can overwrite another open PR's KidClub
  deploy there.
- No new metered API calls. Reads only existing Firestore collections.
