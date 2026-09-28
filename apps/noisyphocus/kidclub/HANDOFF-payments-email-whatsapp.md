# HANDOFF — payments, email, WhatsApp

Written 2026-09-28 for the next session. Three workstreams, in this order. Read `STATUS.md` →
"LIVE IN PROD SINCE 2026-09-27" and "🔴 Open" first (10 minutes).

**One worktree and branch per workstream**, each off `staging`, each PR into `staging`. Renato tests on dev
and does every merge. Don't start the next workstream on the same branch. Update `STATUS.md` as you go.

Before you touch anything:
- Payments are **live money**. Load `.claude/skills/sandbox-first-billing/SKILL.md` before any Easypay
  or Vendus code.
- WhatsApp is a **new metered API**. Load `.claude/skills/new-metered-api-checklist/SKILL.md` before
  the first line of it.
- **Edits to `functions/src/kidclub/billing.ts` were blocked by Claude Code's auto-mode permission check**
  in the last session. Ask Renato to approve that file for the task up front, and don't work around a denial.
- **Never write to prod data yourself.** Reading prod: use `gcloud auth print-access-token` against the
  Firestore REST API (see `.claude/skills/prod-data-check`). Writing prod: give Renato the exact field
  changes and he does them in the console. That's what happened for Marisa, and it worked.

---

## 1. Payments — make a failed payment payable again (do this first)

### Where things stand
- **MB WAY is the only method on the parent Payments page** (hotfix #53, live). Card fails at Easypay with
  "does not have a POS associated": the Easypay account has no card terminal. That's an account setting
  Renato has to sort with Easypay, not code. Multibanco was hidden along with card.
- **The bug that makes MB WAY-only risky:** an MB WAY request the parent doesn't approve in time comes back
  from Easypay as `expired`/`failed`. The webhook sets the bill to `failed`. Then:
  - `PaymentsPage.tsx` only shows "Pagar agora" for `pending`, so there's no button;
  - `initiateMbwayPayment` rejects anything but `pending` (`Already processed (status=failed)`);
  - the month is stuck, and with pay-in-order (#47), **so is every later month**.
- Same class of problem: a card/Multibanco attempt left `processing` has no way back for the parent. That's
  what happened to Marisa Sofia (`8pPhu4JCvGUrpBxsaOeY_2026-09`). Renato reset it by hand: `status` →
  `pending`, and deleted `easypayId`/`paymentLink`.

### The fix (was fully written once, then blocked; redo it)
In `functions/src/kidclub/billing.ts`:
1. Add `const UNPAID_STATUSES = new Set(["pending", "failed"])`.
2. `assertEarlierMonthsPaid`: an earlier month blocks if its status is in `UNPAID_STATUSES`, not only `pending`.
3. `initiateMbwayPayment`: accept `UNPAID_STATUSES`. It already overwrites `easypayId` with the new payment.
4. `initiateMultibancoPayment` and `initiateCardPayment`: throw `failed-precondition` "Pagamento temporariamente
   disponível apenas por MB WAY" first thing, so a page loaded before the hotfix can't start one. Remove this
   when Easypay has a card POS.

In `apps/noisyphocus/kidclub/src/pages/client/PaymentsPage.tsx`:
5. `isPayable` (added in #53, currently `pending` only) → `pending || failed`. It already drives the button,
   the checkbox, the batch and the in-order message, so that one line switches them all.
6. On a `failed` bill, show "O pagamento anterior não foi concluído. Pode tentar de novo."

Then decide with Renato about bills stuck in `processing`. Options: a "Cancelar pagamento" for the parent that
resets to `pending`, or an admin action in the family panel's Cobranças section (`FamilyBills.tsx`). The admin
action is safer: the parent can't abandon a payment that might still land. Either way, check Easypay first that
the old payment wasn't paid.

### Also on this workstream
- **Find other stuck bills in prod** (read-only): any `processing` older than a day, or `failed`. List them for
  Renato; don't reset them yourself.
- **Card/Multibanco back:** once Renato says Easypay has a card POS, restore the two buttons (see #53's diff)
  and remove the server-side refusal from step 4.
- **Test on dev:** real Easypay calls are blocked from `kidclub-dev` (`functions/src/externalGuard.ts`). Check
  whether the Easypay sandbox is wired for dev before assuming anything works end to end.

---

## 2. Email — fix sending, then refactor

### Where things stand
- **No app email has been delivered since 2026-08-01.** 116 failures, all `invalid_grant: Not a valid email or
  user ID`. Parents get no approval, rejection or payment-notice emails. With MB WAY-only, a payment notice
  matters more.
- **How it works today:** code adds a doc to `_apps/arcoiris/emailOutbox`. `functions/src/SendEmailFromOutbox.ts`
  (`onDocumentCreated`) leases it (`queued` → `processing`), then sends through the **Gmail API** as a service
  account impersonating `admin@kidclub.pt` via **Workspace domain-wide delegation**. The key comes from the
  secrets `SA_CLIENT_EMAIL`/`SA_PRIVATE_KEY`. There's a kill switch: `settings/globals.emailsEnabled`.
- **Who writes to the outbox:** `kidclub/notifications.ts` (approval/rejection on status change),
  `kidclub/billing.ts` (payment notices, 2 places), `kidclub/camp.ts` (2), `billingCutoff.ts`, and the admin
  Email Center through `src/services/emailService.ts`.
- **Likely cause, unconfirmed:** the delegation for that service account was removed or changed in Google
  Workspace, or the key was disabled. **The org policy blocks creating service-account keys** (same wall the
  domotics Pi bridge hit), so "make a new key" may not be possible.

### Step 1 — diagnose (read-only, report to Renato before changing anything)
- Confirm the error on a recent failed outbox doc in prod.
- Check in GCP that the SA and its key still exist and are enabled (`gcloud iam service-accounts keys list`).
- Workspace admin (Renato): Security → API controls → Domain-wide delegation. Is the SA's client ID there with the
  `gmail.send` scope?

### Step 2 — pick the sending path with Renato
- **(a) Repair delegation.** Smallest change, if the key is still valid.
- **(b) Keyless delegation.** The function's runtime SA signs a JWT through the IAM Credentials API `signJwt` and
  impersonates the Workspace user, with no key file. This fits the no-keys org policy.
- **(c) A transactional email provider** (SMTP/API). Metered, so it needs the checklist and a cap.
- Recommend (b) if (a) needs a new key.

### Step 3 — refactor (after sending works)
- One place that builds emails, with templates per type: approval, rejection, payment notice, receipt, camp.
  Today HTML is assembled inline in each caller.
- Outbox docs record `type`, `familyId` and `billingId`/`subscriptionId`, so the admin family panel can show
  "emails sent to this family". The panel already has the space.
- Retries with a cap and backoff for transient errors. No infinite loops: see the Cost & Production Safety rules
  in the root CLAUDE.md.
- Before switching sending back on, **decide what happens to the ~116 failed and any queued emails**. Don't let a
  fix mass-send two months of stale notices. Mark them `skipped` unless Renato says otherwise.

---

## 3. WhatsApp — plan first, don't build yet

Renato's idea: message parents on WhatsApp, probably payment notices and reminders, maybe approvals.
**This session produces a written proposal and questions, not code.**

Cover:
- **Which API:** the WhatsApp Business Platform (Meta's Cloud API), directly or through a provider. Needs a Meta
  Business account, a dedicated phone number, a verified business, and **pre-approved message templates** for
  anything the business starts.
- **Cost:** Meta charges per message/conversation by category (utility, marketing, …) and country. Get current
  Portugal pricing. Estimate monthly volume from real numbers (~40 families × a few notices a month). Per the
  checklist: **a hard cap at the provider plus a per-day cap in code**, before anything ships.
- **Consent (GDPR):** parents opt in to WhatsApp, stored per family (e.g. `families/{id}.whatsappOptIn` with
  date and number) and editable in the admin panel and on A minha conta. No opt-in, no message.
- **Architecture:** mirror the outbox. A `whatsappOutbox` collection plus a sender function, or one outbox with a
  `channel` field once the email refactor lands. So do email step 3 before WhatsApp.
- **Which messages** go by WhatsApp, email, or both.
- **Questions for Renato:** which number, who owns the Meta Business account (Noisy Phocus?), which messages,
  budget ceiling.

---

## Smaller item, if time allows (separate branch)
**Duplicate family records on first login.** `familyService.getOrCreateFamily`
(`src/services/familyService.ts`) runs from ~10 client pages. On a parent's first login several run at once, each
finds nothing, and each creates a family: Carla Silva got 3. Renato cleaned up the prod duplicates by hand. Fix:
- share one in-flight promise per user id;
- create new families with `setDoc(docRef('families', userId), …)`, so concurrent creators write the same doc.
  Existing families keep their ids; the lookup stays a query on `primaryContact.userId`.
- The admin list's "⚠ Possível duplicado" chip shows any new cases.
