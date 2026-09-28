# HANDOFF — one admin page for families and subscriptions

> **Built** on `agent/kidclub-admin-unified` (2026-09-28). See STATUS.md → "In review: one admin page".
> Kept for its "Things that will bite you" list, which still applies to the page.

Written 2026-09-28 for the next session. Read `STATUS.md` → "LIVE IN PROD SINCE 2026-09-27"
first (5 minutes). It explains what is live and what must not be touched.

## The goal (Renato's words)

> "Refactor both the families and subs into a single page with filtering and editing,
> status change etc."

Today there are two admin pages that overlap:

| Page | Route | File | Size | What it does |
|---|---|---|---|---|
| **Famílias** | `/admin/families` | `src/pages/admin/FamiliesAdminPage.tsx` | 426 lines | **Read-only.** Lists families with contact, NIF, children and an "orphaned subscriptions" section. It can't edit anything. |
| **Inscrições** | `/admin/subscriptions` | `src/pages/admin/SubscriptionsAdminPage.tsx` | ~2,000 lines | Grouped family → child → subscriptions (since #31). It edits everything *except* NIF and billing address. |

The target: **one page** where an admin finds a family, sees its children and their
subscriptions, and edits any of it, filtering by status, service and the like. Then retire the other
page (or redirect its route).

## Why this came up

On the night of go-live Renato went to fix a parent's NIF (Mafalda Raposo Duarte: her paid
September invoice failed in Vendus because the NIF fails the checksum) and found **no admin
screen can edit a NIF or a billing address**. Only the parent can, in `client/AccountPage.tsx`.
Child and guardian details *are* editable, but hidden behind two ✏️ icons in Inscrições. They
moved there in #31 (`ec97f46`), which read as "the fields disappeared".

## What already exists in `SubscriptionsAdminPage.tsx`: reuse, don't rewrite

- **`ChildDetailsForm`** (~line 206) writes `children/{childId}`: name, date of birth, school,
  school year, home address. It warns when the school changes, because the `auto_school` discount
  (Bissaya) depends on it.
- **`FamilyContactForm`** (~line 369) writes `families/{id}.primaryContact`: guardian name, email and phone.
- Both **mirror** `childName`, `schoolName` and `contactEmail` onto every affected subscription in one
  pass, because `functions/src/kidclub` still reads those mirror fields. **Keep that mirroring**, or
  billing titles, the school discount and the parent↔subscription link will drift.
- **`EditForm`** edits per-subscription fields only: schedule, week pattern, discounts, fee, internal note.
- It also has:
  - status change;
  - review flags (`clientReviewPending` / `adminReviewPending`);
  - the discount picker, which writes `discountOverrides`, each entry true (force on) or false (force off). That is decision 11 in STATUS.md;
  - "Repor automático", which clears the overrides;
  - a create/manual-enroll form;
  - the reload button, needed because the page doesn't live-update.

The cleanest route is probably to **extend Inscrições into the single page**, not to build a
third one. Pull `FamiliesAdminPage`'s useful parts in (search by name, email or NIF, the orphaned
subscriptions section), then redirect `/admin/families` → `/admin/subscriptions`. Confirm with Renato first.

## Must add (the gaps that triggered this)

1. **NIF and billing address** (`families/{id}.nif`, `families/{id}.billingAddress {street, city,
   postalCode, country}`) in the family editor. Validate the Portuguese NIF checksum client-side:
   9 digits, weights 9..2, check digit = 11 − (sum mod 11), 0 if ≥ 10.
   `syncVendusClient` fires on every `families` write and upserts the client in **live Vendus**.
   That's intended (it's how the corrected NIF reaches Vendus), but every save is a real external call.
2. **Invoice errors.** Show `billing/{id}.invoiceError` on the family, and add a **"Tentar faturar
   novamente"** button that calls the existing callable `retryVendusInvoice({ billingId })`.
   There is no UI for either today. Mafalda's record is `JlqSRknVxyzaJfYP2WiM_2026-09`.

## Things that will bite you

- **A status change can email the parent.** `pending → active/confirmed` sends "Inscrição aprovada".
  `pending → cancelled` sends a rejection (`functions/src/kidclub/notifications.ts`). Any bulk or
  quick status control must make that obvious. Cancelling a sub also closes out its future events
  (`closeOutSubscription`) and re-computes billing.
- **Any write to a subscription fires 3 triggers:** discount recalc, billing recompute (rewrites
  `pending` bills from the current month) and event regeneration on schedule/status/date changes.
  Paid and invoiced bills are never rewritten. Don't write fields "just to save the form"; write
  only what changed.
- **Don't touch `enrollmentFeeBilled`.** It means "the €35 + €25 fee is on a bill", not "paid".
- **Months are paid in order** now (#47), enforced in the payment functions. If a September bill is
  wrong, that family can't pay October until an admin fixes September. That makes fast editing on this page more important.
- **Prod is the source of truth.** Never run `scripts/kidclub-migration/promote-subscriptions.mjs` again.
- **App email is broken** (since 2026-08-01, STATUS.md open item #1). Don't assume a parent
  received any email the page triggers.

## Workflow (this repo's rules, and lessons from go-live)

- One worktree and one branch **off `staging`**. PR into `staging`, which deploys to `kidclub-dev`. Renato tests on
  dev and merges. Then a `staging`→`main` PR deploys to prod when it's opened. **Renato does all merges.**
- **Never push to a PR that may already be merged.** Check with `gh pr view N --json state`. If it's merged,
  open a new PR. (#47 → #48 stranded two commits this way.)
- Typecheck baseline for the kidclub app is **13 errors**. Don't add new ones. `pnpm build` must pass.
- Test on dev. The roleless account `parent-test@kidclub.pt` owns `TEST-FAMILY-QA`, and all human dev
  accounts are staff.
- It's a 2,000-line file: split it into components as you go, and keep each commit reviewable.

## Ask Renato before building

1. **One page by extending Inscrições, retiring Famílias.** Or a new page?
2. **Filters:** which ones? Suggested: status (active / confirmed / pending / cancelled), service
   (transport / study room), "has unpaid or overdue months", "invoice error", "review pending", "no family / orphan",
   plus a free-text search (child, guardian, email, NIF).
3. **Status change:** per subscription only, or also bulk? And should a cancel ask for a reason and a date?
4. **Billing on this page:** show each family's bills (status, overdue, invoice errors) inline, or
   only the invoice-error warning and a link to Cobranças?
5. **Families with no subscriptions** (e.g. registered but not enrolled): show them or hide them by default?
