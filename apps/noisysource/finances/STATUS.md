# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-21 (agent/noisyphocus-cost-model)

## Currently working on
Built the NoisyPhocus cost model: extended `RecurringEntryDoc` with a `costModel: 'fixed' | 'commission'`
variant (for EasyPay's %-of-volume fee, as opposed to Vendus's flat SaaS fee), and added a
`/noisyphocus/costs` page that computes and stores
`finances_entities/noisyphocus/costSummary/{yyyy-mm}` — the doc KidClub's "Resumo Financeiro"
is meant to read cross-app instead of computing driver/teacher/software cost itself.
PR: `agent/noisyphocus-cost-model` → `staging`.

**Blocking follow-up (not done in this PR):** none on the Firestore-rules side — a rule was added
(`isRainbowAdmin()` read-only on `finances_entities/noisyphocus/costSummary/{yearMonth}`), so KidClub
*can* read the doc once it's deployed. What's still missing is real data (see "Open questions" below)
and reconciling with KidClub's own in-flight refactor (see next paragraph).

**Important cross-app note found while building this:** KidClub's own `FinancialSummaryPage.tsx`
(branch `agent/financial-costs-decouple`, merged to `staging` 2026-09-21, *before* this PR) went a
different direction than expected — it now stores driver/teacher/software cost as directly-editable
fields on KidClub's own `config/transportation` / `config/studyCenter` docs, not by reading Finances'
`costSummary`. So as of this writing, **nothing on the KidClub side actually reads
`costSummary` yet** — this PR only builds the FinHub half of the contract. Whoever picks up KidClub's
Resumo Financeiro next needs to decide whether to switch it over to read `costSummary` (removing its
own editable cost fields) or keep both and reconcile which one is the source of truth. Flagged in root
CLAUDE.md "Cross-App Data Contracts" too.

## Last completed
- `RecurringEntry.ts`: added `costModel`, `commissionPct`, `commissionVolumeSource` (all optional,
  default behavior unchanged — every pre-existing NoisySource entry has no `costModel` and is treated
  as `'fixed'`), plus a `recurringMonthlyAmountCents()` helper.
- `api.kidclub.monthlyProcessedVolumeCents(yearMonth)` — sums KidClub's paid/invoiced billing for a
  given month, in cents. Used as the volume base for commission-model costs.
- `RecurringPage.tsx`: form now has a Fixo/Comissão toggle (expense entries only) + a commission %
  field; list view shows a "comissão X%" badge and "(estimado)" next to the stored fallback amount.
- `VatPage.tsx` / new `lib/recurringSchedule.ts`: quarterly IVA calc now resolves commission entries'
  actual monthly base using KidClub's processed volume (fetched only when NoisyPhocus has a
  commission-model entry, to avoid an unnecessary cross-app read otherwise). Extracted the
  month-occurrence/IVA logic out of VatPage into `recurringSchedule.ts` so `costSummary.ts` can reuse
  it exactly rather than re-deriving it.
- New `api.costSummary` domain (`lib/api/domains/costSummary.ts`) + `/noisyphocus/costs` page
  (`CostSummaryPage.tsx`): computes `payrollCostCents` (active employment contracts via
  `buildPayrollPreview` + active EC/freelance contracts via `estimatedMonthlyInvoiceCents` — no
  payroll math reimplemented), `softwareCostCents` (active expense `recurring` entries — see
  assumption below), and `vatCents` (IVA dedutível on that month's software costs, via the same
  engine as VatPage, scoped to one month), then writes the sum to
  `finances_entities/noisyphocus/costSummary/{yyyy-mm}`.
- Firestore rule added: `finances_entities/noisyphocus/costSummary/{yearMonth}` readable by
  `isRainbowAdmin()` (KidClub's admin role) in addition to the existing `isFinhubAdmin()` rule — this
  one path only, nothing else opened up.

**Design choice — recompute-on-open, not a manual "publish" button:** `costSummary` is recalculated
and overwritten every time `/noisyphocus/costs` is opened for a given month, rather than requiring an
explicit save step. At this scale (2 employment/EC contracts, a handful of recurring entries, one
KidClub billing read) the computation is cheap, and this avoids the staleness risk of a stored
snapshot silently drifting after someone edits a contract or recurring entry. The tradeoff: KidClub's
number is only as fresh as the last time someone opened this FinHub page for that month — acceptable
for a 2-user, no-automation app, but worth knowing if the number ever looks stale.

**Design choice — no category-based filtering for softwareCostCents:** `categoryId` exists on
`RecurringEntryDoc` but isn't exposed in `RecurringPage.tsx`'s form, so nothing sets it in practice.
Since NoisyPhocus's payroll already lives in `employmentContracts`/`ecContracts` (not `recurring`),
every active `expense` recurring entry under the `noisyphocus` entity is treated as software/tooling
cost by construction. **If a non-software recurring expense is ever added for NoisyPhocus** (rent,
insurance, etc. entered as a `recurring` entry rather than its own collection), `softwareCostCents`
will silently include it — this will need a real `categoryId` filter at that point.

**Note on EC contracts direction:** `EcContractDoc` (`clientName`, `dailyRateCents`,
`expectedDaysPerMonth`) was modeled for *income* — a client paying NoisySource/Renato a daily rate.
Reusing it for NoisyPhocus's freelance teacher (recibo verde) reverses that direction: NoisyPhocus is
the one paying, not the "client" being invoiced. The math (`dailyRateCents × expectedDaysPerMonth`)
still gives the right cost figure, but the "Cliente" field on the form will read oddly for this use
case (put the teacher's name there, not an actual client). Not fixed in this PR — flagging so it isn't
mistaken for a bug later.

## Next step
Renato needs to enter NoisyPhocus's real numbers before `costSummary` produces anything non-zero —
**this is a hard prerequisite**, nothing here is seeded/faked:
1. `/noisyphocus/contracts` — the driver's real employment contract (gross monthly, IRS/SS rates,
   benefits if any), following the pattern of NoisySource's existing contracts (Renato/Marisa).
2. `/noisyphocus/ec-contracts` — the teacher's real recibo verde / EC contract (daily rate × expected
   days/month). Remember the "Cliente" field quirk above — just label it with the teacher's name.
3. `/noisyphocus/recurring` — two expense entries: Vendus's real monthly fee (`costModel: fixed`,
   with its real IVA rate) and EasyPay's real commission (`costModel: commission`, real
   `commissionPct`, real IVA rate).
4. Once those exist, open `/noisyphocus/costs` and confirm the numbers look right for the current
   month before relying on `costSummary` anywhere.
5. Decide (with whoever owns KidClub's Resumo Financeiro next) whether it should switch to reading
   `costSummary` instead of its own editable config fields — see the cross-app note above.

## Open questions for Renato
- Should KidClub's Resumo Financeiro actually switch to reading `costSummary`, given it just shipped
  its own editable driver/teacher/software cost fields on `agent/financial-costs-decouple`? Or should
  both stay, with `costSummary` used elsewhere (e.g. a future company-wide P&L)?
- Is "IVA dedutível on this month's software costs" the right definition for `costSummary.vatCents`,
  or did you have the full quarterly net VAT position (income − deductible) in mind? Went with the
  narrower one since it's an actual monthly cash cost and doesn't require pulling in KidClub's Vendus
  income VAT (a separate cloud function call) into what's meant to be a *cost* summary.

## Anything risky in flight
- PR not yet merged/reviewed (`agent/noisyphocus-cost-model` → `staging`).
- No deploys were run as part of this task (per instructions) — `firestore.rules` change (the new
  `costSummary` read rule) only takes effect once someone runs the Finances/functions deploy or the
  standard `staging`/`main` pipeline picks up the rules file.
- No new metered API calls — everything reads existing Firestore collections (KidClub's `billing`,
  Finances' own entity-scoped collections); no new external API.
