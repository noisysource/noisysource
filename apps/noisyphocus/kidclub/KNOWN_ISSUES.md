# Known Issues / Follow-ups — KidClub

> Backlog of confirmed bugs, suspected risk areas, and deferred decisions surfaced during
> testing and go-live (2026-09-17). Not a changelog — see `git log` for what shipped. Pick
> items off this list in a future session; each entry has enough context to start cold.

## Confirmed bugs, not yet fixed

### UTC-conversion date bug, other locations
**What:** `BillingAdminPage.tsx`'s exclusion calendar stored the *previous* day for every
click — `toIsoDate()` built a `Date` from local `y/m/d` components, then serialized it via
`.toISOString().split('T')[0]`, which converts to UTC first. In Portugal's summer UTC+1
offset, local midnight of day N is 23:00 UTC on day N-1, so every click was silently off by
one. Fixed in `BillingAdminPage.tsx` (commit `3a11f18`) by formatting from local getters
directly instead of round-tripping through UTC.

**Where else this pattern might bite:** a repo-wide grep for `toISOString().split('T')[0]`
turned up ~25 call sites. Most are safe — they format a `Date` that was itself *parsed from*
a UTC ISO string (e.g. `<input type="date">` `max` attributes), so the round-trip cancels out.
The risky ones build a `Date` from local components (`new Date(y, m, d)` or similar) and then
serialize it the same broken way `toIsoDate` did. Confirmed candidates worth auditing:
- `apps/noisyphocus/kidclub/src/pages/client/ClaimSubscriptionsPage.tsx:54`
- `apps/noisyphocus/kidclub/src/components/Calendar.tsx` (multiple call sites, lines ~119-337)
- `apps/noisyphocus/kidclub/src/pages/client/camps/ClientCampsPage.tsx:39`

Not yet audited case-by-case — some of these may turn out to be fine on inspection (e.g. if
the `Date` was already constructed from a parsed ISO string). Worth doing that audit before
assuming they're all broken, but also before assuming they're all fine.

### Enrollment fee routing for mid-year joiners — open question, not yet answered
Raised during Vendus integration review: if a family joins in May (not September), does the
one-time "Taxa de Inscrição e Seguro" bill in May, or wait until September? Never explicitly
resolved — check `functions/src/kidclub/billing.ts`'s `maybeAddEnrollmentFee` logic against
the intended business rule before the next school-year rollover surfaces it as a live bug.

## Deferred by explicit decision (not bugs — just not done)

### Vendus sandbox
Dev (`kidclub-dev`) and prod (`rainbow-prod-2454b`) currently point at the **same live Vendus
account** — there's no sandbox. Vendus calls are disabled on `kidclub-dev` via an explicit
guard (`syncVendusClient.ts`, `billing.ts`'s `DEV_PROJECTS_WITHOUT_VENDUS_SANDBOX` check)
rather than fixed properly. Renato's call: "let's keep vendus disabled and we'll deal with it
later." Needs a real sandbox account + separate dev credentials before re-enabling.

### Pre-existing Vendus documents cleanup
~87 real fiscal documents (Fatura-Recibo, type "FR") were generated in Vendus from earlier
dev/prod testing before the sandbox gap was noticed. Renato flagged "87 sounds too much, are
we sure they all exist in both our app in vendus?" — not investigated further. Needs a
reconciliation pass (Vendus API vs `billing` collection) before deciding what, if anything,
to void/credit.

## Bigger idea, not scoped yet

### Attendance/presence tracking, separate from the billing "blueprint"
Renato's framing: a subscription's schedule is a *blueprint* (the recurring plan), not a
record of what actually happened. The billing exclusion-days feature (marking "child didn't
come") is currently the only place presence is recorded, and only for billing purposes. Worth
a real `presence`/`attendance` collection — keyed by date + child + service, distinct from the
subscription's recurring schedule — for audit and organizational purposes (which kids were
actually in the van / study room on a given day), independent of billing. Not designed yet;
treat as its own feature with its own data model, not an extension of the exclusion-days UI.

## Resolved this session (context, not action items)

For reference — these were found and fixed in the same investigation that produced the above,
in case any turn out to be related to a new report:
- `PaymentsPage.tsx` ignored admin impersonation, showing empty billing for any impersonated family.
- `computeExclusionDeduction()` (`billing.ts`) didn't validate excluded dates against the
  subscription's actual schedule (study: not at all; transport: via a live re-fetch that
  could drift from what generated the line item).
- `setBillingLineItemExcludedDays`'s response didn't tell the client which dates were
  actually kept, so the UI could show marked days that weren't really excluded.
- The UTC off-by-one bug above, which was the actual root cause behind all of the above
  looking like schedule-mismatch bugs during testing.
