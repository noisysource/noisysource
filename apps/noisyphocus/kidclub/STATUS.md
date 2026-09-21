# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-21

## Currently working on

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

### 6. Study-room exclusion calendar — two real bugs found via a live prod case, both fixed
Renato reported Susete Luis's billing looked wrong: the "Dias sem serviço" admin calendar
showed 3 marked study-room days but the billing row's pills showed 7, and the 4 extra ones
couldn't be unmarked. Two distinct bugs, found by reading actual prod data
(`_apps/arcoiris/billing/A7OXOljX1W9xrEn5mhP8_2026-09`, read-only via `gcloud` access token
against the Firestore REST API):

- **Deduction math bug** (`computeExclusionDeduction()` in `functions/src/kidclub/billing.ts`):
  the `"study"` branch deducted for every entry in `excludedDates` with no check that the date
  actually fell on a real schedule day — `"transport"` right below it already did this
  correctly. A stale/bogus date could silently discount a day the child was never billed for.
  Fixed to mirror the transport branch (checks `weekdayOfIsoDate(entry)` against `sub.days`).
  Same schedule-day check also added to `setBillingLineItemExcludedDays` as a second line of
  defense on save.
- **UI bug** (`ServiceCalendar` in `BillingAdminPage.tsx`): the calendar only renders a
  clickable cell for actual schedule days, so once a non-schedule-day entry exists in
  `excludedDates` there was literally no control to remove it — clicking "Guardar" always
  resent the untouched orphan. Fixed by listing any orphaned entries as removable chips below
  the calendar (same styling as the pills already shown elsewhere on the row).
- **Root cause of the orphaned entries, found investigating further**: `toIsoDate()` in
  `BillingAdminPage.tsx` built the ISO date string via `.toISOString()`, which converts to
  UTC. Every calendar cell's `Date` is constructed from local year/month/day, so in any
  timezone ahead of UTC (Portugal is UTC+1/WEST right now) that conversion silently rolls the
  date back by one day before saving — **every click on this calendar was saving the day
  before the one actually clicked.** This is the real, still-live source of the orphaned
  dates (not a stale schedule-change carry-forward, which was the original working theory).
  Fixed by computing the ISO string from local date components instead of `toISOString()`.

Shipped as **`hotfix/exclusion-calendar-timezone`** (PR opened directly against `main` per the
new hotfix path — deploys to prod immediately on PR open, ahead of merge) since it was active
data corruption; checks/deploy were running as of this note. The deduction-math + orphan-chip
fix is on `agent/study-exclusion-validation`, merged with current `main` here, not yet opened
against `staging`.

**Both fixed and confirmed — `hotfix/exclusion-calendar-timezone` merged to `main` and live in
prod** (deploy went green on PR open, merged after). `agent/study-exclusion-validation`
(deduction-math + orphan-chip fix) still needs its PR opened against `staging` — not urgent,
see Next step.

**Verifying the timezone fix in prod surfaced a third, unrelated bug** (see backlog item below
for the real gap this points at): re-marking Susete Luis's days in the live (fixed) calendar
produced a UNION of the old corrupted dates (which had no UI control to remove, since that fix
wasn't deployed yet) plus the new correct ones — 8 study entries, 14 transport entries — not a
clean replace. Investigating the resulting €0 transport deduction (should have been non-zero
for the real dates in there) found that Beatriz Apóstolo's transport subscription
(`transportationSubscriptions/7sYsxBADSPlFOpvlKqTO`) had a **pending cancellation request**
from the parent (`cancelRequested: true`, `feeReviewRequired: true`, submitted 2026-09-18,
never actioned by an admin) that had wiped `schedule: []` on the live subscription doc — while
September's billing record still carried the old Wed/Fri schedule in its own cached
`scheduleDays`/`tripsByDay`. `computeExclusionDeduction` reads the *live* subscription's
schedule, so with it empty, every excluded transport date deducted €0 regardless of validity.

At Renato's explicit instruction ("we haven't addressed what happens to billing when a
subscription changes mid-cycle — treat this one as if it's active and will continue to be,
fix the general problem separately"): restored the subscription to its pre-cancellation state
using `subscriptionVersions` history (which had the exact prior `schedule` — Wed/Fri, 14:00,
Escola Quinta das Flores → Kid Club) — `schedule` restored, `cancelRequested`/
`adminReviewPending`/`feeReviewRequired`/`cancelledAt` cleared, `lastClientAction` reset to
`"confirmed"`, `status` left `"active"` (was never actually changed). Confirmed the *study*
subscription (`studyroom/GJ7JYFe6KPSZAQofIsCM`) was untouched by the same request — only
transport was affected.

With the subscription restored, hand-corrected Susete Luis's Sept 2026 billing record with the
actually-intended dates (4 study absences, 7 transport absences — both at €6/unit): study
€48→€24, transport €48→€6, total €90. **This got overwritten twice more** by
`onTransportBillingSync` firing (with execution delay) off the subscription-restore write and
recomputing the record from whatever `excludedDates` happened to be present at that moment —
see the audit note below for the general risk this points at. Took six prod writes total
across the full saga (€114→€138→€156→€132(union)→€90→reverted to €132 by the trigger
race→**€90 again, confirmed stable this time**) before it actually stuck — worth Renato
knowing this one record's edit history is not "clean" if it's ever audited, though the final
state is correct and verified (`scheduleDays`/`tripsByDay` also confirmed intact). Several of
these writes required Renato to run the `curl` command himself — the auto-mode permission
classifier started blocking repeated prod-write `curl` calls from this session after several
in a row ("Modify Shared Resources" / "Blocked by classifier"), which is a harness-level gate,
not something an in-chat "yes go ahead" satisfies.

**Status: closed.** Susete's record is correct and stable. The deduction-math + orphan-chip
fix (`agent/study-exclusion-validation`) went through `staging` → `main` cleanly and is live in
prod. See the audit note under the "billing records don't react to subscription changes"
backlog item above for what turned up scanning the rest of the pending records — one real
still-open under-billing (Mafalda Raposo Duarte), left for the new architecture effort rather
than another one-off patch.

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
- Study-room exclusion calendar: found + fixed both the deduction-math bug and the timezone
  off-by-one that was silently corrupting every saved exclusion date. Timezone fix shipped as
  a hotfix PR straight to `main` (checks running as of this note); the deduction-math + orphan
  cleanup UI fix is merged with current `main` on `agent/study-exclusion-validation`, PR not
  yet opened against `staging`.

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
8. **Confirm the `hotfix/exclusion-calendar-timezone` deploy went green and merge it**, then
   open `agent/study-exclusion-validation` against `staging` (deduction-math + orphan-chip
   fix — not urgent, but should still land).
9. **Once the timezone hotfix is confirmed live, re-mark Susete Luis's real absence days**
   (her Sept 2026 record was cleared to zero exclusions, both line items back to full gross,
   total €156 — see item 6 above) — Renato was about to do this himself.
10. Worth a deliberate look once things settle: audit other pending billing records for the
    same shifted-by-one-day corruption pattern (any family with excludedDates that don't land
    on a real schedule weekday is a symptom) — not started, flagged by Renato as a next step
    after the hotfix ships, not done in this session.
11. **Address the shared-`kidclub-dev`-deploy collision problem** (see Backlog below) —
    Renato explicitly wants this picked up next. Surfaced when `agent/study-exclusion-validation`'s
    `staging` PR failed to deploy: `onBillingPaidEffectiveEvents`, manually deployed to
    `kidclub-dev` from the unmerged, currently-paused `agent/financial-events-model` branch,
    blocked every other branch's dev deploy because `firebase deploy` refuses to silently
    delete a remote function missing from the deploying branch's source. Unblocked by deleting
    that one function from `kidclub-dev` (`firebase functions:delete
    onBillingPaidEffectiveEvents --region europe-west3 --project kidclub-dev` — safe, only
    removes the deployed artifact, source is untouched on that branch and will redeploy fine
    whenever that work resumes) — but the structural cause is unaddressed.

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
- None new for the exclusion-calendar bug itself — Renato already confirmed the fix approach
  and the decision to correct Susete Luis's billing amount upward (€114→€138, then cleared to
  €156 pending re-marking) rather than absorb it as goodwill.

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
- Susete Luis's Sept 2026 billing record is now correct and closed out (total €90 — see
  section 6 above for the full chain). Not risky, noted here only so nobody re-opens it.
- **The timezone bug likely corrupted other families' exclusion dates too**, silently, for as
  long as it's been live — not audited yet (see Next step #10). Any other under- or
  over-billed pending record with excludedDates that don't land on a real schedule weekday is
  a symptom of the same root cause.
- Worktree `.claude/worktrees/exclusion-calendar-timezone-hotfix` (the timezone hotfix) and
  `.claude/worktrees/study-exclusion-validation` (deduction-math + orphan-chip fix) both still
  open — remove once their respective PRs are merged.

## Backlog — bigger features surfaced but not started
- **`kidclub-dev` is a shared Firebase project that every branch's `staging` PR deploys a full
  functions sync to** (surfaced 2026-09-21, Renato wants this picked up next). Any branch with
  in-progress functions work that gets deployed to dev directly (not yet merged to `staging`)
  leaves those functions live on the shared project. The next unrelated branch's CI deploy
  then fails, because `firebase deploy` refuses non-interactively to delete a remote function
  missing from the deploying branch's own source — exactly what happened with
  `onBillingPaidEffectiveEvents` from the paused `agent/financial-events-model` branch
  blocking `agent/study-exclusion-validation`'s unrelated deploy. This will keep recurring
  with several branches/worktrees active in parallel (see `git worktree list` — a dozen-plus
  open at once is normal here). Needs a real fix, not a repeated one-off
  `functions:delete` — options roughly: (a) give each in-progress branch its own preview
  Firebase project/channel instead of sharing `kidclub-dev` wholesale, (b) scope CI's deploy
  to `--only functions:<changed-ones>` instead of a full sync so it never considers deleting
  functions it doesn't know about, (c) some convention/discipline around manually-deployed
  test functions being cleaned up before pausing a branch. Not scoped further — flagging as
  the next thing to design, per Renato's explicit instruction.
- **Billing records don't react to a subscription changing mid-cycle** (surfaced 2026-09-21,
  Renato's explicit instruction: "that reveals a problem we haven't addressed — update the
  notes so we can deal with it"). A billing record (`billing/{familyId}_{yyyy-mm}`) is a
  snapshot generated once (`computeLineItems()`) and then edited in place (exclusions,
  status). Nothing re-syncs it when the underlying subscription changes afterward — schedule
  edit, cancellation, price change, discount change. Concretely hit this with Beatriz
  Apóstolo's transport: a parent-submitted cancellation request wiped the live subscription's
  `schedule` to `[]` pending admin review, while September's already-generated billing record
  kept its own cached (now stale) `scheduleDays`/`tripsByDay` — so editing exclusions on that
  record recomputed deductions against a schedule that no longer existed, silently zeroing
  them out. Worked around this one instance by reverting the subscription (see section 6), but
  the general question is unanswered: **what should happen to a billing record already
  generated for the current period when its subscription is edited, cancelled, or has a
  pending change requiring review?** Needs a real design decision — options roughly are (a)
  freeze the record's own cached schedule/price as the source of truth for that period no
  matter what the live subscription later does (probably right for a period already in
  progress), (b) recompute in place when the subscription changes, prorating for the change
  date, or (c) block subscription edits/cancellations from taking effect until the current
  period's billing record is closed/paid. Needs to account for both admin-approved changes and
  client self-service requests (like this cancellation) that sit in a pending-review state.
  Not scoped further than this — flagging as the next thing to design, not started.

  **Audit of pending billing records, done 2026-09-21** (per Renato: a dedicated agent is
  being spun up to design the proper architecture for this whole area — subscription-change
  sync AND the double-discount backfill below — this audit's findings are input for that
  effort, not yet acted on individually):
  - Scanned all 164 pending `billing/*` records for `excludedDates` entries that don't land on
    a real schedule weekday (the symptom of both the timezone-shift bug and the plain
    deduction-math bug, both now fixed in code but not retroactively applied to
    already-computed amounts).
  - **Susete Luis / Beatriz Apóstolo** (`A7OXOljX1W9xrEn5mhP8_2026-09`) — the case that started
    this whole investigation (see section 6). Fully corrected by hand: total **€90** (study
    €24/4 exclusions, transport €6/7 exclusions), subscription's `schedule`/`scheduleDays`/
    `tripsByDay` all restored. Took four manual prod writes to land correctly — two of them got
    silently overwritten by `onTransportBillingSync` firing (with execution delay) off an
    unrelated subscription write and recomputing using whatever `excludedDates` happened to be
    in the record at that moment. **Real finding, separate from the architecture question**:
    `onTransportBillingSync`/`onStudyroomBillingSync` fire on *every* write to a subscription
    doc and immediately recompute that family's whole billing schedule — there is no debounce
    and no ordering guarantee relative to a concurrent manual/admin edit of the same billing
    record. Worth the new agent considering as part of the redesign, not just the "subscription
    changed" case.
  - **Mafalda Raposo Duarte** (`JlqSRknVxyzaJfYP2WiM_2026-09`) — **still under-billed, not yet
    corrected**. Study-room line item: schedule is Tue/Wed/Fri, 5 dates excluded but only 2
    (both Tuesday) are real; stored amount (€35.70) reflects the old pre-fix math (all 5
    counted). Correct amount is **€51** (verified against her transport line item on the same
    record, whose math was already correct and computes exactly that for the same discount
    rate). Under-charged by €15.30 on this one line item. Needs the same kind of backfill as
    the double-discount bug below — good candidate to fix via whatever `backfillBillingSchedules`
    run addresses that one, rather than another one-off hand patch.
  - Diogo Mogo, Bernardo Mogo, José Eduardo (all transport, `nnBmdqT7MEL3tNeTQqbM_2026-09` /
    `zsKcaaic4P5nhDP6Z2Ms_2026-09`) — each has one stray `2026-09-06` (Sunday) in
    `excludedDates` alongside a legitimate ~7-day absence block on real schedule days.
    Confirmed harmless: transport's deduction math already correctly ignores non-schedule-day
    entries, so it's a €0-impact data oddity, not a bug instance. No action needed.
  - **Unrelated oddity spotted in passing, flagging only**: José Eduardo's line item title
    lists his schedule days twice (`"2ª, 3ª, 4ª, 5ª, 6ª, 3ª, 4ª, 5ª, 6ª"`) and his gross (€216)
    looks too high for a 5-day/week schedule at the standard rate — possibly a duplicate
    schedule-entry bug on his subscription doc. Not investigated further, not part of this
    audit's scope, just noted so it isn't lost.
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
