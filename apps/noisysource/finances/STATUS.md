# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-11-05 (Plano and Ano built: forecast first)

## FinHub v2 — forecast first (2026-11-05)

Renato changed the order on 2026-11-04: blueprints first, then a year generated and confirmed by
him, and only then the bank, as a monthly check. See HANDOFF-finhub-v2.md § "Order change", which
also has his answers. **The night-2 click-through below (Aceitação, Mês, April) is no longer asked
of him.**

**Open on dev:** https://kidclub-dev-finhub.web.app/v2/noisysource/plano (first two sidebar items:
**Plano**, **Ano**). Same PR **#125** into `staging`.

**Built:**
- **Plano**: every blueprint with all its values, its origin, "Confirmar", and a form to add or
  change it. A new contract's form shows what it will generate before saving.
- **Ano**: one row per blueprint, one column per month, through December of next year, with the
  month-end balance. Click a value for how it was calculated.
- **Money between companies**: new blueprint, moved by the bank lines naming the company.
- **Confirmations**: per blueprint, tied to the version seen; a later version goes back to "por
  confirmar".

**Next step, Renato's:** in Plano, in this order:
1. **Dinheiro entre empresas → "Criar a partir das linhas"** for NoisyPhocus. Is there a balance from
   before 2026? The statements only start in 2026, so the form opens at 0, "por confirmar".
2. **Créditos → Empréstimo BPI → Alterar.** The loan's principal and rate came from the seed and don't
   match the 2026 statements, which show a larger amount drawn in March and interest on actual days /
   360. With the statements' values, May–September match the bank to the cent (checked locally, not
   on dev). April doesn't: it's the first period, and it doesn't change the forecast. No amounts here:
   derive them from the statements, or see `prodata/`.
3. **Calendário:** the client's 2027 calendar is almost empty. A new contract running through 2027
   needs the Commission's list, or it counts those days as worked.
4. Go through the rest, then **Ano**, and confirm what's right. Night 1's and night 2's "A confirmar"
   below now belong to the blueprint they affect.

**Open questions for Renato:**
- Are the other 2026 transfers money to be returned (two with other companies or people in May, and
  those with the two partners in January–February)? If so, each gets a "Nova empresa" entry.
- Will NoisySource lend NoisyPhocus more? Only repayments can be planned today, not new lending.
- Tolls and Tesla charging have no bank lines since August but are still forecast. End them?
- Renato's childcare voucher is forecast above April's payslip value. A raise, or a wrong term? Not
  checked.

**Self-check:** domain + form tests pass with made-up values (blueprints: 22 new). On the real events,
locally and written nowhere: the year's month-ends add up, and a made-up new contract at another rate
generated its months and removed the "no income" warning. Not clicked through on dev: Renato tests
the screens.

**Risky / left in flight:**
- `gcloud` needs `gcloud auth login`, so the importer can't run against dev until then. Plano's forms
  don't need it.
- Any push to `staging` takes v2 off dev until #125 deploys again: merge `origin/staging` into the
  branch and push, **not** `gh run rerun` (a re-run reuses its old merge commit and would put older
  KidClub, functions and rules back on dev).
- `scripts/finhub-v2/` not changed since night 2, still flagged for review.
- Next build: step C (Importar extrato, Folha de horas, Recibo, compare with the confirmed forecast).

## FinHub v2 — night 2 morning report (2026-10-29)

**Open on dev:** https://kidclub-dev-finhub.web.app/v2/noisysource → new sidebar items **Mês**,
**Aceitação 2026**, **Diário**. Same PR **#125** → `staging` (more commits, no new PR). Dev deploy:
see "Deploy" below.

**What's new**
- **Matching** (`packages/shared/finhub/noisysource/reconcile.ts`): every bank line gets a
  suggestion, computed on load and never stored: SS lines by the month they name; the client's and
  workers' names; the words of a payment rule or cost plan; the same IBAN as a hinted line; then the
  same amount (oldest open item first; direct debits to their own month); one payment for several
  items (voucher cards incl. the provider's fee, the accountant's lump payments); several lines for
  one item (a salary paid in two, an insurance in two debits); costs that vary (tolls, charging,
  phone) as an amount difference; and what's left gets an ad hoc category from keywords (travel,
  credit card, State, insurance payouts…). Once you confirm lines, lines with the same description
  follow your choice.
- **Mês** (`/v2/noisysource/mes/2026-03`): the month's checklist (timesheet, invoice, payslips,
  SS and IRS paid), planned vs real, and **real − planned split into named buckets** (ad hoc lines,
  amount differences, paid in another month, planned items without a line with/without a reason,
  lines not explained). Every bank line: **Confirmar** a suggestion, **Ligar a…** a planned item
  by hand, **Ocasional…** with a category, **Desfazer**. Every planned item without a line: write
  the reason. Buttons confirm all exact matches / all suggested categories of the month at once.
- **Aceitação 2026**: § Acceptance 1–5 per month + the EC contract chain; click a month for why.
- **Diário**: every event newest first, filter by type, who (app/importer), month, text; reversed
  events struck through; click a row for the full payload.
- Every click is an event (`bank.movement.matched`, `bank.movement.classified`,
  `plan.item.explained`); undo is a `reversal`. Nothing is overwritten.
- **Voucher provider's fee** is now in the plan (a confirmar #8 below): the voucher payments are
  the cards + 4.5% + 23% VAT on the fee, **to the cent on every 2026 payment**. Put on the voucher
  payment rule; vouchers are now one planned item per card.
- **The importer now writes corrections**: when an input changes, it reverses the version in force
  and adds a `-r2` (it never overwrites, and never replaces a version recorded in the app). Tonight
  it wrote exactly one: the voucher rule with the fee (`rev-rule-vales-2026-01-01` +
  `rule-vales-2026-01-01-r2`, visible in Diário). Dev now holds 414 events; a second run writes 0.

**Acceptance per month** (with the suggestions; nothing is confirmed yet, that's your click):

| Month | 1 lines | 2 planned | 4 payslips | 5 EC days | What's left |
|---|---|---|---|---|---|
| Jan | 31/31 suggested | 1 without line | 3/3 | 20 = 20 | Edenred fee debit absent this month |
| Feb | 31/31 | 1 | 2/3 | 20 = 20 | same; Renato's IRS rate; his transfer ≠ payslip net (shown as a difference) |
| Mar | 49/50 | 1 | 2/3 | 18+4 = 18+4 | an occupational-health payment; Feb's IRS paid with another amount |
| **Apr** | 50/50 | all | 3/3 | 19 = 19 | **passes once you confirm** |
| May | 34/35 | all | 3/3 | 17 = 17 | one vehicle-contract payment with no description |
| Jun | 36/36 | 1 | 2/3 | 19 = 19 | May's IRS paid with another amount; per diem line |
| Jul | 40/40 | 2 | 2/3 | 21 = 21 | June's IRS; Renato's meal card top-up for July |
| Aug | 35/36 | 4 | 2/3 | 11 = 11 | an equipment-rental direct debit; Edenred fee, tolls, charging, Via Verde planned, none (car change?) |
| Sep | 26/26 | 3 | 2/3 | payment in Oct | tolls/charging planned, none; Renato's meal card for September |

So 3 of 335 bank lines have no suggestion, and 13 planned items have no line: those are yours (a
reason, a link by hand, or a plan to change). Criterion 3 passes when every euro of real − planned
sits in a named bucket; amount differences and payments in another month are named, not hidden.
The 6 payslip differences are the same as night 1 and wait for the answers below.

**What to click:**
1. **Aceitação 2026**: the table, then a month (e.g. April, then March).
2. **Mês → abril 2026**: read the suggestions, "Confirmar N correspondências exatas", then
   "Classificar N como sugerido". Those two buttons cover 30 of the 50 lines; the other 20 (costs
   whose amount differs from the plan, or several lines for one item: Tesla, tolls, MEO, loan, Via
   Verde, Edenred, BPI fees) need their own "Confirmar" (filter "Por confirmar"). Then Aceitação
   says April **passa**.
3. **Mês → março 2026**: "Ligar a…" the State payment of 23 Mar to "IRS retido — fev" if that's
   what it is, or write a reason; classify the occupational-health payment.
4. **Diário**: your clicks appear at the top; the voucher-rule correction is there too.
5. Try **Desfazer** on one confirmation: the suggestion comes back, Diário shows the reversal.

**A confirmar** (night 1's list below still open; new ones):
10. The voucher provider's fee (4.5% + 23% VAT on the fee), read from the statements.
11. The State payments that don't equal a month's IRS (Jan ×2, Feb, Mar, Apr, Jun, Jul, Aug): IRS
    plus withholding on suppliers? IRC? IVA? They're classified "Estado (a identificar)" until you
    say; link them to the IRS month by hand where that's what they are.
12. Two vehicle contracts paid monthly Jan–May, then paid off in May: should they be planned costs?
    (Classified as ad hoc "viaturas" for now; they don't affect the months ahead.)
13. Tolls and Tesla charging are planned every month but have no lines since August, and Via Verde
    none in August (a new Via Verde id from September): end or change those cost plans (from when?).
14. Renato's meal card top-ups for July and September have no bank line: paid another way?

**Self-check (no amounts):** 100 tests pass (16 new: matching, fee, buckets add up to real −
planned, confirmations and undo, acceptance, import corrections), 1 skipped (real-PDF test).
finances `tsc`: 22 = `staging` baseline. ESLint `src/v2`: clean. `build:staging`: OK. The five v2
pages and Mês for Mar/Sep/Dec server-rendered locally with the real events: no errors, no NaN; on
every month the buckets add up to real − planned to the cent. EC chain: both PASS. Rules unchanged
since night 1 (no rules test re-run).

**Deploy:** **green** (Deploy to Dev, 2026-10-29 16:25 UTC: FinHub hosting + rules + indexes). Checked
live afterwards: dev's ruleset holds the `finhub/{company}/events` block **and** `domotics_energy` /
`domotics_climate` (the Pi's history; the comfort experiment runs 29–31/10); the hosted bundle has
the new screens and the dev Firebase config. No other open PR touches rules or FinHub (checked
before pushing).

**Risky / left in flight:**
- Merged `origin/staging` into the branch (59 commits: domotics #118–#124, docs). The "carry
  #124's rules — DROP BEFORE MERGE" commit is now a no-op: `git diff origin/staging...HEAD --
  firestore.rules` shows only the v2 block. Left in history (branch is pushed).
- Any push to `staging` (any merge) removes v2 from dev until #125 deploys again. Restore it by
  merging `origin/staging` into the branch and pushing, **not** `gh run rerun`: a re-run reuses its
  old merge commit and would also put an older KidClub, functions and rules back on dev.
- `scripts/finhub-v2/` changed (import corrections, full read of dev's events): flagged for your
  review, like night 1's scripts.
- Night 3 (HANDOFF § Steps): forms (Folha de horas, Recibo, Calendário, Importar extrato) + Equipa,
  and whatever your answers change (they go through the importer as corrections).

## FinHub v2 — night 1 morning report (2026-10-29)

**Open on dev:** https://kidclub-dev-finhub.web.app/v2/noisysource (or the "FinHub v2 · NoisySource"
link at the top of the old sidebar). PR **#125** → `staging`. Dev deploy: **green** (2026-10-29 10:35 UTC run: Firestore rules + FinHub hosting; nothing else deployed). Checked after it: dev's live rules hold the v2 block and still hold #124's domotics blocks; the hosted bundle has both screens and the dev config.

**Built** (branch `agent/finhub-v2-noisysource`, worktree `.claude/worktrees/finhub-v2-noisysource`):
- **Domain** `packages/shared/finhub/`, pure, 39 tests with made-up values: event envelope
  (append-only, reversals), NoisySource event types + zod, holiday calendars (`pt`, `pt-coimbra`
  computed incl. Easter-based ones and 4 July; client and company calendars from events), days
  engine (EC days, meal days, per diems, leave), EC runway (opening position, timesheets, early
  end, gaps, 3-month warning), payslip estimate + comparison, expected movements, Tesouraria
  projection and past-month checks.
- **Storage:** rules for `finhub/{company}/events/{eventId}` (read/create for FinHub admins, no
  update/delete, honest `recordedBy`/`recordedAt`/`company`/`id`; emulator test 15/15). Event
  store in the app (`src/v2/noisysource/eventStore.ts`: read, append in a transaction, reverse).
- **Scripts (flagged for human review), dev only:** `scripts/finhub-v2/import-noisysource-dev.ts`
  (seed part + the two 2026 Malt contracts + payslip PDFs as recorded facts + BPI statements via
  `bpiPdf.ts`; dry run by default; deterministic ids + create-only precondition; refuses any
  project but `kidclub-dev`, checked before any call) and `wipe-noisysource-dev.ts` (only
  `finhub/noisysource/events`). Run: `node scripts/finhub-v2/run.mjs scripts/finhub-v2/<script>.ts [--write]`.
  Their real inputs: `prodata/finhub-v2-noisysource.json` (new, local only: transcribed Malt
  contracts, calendars, per diem values, payment days); shape in `scripts/finhub-v2/noisysource-inputs.example.json`.
- **On dev:** 412 events in `finhub/noisysource/events` (335 bank lines Jan–Sep, 27 payslips,
  15 calendar entries, 14 cost plans, 10 terms versions, 6 payment rules, 3 holiday calendars,
  2 EC contracts). Second run: 0 new (idempotent). `finances_entities` (#94's data) not touched.
- **Screens** under `/v2/noisysource` (own shell; NoisyPhocus/Casa shown as "em breve"):
  **Tesouraria** and **Contratos EC**. ESLint `no-restricted-imports` for `src/v2/**`.

**What to click:**
1. **Tesouraria:** the three cards (real balance from the 30 Sep statement, projected balance,
   lowest point); **Dias de pagamento** (the proposal below, "a confirmar" badges); **Próximos
   movimentos** (90 days / 6 / 12 months; each line says why: days × rate, gross − IRS − SS,
   meal days; October's lines are greyed "sem extrato" until October's statement is imported);
   **Meses passados**: planned vs real month-end for Jan–Sep, click a month for plan vs bank side
   by side (✓ = a bank line with the same amount within ±10 days, a hint only).
2. **Contratos EC:** the two Malt contracts in order, "segue-se diretamente", used/planned/left,
   last day vs Malt's estimate, the **warning is active** (3 months before the current contract's
   last day: prepare the next one), months with "No banco ✓", and the calendars used (client
   holidays, Renato's absences and trips).

**Self-check (no amounts):**
- `pnpm --filter finances test`: 84 passed (39 new shared + 45 existing), 1 skipped (real-PDF test).
  finances `tsc`: 22 errors = `staging` baseline (none new). `build:staging`: OK. ESLint on
  `src/v2`: clean, and a probe confirmed it flags old pages/api/contractSync/other companies.
- EC: the older contract runs out on **2026-03-25** (the day before the next one starts); the
  current one's projected last day = **2027-01-26** (Malt's estimate). Both PASS.
- EC days Jan–Aug: planned = days Malt paid, **9/9 contract-months** (March split 18 + 4).
- Payslips Jan–Sep: **21/27 equal the estimate** (Marisa 9/9, Bernardo 9/9, Renato 3/9). Renato's
  differences by cause: **IRS rate** of the month differs from the terms (Feb); **per diem** line
  isn't a whole number of days at the daily value (Mar, Jun); **meal days** don't follow the
  calendar (Jul: estimate 17, payslip 21; Aug: 8 vs 11; Sep: 19 vs 18).
- Month-end planned vs real: all 9 months differ, as expected for night 1 (card purchases, tolls,
  trips, transfers, the voucher provider's fee, Dec 2025 items paid in Jan): night 2 explains them
  line by line (§ Acceptance 1–3).

**Payment days proposed from the 2026 statements (a confirmar, used in the plan):**
- 20th of M+1: SS (TSU) and IRS withheld (Renato; statements 14–24). 25th: net salaries (Renato).
- 25th (with the salaries): meal card top-up and the Edenred vouchers via EasyPay; if not a
  business day, the business day before.
- Malt: invoice on the month's last day, money +10 days (statements: 4th–10th of M+1).
- 8th: BPI account fee + stamp duty. 9th: MEO. 12th: accountant (paid in lumps, irregular). 15th:
  health insurance, Via Verde, tolls, Tesla charging (estimates). 20th: BPI loan instalment.
- 22nd of July, September, December: IRC payments on account (two equal state payments in Jul
  and Sep 2026, so December inferred).
- Annual insurances on their 2026 debit dates (23 Feb, 2 Mar, 6 Jul, 4 Aug).
- Not planned: the company card's monthly settlement (end of month, variable) and the other
  irregular "Pagamento ao Estado" debits (what they are: open).

**A confirmar (placeholders in the data, marked in the UI):**
1. The payment days above (except salaries 25 and SS/IRS 20).
2. Commission holidays 2026: 2 Jan and 15 May are filed as Commission holidays, not Renato's days
   off (both are on the Commission's usual list; May's payslip pays 15 May as a meal day). Nov–Dec
   and 1 Jan 2027 are inferred from Malt's end-date estimate.
3. Carnaval (17 Feb) as a NoisySource day off: February's payslip has one meal day fewer than the
   calendar (the handoff's trap).
4. Renato's leave: January's payslip shows a full month of parental leave while Malt paid 20 days
   that month. So **leave (`licenca`) is a payroll fact**: it removes salary and meal days, not EC
   days. February's 8 leave days are placed on 1–8 Feb (dates a confirmar).
5. Trip days: counted from the per diem lines (amount ÷ daily value), dates placed on the first
   free working days of the month. Daily values: Renato's (March's and June's lines don't divide
   evenly at it) and Marisa's (one line only) a confirmar; Bernardo's divides every line.
6. Christmas subsidy in **November** (not in the Dec 2025 payslips; 14 payments in a 2025 YTD).
7. 9 July: Renato's day off isn't counted as vacation on July's payslip.
8. The voucher payments carry the provider's fee (about 4.5% + VAT, from the amounts): not in the
   plan yet.
9. The loan instalment's interest is estimated on the outstanding capital per month; the bank's
   differs by a little (it counts actual days).

**Additions to the design** (handoff tables): calendar kind `licenca`; `opening` on EC contracts;
terms carry subsidy months, holiday calendars and the per diem value; cost plans can be a loan;
bank lines carry `seq`. Only the two 2026 Malt contracts were imported (the two older ones, 2024–2025,
aren't needed for 2026).

**Risky / failed / left in flight:**
- **Commit `chore(finances): carry PR #124's domotics rules … DROP BEFORE MERGE`.** kidclub-dev's
  live ruleset is #124's (`domotics_energy`, `domotics_climate`, `domotics_config/tariff`) and the Pi
  writes the energy/climate history there; a PR deploys its whole `firestore.rules` to dev, so
  without that copy this PR would have cut the Pi off. Before merging this PR: drop that commit, or
  merge #118/#124 into `staging` first. Also: a domotics PR's next push redeploys its rules without
  the v2 block, and then Tesouraria on dev says "Missing or insufficient permissions" until this
  PR is pushed again (or the Deploy to Dev workflow re-runs on it).
- No browser check (login can't be done unattended). Both pages were server-rendered locally
  with the real events: no errors, no NaN.
- Night 2 next: **Mês** + matching (suggested, confirmed by a click), the acceptance report per
  month (§ Acceptance 1–5), **Diário**.

## Direction change (2026-10-28): FinHub v2 — read this first
Renato decided to rebuild FinHub as **three modules, one per company** (NoisySource, NoisyPhocus,
Casa) in the same app, with an **append-only event log** as the record. **NoisySource first**,
rebuilt for 2026 and checked against the bank statements (bank balances are the truth). Design,
decisions, Renato's answers: **`HANDOFF-finhub-v2.md`** (same folder), on branch
`agent/finhub-v2-noisysource` (worktree `.claude/worktrees/finhub-v2-noisysource`). Night 1 ran
2026-10-29, night 2 the same day (reports above).

**Paused (Renato, 2026-10-28), everything below this section:** #94 `agent/finhub-real-data`
(open, not merged; its latest state is in *that branch's* STATUS.md, 2026-10-18, newer than this
file; its real data stays on dev), KidClub reconciliation step 2, emails → expenses, the FinHub
release. The old FinHub keeps running as it is until v2's NoisySource module passes.

**Next step:** Renato checks night 2 on dev (Aceitação, Mês, Diário), confirms a month or two and
answers the "a confirmar" lists above; then night 3 of `HANDOFF-finhub-v2.md` (§ Steps) on the
same branch and PR. Timesheets still to come.

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
**Next session: real data for FinHub — read `HANDOFF-finhub-data.md` (same folder).** FinHub has
no real data anywhere yet. Plan (Renato, 2026-10-12): copy KidClub's prod billing into dev
(pseudonymised), build a seed file from the dev draft + Renato's documents and answers, an
importer in Dev Tools, check everything on dev, then release and import on prod. The review of
dev's data (5 conflicts, gaps) is in `prodata/finhub-data-review.md` (local only). #87 (VAT) and
#88 (FinHub in the deploy pipeline) are merged into `staging`.

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
