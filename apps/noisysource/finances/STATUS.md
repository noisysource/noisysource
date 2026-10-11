# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-11

## Background — why this branch exists
The 2026-09-21 session built a NoisyPhocus cost model on `agent/financial-events-model` (PR #20).
That PR was **closed unmerged on 2026-09-22**: its KidClub half was written against the old
`billing.ts` discount pipeline, which PR #28 replaced with event-sourced reconciliation, so it
couldn't be rebased. None of its work reached `main`. The old commits are still on
`origin/agent/financial-events-model` for reference.

The finances half never depended on the old KidClub billing code, so it was cherry-picked
cleanly onto a fresh branch off `main`: **`agent/finhub-cost-model`** (worktree
`.claude/worktrees/finhub-cost-model`).

## Next feature: KidClub bank reconciliation (decided 2026-10-11)
Monthly check of the NoisyPhocus BPI statement against KidClub bills, Vendus invoices and EasyPay's
daily payouts. Renato's call: it lives in FinHub, not KidClub. **Read
`HANDOFF-kidclub-reconciliation.md` (same folder) before starting.** It shares the statement page
with emails → expenses (build that page once). Core output: flag every credit with no invoice
("Sem fatura"; Vendus is the source of truth, not only KidClub bills). Sample statement received
(BPI **PDF**, `~/dev/noisysource/prodata/`, gitignored), so steps 1–2 (PDF import, read-only
reconciliation) are unblocked. Still open: what the card-terminal (TPA) sales are, and the EasyPay
key scopes before step 4 (handoff §7). Handoff committed on `agent/finhub-kidclub-reconciliation`
(worktree `.claude/worktrees/finhub-kidclub-reconciliation`, local only, not pushed; stacked on
`agent/finhub-nav` until #82 merges). Renato chose this over emails → expenses as the next feature.

## After that: emails → expenses → invoices (decided 2026-10-06)
Comes after the KidClub reconciliation (Renato, 2026-10-11); both share the statement page.
Still takes priority over redesign steps 3–5 below. **Read `HANDOFF-email-expenses.md` (same folder)
before starting.** It has the design, the traps already found (e.g. confirmed events would
double-count balances) and the questions Renato must answer first. Start it in a fresh session,
on a new `agent/` branch, once #75 and #82 (re-land of #76) are merged.

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

## Currently working on
Nothing in progress. #75 is merged; #82 (re-land of #76) is waiting for its dev deploy.

**#76 did not reach `staging` (2026-10-11).** It was stacked with base `agent/finhub-cost-model`;
#75 merged into `staging` 26 s before #76 merged, so #76 merged into `agent/finhub-cost-model`
instead. Re-landed as **#82** (`agent/finhub-nav` → `staging`, same 7 commits, trial merge clean).
Lesson: after merging the base of a stacked PR, retarget the stacked PR to `staging` *before*
merging it.

## Last completed
- **#75 merged into `staging` (2026-10-11):** CI/hosting fixes (`build:staging` for the dev job,
  `no-cache` headers), commission cost model (`costModel: 'fixed' | 'commission'`), green-receipt
  contracts, Payroll scoped to the entity, `/noisyphocus/costs` page writing
  `finances_entities/noisyphocus/costSummary/{yyyy-mm}`. Details in PR #75. Deliberately not in
  it: the `costSummary` read rule for KidClub and any KidClub code (see Next step 5).
- Reconciliation handoff written and agreed with Renato (2026-10-11).

## Next step
1. **Merge #82** once its `deploy` check is green. Then run `deploy-finances.yml` by hand
   (workflow_dispatch on `staging`). FinHub hosting isn't in the automatic dev pipeline.
2. **KidClub reconciliation, step 1 (BPI PDF import):** in the worktree
   `.claude/worktrees/finhub-kidclub-reconciliation`, `git fetch && git rebase origin/staging`
   (after #82 merges, only the 3 handoff/STATUS commits remain), then build step 1 per
   `HANDOFF-kidclub-reconciliation.md` §6. PR → `staging`.
3. **Clean up worktrees:** `finhub-cost-model` now (#75 merged); `finhub-nav` after #82 merges
   (`.claude/skills/worktree-cleanup`).
4. **Still to do on dev, from the cost-model work:** enter NoisyPhocus's real numbers (the driver
   as an employee contract, the teacher as a green receipt, Vendus fixed and EasyPay commission as
   recurring expenses), then check `/noisyphocus/costs` for the current month.
5. **Later, a separate KidClub-scoped task:** rebuild `financialEvents` and make Resumo
   Financeiro read `costSummary`, against the new event-sourced billing. Add the `costSummary`
   read rule and a Cross-App Data Contracts entry in root CLAUDE.md in that same PR.
6. Separately: the VAT amount bug (Open questions below), then Phase 7 (IRC estimation).

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
- **#82 open** (`agent/finhub-nav` → `staging`). Its deploy runs `deploy-dev.yml` against the
  shared `kidclub-dev`; it changes no KidClub code.
- **`kidclub-dev-finhub.web.app` still serves the hand-deployed `agent/finhub-nav` @ a855d6c**
  (2026-10-05, hosting only) until `deploy-finances.yml` runs on `staging`.
- **`agent/finhub-kidclub-reconciliation` exists only locally** (in its worktree). Don't delete
  that worktree before the branch is pushed.
- The real BPI statement used for the reconciliation design is in the main checkout's
  gitignored `prodata/`. Never copy it into a worktree or commit it.
- A PR into `main` only deploys to prod when its head is `staging`. Feature branches go to
  `staging` first.
- No new metered API calls yet. Reconciliation steps 2 and 4 will add Vendus and EasyPay reads
  (checklists in the handoff §5).
