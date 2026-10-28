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
  and a number of days**. An extension and a new contract each get a new number; a rate change
  almost always means a new contract.
- The days budget gives the **last working day**, so the next contract can be prepared in time.
- **Days worked vary per month**, so income varies.
- **Three workers. Payslips vary month to month**: travel allowances, and the meal allowance
  depends on the working days of the month.
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
| `ec.contract.signed` | number, client, personId, dailyRateCents, totalDays, startDate, `follows` (previous number), kind `new`/`extension`, holiday calendar id, daysToPayment, vatCode (`isento`) | `ec-<number>` |
| `ec.contract.ended` | number, lastDay, reason (early end only; the normal end is computed) | `ec-<number>-end` |
| `employment.terms.set` | personId, from, contractType, grossMonthlyCents, irsRatePct, ssEmpPct, ssErPct, benefits (per day or per month, IRS/SS flags, card or account), payDay | `emp-<person>-<from>` |
| `employment.ended` | personId, lastDay | `emp-<person>-end` |
| `absence.set` | personId, dates, halfDays, kind (férias, doença, outro) | generated |
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
- **EC days** per contract: the contract's calendar (the client's holidays; #94's seed already
  lists them for 2026) minus the worker's absences. Before a timesheet is submitted these are the
  planned days; afterwards the timesheet replaces them.
- **Meal days** per worker: the working days of the month minus absences (calendar: open question 2).
- **EC runway**: days used (submitted timesheets) + days planned ahead → projected last working
  day and "prepare the next one from" date. Built on `computeEcProjection`
  (`packages/shared/lib/ecProjection.ts`), which already reproduces the client's end date (#94).
- **Payslip estimate**: `computeMonthlyPayroll` changed to take meal days and travel lines as
  inputs instead of a fixed `daysPerMonth` / 22. A recorded payslip replaces the estimate.

## Expected movements (what Tesouraria shows ahead)

Each item carries its inputs so the screen can explain the number ("21 dias × taxa, contrato N").

- **EC invoice** for month M: days(M) × rate; days from the timesheet if submitted, else planned.
  Issue date per rule; cash in at issue + `daysToPayment`.
- **Net salary** per worker for M on the pay day (25).
- **Meal voucher top-up** per worker: meal days × daily value, on the voucher rule's day.
- **SS** (employee + employer) and **IRS withheld** for M: day 20 of M+1.
- **Fixed costs**: from the cost plans.
- Days that fall on a weekend or holiday move per the rule (before or after).

## Screens (NoisySource module, labels in Portuguese)

1. **Tesouraria** (home): the next 90 days by default (up to 12 months), day by day, every expected
   movement with the projected balance from the last real balance (latest imported statement).
   Past days: planned vs real side by side, missing items flagged.
2. **Contratos EC**: the chain of contracts (each extension follows the previous one): number,
   client, rate, days total / used / planned / left, projected last day, warning when it's time to
   prepare the next contract.
3. **Mês**: a monthly checklist (folha de horas submetida, fatura emitida, recibos registados, SS
   e IRS pagos, every bank line matched) and planned vs actual totals.
4. **Equipa**: per worker, terms history and payslips (estimate vs recorded).
5. **Diário**: every event, newest first, filterable, with who, when and reversals. This is the
   audit screen.

Forms: Folha de horas (pre-filled with the planned days), Recibo de vencimento (pre-filled from the
estimate; Renato adds travel), Novo contrato EC, Ausências, Importar extrato (reuses
`src/lib/parsers/bpiPdf.ts` and its balance check).

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
numbers).

**Importer** (dev only, refuses any project other than `kidclub-dev`): seed → plan and payslip
events; statements → movement events through `bpiPdf.ts`.

Imported bank lines make the month-end balances true by construction. **The test is whether the
plan predicts the bank.** For each month January–September 2026:

1. Every bank line is matched to a planned item or classified as ad hoc.
2. Every planned item in the month has its bank line, or a written reason.
3. Planned month-end balance (previous real balance + planned items) − real month-end balance =
   the sum of the ad hoc lines. Nothing unexplained.
4. Each payslip equals the plan's estimate except lines entered by hand (travel), shown as the
   difference.
5. EC: the contract chain's projected last days match the client's; each invoice = timesheet days
   × rate.

Then Renato compares Tesouraria with the old FinHub's Previsão for the coming months.

## Steps

Each a branch off `staging` and a PR into `staging`, as usual.

1. **Domain only** (no UI, no Firestore): envelope, NoisySource events + zod, days engine, payslip
   estimate with meal days and travel, expected movements, state rebuild. Tests with made-up values.
2. **Storage**: rules, event store (read, append, reverse), dev-only importer and wipe script,
   Diário. Import 2026 on dev.
3. **Tesouraria + Contratos EC.**
4. **Mês + matching + forms** (Folha de horas, Recibo, Ausências, Importar extrato).
5. **Acceptance run with Renato**, then remove the old NoisySource pages. Then choose the next
   company (NoisyPhocus or Casa).

## Open questions for Renato

1. **Meal allowance**: paid for the working days of the month being paid, or the previous month's
   actual days? Do vacation and sick days reduce it?
2. **Holidays for the workers' meal days**: Portuguese national holidays plus the municipal one?
   (EC days use the client's list, already in the seed.)
3. **Travel allowances**: known before the month (planned trips) or only when the payslip is done?
   If before, Tesouraria can show them ahead.
4. **EC contracts**: does an extension keep the rate and continue straight after the previous
   contract? How long before the last day should FinHub warn about the next one?
5. **Payment days** besides salaries (25) and SS + IRS withheld (20 of the next month): when are
   meal vouchers topped up, and which other NoisySource payments have fixed days (IRC, accountant,
   insurance)? The agent can propose a list from the 2026 statements first.

## Traps

- **Real values only in `prodata/`.** Fixtures and examples use made-up values.
- **Writes go to `kidclub-dev` only** until a release is decided. Prod isn't touched.
- **Don't put v2 under `finances_entities`**: its wildcard rule allows writes.
- **Casa still depends on `contractSync`**: the old app writes Casa's salary income from NoisySource
  contracts. Keep it until Casa moves to v2; then Casa reads NoisySource's payslip events.
- **Dev deploy race**: any PR into `staging` deploys `staging`'s FinHub to dev, replacing #94's
  build that's there now. The data stays; #94's pages disappear from dev until it's redeployed.
