# HANDOFF — Emails → expenses → invoices (FinHub)

> Written 2026-10-06 for the next agent picking this up cold. Read `STATUS.md` (same folder)
> first, then this. **Don't start building until Renato has answered the questions in §6**;
> several of them change the design, not just details.

## 1. What Renato wants

Expenses fully captured, each with its invoice attached, so that:
- the forecast and balances use **real** numbers (confirmed events), not only planned ones;
- each month, per company, there's a pack of invoices to send to the accountant.

Two sources:
- **Bank statements** (Renato provides them) = what was actually paid.
- **Email** = where ~90% of invoices arrive. Four mailboxes:
  - `admin@kidclub.pt` (Google Workspace, kidclub.pt domain)
  - `noisysource@gmail.com`
  - `renato343@gmail.com`
  - `geral.arcoirisdapequenada@gmail.com`

His design, in his words: an **Emails page** that reads from these accounts. Each email gets
marked as an expense, automatically when possible and by hand when not. The app then finds the
matching bank-statement line, attaches the email's invoice to it, and records it as a real
(confirmed) event.

Per-vendor API integrations (EasyPay, Anthropic, Google, Booking…) are **later, and only where
email can't supply the data**. Most vendors don't expose invoice PDFs via API; email covers them
all at once. EasyPay is the likely exception (per-payment fees feed the commission cost model).

## 2. What already exists (verified 2026-10-06, read the code before relying on it)

- **Bank import:** BPI XLSX only (`src/lib/parsers/bpiXlsx.ts`,
  `src/lib/api/domains/bankTransactions.ts`). Writes top-level `finances_bank_transactions/{id}`
  (deterministic id per tx, so re-imports dedupe) and `finances_bank_imports/{id}`. Each tx has
  `accountId` + `entityId`, so **the bank account already tells you which company an expense
  belongs to**. The model has unused `categoryId`, `recurringId` and `notes` fields; there's no
  document/attachment field yet. CGD, Montepio and Revolut have no parser.
- **Import sets the account balance** to the statement's closing balance (`balanceCents`,
  `balanceAsOf`).
- **Events:** `finances_events` (`FinanceEvent`, `packages/shared/models/FinanceEvent.ts`) has
  `status: planned | confirmed | cancelled | corrected`, `sourceType`, `sourceId` and
  `correctedBy`. Forecast events are mostly *computed* from templates
  (`packages/shared/lib/eventGenerators.ts`); only the Dashboard writes events today.
- **Gmail:** `functions/src/SendEmailFromOutbox.ts` sends mail with a service-account key from
  Secret Manager (`SA_CLIENT_EMAIL` / `SA_PRIVATE_KEY`) + Workspace domain-wide delegation
  (`google.auth.JWT` with `subject`). Scope is `gmail.send` only.
- **External-call guard:** `functions/src/externalGuard.ts` `assertExternalCallsAllowed()` blocks
  every real external call unless the project is `rainbow-prod-2454b`, because dev secrets hold
  the same live credentials as prod.
- **Storage:** `storage.rules` has one rule, `finances/{entityId}/insurances/**`, open to
  **any authenticated user**. KidClub parents sign in to the same Firebase project.
- **Navigation:** one menu config in `src/components/layout/nav.ts` (picker + groups). A new page
  is one entry there plus a route in `App.tsx`.

## 3. Traps already found

1. **Double counting.** `AccountsPage` shows `balanceCents` + the sum of *all* confirmed
   `finances_events` for that account, with no date cutoff. Statement import already sets
   `balanceCents` to the closing balance, so a confirmed event created from a bank tx dated on or
   before `balanceAsOf` would count twice. Fix this first: only add confirmed events dated
   **after** `balanceAsOf`, or don't add them at all and treat imported transactions as the
   source of truth.
2. **Consumer Gmail + OAuth.** `gmail.readonly` is a *restricted* scope. For `@gmail.com`
   accounts, the OAuth app must be "External". Unverified/testing-mode External apps get refresh
   tokens that **expire after 7 days**, and verification for restricted scopes needs a paid
   security assessment. Domain-wide delegation only covers `admin@kidclub.pt`. See Q1.
3. **Dev can't reach Gmail.** The external guard blocks it, by design. Reading real mailboxes
   from dev would also put personal email in the dev project. See Q6.
4. **Storage rule is too open.** Invoices need a rule restricted to finhub admins (Storage rules
   can `firestore.get()` the `users/{uid}` doc, same as `isFinhubAdmin()` in `firestore.rules`).
   The existing insurances rule has the same problem; flag it, and fix it if Renato agrees.
5. **The `api.setEntity()` global** is flipped by the Dashboard while it loads. New code should
   pass the entity explicitly, not rely on it.
6. **Metered API.** If invoice extraction uses the Claude API (likely for PDFs without a known
   layout), it's a metered call: run `.claude/skills/new-metered-api-checklist` first. That means
   a provider spend cap, plus a per-day call cap and max retries in code, before it ships.

## 4. Proposed design (to confirm with Renato via §6)

**Flow:** mail arrives → ingested into an inbox collection → classified (rule or by hand) →
invoice fields extracted → matched to a bank tx → attached → confirmed event recorded.

**Data (sketch):**
- `finances_inbox/{mailbox}_{messageId}`: mailbox, messageId, threadId, from, subject, date,
  snippet, attachments `[{storagePath, filename, mime, size}]`,
  `status: new | expense | not_expense | matched | needs_review`,
  `classifiedBy: rule:<id> | manual`, `extracted: {vendor, amountCents, currency, date,
  invoiceNumber, supplierNif}`, `bankTransactionId?`, `entityId?` (taken from the matched tx's
  account).
- `finances_bank_transactions` gains `documents: [{inboxId?, storagePath, filename}]` and
  `docStatus: missing | attached | not_needed` (transfers, salaries and taxes are `not_needed`).
- `finances_vendor_rules/{id}`: sender/domain pattern → vendor name, default entity/category,
  "always expense" or "always ignore". Rules are what make classification automatic; every
  manual decision should offer "remember for this sender".
- Storage: `finances/{entityId}/invoices/{yyyy-mm}/{file}`, finhub-admin-only rule.

**Matching:** same amount (same sign, EUR) within a date window (e.g. −3/+10 days of the invoice
date), and for a tie prefer the vendor name appearing in the bank description. One clear match
gets suggested; zero or several go to `needs_review`. Always show the suggestion and let Renato
confirm; never auto-attach silently in v1.

**Real events:** a matched tx produces a `confirmed` `FinanceEvent` (`sourceType` e.g.
`'bank_transaction'`, `sourceId` = tx id). If a planned/computed event exists for the same
recurring entry and month (e.g. the Anthropic subscription), the confirmed one replaces it in the
forecast (see Q5).

**Pages** (as `nav.ts` entries):
- **Emails** (global, above the picker, since mail isn't per company until matched): inbox list,
  filters by status and mailbox, one-click "despesa / não é despesa", and the match suggestion.
- **Movimentos** (per entity, under Dinheiro): bank transactions with `docStatus`, i.e. "what
  still lacks an invoice" — the actual to-do list.
- **Pack contabilista** (per entity, monthly): the export (Q4).

## 5. Suggested build order

1. **Fix the double counting (§3.1)**, plus the Movimentos page with `docStatus` and **manual**
   PDF upload per transaction. That's useful on its own and needs no email access.
2. **Ingestion for `admin@kidclub.pt` only** (Workspace, domain-wide delegation, easiest auth),
   behind the external guard, prod only. Store emails + attachments; no auto-classification yet.
3. **The Emails page:** manual classification + vendor rules + match suggestions.
4. **The other three mailboxes**, using whatever Q1 decides.
5. **Extraction** (rules per known sender first; Claude API fallback with caps), then the
   **accountant pack**.
6. More bank parsers (CGD, Montepio, Revolut) as needed.

Each step is its own `agent/` branch off `main`, PR → `staging`. Update `STATUS.md` as you go.

## 6. Questions for Renato (answer before building)

1. **Consumer Gmail access.** Pick one (recommendation first):
   a. **Auto-forward** invoice emails from the three `@gmail.com` accounts to one kidclub.pt
      mailbox (e.g. a `faturas@kidclub.pt` alias or `admin@`), using a Gmail filter in each
      account. FinHub then reads only Workspace mail via the delegation that already exists. No
      OAuth verification, no expiring tokens; the cost is setting up a forwarding filter per
      account.
   b. **Google Apps Script** in each consumer account, running as that user on a timer, copying
      labelled emails/attachments to FinHub (Drive or an HTTPS function). No verification needed,
      but four scripts to maintain.
   c. **OAuth "External" app in testing mode:** works, but each account must re-authorise
      **every 7 days**.
2. **Which emails count?** Read everything in each mailbox and let the app classify, or only
   emails with a Gmail label/filter (e.g. "Faturas")? A label is safer for privacy and much
   cheaper to process; reading everything finds more automatically.
3. **Which company does each mailbox mostly belong to?** E.g. `geral.arcoirisdapequenada` →
   NoisyPhocus, `renato343` → Casa? This is only a hint (the matched bank account decides), but it
   helps when there's no match yet.
4. **The accountant.** What do they need, and in what form: a Drive folder per company per month,
   a zip, uploads to their own software? Do they already pull Portuguese suppliers' invoices from
   **e-Fatura**? If so, the pack may only need foreign vendors (Anthropic, Google, Booking…),
   which don't appear there.
5. **Real vs planned events.** When a confirmed expense matches a recurring entry (Vendus,
   EasyPay, a subscription), should it replace that month's planned event, and should the
   recurring amount be updated when the real amount differs?
6. **Testing on dev.** Read-only Gmail isn't a side effect like sending, but it would put real
   personal email into the dev project. Options: (a) test ingestion only in prod, behind the
   guard, and build/test the Emails page on dev with saved sample emails (fixtures);
   (b) allow read-only Gmail from dev for one test mailbox. Recommendation: (a).
7. **Invoice extraction by AI.** OK to use the Claude API (e.g. Haiku 4.5) for invoices with no
   known layout, with a monthly spend cap? What cap: €5/month?
8. **Bank formats.** Besides BPI, which banks first? Renato needs to provide a sample export per
   bank (CSV/XLSX/PDF) for the parser.
9. **Expenses without email:** card payments with a paper receipt, bank fees, taxes. Is "manual
   upload or mark as no invoice needed" enough for those?

## 7. Don'ts

- No Gmail write scopes (`gmail.readonly` only); never move, label or delete Renato's mail from
  the app unless he asks for it explicitly.
- No real mailbox reads from `kidclub-dev` without Renato's explicit OK (Q6).
- Don't widen the external guard to "allow everything from dev"; add a narrowly scoped
  read-only exception only if Q6 says so.
- Invoices and emails are personal and financial data: finhub-admin-only rules everywhere, in
  Firestore **and** Storage.
- Never auto-attach or auto-confirm in v1; suggest, Renato confirms.
