# HANDOFF — FinHub v2: one module per company, events as the record, NoisySource first

> Written 2026-10-28 from a planning session with Renato. **Design for review, no code yet.**
> Facts about today's code were checked on `staging` and `agent/finhub-real-data` (#94) that day.
> No real values in this file or in tests: they live in `prodata/` (main checkout only).

## Why

- **Derived data is stored as if it were source data.** `src/lib/contractSync.ts` copies each
  employment and EC contract into recurring entries, in NoisySource and in Casa (by flipping the
  global `api.setEntity`). One salary lives in three documents. #87 fixed a double count caused by
  this; #94 had to add `contractInForce` checks everywhere.
- **No history.** Documents are edited in place with only `updatedAt`. Nobody can see who changed
  what, or what FinHub believed on a given day.
- **One UI for three businesses.** 17 pages filtered by entity, menu items shown or hidden per
  entity. Each company's work is buried in the others'.
- **Payroll doesn't follow the calendar.** `packages/shared/lib/payroll.ts` uses 22 meal days
  unless `daysPerMonth` is set, and benefits are fixed per month. Real payslips change every month.

## Decisions (Renato, 2026-10-28)

1. **Three modules, one per company** (NoisySource, NoisyPhocus, Casa), each with its own routes,
   menu and data, **in the same FinHub app and hosting site**. Not micro frontends: building and
   loading modules separately adds work for one developer with one pipeline and brings no benefit.
2. **One Firestore database, one root per company** (`finhub/{company}/…`). Not one database per
   company: the free tier covers one database per project, each extra one needs its own rules and
   indexes, and NoisyPhocus must read KidClub's billing in `(default)`.
3. **Bank balances are the truth.** Every other figure is checked against them.
4. **NoisySource first**, rebuilt for 2026 from the documents and statements. It's done when its
   plan reproduces what the bank shows (§ Acceptance).
5. **All other FinHub work is paused:** #94 (stays open, not merged; its data stays on dev),
   KidClub reconciliation step 2, emails → expenses, the FinHub release. The old FinHub keeps
   running as it is. Its NoisySource pages are removed only after v2 passes.

## How NoisySource works (Renato, 2026-10-28)

- **One income: EC contracts**, billed per day worked. Each contract has a **number, a daily rate
  and a number of days**. Every contract, extension or not, gets a new number, so it is always a
  new contract. Some start right after the previous one, some don't.
- The days budget gives the **last working day**. FinHub warns **3 months** before it, so the next
  contract can be prepared in time.
- **Days worked vary per month**, so income varies.
- **Three workers. Payslips vary month to month**: the meal allowance follows the month's possible
  working days minus vacation, sick and trip days; trips are paid as per diems (a fixed value per
  trip day).
- **What matters most: seeing ahead which money leaves, and when.** E.g. on the 25th salaries and
  voucher top-ups; on the 20th taxes. All of it follows from the days in the month and the
  contracts.

## The model: plans, facts, views

| Kind | Examples | Stored | Changed by |
|---|---|---|---|
| **Plans** | contracts, absences, holiday calendars, payment days, fixed costs | as events | a new event with a later effective date |
| **Facts** | timesheet, invoice, payslip, bank movement, match | as events | a `reversal` event, then a new one |
| **Views** | Tesouraria, Contratos EC, Mês, Diário | **never**; computed on load | n/a |

Nothing derived is ever written. That removes the whole `contractSync` class of bug.

### Event envelope (shared by all three companies)

```ts
interface FinEvent<T extends string, P> {
  id: string;             // deterministic when the source has a natural key (table below)
  company: 'noisysource' | 'noisyphocus' | 'casa';
  type: T;
  effectiveDate: string;  // YYYY-MM-DD: when it is true in the world
  recordedAt: Timestamp;  // server time: when FinHub learned it
  recordedBy: string;     // uid
  source: 'manual' | 'import:seed' | 'import:bpi-pdf' | 'system';
  reverses?: string;      // only on type 'reversal': the id it cancels
  note?: string;
  payload: P;
}
```

- **Corrections**: a `reversal` event naming the wrong one, then a new event with a suffixed id
  (`…-r2`). Readers drop reversed events.
- `effectiveDate` vs `recordedAt` answers both "what happened" and "what did we know on day X"
  (forecast vs actual, and the audit trail).
- Each company defines its own event types on this envelope.

### NoisySource events

| Type | Main payload fields | Id |
|---|---|---|
| **Plans** | | |
| `ec.contract.signed` | number, client, personId, dailyRateCents, totalDays, startDate, holiday calendar id, daysToPayment, vatCode (`isento`) | `ec-<number>` |
| `ec.contract.ended` | number, lastDay, reason (early end only; the normal end is computed) | `ec-<number>-end` |
| `employment.terms.set` | personId, from, contractType, grossMonthlyCents, irsRatePct, ssEmpPct, ssErPct, meal value per day, per diem per trip day, other benefits (per day or per month, IRS/SS flags, card or account), payDay | `emp-<person>-<from>` |
| `employment.ended` | personId, lastDay | `emp-<person>-end` |
| `calendar.entry.set` | personId, dates, halfDays, kind (`ferias`, `doenca`, `viagem`, `outro`) | generated |
| `holidays.set` | calendar id (`pt`, `client-…`), year, dates | `hol-<calendar>-<year>` |
| `payment.rule.set` | what (net salaries, meal vouchers, SS, IRS withheld, EC invoice…), day, month offset, if not a business day: before/after | `rule-<what>-<from>` |
| `cost.plan.set` | key, description, amountCents (VAT-inclusive), vatCode, frequency, day, from, to, account | `cost-<key>-<from>` |
| **Facts** | | |
| `ec.timesheet.submitted` | contract number, month, days, halfDays | `ts-<number>-<yyyy-mm>` |
| `ec.invoice.issued` | invoice number, contract number, month, amountCents, vatCode, issue date, due date | `inv-<number>` |
| `payroll.payslip.recorded` | personId, month, lines (code, amountCents, days, IRS/SS flags), irsCents, ssEmpCents, ssErCents, netCents, payDate | `ps-<person>-<yyyy-mm>` |
| `bank.movement.imported` | accountId, date, valueDate, amountCents, description, balanceAfterCents, importId | `bpiPdfTxId` (existing) |
| `bank.movement.matched` | movementId, matched to: invoice / payslip / tax / voucher / cost + its ref and month | `m-<movementId>` |
| `bank.movement.classified` | movementId, category, vatCode, description (ad hoc) | `c-<movementId>` |
| `reversal` | (uses `reverses`) | generated |

"Payment received" and "tax paid" are not separate events: they are bank movements matched to an
invoice or a tax obligation. The bank is the record of money; documents are the record of why.

## The days engine (everything depends on it)

`packages/shared/finhub/days.ts`, pure and tested:

- `workingDays(month, { calendar, absences, from?, to? })` → weekdays − holidays − absences, half
  days count 0.5, with the list of dates.
- **Two holiday calendars.** `pt-coimbra`: Portuguese national holidays (Easter-based ones
  computed) plus Coimbra's municipal holiday (4 July). `client-…`: the client's holidays (#94's
  seed lists them for 2026). They rarely differ, but they can.
- **Calendar entries** per worker change the days like this:

  | Kind | EC days | Meal days | Per diem |
  |---|---|---|---|
  | `ferias`, `doenca`, `outro` | − | − | no |
  | `viagem` | counted as worked (check against the 2026 timesheets) | − | days × daily value |

- **EC days** per contract: working days on the client's calendar, minus the entries above. Before
  a timesheet is submitted these are the planned days; afterwards the timesheet replaces them.
- **Meal days** per worker: the month's possible working days on `pt-coimbra`, minus vacation,
  sick and trip days. Driven by the calendar, never by the EC timesheet.
- **Per diem** per worker: trip days in the month × the fixed daily value in their terms.
- **EC runway**: days used (submitted timesheets) + days planned ahead → projected last working
  day, with the warning date 3 months before it. Built on `computeEcProjection`
  (`packages/shared/lib/ecProjection.ts`), which already reproduces the client's end date (#94).
- **Payslip estimate**: `computeMonthlyPayroll` changed to take meal days and per diem days as
  inputs instead of a fixed `daysPerMonth` / 22. A recorded payslip replaces the estimate.

## Expected movements (what Tesouraria shows ahead)

Each item carries its inputs so the screen can explain the number ("21 dias × taxa, contrato N").

- **EC invoice** for month M: days(M) × rate; days from the timesheet if submitted, else planned.
  Issue date per rule; cash in at issue + `daysToPayment`.
- **Net salary** per worker for M on the pay day (25), per diems included. Check on the 2026
  payslips whether a trip after the 25th is paid in M or M+1.
- **Meal voucher top-up** per worker: meal days × daily value, on the voucher rule's day.
- **SS** (employee + employer) and **IRS withheld** for M: day 20 of M+1.
- **Fixed costs**: from the cost plans.
- Days that fall on a weekend or holiday move per the rule (before or after).
- **No EC income after a contract's last day** until the next contract is signed: the gap shows
  in Tesouraria as it is.
- **Other payment days** (meal voucher top-up, IRC, accountant, insurance…): the agent proposes
  the list from the 2026 statements in step 1; Renato confirms (Renato, 2026-10-28).

## Screens (NoisySource module, labels in Portuguese)

1. **Tesouraria** (home): the next 90 days by default (up to 12 months), day by day, every expected
   movement with the projected balance from the last real balance (latest imported statement).
   Past days: planned vs real side by side, missing items flagged.
2. **Contratos EC**: every contract by client in date order, gaps between them shown: number,
   rate, days total / used / planned / left, projected last day, and the warning 3 months before
   it.
3. **Mês**: a monthly checklist (folha de horas submetida, fatura emitida, recibos registados, SS
   e IRS pagos, every bank line matched) and planned vs actual totals.
4. **Equipa**: per worker, terms history and payslips (estimate vs recorded).
5. **Diário**: every event, newest first, filterable, with who, when and reversals. This is the
   audit screen.

Forms: Folha de horas (pre-filled with the planned days), Recibo de vencimento (pre-filled from the
estimate, per diems included), Novo contrato EC, Calendário (férias, doença, viagens), Importar
extrato (reuses `src/lib/parsers/bpiPdf.ts` and its balance check).

## Storage and rules

- `finhub/noisysource/events/{eventId}`; later `finhub/noisyphocus/…`, `finhub/casa/…`.
- **A new root on purpose.** `finances_entities/{entityId}/{collection}/{docId}` has a wildcard
  that allows writes, and rules are OR, so append-only can't live under it. `finances_events` is
  taken by the old forecast entries.
- Rules (sketch):
  ```
  match /finhub/{company}/events/{eventId} {
    allow read: if isFinhubAdmin();
    allow create: if isFinhubAdmin()
      && request.resource.data.company == company
      && request.resource.data.recordedBy == request.auth.uid
      && request.resource.data.recordedAt == request.time;
    allow update, delete: if false;
  }
  ```
  Writing an existing id counts as an update and is denied, so a re-import with deterministic ids
  can't duplicate or overwrite anything. The importer checks for existing ids and skips them.
- **Wiping dev** needs an Admin SDK script (rules deny delete) that refuses any project other than
  `kidclub-dev`.
- **Volume**: NoisySource ≈ 100 events a month (mostly bank lines), ≈ 1,200 a year. The module reads
  them all once per load and computes in the browser. No snapshots or projection functions until a
  year holds several thousand.
- Domain logic stays in `packages/shared` as pure functions, like FinHub today, so it can move into
  `functions/` later without a rewrite.

## Code layout

- `packages/shared/finhub/`: envelope, `days.ts`, `noisysource/events.ts` (types + zod),
  `noisysource/plan.ts` (expected movements), `noisysource/state.ts` (rebuilds current state from
  the events), tests.
- `apps/noisysource/finances/src/v2/shell/` (layout, company picker) and `src/v2/noisysource/`
  (pages, forms, event store). Route `/v2/noisysource/…`; old routes untouched; a link from the
  old sidebar.
- ESLint `no-restricted-imports`: `src/v2/**` must not import `src/pages`, `src/lib/api`,
  `src/lib/contractSync` or another company's module. Allowed reuse: `@shared/lib/{payroll, irs,
  vat, ecProjection, money}` and `src/lib/parsers/bpiPdf`.

## Acceptance: rebuild 2026

**Inputs** (local, `prodata/`, never committed): the NoisySource part of `finhub-seed.json` (#94:
contract versions, January–September payslips, the EC contract with the client's holidays,
recurring costs) and NoisySource's BPI statements January–September (October once available). The
seed holds the EC contract as two versions; v2 needs them as numbered contracts (Renato has the
numbers). 2026 calendar entries: vacation is in the seed's EC days off; trip days can be read back
from the payslips' per diem lines (amount ÷ daily value), with the dates confirmed by Renato.

**Importer** (dev only, refuses any project other than `kidclub-dev`): seed → plan and payslip
events; statements → movement events through `bpiPdf.ts`.

Imported bank lines make the month-end balances true by construction. **The test is whether the
plan predicts the bank.** For each month January–September 2026:

1. Every bank line is matched to a planned item or classified as ad hoc.
2. Every planned item in the month has its bank line, or a written reason.
3. Planned month-end balance (previous real balance + planned items) − real month-end balance =
   the sum of the ad hoc lines. Nothing unexplained.
4. Each payslip equals the plan's estimate (meal days and per diems from the calendar); any
   difference is shown and explained.
5. EC: the contract chain's projected last days match the client's; each invoice = timesheet days
   × rate.

Then Renato compares Tesouraria with the old FinHub's Previsão for the coming months.

## Steps: one night run each (Renato, 2026-10-28)

Agents build overnight; Renato checks on dev in the morning. So every night ends with screens he
can click on dev, not only tests. Each night: a branch off `staging`, a PR into `staging`.

| Night | Builds | Morning check on dev |
|---|---|---|
| 1 | Domain (envelope, events + zod, both calendars, days engine, payslip estimate, expected movements, state rebuild, tests) · storage (rules, event store, dev-only importer + wipe script) · 2026 imported on dev · **Tesouraria** · **Contratos EC** | Tesouraria: the next 90 days, and for past months the planned vs real month-end balance; the EC contracts, last days and 3-month warning; the proposed payment days |
| 2 | **Mês** + matching (suggested, confirmed by a click) · the acceptance report per month (§ Acceptance 1–5) · **Diário** | the report: which months pass, what's unexplained |
| 3 | Forms (Folha de horas, Recibo, Calendário, Importar extrato) · **Equipa** · fixes from Renato's notes | enter one month by hand, end to end |
| 4 | Acceptance with Renato, then remove the old NoisySource pages | |

Then choose the next company (NoisyPhocus or Casa).

**Before night 1 (Renato):** the 2026 EC contracts with their numbers (number, rate, days, start
for each) in `prodata/` (local only). Without them the agent uses `EC-1`, `EC-2` marked "a
confirmar". 2026 trip days: the agent derives the count per month from the per diem lines (amount ÷
daily value) and marks the dates "a confirmar"; the count is enough for meal days and per diems.

### Night run rules

- **Runs on Renato's Mac**, not in the cloud: the 2026 inputs are in `prodata/` (local only). The
  Mac stays awake (`caffeinate -dims` in a terminal), the Claude Code session stays open, auto mode
  on (a permission prompt would stop the run until morning).
- **One FinHub agent at a time, one branch per night.** Every PR into `staging` redeploys FinHub on
  dev, so two FinHub PRs overwrite each other's screens. Agents on other apps can run alongside.
- **Commit as it goes**; push and open or update the PR only once the night's screens build and the
  tests pass, so dev never shows a broken build.
- **Stop, and write why in STATUS.md**, if: any Firebase project other than `kidclub-dev` comes up;
  the same test still fails after 3 tries; a step needs a decision only Renato can make and no
  placeholder works.
- **Questions don't block otherwise**: use a placeholder marked "a confirmar" in the UI and list it
  in STATUS.md.
- **Morning report** at the top of STATUS.md: what was built, the dev URL, what to click, what's "a
  confirmar", what failed.

## Answers (Renato, 2026-10-28)

1. **Meal allowance** follows the month's possible working days, minus vacation, sick and trip days
   (trips get per diems instead). It can differ from the EC days worked; rarely, but it happens.
2. **Holidays for meal days**: Portuguese national holidays plus Coimbra's municipal holiday.
3. **Travel**: a fixed per diem per day. A trip on the calendar × its days gives the amount, so
   Tesouraria shows it ahead.
4. **EC contracts**: an extension sometimes follows straight on, sometimes not. It always has a new
   number, so it is always a new contract. Warn 3 months before the last working day.
5. **Payment days** besides 25 and 20: the agent proposes them from the 2026 statements.

## Traps

- **Real values only in `prodata/`.** Fixtures and examples use made-up values.
- **Writes go to `kidclub-dev` only** until a release is decided. Prod isn't touched.
- **Carnaval isn't a legal holiday**, so it's not in `pt-coimbra`. If a 2026 payslip shows one meal
  day fewer in February or March, ask Renato whether NoisySource gives it off and add it as a
  company day off.
- **Don't put v2 under `finances_entities`**: its wildcard rule allows writes.
- **Casa still depends on `contractSync`**: the old app writes Casa's salary income from NoisySource
  contracts. Keep it until Casa moves to v2; then Casa reads NoisySource's payslip events.
- **Dev deploy race**: any PR into `staging` deploys `staging`'s FinHub to dev, replacing #94's
  build that's there now. The data stays; #94's pages disappear from dev until it's redeployed.
