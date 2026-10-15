# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-15

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
2026-07-31.** **#88 (merged 2026-10-12) deploys FinHub with KidClub**: a PR into `staging` → dev,
the `staging` → `main` PR → prod, no manual runs; its dev half ran green on 2026-10-12, the prod
half first runs on the next `staging` → `main` PR. **No real FinHub data exists yet** (Q1
answered): the release waits for `HANDOFF-finhub-data.md`.

## VAT convention for both apps (decided 2026-10-11)
`packages/shared/HANDOFF-vat-convention.md`. **PR 1 (shared helper + FinHub) is #87, merged into
`staging` 2026-10-12.** Renato re-enters all recurring entries afterwards (no migration;
`RELEASE-TEST-PLAN.md` §6 V1). PR 2 (KidClub) not started. The reconciliation and email work
below must follow the same rule: bank-transaction amounts are VAT-inclusive, with a VAT code from
`packages/shared/lib/vat.ts`.

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
**Real data for FinHub (2026-10-15): branch `agent/finhub-real-data`, worktree
`.claude/worktrees/finhub-real-data`.** Follows `HANDOFF-finhub-data.md` (same folder), changed by
Renato's decisions of 2026-10-15:
- **The documents in `prodata/` are the blueprint**: payslips, bank statements, Renato's answers.
  Dev's draft data, `scripts/seed-finhub.js` and `createInitialSetup()` are **not** sources.
  Evidence and the source of every value: `prodata/finhub-seed-sources.md` (local only).
- **History starts 2026-01-01.** Every change seen in the documents becomes a dated version
  (employment contract, income source, EC contract) in force from its month onwards; earlier
  months keep the earlier values.
- **Added to the importer PR (Renato's OK):** FinHub honours start/end dates everywhere. Today
  the Payroll page and Custos do mês count every active contract in every month, income sources
  have no end date, and Dashboard/Previsão use only the first active EC contract. Real payslips
  are seeded as `payrollRuns`. `scripts/seed-finhub.js` deleted (2768d0c: real values in code,
  could write to prod).
- **Not in this PR:** a per-month EC timesheet ("Folha de horas", redesign step 3). Until then the
  EC contract counts down its contracted days with the existing days-off calendar.

Progress:
- **Step 1, prod billing → dev:** `scripts/copy-prod-billing-to-dev.mjs` committed (02683d7),
  tested offline only. **Blocked on Renato:** his gcloud login expired (`gcloud auth login`), and
  the session's prod-read entry in `.claude/settings.local.json` isn't added yet. Next: `--inspect`
  on prod → agree the pseudonymised field list → dry run → his OK → `--write`.
- **Step 2, seed draft:** evidence gathered from the payslips and statements. Waiting on
  documents (NoisySource payslips for Jan and Mar 2026, Marisa's ASFD payslips) and answers.
- **Step 3, importer + date fixes:** not started.

#87 (VAT) and #88 (FinHub in the deploy pipeline) are merged into `staging`.

Lesson kept from #76 (2026-10-11): after merging the base of a stacked PR, retarget the stacked PR
to `staging` *before* merging it (#76 merged into its old base instead and was re-landed as #82).

## Last completed
- **VAT convention PR 1, #87 (2026-10-12)**, → `staging`, not merged:
  - `packages/shared/lib/vat.ts`: codes `23 | 13 | 6 | 0 | isento | autoliquidacao |
    por_confirmar` (percent integers, cents), `splitGross`, `grossFromNet`, labels,
    `formatVatBreakdown`. `por_confirmar` returns null, never 0. Byte-identical mirror in
    `functions/src/lib/vat.ts`; `functions/src/lib/vat.test.ts` fails if they drift.
  - `RecurringEntryDoc.vatCode` replaces `ivaRatePct` (kept only as a hint). With a code the
    amount includes VAT; without one it's "IVA por confirmar". Always read it through
    `recurringVatCode()`: none for transfers and pay synced from contracts (`emp:`/`inc:`),
    `isento` for synced EC income and insurance.
  - Form: VAT code picker (default Por confirmar), com IVA / sem IVA switch next to the amount
    (converted on save), preview of what gets saved; "% sem IVA" for commissions. List: badge,
    breakdown under each amount, banner counting entries to confirm. Nothing for Casa.
  - IVA page (`recurringVatInMonths`, was `recurringIvaInQuarter`): VAT split out of the amount
    per month; "IVA por confirmar — fora dos totais" section.
  - Custos do mês: com/sem IVA columns, no extra VAT line. `costSummary` docs gain
    `softwareNetCents`, `totalNetCents`, `unconfirmedVatCount`, per-line `netCents`/`vatCode`;
    **`totalCostCents` is now the com IVA total** (before: payroll + costs + VAT on top). KidClub
    doesn't read it yet. Also fixed: a NoisyPhocus contract's pay was counted twice (contract +
    its synced "Encargos Salariais" recurring entry).
  - Commission: fee = volume × % (before VAT) + VAT at the entry's code. Forecast: commission =
    % × that month's KidClub revenue (`kidclubVolumeByMonth`), estimate when no KidClub bills;
    EC cash-in = invoice with VAT at `ecContractVatCode()`. EC is `isento` (Renato,
    2026-10-12), so EC cash-in is unchanged; EC contracts now save `vatCode: 'isento'`.
  - Tests: finances vitest now resolves `@shared`; 17 new tests (`src/lib/recurringVat.test.ts`).
    tsc: finances 20 errors = `staging` baseline. Deployed by hand to dev hosting; smoke-tested
    Recorrentes (form both ways), IVA, Custos do mês, Previsão.
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
1. **Real data, then release:** `HANDOFF-finhub-data.md` steps 1–5. The release
   (`staging` → `main`) waits until Renato has checked FinHub on dev with real data. Also
   **confirm EasyPay's % is before VAT** from one real EasyPay fee invoice (VAT handoff Q3).
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
6. Then Phase 7 (IRC estimation).

## Open questions for Renato
- **Real data (2026-10-15), still open** (values in `prodata/finhub-seed-sources.md`). Answered:
  employer SS 23.75% for everyone; Exquisite Talent from 1 Jan, separate childcare card; the EC
  contract's total days and past days off. Open:
  - **Social Security, Feb–May payroll:** the monthly TSU charge on the NoisySource statement
    equals only the employees' 11%; the company's 23.75% isn't there (Dec, Jan, Jul, Aug match the
    full 34.75% exactly). June's TSU charge isn't in the statements at all. Exemption, or paid
    another way? Decides what the seeded payroll runs record as employer SS.
  - **EC days:** one July day off is missing from Renato's list (Malt paid one day less than the
    list implies). April and May match once the client's public holidays are counted; do the
    upcoming client holidays (Nov, Christmas week) go in the days-off calendar too? That's what
    makes FinHub's end date match Malt's estimate.
  - **Marisa's ASFD pay before July:** only July's payslip exists; it carries a June retroactive,
    so the terms may have changed in June.
- **Found 2026-10-12, not fixed (existing behaviour, XLSX too):** every statement import sets the
  account's `balanceCents` / `balanceAsOf` to that statement's closing balance, even when the
  statement is older than the current `balanceAsOf`. Importing August after September would put
  August's balance back. Fix: only update when `dateTo ≥ balanceAsOf`. Small; worth doing in step 2.
- The PDF preview shows the statement's account number, but the import doesn't check it against
  the account picked. Eyeball it before clicking Importar.
- **Decided 2026-10-09 (VAT):** Renato wants every cost shown **with VAT and without VAT**, side
  by side, ideally on one summary page (fold into "Resumo do mês", redesign step 5). Amounts are
  typed as they appear on the invoice, **VAT included**.
- **EasyPay commission (#87 assumes before VAT):** confirm from one real EasyPay fee invoice. If
  the % already includes VAT, change `recurringMonthlyAmountCents` in
  `packages/shared/models/RecurringEntry.ts` (one line) and its test.
- The recurring-amount VAT bug (found 2026-10-09) and the forecast ignoring the commission %
  are fixed by #87. EC contracts: no PT VAT, `isento` (Renato, 2026-10-12).
- `softwareCostCents` counts **every** active NoisyPhocus recurring expense as software, because
  the form doesn't expose `categoryId`. Fine while the only entries are Vendus and EasyPay; it
  needs a category filter if rent or insurance ever get entered as recurring.

## Anything risky in flight
- **`scripts/copy-prod-billing-to-dev.mjs` reads prod** (branch `agent/finhub-real-data`, not
  merged). Run it only with the session's opt-in entry in `.claude/settings.local.json`, and
  remove that entry once step 1 is done. It writes only to `kidclub-dev`.
- **The next `staging` → `main` PR deploys FinHub to prod too** (#88), not just KidClub. Its
  prod half hasn't run yet.
- **`prodata/` holds real personal and financial data** (statements, the dev export, the data
  review, soon the seed). It's in `.gitignore`. Never copy it into a worktree or commit it.
- **Branch protection on `main` isn't enforced** (private repo, GitHub Free; root CLAUDE.md).
  Check a deploy is green before merging.
- **Local Firebase CLI login expired** (2026-10-12). That deploy used your gcloud session:
  `GOOGLE_CLOUD_QUOTA_PROJECT=kidclub-dev firebase deploy --only hosting:finances
  --project=kidclub-dev --token "$(gcloud auth print-access-token)"` (the quota variable is
  needed with a user token). `firebase login --reauth` fixes the plain command.
- The real BPI statement used for the reconciliation design is in the main checkout's
  gitignored `prodata/`. Never copy it into a worktree or commit it.
- A PR into `main` only deploys to prod when its head is `staging`. Feature branches go to
  `staging` first.
- No new metered API calls yet (step 1 is browser-only parsing + Firestore). Reconciliation steps
  2 and 4 will add Vendus and EasyPay reads (checklists in the handoff §5).
