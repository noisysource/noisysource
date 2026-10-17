# HANDOFF — FinHub redesign after the real-data import (Recorrentes, Despesas, Equipa, Movimentos, IVA)

> Written 2026-10-18 from Renato's review of FinHub on dev with real data (PR #94,
> `agent/finhub-real-data`). Decided: **redesign first, then the release** (`staging` → `main`).
> All of it lands in #94, one step at a time; Renato tests each step on dev in the browser.
> No real values in this file or in tests (they live in `prodata/`, main checkout only).

## What Renato wants (his words, condensed)
- **Recorrentes** should be the aggregator of every recurring flow: loans, insurances, schools,
  salaries, subscriptions. Grouped and expandable (Créditos, Seguros, Educação, …), showing which
  account or card the money comes from. "Encargos salariais" expandable into its composition.
- A place to **consult monthly expenses** with their details (every entity, not only NoisyPhocus).
- A place with **running balances**, where the recurring expenses are seen actually being charged,
  ad hoc expenses can be added, and statement lines confirmed / reconciled.
- **Contratos / Salários**: a list where each entry expands to its details, a button to create a
  new one (not a form always open), grouping instead of filters on top; Salários must show the
  payslips already processed.
- **IVA** should come from the actual expenses so far, not a fixed table.
- Custos do mês: months in calendar order (January first) with a year filter, the detail inside
  each month, expandable.

## Decisions (2026-10-18)
- Order 1 → 5 below. Each step: commits in #94, push (dev deploys), Renato tests.
- Recorrentes groups **by category by default**, with a switch to group **by account**. Derived
  items: salaries/charges → "Pessoal", salary credits → "Salários", voucher credits → "Vales",
  insurances → "Seguros", loans → "Créditos", EC income → "Prestação de serviços" (the seeded
  category names, so hand-entered entries with those categories land in the same group).
- Despesas do mês shows **expected** costs only, until Movimentos exists; then actual figures
  replace expected ones for past months.
- Movimentos matching: **suggestions only, confirmed by a click** (no auto-confirm in v1), as in
  `HANDOFF-email-expenses.md` §4. Renato can still change this before step 4.
- Obras e Montagens is an insurance with no recurring entry: `InsuranceDoc.recurring = false`
  (switch "Prémio recorrente", done 2026-10-18).

## Steps
1. **Recorrentes as the aggregator** (per entity, `/:entity/recurring`). **DONE 2026-10-18**
   (`src/lib/recurringItems.ts` + tests; RELEASE-TEST-PLAN §6 R1).
   - Items: every recurring entry (hand-entered and synced `emp:` / `inc:` / `ec:` / `insurance:`)
     plus **credit instalments** computed from `creditContracts` (`buildAmortizationSchedule`), which
     today appear nowhere in Recorrentes.
   - Totals count only items **in force this month**, as a monthly equivalent (quarterly ÷ 3,
     annual ÷ 12, once = 0). Ended / future / inactive items sit in a collapsed history.
   - Each row: amount, how often, the account or card it's paid from (to, for transfers), the VAT
     badge/line for companies. Expandable: salary charges → gross, employer SS, each benefit, cost;
     credit → capital, interest, outstanding, end; insurance → insurer, policy, renewal; EC →
     client, rate.
   - Derived items are read-only with a link to their page; hand-entered ones keep Editar/Apagar.
   - Pure builder (`src/lib/recurringItems.ts`) + tests; the page only renders.
2. **Despesas do mês, every entity.** Year filter; January → December; each month expandable by
   group with its lines (same grouping as Recorrentes). Past months use the confirmed payroll runs
   for salaries, future months the contracts. NoisyPhocus keeps writing `costSummary/{yyyy-mm}`
   (KidClub's future Resumo Financeiro reads it; CLAUDE.md Cross-App Data Contracts).
3. **Equipa** (Contratos + Salários, per company). People list; each person expands to their
   contract versions (em vigor / terminado, dates) and their payroll history (confirmed runs per
   month, each expandable). "Novo contrato" opens the form in a modal; "Processar mês" opens the
   preview + confirm (one run per company-person-month, `payrollRunId`).
4. **Movimentos** (per account, under Dinheiro). Statement lines with the running balance; each
   line matched to an expected Recorrentes item of that month (suggested by amount, date window,
   description; confirmed by a click) or classified ad hoc (category, VAT code); expected items with
   no line after their date are flagged "em falta"; "+ despesa" for spending not on a statement.
   **Fix first** the double counting in `HANDOFF-email-expenses.md` §3.1 (AccountsPage adds every
   confirmed event to a balance that statement imports already set). This is the generic base that
   `HANDOFF-kidclub-reconciliation.md` (Vendus/EasyPay credits) and the emails → expenses work plug
   into later; don't build their specific matching here.
5. **IVA from Movimentos.** Past months: VAT from classified/matched lines (VAT code from the
   recurring item or the ad hoc classification, never a silent 0); future months: the current
   estimate from Recorrentes.

## Traps
- **Versions:** contracts, income sources and EC contracts have consecutive dated versions. Anything
  that sums them must use `contractInForce` / `incomeSourceInForce` / `ecContractInForce`
  (`packages/shared`), never `active` alone. (Rendimento and Recorrentes summed both versions.)
- **`api.setEntity` is one global** that syncs and loaders flip; set it right before each call or
  pass the entity explicitly.
- **Dev deploy race:** every PR into `staging` deploys its own build to dev; another open PR can put
  an older FinHub on dev (STATUS "Anything risky").
- The forecast shows people by first name only (`generateEmploymentEvents`), by design.

## Open
- NoisyPhocus insurances: Renato is collecting the insurance documents (whether NoisyPhocus has
  policies, or some NoisySource-paid ones are NoisyPhocus's / the van's).
- Hand-entered data still missing on dev: card and Revolut balances, the van's loan data, Colégio
  São José, Vendus/EasyPay (category Software), the insurances marked "PRECISA DE MAIS DADOS",
  Marisa's ASFD salary before June.
