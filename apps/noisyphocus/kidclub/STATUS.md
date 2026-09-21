# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-21

## Currently working on
Fixed a second real billing bug found in prod (separate from the double-discount bug below,
which is already merged — PR #13, `1a4aaec`): `computeExclusionDeduction()` for `type === "study"`
in `functions/src/kidclub/billing.ts` counted every entry in a line item's `excludedDates`
with no check that the date actually fell on one of the subscription's real schedule days
(`sub.days`). The `transport` branch right below it already did this correctly. Found via a
prod family with 7 study `excludedDates` but only 3 real Wed/Fri schedule days — the other 4
(Tue/Thu) still fully counted as deductions, undercharging by 4 days. Renato hand-corrected
that one prod record (`_apps/arcoiris/billing/A7OXOljX1W9xrEn5mhP8_2026-09`) directly; this
session was the code fix so it can't recur.

**Fixes made** (branch `agent/study-exclusion-validation`, commit `188d117`, not yet PR'd/merged):
1. `computeExclusionDeduction("study", ...)` now mirrors the transport branch — only deducts
   for excluded dates whose weekday is in `sub.days.map(d => d.day)`.
2. `setBillingLineItemExcludedDays` (the callable behind the "Dias" modal) now applies the same
   schedule-day check when validating dates to save, not just period-range — so a bad date can't
   be saved from the client either.
3. UI symptom fix: `ServiceCalendar` in `BillingAdminPage.tsx` only rendered a clickable toggle
   for schedulable days, so an orphaned `excludedDates` entry (date not on a current schedule
   day — however it got there) had no UI control to remove it. Added a small removable-chip list
   below each calendar for exactly these orphaned entries, so an admin can clean them up.
4. **Deliberately not changed**: `computeLineItems()`'s carry-forward of `excludedDates` from the
   prior billing record still copies entries verbatim, even ones that no longer match the
   subscription's *current* schedule (e.g. after a schedule change). This is the likely root
   cause of how the prod orphan appeared in the first place. Left alone because (a) the
   deduction fix above already makes a stale entry harmless financially, and (b) auto-dropping
   it here would hide the entry from the new orphan-cleanup chips in fix #3 — an admin couldn't
   see/confirm it was there. Worth a follow-up decision: silently drop on carry-forward, or keep
   surfacing it for admin review as done here.

Typechecked clean: `pnpm --filter functions exec tsc --noEmit` and
`pnpm --filter kidclub exec tsc --noEmit` (kidclub has several pre-existing unrelated errors,
same set present on `main` before this change — confirmed by diffing). Not deployed anywhere
yet; PR not opened yet.

---

Previous session (2026-09-19, PR #13, already merged into `main` as of `1a4aaec`) —
investigated "igbpinto@gmail.com's billing looks wrong" (Renato's ask: monthly amount
should be base price − multi-trip discount − school discount). Confirmed in **prod** (read-only,
via `gcloud auth print-access-token` + Firestore REST — no prod service account key exists,
per org policy): her transport subscription (Carolina Almeida, `XiblZZlEVZHsSLFdN5z5`) has
gross €240/month (10 trips × €6 × 4 weeks), 20% school + 10% multi-trip discount → correct
billed amount is **€168**, but her billing page showed **€117.60** — the 30% discount was
being applied twice.

Root cause: `computeLineItems()` in `functions/src/kidclub/billing.ts` read
`sub.originalFee ?? sub.monthlyFee` as the *gross* transport fee. But
`discountRecalc.ts` overwrites `monthlyFee` with the already-discounted price whenever a
discount fires, and subscriptions created via the client self-enroll (offer/accept) flow never
get `originalFee` set at all — so billing silently re-applied `appliedDiscounts` on top of an
already-net price. This under-bills, it doesn't overcharge.

**Scope check (prod, read-only): 8 of 23 active transport subscriptions** are missing
`originalFee` while carrying discounts — same bug, same under-billing, affecting: José Eduardo,
Vasco Moura, Maria Manon, Diogo Mogo, Carolina Almeida (Inês Pinto), Bernardo Mogo, Gil
Figueiredo, Leonardo Marques. Study room subs are NOT currently affected (0 of 14 missing
`basePrice`), but `discountRecalc.ts`'s study-side gross calc (`x.basePrice ?? x.monthlyPrice`)
has the same latent shape of bug — not fixed here, no live instance found, flagging only.

**Fix applied:** `functions/src/kidclub/billing.ts` now derives transport gross from
schedule length × `flatRatePerTrip` × weeks-in-pattern (mirrors `discountRecalc.ts`'s own
formula) instead of trusting `originalFee`/`monthlyFee`. Committed on branch
`agent/billing-double-discount-fix`, pushed, **PR not opened** (no `gh` CLI in this session) —
open from https://github.com/noisysource/noisysource/pull/new/agent/billing-double-discount-fix.
Typecheck passes; **not deployed anywhere yet**.

**NOT done — needs a decision + prod write access (deliberately not done in this session,
per CLAUDE.md's no-standing-prod-write-access rule):**
1. Deploy this fix to dev, verify a transport billing line item matches the sub's `monthlyFee`.
2. Deploy to prod (`deploy-functions.yml` is manual `workflow_dispatch` — stays that way).
3. **Backfill the 8 affected families' pending billing records** — their Sept 2026–Aug 2027
   `billing/{familyId}_{yyyy-mm}` docs currently have the double-discounted (too-low) `total`
   and need recomputing once the fix is live. `backfillBillingSchedules` (already exists,
   owner/rainbowAdmin-gated callable) should do this correctly once deployed, but confirm on
   dev first — running it recomputes ALL families' billing, not just these 8.
4. Decide whether to also proactively backfill `originalFee` onto existing subscription docs
   so this can't recur even if the schedule/config-derived fallback ever goes stale.

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
- Branch `agent/impersonation-billing-fix` pushed, PR not yet opened (no `gh` CLI in this
  session — compare link: https://github.com/noisysource/noisysource/pull/new/agent/impersonation-billing-fix).
- `pnpm --filter kidclub build` and `build:staging` both succeed, no new type errors.
- Deployed to **kidclub-dev** (build:staging) — https://kidclub-dev-arcoiris.web.app, 200 OK.
  NOT smoke-tested behind login in that environment.
- **Deployed straight to prod hosting** (`pnpm --filter kidclub build` — plain, not
  build:staging — + `firebase deploy --only hosting:kidclub --project=rainbow-prod-2454b`),
  at Renato's explicit request, bypassing the usual PR-merge-triggers-deploy flow. Confirmed
  both https://kidclub.pt and https://rainbow-prod-2454b-arcoiris.web.app respond 200.
  NOT smoke-tested behind login on prod either.

## Next step
0. **New (this session): open the PR for `agent/study-exclusion-validation`** (study exclusion
   schedule-day validation fix, commit `188d117`), get it reviewed/merged, deploy functions to
   dev then prod. Low urgency financially (the bug under-charges, doesn't over-charge) but it's
   confirmed live in prod until this deploys. No backfill needed — the fix only changes how
   *future* recomputes treat `excludedDates`; the one known-bad prod record was already
   hand-corrected by Renato directly.
1. ~~Open + merge the billing double-discount PR~~ — **done**, PR #13 merged (`1a4aaec`). Confirm
   it's actually deployed to prod functions (not just merged to `main`) before considering this
   fully closed — deploy is still manual `workflow_dispatch`.
2. If not already done, run/trigger `backfillBillingSchedules` (owner/rainbowAdmin
   callable) to recompute the 8 affected families' pending billing totals — check the result
   counts against the 8 names listed above before trusting it's fully caught.
3. **`main` on GitHub does NOT have the impersonation-billing-fix commit yet** — prod hosting
   was pushed straight from that branch, so the deployed bundle and `main` are still out of
   sync. Open the PR and merge it, so the next push-to-main deploy doesn't revert it
   (`build-and-deploy-kidclub.yml` deploys hosting on every push to `main`).
4. Smoke test impersonation-billing-fix on prod: impersonate a family with real `billing`
   records, open `/client/payments`, confirm records show up.
5. Separately, decide on the "As minhas faturas" feature work (see above) and scope it as
   its own task when ready.

## Open questions for Renato
- Billing fix: OK to run `backfillBillingSchedules` against **prod** once the fix is deployed?
  It recomputes every family's billing, not just the 8 affected ones — low risk (it's the same
  logic already running on every subscription write) but it is a prod write, flagging per the
  no-standing-write-access rule.
- Otherwise: just the `main` merge for the impersonation fix (to resync source with what's
  live) and a prod smoke test.

## Anything risky in flight
- **8 active prod transport subscriptions are currently under-billed** (double-discounted,
  see above) until the `agent/billing-double-discount-fix` PR merges, deploys, and a backfill
  runs. No prod data was changed investigating this — reads only, via `gcloud` access token
  against the Firestore REST API (no prod service account key exists on this machine, matches
  org policy). Worktree `.claude/worktrees/billing-double-discount-fix` still exists — remove
  it once the PR is merged.
- **Prod hosting was deployed ahead of `main`** — `agent/impersonation-billing-fix` is live
  on kidclub.pt but not merged. Until merged, `main` doesn't reflect what's actually running
  in prod, and the next push-to-main deploy will silently revert this fix unless that push
  also contains it. Merge the PR (link above) to close this gap.
- Unrelated, still open from a prior session: `git worktree list` shows several stale
  worktrees not cleaned up (`claim-studyroom-fix`, `deploy-functions-workflow-fix`,
  `kidclub-cicd-automation`, plus some pre-convention ones outside `.claude/worktrees/`).
  Worth Renato clearing out whichever are merged/abandoned.
- Also unrelated, paused mid-session on 2026-09-18: a unified client calendar
  (`agent/family-calendar` branch, `/client/calendar`) for cancelling study/transport days
  in one place instead of per-subscription. Built, builds clean, not deployed/reviewed yet.
  Needs a Firestore composite index deployed (`firestore.indexes.json`, committed on that
  branch) before it's usable — see that branch's own state for details, picking back up was
  put on hold to investigate the Marisa billing issue.
