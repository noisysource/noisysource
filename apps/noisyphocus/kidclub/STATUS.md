# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-21

## Currently working on

### 0. `financialEvents` consolidation + NoisyPhocus cost model — both halves merged, PAUSED mid-testing 2026-09-21
**Status: paused at Renato's request** — a bigger prod issue came up needing
this same dev environment, so live testing of this branch stopped mid-way.
Pick this back up by re-reading this section + the matching one in
`apps/noisysource/finances/STATUS.md` (same branch, other app) before
touching anything — there's an unresolved mystery below that needs solving
before testing can continue.

Consolidating KidClub's three disconnected money-calculation paths
(`financialEvents`, `billing`, and `FinancialSummaryPage.tsx`'s independent
raw-subscription math) onto `financialEvents` as the single source of truth
for KidClub's own revenue, readable cross-app by the Finances app.

**Branch: `agent/financial-events-model` (based on `staging`), PR not yet
opened** — pushed to `origin`, `gh` CLI unavailable in every environment
used so far (confirmed genuinely not installed on this machine, not a
sandbox restriction). Open manually: `--base staging`,
https://github.com/noisysource/noisysource/pull/new/agent/financial-events-model.
This branch now also contains the entire parallel Finances-app task
(`agent/noisyphocus-cost-model` was merged into it, not kept separate — see
finances STATUS.md for why) plus several fixes found while testing, listed
below.

This started as the KidClub-side half only, then absorbed the Finances-app
half and a round of bug fixes once testing began. What's built, in order:

Built:
- `packages/shared/models/FinancialEvent.ts`: added `sourceCollection`,
  `sourceId` (formalizing the deterministic-ID pattern already used ad hoc),
  and `tier: 'committed' | 'pipeline'` (orthogonal to the existing
  `eventKind: 'planned' | 'effective'` — tier = is the underlying
  subscription/booking real yet, eventKind = has the money actually landed).
  Fields are optional for backward-compat with legacy events (e.g. the
  driver/teacher wage forecasts), but every new event-generating code path
  sets them.
- `eventService.ts`: `studyRoomIncomeMapper`, `transportSubIncomeMapper`,
  `partyBookingIncomeMapper` now also generate `pipeline`-tier events for
  `pending` subs/entries/bookings (previously pending was silently excluded
  entirely). Added `campBookingIncomeMapper` (new — camps had no income
  mapper at all before), reading `campSubscriptions` + `camps` (for the
  date range, since a subscription has no date of its own). Added van +
  electricity fixed-cost `expense` events (`tier: 'committed'`) sourced from
  `config/transportation`'s `vanMonthlyCost`/`electricityMonthlyCost` —
  deliberately NOT driver/teacher payroll, which is moving to the Finances
  app's own cost tracking instead.
- `functions/src/kidclub/billing.ts`: new `onBillingPaidEffectiveEvents`
  Firestore trigger (`onDocumentWritten` on `billing/{billingId}`) — when a
  billing record first transitions to `paid`/`invoiced`, emits a new
  immutable `effective` `financialEvents` doc with the same deterministic
  `sourceId` as the original planned/committed event (matched by
  reconstructing the mapper's own ID pattern from the billing record's
  period + subscriptionId). Never mutates the original planned event — pure
  event sourcing, new doc every time. Enrollment-fee line items have no
  planned-event equivalent yet, so they're skipped (flagged in code comment,
  not silently wrong).
- `apps/noisyphocus/kidclub/src/services/financeCostSummaryService.ts`
  (new): read-only client for the Finances app's
  `finances_entities/noisyphocus/costSummary/{yyyy-mm}` doc. Treats a
  missing doc as "not yet configured", never as €0.
- `firestore.rules`: added a narrowly-scoped read rule so `rainbowAdmin`
  (KidClub admin) can read `finances_entities/noisyphocus/costSummary/*`
  specifically, without broader `finances_entities` access.
- `FinancialSummaryPage.tsx`: rewritten as a thin summary over
  `financialEvents` — sums by `type`/`tier`/`eventKind` for the selected
  period instead of computing revenue/cost independently from raw
  subscription docs. Shows Effective revenue, Committed revenue (incl.
  already-effective), Pipeline revenue (called out separately, never summed
  into the totals above), Committed cost (van + electricity from
  `financialEvents` + the Finances app's `costSummary` total), and two
  profit/margin figures (Effective vs. committed cost, Committed vs.
  committed cost). Kept the van/electricity cost editor (writes
  `config/transportation`, which `generateEvents()` reads next run) but
  dropped the driver/teacher/rent editors entirely — those costs now live
  only in the Finances app.

**Typecheck and `build:staging` both pass** (pre-existing baseline errors in
`eventService.ts`/other files re: `StudyRoomEntry.transportFee` and
`DaySelection.transport` are unrelated pre-existing type mismatches, verified
via `git stash` against the branch tip before this session's changes — not
introduced by this work).

**Since merged in — also built (see finances STATUS.md for full detail):**
- `finances_entities/noisyphocus/costSummary/{yyyy-mm}` now IS written by
  the Finances app's `/noisyphocus/costs` page (`computeAndSave`, recomputed
  on every open, not a manual publish step). `FinancialSummaryPage.tsx`'s
  fallback-to-"not configured" behavior only matters until Renato enters
  real contracts/recurring entries there — see finances STATUS.md's
  "Next step" for the exact prerequisite data entry.
- A missing `bookings` composite index (`status` ASC + `date` ASC) that
  broke `generateEvents()`'s party-booking mapper — added to
  `firestore.indexes.json` so it's in code, not just clicked into existence
  once via the console error's link.
- Moved/renamed the only UI trigger for `eventService.generateEvents()`:
  it lived solely on the admin Calendar page ("Gerar financeiro", now
  "Gerar eventos do mês" since it always generated calendar occurrences
  too, not just financial events) with no link from Resumo Financeiro.
  Added a second, correctly-labeled "Gerar eventos financeiros — [mês]"
  trigger directly on `FinancialSummaryPage.tsx`, scoped to the month
  filter. Same idempotent call underneath, safe from either place.
  **This manual-button approach is a stopgap** — a Firestore trigger
  (subscription/booking write → auto-generate its event) is the real fix,
  not started.
- Backlog entry added (see bottom of this file): a billing record can get
  stuck at `status: "paid"` with an unresolved `invoiceError` (Vendus
  invoice creation failed) with no admin-visible flag — a real
  fiscal-compliance gap, unrelated to and not blocking this work.

**Deploy state:** every push to this branch auto-deploys to `kidclub-dev`
via `deploy-dev.yml` (PR-against-`staging` triggers it) — confirmed this
covers terraform apply, Firestore rules, indexes, Cloud Functions, and
KidClub hosting, all together, on every push. **This is NOT how the
Finances app deploys** — it has its own `deploy-finances.yml`,
`workflow_dispatch`-only, and (see finances STATUS.md) had its own separate
bugs blocking it. As of this session, KidClub's revenue-tier behavior
(committed/pipeline split, effective events on payment) was confirmed
working live on `kidclub-dev-arcoiris.web.app` by Renato. The cost side
(staff/software/VAT from Finances' `costSummary`) was NOT yet confirmed
end-to-end before the pause — that's the actual next step.

**Not done / explicitly out of scope**:
- The `billing` collection's schema was not touched.
- Enrollment fee (registration/insurance) line items don't get an
  `effective` event yet — no planned equivalent exists for them in
  `eventService.ts`. Low priority (one-time small fees), flagged for later.
- Tier/eventKind badge redesign (collapsing the confusing two-column
  Tier+Estado display into one three-state badge: Pipeline / Confirmado a
  cobrar / Recebido) and a preset revenue-scenario filter (bring back
  something like the old "Apenas ativos / Ativos + pendentes / Tudo"
  toggle, adapted to tier vocabulary) — **agreed with Renato, not yet
  built**. Do this next once the cost-side mystery below is resolved.

## Currently working on (prior threads, still open)

### 1. Billing double-discount bug — FIXED, deployed to prod, partially backfilled
Investigated "igbpinto@gmail.com's billing looks wrong". Root cause: `computeLineItems()` in
`functions/src/kidclub/billing.ts` read `sub.originalFee ?? sub.monthlyFee` as the *gross*
transport fee, but `discountRecalc.ts` overwrites `monthlyFee` with the already-discounted
price once any discount fires, and subscriptions from the client self-enroll flow never get
`originalFee` set — so billing silently re-applied `appliedDiscounts` a second time. This
under-billed customers (never overcharged). 8 of 23 active transport subs were affected.

Fixed on branch `agent/billing-double-discount-fix` (PR #13, merged to `main`): gross is now
derived from schedule length × `flatRatePerTrip` × weeks-in-pattern, same formula
`discountRecalc.ts` already uses, instead of trusting a field that can silently already be net.
**Deployed to prod** (`onStudyroomBillingSync`, `onTransportBillingSync`,
`backfillBillingSchedules`, `setBillingLineItemExcludedDays` — the 4 functions that actually
use the fixed logic). Verified live: Carolina Almeida's October billing line item now shows
the correct **€168** (was €117.60).

**Still under-billed, not yet backfilled**: José Eduardo (Miguel Melo) and Diogo+Bernardo Mogo
(Sandra Abreu) — only Carolina Almeida's family has actually been recomputed so far (via a
verification touch). Either trigger a no-op write on those subscriptions or run
`backfillBillingSchedules` (recomputes everyone, not just these — confirm on dev first, and
see the open question below on running it against prod).

Study room subs are NOT currently affected by this exact bug (0 of 14 missing `basePrice`),
but `discountRecalc.ts`'s study-side gross calc (`x.basePrice ?? x.monthlyPrice`) has the same
latent shape — not fixed, no live instance found, flagging only.

### 2. Discount *model* itself — confirmed wrong, NOT yet implemented
Separately from the bug above: Renato confirmed the discount model that's actually live (flat
% off the whole gross once a threshold is met — e.g. multi-trip discount applies to ALL trips
that day, sibling discount applies to a sibling's ENTIRE fee) is **not** the intended design.
Intended model is **marginal/per-unit**:
- Multi-trip: within a day, the first (chronologically earliest) trip is full price; every
  trip after it that same day gets the multi-trip discount.
- Sibling: order children family-wide by earliest subscription/enrollment date; the
  first-enrolled child's subscriptions stay full price; every subsequent child's subscriptions
  get the sibling discount.
- School discount (and flat manual discounts like "Aluno do ano anterior") still apply last,
  as a flat % on the resulting sum — no natural per-unit basis for those.

Comparison table run against 5 real prod subscriptions showed real, not-cosmetic differences
(e.g. Carolina Almeida: €168 flat vs **€182.40** marginal; José Eduardo: €151.20 vs
**€165.12**; Diogo Mogo loses his sibling discount entirely once his sibling-enrollment-order
is accounted for, since he was enrolled before his brother). **This needs its own implementation
pass** — touches `discountRecalc.ts`, `billing.ts`, and the `AppliedDiscount` display model
(admin discount badges, client "was €X now €Y" comparisons currently assume one flat % per
discount, which doesn't hold once multi-trip/sibling are marginal). Not started. See Backlog
section below.

### 3. Financial Summary — decoupled from Route Planner, deployed to dev only
`FinancialSummaryPage.tsx` was silently showing driver/electricity cost as €0 because it
derived them from the latest saved snapshot in `transportRoutes`, which was **empty in prod**
(nobody had ever run/saved a route plan) — meaning the page's "profit" figure was fake. Real
driver wage is **€1,400/month**; plugging that in flips prod from an apparent +€1,271.60/month
"profit" to roughly **−€440/month** loss once corrected for other data-quality issues found
along the way (an orphaned, never-actually-billed subscription for Leonardo Marques inflating
revenue by €240/mo, and 3 subs with stale `monthlyFee` fields inflating it by €72/mo more).

Refactored (branch `agent/financial-costs-decouple`, currently mid-merge-conflict-resolution
with `main` — see Next step #1):
- Removed the `transportRoutes`-snapshot dependency and the override/fallback chain entirely.
- Added `driverMonthlyCost` / `electricityMonthlyCost` as direct fields on
  `TransportationConfig` (alongside existing `vanMonthlyCost`), with a new **"Custos Fixos"**
  panel on the page itself — Van/Motorista/Eletricidade/Professora/Renda all inline-editable,
  saving straight to `config/transportation`/`config/studyCenter`.
- `TransportPlannerPage.tsx` is untouched — it keeps planning routes and saving its own
  `transportRoutes` version snapshots; Financial Summary just no longer reads them.
- Fixed one cosmetic bug post-deploy: the "Custos Fixos" KPI subtitle said "van + motorista +
  professora + renda", missing "eletricidade" even though it was already correctly included
  in the total — fixed and redeployed.

Typecheck + build both pass. **Deployed to dev only** (`kidclub-dev-arcoiris.web.app`), smoke-
tested manually by Renato (entered €1400/€300 into the new panel, numbers computed correctly:
€3787 revenue − €3750 costs = +€37, 1% margin — dev's own subscription data, not prod's).
**Not merged to main / not deployed to prod yet.**

### 4. Prod → dev data sync — done
At Renato's request, did a full (non-anonymized) copy of KidClub's real data from
`rainbow-prod-2454b` into `kidclub-dev`, to give dev realistic subscription/family data for
testing (e.g. the Financial Summary work above). Method: `gcloud firestore export` (scoped to
`billing, children, config, eventModifications, families, financialEvents, invoices, settings,
studyroom, subscriptionVersions, transportationSubscriptions, users` — deliberately excluding
`emailOutbox`/`emailCampaigns` so nothing risks re-queuing real emails) → copied the export
between each project's own `*-exports` GCS bucket → `gcloud firestore import` into
`kidclub-dev`. Verified Inês Pinto's family record landed correctly. Temporary export files
deleted from both buckets afterward.

**Side effect (expected, flagged beforehand):** the import overwrote dev's `config/transportation`
doc wholesale, clearing the `driverMonthlyCost: 1400` / `electricityMonthlyCost: 300` Renato had
just entered for testing (prod's doc doesn't have those fields set) — needs re-entering in dev
if still wanted there (see Next step #4).

**Caveat:** Firebase Auth UIDs are per-project — copied `users/{uid}` docs and every
subscription's `userId` field still reference prod UIDs, which don't correspond to real dev
Auth accounts. Fine for admin-side testing (Financial Summary, billing admin), but per-family
client-login testing against this data won't work without also creating matching dev Auth
accounts.

### 5. CI/CD pipeline — rebuilt, now fully live (separate, now-closed thread of work)
Rebuilt the whole deploy pipeline this week (see root `CLAUDE.md`'s "Branch → environment
pipeline" for the full model). Now **fully merged and operational**, not in-progress:
- PR into `staging` → auto-deploys app/rules/indexes/functions/terraform to `kidclub-dev`.
- PR into `main` → auto-deploys app/rules/indexes/functions to prod immediately (before
  merge) — **`terraform apply` stays disabled for prod specifically**, see below.
- Merge to `main` → re-deploys + `sync-staging` fast-forwards `staging` to match.
- **GitHub branch protection is now configured on `main`**: the `deploy` check must pass
  before merge is even clickable. This was the missing piece that made the whole thing
  trustworthy — closed out this session.

Getting the first real prod deploy green took a long chain of IAM fixes, all against prod's
CI identity `github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com` (a
completely different identity from dev's `gmail-sender-kidclub-dev`, which is why none of
dev's earlier fixes carried over automatically). It now has, granted by hand and documented
in `infra/gcp/terraform/iam.tf`/`secrets.tf`/`billing-cutoff.tf` (not yet applied via
Terraform, since terraform apply is off for prod):
`datastore.indexAdmin`, `secretmanager.secretAccessor` + `secretmanager.viewer` (on all 7
secrets — accessor alone isn't enough, viewer is what `firebase deploy`'s validation step
actually needs), `serviceusage.serviceUsageAdmin`, `iam.serviceAccountUser` (project-wide,
for functions' actAs), `cloudscheduler.admin`, `pubsub.editor`.

**`billingCutoff` no longer deploys to prod at all** — it's the "combined dev+prod billing
circuit breaker" singleton agent, and GCP's `iam.disableCrossProjectServiceAccountUsage` org
policy (confirmed enforced on `rainbow-prod-2454b`) categorically blocks prod's CI identity
from acting as its dev-project service account, no IAM grant can override that. Traced
further and found the prod copy would've been permanently untriggered anyway (its Pub/Sub
topic and the budget that publishes to it only exist in dev's Terraform state) — so rather
than build a redundant prod-native agent, `functions/src/billingCutoff.ts`'s export is now
conditional on `GCLOUD_PROJECT === "kidclub-dev"`.

**Prod's Terraform state is still essentially empty** (81 resources pending creation, real
infra was never imported — found via `terraform plan -var-file=env/prod.tfvars`) — `apply`
stays off for prod (`run_terraform: false` in `deploy-prod.yml`) until that's deliberately
reconciled as its own task. Not urgent; app/rules/indexes/functions/hosting all deploy fine
without it.

## Last completed
- Billing double-discount fix: merged (PR #13), deployed to prod, verified live for Carolina
  Almeida. José Eduardo + Mogo siblings still need backfill.
- Financial Summary refactor: on `agent/financial-costs-decouple`, deployed to dev only,
  smoke-tested manually by Renato. Currently resolving a merge conflict against `main` (this
  branch was opened before the CI/CD pipeline work landed, so it was ~23 commits behind).
- Prod → dev data sync: done, verified, temp export files cleaned up from both buckets.
- CI/CD pipeline: fully merged to `main`, branch protection configured, first real prod
  deploy went green.
- `agent/impersonation-billing-fix` (from the 2026-09-18 session) — confirmed merged into
  `main` (PR #11) a while back; the "prod ahead of main" risk from that session is resolved,
  no longer worth tracking.

## Next step
1. **Finish merging `main` into `agent/financial-costs-decouple`**, push, then open the PR.
   Because branch protection is now live, opening/updating this PR will trigger a real prod
   deploy check (`deploy-prod.yml` on `pull_request`) — this is actually a good thing: it's
   the first real validation this branch has had against the new pipeline. Watch it go green
   before merging.
2. **Backfill José Eduardo's and the Mogo siblings' billing** — same double-discount bug,
   code fix is live, their existing records just haven't been recomputed yet. See open
   question below on running `backfillBillingSchedules` against prod.
3. Re-enter `driverMonthlyCost: 1400` (and whatever electricity figure) into dev's Custos
   Fixos panel — cleared by the prod→dev import.
4. Decide on the "As minhas faturas" feature work (dead `invoices` collection, flagged in an
   earlier session) — separate, not urgent.
5. Prod Terraform state reconciliation (see item 5 above) — separate, not urgent, real effort.
6. Decide whether to bring `deploy-finances.yml` onto the same staging/main pipeline model.
7. See **Backlog** below for the two bigger features surfaced this week (discount model
   rework, route planner rework) — neither started, both need their own scoping pass.

## Open questions for Renato
- OK to run `backfillBillingSchedules` against **prod** to catch José Eduardo's and the Mogo
  siblings' still-under-billed records? Recomputes every family, not just these — low risk,
  but flagging per the no-standing-write-access rule.
- Discount model rework (marginal/per-unit, see above) — confirmed as the intended design,
  but not scoped/scheduled yet. When should this happen relative to other work?
- Worth a deliberate look, not urgent: is `roles/resourcemanager.projectIamAdmin` +
  `roles/billing.admin` on prod for dev's CI service account (granted earlier this week, for
  the cross-project Terraform resources) the long-term shape you want, or should it get
  narrowed to a custom role later?

## Anything risky in flight
- **José Eduardo and the two Mogo siblings (Diogo, Bernardo) are still under-billed in prod**
  — the code fix is live, but their existing pending billing records haven't been recomputed
  yet (only Carolina Almeida's has).
- **Financial Summary refactor is only on dev** — `agent/financial-costs-decouple` not merged,
  prod's Financial Summary page still has the old planner-snapshot dependency (shows €0
  driver/electricity cost, fake profit) until this ships.
- **Prod's CI service account has accumulated a lot of IAM roles this week**, granted
  reactively as each deploy step hit a new gap (see item 5 above for the full list) — not
  wrong, but worth knowing the shape of it if you're ever auditing prod IAM.
- Worktrees now open: `.claude/worktrees/financial-costs-decouple` (this one, mid-merge, keep
  until PR opens and merges). `.claude/worktrees/billing-double-discount-fix` — PR merged,
  safe to remove. Several CI/CD-related worktrees from this week
  (`cicd-prod-prep`, `cicd-prod-index-fix`, `cicd-prod-pr-gate`) are also fully merged now —
  safe to remove. Plus pre-existing stale ones from prior sessions (`claim-studyroom-fix`,
  `deploy-functions-workflow-fix`, `kidclub-cicd-automation`, and some pre-convention ones) —
  worth Renato doing a general `git worktree list` sweep and clearing out whatever's merged.
- Unrelated, still paused: a unified client calendar (`agent/family-calendar` branch,
  `/client/calendar`) — built, builds clean, not deployed/reviewed. Needs a Firestore
  composite index deployed (`firestore.indexes.json`, committed on that branch) — now that
  the pipeline is live, opening its PR against `staging` will handle that automatically.

## Backlog — bigger features surfaced but not started
- **Discount model rework** (surfaced 2026-09-20): live discount logic is flat-%-off-gross;
  confirmed intended design is marginal/per-unit (multi-trip: only the 2nd+ trip in a day is
  discounted; sibling: only the 2nd+ enrolled child is discounted; school/manual discounts
  stay flat on the resulting sum). Touches `discountRecalc.ts`, `billing.ts`, and the
  `AppliedDiscount` display model across several admin/client pages. Needs its own scoping
  pass before implementation — see "Currently working on" #2 above for the full spec and
  worked examples.
- **Transport Route Planner rework** (surfaced 2026-09-20, no prior note found anywhere in
  this repo's docs or memory before now): `TransportPlannerPage.tsx` currently owns route
  planning AND used to be the only source of driver/electricity cost for the Financial
  Summary page (now decoupled, see above). The planner itself hasn't been touched — it's a
  large (2300+ line) page that still needs a proper look: `transportRoutes` was completely
  empty in prod (nobody had ever saved a route plan), which is how the driver-cost blind spot
  happened in the first place. Worth a dedicated pass to figure out why it's never been used,
  whether it should feed anything else now that Financial Summary doesn't depend on it, and
  whether its own cost-estimate model (`driverRatePerHour`, `consumptionPer100km`,
  `electricityPricePerKwh`) is still the right shape for actual route planning. Not scoped
  further than this — flagging as a known future feature, not a plan.
- **"Paid but never invoiced" has no visibility anywhere** (surfaced 2026-09-21, while
  testing the `financialEvents` consolidation above): `BillingStatus` (`packages/shared/models/Billing.ts`)
  models `paid` and `invoiced` as one enum, not two independent facts. In the happy path
  `easypayWebhook` (`functions/src/kidclub/billing.ts`) sets `status: "paid"` then
  immediately calls `createVendusInvoiceForBilling()`, which sets `status: "invoiced"` —
  same function call, milliseconds apart. But if Vendus invoice creation fails, the record
  is stuck at `status: "paid"` with an `invoiceError` field set, until the next EasyPay
  webhook retry or a manual `retryVendusInvoice` call succeeds — meaning real money was
  received with no legal invoice issued, for an unbounded amount of time, with nothing
  surfacing that state to an admin. Not touched here — `onBillingPaidEffectiveEvents`
  (this session's new trigger) already treats `{paid, invoiced}` as one "money landed"
  boundary and doesn't need this fixed to work correctly. But it's a real fiscal-compliance
  gap independent of the financialEvents work: worth a visible "paid, not yet invoiced"
  flag on a billing admin page at some point. Not scoped further than this.
