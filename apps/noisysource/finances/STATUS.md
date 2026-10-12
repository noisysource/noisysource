# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-12

## Background — why this branch exists
The 2026-09-21 session built a NoisyPhocus cost model on `agent/financial-events-model` (PR #20).
That PR was **closed unmerged on 2026-09-22**: its KidClub half was written against the old
`billing.ts` discount pipeline, which PR #28 replaced with event-sourced reconciliation, so it
couldn't be rebased. None of its work reached `main`. The old commits are still on
`origin/agent/financial-events-model` for reference.

The finances half never depended on the old KidClub billing code, so it was cherry-picked
cleanly onto a fresh branch off `main`: **`agent/finhub-cost-model`** (worktree
`.claude/worktrees/finhub-cost-model`).

## Release to prod (2026-10-12)
`RELEASE-TEST-PLAN.md` (repo root): what's going to prod, scenarios to test on dev for KidClub
and FinHub, the go-live steps, and open questions. **Prod FinHub still runs a build from
2026-07-31.** **FinHub deploy pipeline (2026-10-12), branch `agent/finhub-deploy-pipeline`
(worktree `.claude/worktrees/finhub-deploy-pipeline`), pushed, PR not opened yet:** it deploys
FinHub with KidClub (a PR into `staging` → dev, the `staging` → `main` PR → prod, no manual
runs). **Open its PR only after #87 merges** (Renato's call): a PR into `staging` redeploys dev
FinHub from `staging` + the branch, which would replace #87's build that's on dev for testing.
To open it: `gh pr create --base staging --head agent/finhub-deploy-pipeline`, then check its
dev run shows green "Check both builds target kidclub-dev" and "Deploy FinHub Hosting", and that
`kidclub-dev-finhub.web.app` serves `staging` (with the VAT work). The prod half is only
exercised by the next `staging` → `main` PR. First question to settle, before that promotion
PR: does the real FinHub data live on dev or prod?

## VAT convention for both apps (decided 2026-10-11)
`packages/shared/HANDOFF-vat-convention.md`. PR 1 there (shared helper + FinHub) fixes the
recurring-amount VAT bug below and adds com/sem IVA columns to Custos do mês. Renato will
re-enter all recurring entries afterwards (no migration). Do it before or alongside the
reconciliation and email work below, since bank-transaction amounts follow the same rule.

## Next feature: KidClub bank reconciliation (decided 2026-10-11)
Monthly check of the NoisyPhocus BPI statement against KidClub bills, Vendus invoices and EasyPay's
daily payouts. Renato's call: it lives in FinHub, not KidClub. **Read
`HANDOFF-kidclub-reconciliation.md` (same folder) before starting.** It shares the statement page
with emails → expenses (build that page once). Core output: flag every credit with no invoice
("Sem fatura"; Vendus is the source of truth, not only KidClub bills). Sample statement received
(BPI **PDF**, `~/dev/noisysource/prodata/`, gitignored). **Step 1 (PDF import) is built** and
merged into `staging` (#85) from `agent/finhub-kidclub-reconciliation` (worktree
`.claude/worktrees/finhub-kidclub-reconciliation`); step 2 (read-only reconciliation) is next.
Still open: what the card-terminal (TPA) sales are, and the EasyPay key scopes before step 4
(handoff §7). Renato chose this over emails → expenses as the next feature.

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
Reconciliation step 1 (BPI PDF import) is done and waiting for review: PR → `staging` from
`agent/finhub-kidclub-reconciliation`. Nothing else in progress.

Lesson kept from #76 (2026-10-11): after merging the base of a stacked PR, retarget the stacked PR
to `staging` *before* merging it (#76 merged into its old base instead and was re-landed as #82).

## Last completed
- **Reconciliation step 1, BPI PDF import (2026-10-12)**, PR → `staging`:
  - `src/lib/parsers/bpiPdf.ts`, same `ParsedBpiStatement` as `bpiXlsx.ts` (plus an optional
    `openingBalanceCents`). Two parts: pdfjs extraction (`extractPdfTextItems`), then pure
    functions (`groupTextLines` → `parseBpiPdfLines`). pdfjs reads text runs column by column,
    so rows are rebuilt from y-coordinates and columns from the header's x-positions; a
    string-only parser would misread rows like a blank DATA MOV followed by a description that
    starts with `27/08 …`.
  - **Balance check:** SALDO ANTERIOR + each line must equal that line's SALDO, ending at SALDO
    ACTUAL CONTABILISTICO. Any mismatch, unknown line, missing balance, date outside `Período` or
    second account section refuses the whole import with the reason shown in the modal.
  - Year from `Período` (Dec → Jan statements and value dates just before the period handled);
    a blank DATA MOV takes the date of the line above, across the page break too.
  - **Ids:** `bpiPdfTxId` = `bpiTxId` + the running balance (handoff §5.8). `bpiTxId` is
    unchanged; a test pins its output.
  - **Import** (`api.bankTransactions.importStatement`, was `importXlsx`): the Accounts page modal
    takes `.pdf` or `.xlsx`. The PDF isn't stored. It refuses if the account already has movements
    from the *other* format in the same dates (the ids never match, so everything would be
    duplicated). The preview shows opening balance, the statement's account number and "Saldos
    verificados". Import records now get `sourceFormat: 'pdf'` and `openingBalanceCents`.
  - **Tests:** vitest added to the finances app (`pnpm --filter finances test`): 28 tests on an
    anonymised fixture (`src/lib/parsers/fixtures/bpiPdfSeptember.ts`: the real layout, made-up
    names, IBANs and amounts). To re-check a real statement locally without committing it:
    `BPI_PDF=~/dev/noisysource/prodata/<file>.pdf pnpm --filter finances test`.
  - **Verified:** the September 2026 statement parses with every balance matching, 36 movements
    (16 credits, 20 debits), both in Node and in Chrome through the pdfjs worker.
- **#82 (re-land of #76, navigation) merged into `staging` (2026-10-11).**
- **#75 merged into `staging` (2026-10-11):** CI/hosting fixes (`build:staging` for the dev job,
  `no-cache` headers), commission cost model (`costModel: 'fixed' | 'commission'`), green-receipt
  contracts, Payroll scoped to the entity, `/noisyphocus/costs` page writing
  `finances_entities/noisyphocus/costSummary/{yyyy-mm}`. Details in PR #75. Deliberately not in
  it: the `costSummary` read rule for KidClub and any KidClub code (see Next step 5).
- Reconciliation handoff written and agreed with Renato (2026-10-11).

## Next step
1. **Review and merge the step 1 PR** (`agent/finhub-kidclub-reconciliation` → `staging`). Its
   automatic dev deploy covers KidClub only. To click through FinHub on dev: merge into `staging`,
   then run `deploy-finances.yml` (workflow_dispatch, ref `staging`; it only deploys dev from
   `staging`). Or run it locally first with `pnpm dev:finances` (dev project). Try: upload a
   statement to the NoisyPhocus BPI account, re-upload it (expect all duplicates ignored), and try
   a non-BPI PDF (expect a refusal with the reason). Note that importing the real September PDF
   on dev stores real payer names in the dev Firestore; Renato's call whether that's OK.
2. **Before the first prod PDF import:** check whether the NoisyPhocus BPI account already has
   XLSX-imported movements (`.claude/skills/prod-data-check`). The import now refuses an overlap,
   but if old XLSX data exists Renato has to decide whether to delete it or keep using XLSX for
   those months. Once the pipeline branch above is merged, FinHub deploys to prod with the
   `staging` → `main` PR.
3. **KidClub reconciliation, step 2** (read-only matching, Sem fatura flag, monthly check page),
   per `HANDOFF-kidclub-reconciliation.md` §4 and §6. New `agent/` branch off `staging` after the
   step 1 PR merges. It reads Vendus documents: run the sandbox-first and metered-API checklists.
4. **Clean up worktrees:** `finhub-cost-model` (#75 merged) and `finhub-nav` (#82 merged)
   (`.claude/skills/worktree-cleanup`); this one after the step 1 PR merges, unless step 2
   continues in it.
4. **Still to do on dev, from the cost-model work:** enter NoisyPhocus's real numbers (the driver
   as an employee contract, the teacher as a green receipt, Vendus fixed and EasyPay commission as
   recurring expenses), then check `/noisyphocus/costs` for the current month.
5. **Later, a separate KidClub-scoped task:** rebuild `financialEvents` and make Resumo
   Financeiro read `costSummary`, against the new event-sourced billing. Add the `costSummary`
   read rule and a Cross-App Data Contracts entry in root CLAUDE.md in that same PR.
6. Separately: the VAT amount bug (Open questions below), then Phase 7 (IRC estimation).

## Open questions for Renato
- **Found 2026-10-12, not fixed (existing behaviour, XLSX too):** every statement import sets the
  account's `balanceCents` / `balanceAsOf` to that statement's closing balance, even when the
  statement is older than the current `balanceAsOf`. Importing August after September would put
  August's balance back. Fix: only update when `dateTo ≥ balanceAsOf`. Small; worth doing in step 2.
- The PDF preview shows the statement's account number, but the import doesn't check it against
  the account picked. Eyeball it before clicking Importar.
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
- **Step 1 PR open** (`agent/finhub-kidclub-reconciliation` → `staging`). Its automatic deploy
  runs `deploy-dev.yml` against the shared `kidclub-dev`; it changes no KidClub code, rules or
  functions.
- **`kidclub-dev-finhub.web.app` may still serve the hand-deployed `agent/finhub-nav` @ a855d6c**
  (2026-10-05) if `deploy-finances.yml` hasn't been run on `staging` since #82 merged.
- The real BPI statement used for the reconciliation design is in the main checkout's
  gitignored `prodata/`. Never copy it into a worktree or commit it.
- A PR into `main` only deploys to prod when its head is `staging`. Feature branches go to
  `staging` first.
- No new metered API calls yet (step 1 is browser-only parsing + Firestore). Reconciliation steps
  2 and 4 will add Vendus and EasyPay reads (checklists in the handoff §5).
