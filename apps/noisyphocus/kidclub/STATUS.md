# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-20

## Currently working on

### 1. Billing double-discount bug — FIXED, deployed to prod, backfilled
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
use the fixed logic). One deploy gotcha hit along the way: the predeploy build script left a
stale `lib/` on the first couple of attempts (functions silently missing from the bundle) —
fixed by running `tsc` manually before deploying; each `firebase deploy --only functions:...`
call also only actually updated one function at a time, so it took 4 separate invocations to
land all 4. Verified live: Carolina Almeida's October billing line item now shows the correct
**€168** (was €117.60).

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

### 3. Financial Summary — decoupled from Route Planner, deployed to dev
`FinancialSummaryPage.tsx` was silently showing driver/electricity cost as €0 because it
derived them from the latest saved snapshot in `transportRoutes`, which was **empty in prod**
(nobody had ever run/saved a route plan) — meaning the page's "profit" figure was fake. Real
driver wage is **€1,400/month**; plugging that in flips prod from an apparent +€1,271.60/month
"profit" to roughly **−€440/month** loss once corrected for other data-quality issues found
along the way (an orphaned, never-actually-billed subscription for Leonardo Marques inflating
revenue by €240/mo, and 3 subs with stale `monthlyFee` fields inflating it by €72/mo more).

Refactored (branch `agent/financial-costs-decouple`, 2 commits, PR not opened — no `gh` CLI):
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
**Not deployed to prod, PR not opened/merged.**

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
if still wanted there.

**Caveat:** Firebase Auth UIDs are per-project — copied `users/{uid}` docs and every
subscription's `userId` field still reference prod UIDs, which don't correspond to real dev
Auth accounts. Fine for admin-side testing (Financial Summary, billing admin), but per-family
client-login testing against this data won't work without also creating matching dev Auth
accounts.

---

Previous session (2026-09-18) — fixed a real bug found while investigating "Marisa Pratas can't see her billing records":
impersonating a family in the admin panel and then visiting the client billing pages showed
nothing, regardless of what records actually existed for that family.

Root cause: `PaymentsPage.tsx` and `InvoiceListPage.tsx` query Firestore directly by
`user.uid` (the real logged-in admin's own uid) instead of going through `familyService.ts`,
which is the thing that actually knows how to resolve the impersonated family. Every other
client page (dashboard, children, subscriptions) already switches to querying by `familyId`
while impersonating — these two just never got that treatment.

Fixed both to query `familyId` when `impersonation` is active, same pattern as
`familyService.ts` (`apps/noisyphocus/kidclub/src/services/familyService.ts:72-73`). No
Firestore rules change needed — admins already have blanket read on `billing`/`invoices`.

**Renato is already aware of the invoices/payments split** — noted here as a feature to
implement, not a new finding: `InvoiceListPage.tsx` ("As minhas faturas" nav item) reads from
an `invoices` Firestore collection that **nothing in the codebase writes to** — no Cloud
Function, no admin page. It's empty for every family, not just Marisa. The billing system
that's actually alive is `PaymentsPage.tsx` ("Pagamentos"), backed by the `billing`
collection and `autoCreateBillingSchedule()` in `functions/src/kidclub/billing.ts`.

**TODO / feature to implement:** wire "As minhas faturas" up to real invoice data (or decide
to retire it and redirect to Pagamentos instead) — needs a decision on which, then either a
Cloud Function that populates `invoices` (e.g. from Vendus documents) or removing the page.
Not done in this session — separate scope from the impersonation fix below.

## Last completed
- Billing double-discount fix: merged (PR #13), deployed to prod, verified live (Carolina
  Almeida's October billing now shows €168 correctly).
- Financial Summary refactor: committed on `agent/financial-costs-decouple` (2 commits),
  deployed to **dev only**, smoke-tested manually by Renato through the new panel.
- Prod → dev data sync: done, verified, temp export files cleaned up from both buckets.

## Next step
1. **Backfill the remaining affected families' billing** — the billing fix is deployed and
   self-correcting for *future* writes, but only Carolina Almeida's family has actually been
   recomputed so far (via a verification touch). José Eduardo (Miguel Melo) and Diogo+Bernardo
   Mogo (Sandra Abreu) still have under-billed pending records in prod. Either trigger a no-op
   write on those subscriptions or run `backfillBillingSchedules` (recomputes everyone, not
   just these — confirm on dev first).
2. **Open + merge the Financial Summary PR**: no link generated yet (no `gh` CLI this
   session) — push already done, branch is `agent/financial-costs-decouple`. Then deploy to
   prod hosting once reviewed.
3. Re-enter `driverMonthlyCost: 1400` (and whatever electricity figure) into dev's Custos
   Fixos panel — cleared by the prod→dev import.
4. **`main` on GitHub does NOT have the impersonation-billing-fix commit** (from the
   2026-09-18 session, see below) — still unresolved, prod hosting is ahead of `main`.
5. Decide on the "As minhas faturas" feature work (see 2026-09-18 section below).
6. See **Backlog** below for the two bigger features surfaced this session (discount model
   rework, route planner rework) — neither started, both need their own scoping pass.

## Open questions for Renato
- OK to run `backfillBillingSchedules` against **prod** to catch José Eduardo's and the Mogo
  siblings' still-under-billed records? Recomputes every family, not just these — low risk,
  but flagging per the no-standing-write-access rule.
- Discount model rework (marginal/per-unit, see above) — confirmed as the intended design,
  but not scoped/scheduled yet. When should this happen relative to other work?
- `main` still doesn't have the impersonation-billing-fix commit from 2026-09-18 — same open
  item as last session, carried forward.

## Anything risky in flight
- **José Eduardo and the two Mogo siblings (Diogo, Bernardo) are still under-billed in prod**
  — the code fix is live, but their existing pending billing records haven't been recomputed
  yet (only Carolina Almeida's has). Same double-discount bug as before, just not yet
  backfilled for these three.
- **Financial Summary refactor is only on dev** — `agent/financial-costs-decouple` not merged,
  prod's Financial Summary page still has the old planner-snapshot dependency (shows €0
  driver/electricity cost, fake profit) until this ships.
- **Prod hosting was deployed ahead of `main`** (carried over from 2026-09-18) —
  `agent/impersonation-billing-fix` is live on kidclub.pt but still not merged.
- Worktrees now open: `.claude/worktrees/billing-double-discount-fix` (PR merged, safe to
  remove), `.claude/worktrees/financial-costs-decouple` (PR not yet opened, keep until
  merged). Plus the pre-existing stale ones from prior sessions (`claim-studyroom-fix`,
  `deploy-functions-workflow-fix`, `kidclub-cicd-automation`, and some pre-convention ones) —
  worth Renato clearing out whichever are merged/abandoned.
- Unrelated, still paused: a unified client calendar (`agent/family-calendar` branch,
  `/client/calendar`) — built, builds clean, not deployed/reviewed. Needs a Firestore
  composite index deployed (`firestore.indexes.json`, committed on that branch) before it's
  usable.

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
