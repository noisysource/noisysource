# STATUS — Finances (FinHub)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-21 — **PAUSED mid-testing at Renato's request** (a bigger prod issue
came up needing this same dev environment). Resume by reading this whole section before touching
anything — there's an unresolved bug at the bottom blocking further testing.

## Currently working on
Branch `agent/financial-events-model` (yes, that name — this branch originally was KidClub-only,
then this app's whole cost-model task (`agent/noisyphocus-cost-model`) was merged into it so both
halves land as one PR against `staging`, since KidClub's Resumo Financeiro reads exactly the
`costSummary` shape this app writes and testing them separately wasn't useful). PR not yet opened
(`gh` CLI genuinely not installed on this machine, confirmed, not a sandbox thing) — open manually,
`--base staging`: https://github.com/noisysource/noisysource/pull/new/agent/financial-events-model.
See `apps/noisyphocus/kidclub/STATUS.md`'s matching section for the KidClub-side half.

**What shipped, in the order it happened:**

1. Original scope: extended `RecurringEntryDoc` with a `costModel: 'fixed' | 'commission'` variant
   (EasyPay's %-of-volume fee vs. Vendus's flat SaaS fee), added `/noisyphocus/costs`
   (`CostSummaryPage.tsx`) computing and writing `finances_entities/noisyphocus/costSummary/{yyyy-mm}`,
   and a Firestore rule so KidClub can read it (`isRainbowAdmin()`, read-only, that one path only).
2. **Cross-app reconciliation** (this was flagged as an open gap, then resolved): KidClub's
   `FinancialSummaryPage.tsx` was rewritten in the same merged branch to actually read `costSummary`
   cross-app, matching this app's write shape exactly — the "nothing reads this yet" gap from the
   original build is closed. Both halves were built in parallel by separate agents that couldn't see
   each other's work, hence the merge.
3. **Real bugs found once Renato started testing live on `kidclub-dev-finhub`** (in order found):
   - **Payroll showed NoisySource's contracts while viewing NoisyPhocus.** Root cause:
     `PayrollPage.tsx`'s company picker read from the global, un-scoped `finances_companies` list and
     defaulted to `companies[0]` regardless of the selected entity — the underlying contract data was
     already correctly entity-scoped, only the picker ignored entity. Fixed by matching company↔entity
     by name (same pattern `EmploymentContractsPage.tsx` already used correctly), with a `console.warn`
     fallback if the name match ever finds nothing.
   - **EC Contracts was the wrong tool for the teacher's freelance cost.** `EcContractDoc` models a
     *client paying us* (income direction) — wrong shape for an expense NoisyPhocus pays out. Fixed
     properly, not just relabeled: added `contractType: 'employee' | 'green_receipt'` directly to
     `EmploymentContractDoc` (`packages/shared/models/Employment.ts`). A green-receipt contract just
     forces `ssEmpPct`/`ssErPct` to 0 and hides Benefits at save time in
     `EmploymentContractsPage.tsx` — `buildPayrollPreview`'s existing `costToEmployerCents = gross +
     ssEr + benefits` math needed zero changes to come out correct. Removed the `ecContracts` input
     from `costSummary.ts` entirely — both contract types now flow through the same `employmentContracts`
     path. **Do not use `/noisyphocus/ec-contracts` for anything NoisyPhocus-related — it's for
     NoisySource's own client/freelance income only.**
   - **`deploy-finances.yml`'s dev job builds with prod Firebase config.** Real, pre-existing CI bug,
     nothing to do with this branch: the dev job ran plain `pnpm --filter finances build` (Vite's
     default "production" mode → `.env.production` → `rainbow-prod-2454b`) then deployed that bundle
     to `kidclub-dev`'s hosting site. Prod's Firebase API key has an HTTP-referrer restriction that
     doesn't include `kidclub-dev-finhub.web.app`, so every Firebase SDK call (installations,
     analytics, identitytoolkit) 403s in the browser — this is what Renato saw. Fixed: dev job now
     uses `build:staging` (`.env.staging` → `kidclub-dev`), matching what the prod job already
     correctly does with plain `build`. Same family of bug as the KidClub prod-deploy incident in
     root CLAUDE.md, mirrored here.
   - **`firebase.json`'s finances target had no cache-busting for the SPA's HTML.** Default 1-hour
     `cache-control` on every response meant a fresh deploy could sit invisible in a browser for up to
     an hour. Tried `"source": "/index.html"` first — doesn't work, only matches a literal request for
     that exact path, not `/` or any client-side route (all served via the `** → /index.html` rewrite,
     and Firebase matches header rules against the *originally requested* path, not the rewrite
     destination). Broadened to `"source": "**"` — confirmed via `curl -I` that `/` now serves
     `no-cache`. Trade-off: also stops long-caching the hashed JS/CSS assets, irrelevant at this app's
     2-user scale.
   - Manually deployed the corrected `build:staging` bundle to `kidclub-dev-finhub` twice (once before
     discovering the cache-header bug, once after) — both via local `firebase deploy --only
     hosting:finances --project=kidclub-dev`, since `deploy-finances.yml`'s `workflow_dispatch` only
     ever builds from `staging`, not this unmerged branch.

**UNRESOLVED — blocks further testing, start here next session:** After all the above, Renato still
could not see the EasyPay commission toggle ("Modelo de custo" Fixo/Comissão) on
`/noisyphocus/recurring`, even after a hard refresh. Verified independently and ruled out:
- The code is real and correct (`RecurringPage.tsx` shows the toggle whenever `form.type === 'expense'`,
  which is the form's default — should be visible immediately on "+ Nova entrada", no extra clicks).
- The deployed bundle contains it: `curl`'d the live JS from `kidclub-dev-finhub.web.app` directly,
  found "Comissão" and 14 references to `commissionPct` in it.
- Cache is very unlikely to still be the cause: `curl -I` on `/` after the header fix + redeploy shows
  `cache-control: no-cache` — a hard refresh should have picked this up.

**Not yet tried / hypotheses for next session, roughly in order of likelihood:**
1. **Wrong hosting site.** `firebase hosting:sites:list --project=kidclub-dev` shows FOUR sites:
   `kidclub-dev`, `kidclub-dev-arcoiris`, `kidclub-dev-domotics`, `kidclub-dev-finhub`. Confirm Renato
   is actually on `https://kidclub-dev-finhub.web.app` and not `kidclub-dev.web.app` (the bare default
   site — unclear what, if anything, is deployed there; could be blank, could be something stale and
   totally unrelated).
2. **Not actually on `/noisyphocus/recurring`.** Confirm the entity switcher is on NoisyPhocus (the
   toggle only shows for `type === 'expense'`, which is the default — but confirm the "+ Nova entrada"
   button was actually clicked and a modal opened at all).
3. **A JS runtime error is breaking the page silently.** Wasn't checked — open browser devtools
   console on that exact page/URL and look for uncaught errors, not just network 403s (those should be
   gone now, but a stale service worker or a different error could still block rendering).
4. **Screen-share or a fresh screenshot** — fastest way to actually see what Renato sees rather than
   guessing further blind.

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

**SUPERSEDED — EC contracts direction note:** the paragraph that used to be here (about reusing
`EcContractDoc` for the teacher) described a real problem that has since been **fixed properly**, not
just documented as a quirk — see "EC Contracts was the wrong tool" above. Use
`/noisyphocus/contracts` with `contractType: green_receipt` for the teacher; do not use
`/noisyphocus/ec-contracts` for anything NoisyPhocus-related.

## Next step
1. **First, resolve the unresolved bug above** (EasyPay commission toggle invisible to Renato) —
   don't proceed to data entry until `/noisyphocus/recurring` actually shows the Fixo/Comissão toggle
   for Renato, or you'll be debugging on top of an unconfirmed base.
2. Once confirmed working, Renato needs to enter NoisyPhocus's real numbers before `costSummary`
   produces anything non-zero — **this is a hard prerequisite**, nothing here is seeded/faked:
   - `/noisyphocus/contracts` — the driver as a normal `contractType: employee` contract (gross
     monthly, IRS/SS rates, benefits if any), following the pattern of NoisySource's existing
     contracts (Renato/Marisa); the teacher as `contractType: green_receipt` (just gross monthly +
     retenção na fonte %, no SS fields to fill in — they're forced to 0 automatically).
   - `/noisyphocus/recurring` — two expense entries: Vendus's real monthly fee (`costModel: fixed`,
     real IVA rate) and EasyPay's real commission (`costModel: commission`, real `commissionPct`,
     real IVA rate).
   - Once those exist, open `/noisyphocus/costs` and confirm the numbers look right for the current
     month before relying on `costSummary` anywhere.
3. Loop back to KidClub's Resumo Financeiro (already wired to read `costSummary` — see KidClub
   STATUS.md) and confirm the staff/software/VAT cost figure actually shows up there, replacing "não
   configurado". This is the real end-to-end confirmation that was interrupted by the pause.

## Open questions for Renato
- (Resolved) Whether KidClub's Resumo Financeiro should read `costSummary` — yes, it now does, both
  halves were reconciled in this same branch.
- Is "IVA dedutível on this month's software costs" the right definition for `costSummary.vatCents`,
  or did you have the full quarterly net VAT position (income − deductible) in mind? Went with the
  narrower one since it's an actual monthly cash cost and doesn't require pulling in KidClub's Vendus
  income VAT (a separate cloud function call) into what's meant to be a *cost* summary.

## Anything risky in flight
- PR not yet opened (branch `agent/financial-events-model`, pushed, needs manual `gh`-less creation
  — see "Currently working on" above for the link). Not merged/reviewed.
- **`kidclub-dev-finhub.web.app` has been manually deployed twice from this unmerged branch**
  (`firebase deploy --only hosting:finances --project=kidclub-dev`, local, dev project only — never
  touched prod or `staging`). This is intentional (the normal `workflow_dispatch` deploy only builds
  from `staging`, which doesn't have this branch's fixes yet), but means dev is currently running
  code that isn't merged anywhere — don't be surprised if `staging`/`main` "look different" from what
  dev is showing right now.
- `firestore.rules`'s new `costSummary` read rule IS live on `kidclub-dev` (came along with KidClub's
  side of this branch, which auto-deploys via `deploy-dev.yml` on every push to this PR — see KidClub
  STATUS.md). Not live on prod.
- Also fixed, real pre-existing bug unrelated to this feature: `deploy-finances.yml`'s dev job used
  to build with prod Firebase config (see above) — this was silently broken for however long that
  workflow has existed, not something this session introduced. Now fixed on this branch; will apply
  to real `workflow_dispatch` runs once merged to `staging`.
- No new metered API calls — everything reads existing Firestore collections (KidClub's `billing`,
  Finances' own entity-scoped collections) or an existing Vendus API call (`getKidclubVatSummary`,
  pre-existing, not added this session).
