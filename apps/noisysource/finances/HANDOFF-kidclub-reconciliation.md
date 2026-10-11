# HANDOFF — KidClub bank reconciliation (FinHub)

> Written 2026-10-11 for the next agent picking this up cold. Read `STATUS.md` and
> `HANDOFF-email-expenses.md` (same folder) first: this feature shares that one's statement
> page and its double-counting trap. **§7 lists what's still needed from Renato before building.**

## 1. What Renato wants

A monthly task: upload the NoisyPhocus BPI statement and check that every euro received matches
a KidClub bill, that every paid bill has a Vendus invoice, and that the month's totals add up.

Decided with Renato (2026-10-08 / 2026-10-11):
- **It lives in FinHub, not KidClub.** It's the same statement the emails → expenses feature
  uses for the money going out, and it shows wages and every supplier, so it stays behind
  `finhubAdmin`. Only Renato/Marisa do this for now. If someone without FinHub access ever takes
  the task over, revisit (option then: import only the credits into KidClub).
- **EasyPay pays out daily, at the full amount.** Fees are *not* deducted from payouts: Renato
  tops up an EasyPay wallet and EasyPay invoices that top-up. So fees are an expense (debit side,
  emails → expenses), not a gap to explain here.
- **Use EasyPay's API** to break each payout down into payments (see §3).
- **Parties** are mostly paid by bank transfer or cash deposit; they should increasingly go
  through EasyPay. Party deposits already create `billing` docs (`type: party_deposit`,
  `bookingId`, `createPartyDeposit` in `functions/src/kidclub/billing.ts`); camps bill too.
- Renato will provide a real BPI statement that includes parent transfers.

## 2. What already exists (verified 2026-10-11 against `main`)

- **Bank import:** BPI XLSX → `finances_bank_transactions/{deterministic id}` (signed
  `amountCents`, `date`, `description`, `entityId`, `accountId`) + `finances_bank_imports`.
  Rules: `isFinhubAdmin() || isOwner()`. No reconciliation fields yet.
- **FinHub already reads KidClub bills:** `api.kidclub.listBilling()`
  (`src/lib/api/domains/kidclub.ts`), used by `NoisyPhocusRevenuePage` and `ForecastPage`.
- **The bill** (`packages/shared/models/Billing.ts`): `status` pending | processing | paid |
  invoiced | failed | cancelled | dry-run; `paymentMethod`; `total`; `billingName`;
  `easypayId` (latest attempt), `previousEasypayIds`, `paidEasypayId` (the attempt that paid;
  bills paid before that field existed don't have it); `paidAt`; `manualPayment`;
  `invoiceNumber` / `vendusId` / `invoiceError`; `duplicatePaymentEasypayIds`.
- **`markBillingPaid`** (`functions/src/kidclub/manualPayment.ts`): open bill → `paid` in a
  transaction → `createVendusInvoiceForBilling`. Inputs `billingId`, `paidAt` (yyyy-mm-dd, not in
  the future, Lisbon), `method: 'bank_transfer'`, `note`. **Role check: `owner` or
  `rainbowAdmin` only.**
- **EasyPay client** (`functions/src/kidclub/easypay.ts`): only `POST /single`. It does **not**
  send a `key`, so EasyPay doesn't know our bill id. The sandbox is used on dev (`isSandbox`), and
  every call goes through `assertExternalCallsAllowed`.
- On prod, 18 of 41 families pay by bank transfer (KidClub STATUS, 2026-10-07).

## 3. EasyPay API: what we'd use

Source: `https://docs.easypay.pt/_bundle/openapi.yaml`, read 2026-10-11.

- **`GET /settlement`** (scope `settlement:read`): "each settlement groups the transactions paid
  out together in a single bank transfer." Fields: `id` (uuid), `name` (batch reference, e.g.
  `"1006"`), `description` (e.g. `EASYPAY-1977225-42185-161-998590696`, probably what shows up on
  the BPI line), `status` IN_TRANSIT | SUCCEEDED | FAILED, `total_amount`, `number_of_items`,
  `created_at`, `destination.details.iban`. Filters: `created_at`, `status[]`; cursor pagination.
- **`GET /report/ledger`** (scope `report:read`): filters `transfer_batch`, `transaction_type`,
  `created_at`; `limit` max 100; cursor. Each entry: `transaction_type` (CP capture, RF refund,
  FEE, CB chargeback, …), `amount_details` (requested, paid, `fees[]` fixed/variable/vat),
  `amount` (net), `transfer_batch`, `transfer_batch_date`, `details.payment_id`,
  `details.payment_key`, `details.method`.
- `GET /report/transactions` is end-of-life (removed 2026-07-31). Don't use it.

**The chain:** BPI credit ⇄ `settlement.total_amount` (+ description) ⇄ ledger entries whose
`transfer_batch` = `settlement.name` ⇄ `payment_id` ⇄ the bill's `paidEasypayId` /
`easypayId` / `previousEasypayIds`.

**Unverified until the first real call:**
- whether our API key has `settlement:read` and `report:read` (see §7);
- that `settlement.name` really equals the ledger's `transfer_batch`;
- that the ledger's net `amount` equals the paid amount, since fees come from the wallet. Handle
  both cases: if they differ, show the gap as fees, never as a mismatch;
- whether the sandbox returns any settlements. Probably not, so build and test the UI on dev
  against saved, anonymised fixtures.

## 4. Proposed design

**Monthly flow (NoisyPhocus entity):** import the BPI statement (existing importer) → sync that
month's EasyPay settlements + ledger (callable, prod only, triggered by Renato; no schedule in
v1) → the app suggests a match for each credit → Renato confirms → monthly check page.

**Three kinds of credit:**

1. **EasyPay payout.** Match when the amount equals `settlement.total_amount`, the date falls in
   `created_at` … +3 business days, and the description contains `EASYPAY` / the settlement
   description. One settlement ↔ one credit. Its ledger captures then map to bills, which the
   webhook should already have set to `paid` / `invoiced`. Flag: a capture with no bill; a bill
   paid via EasyPay that is in no settlement after a few days; refunds or chargebacks in the batch.
2. **Parent bank transfer.** Candidates: open bills (pending / processing / failed), with
   `paymentMethod: bank_transfer` first. The amount must match exactly; rank by name tokens from
   `billingName` or the child appearing in the description, and by date ≥ bill creation. One clear
   candidate becomes a suggestion. On confirm → `markBillingPaid(paidAt = tx.date, note = "Extrato
   BPI <txId>")` → Vendus invoice. Also allow:
   - linking a credit to a bill that was already marked paid by hand (link only, no call);
   - one transfer covering several bills (two months, siblings): multi-select, and the bill totals
     must add up to the credit.
3. **Other** (party balance paid without a bill, cash deposits, refunds, capital, interest):
   classify by hand, with "remember for this description" as a rule.

**Monthly check page (read-only):**
1. Every credit is matched or classified; the rest is the to-do list.
2. Every bill marked paid by hand (`manualPayment`) has a bank credit. If not, it was probably
   marked paid by mistake.
3. Every `paid` bill is `invoiced`, without `invoiceError`. Money received with no invoice issued
   is the case that matters for the tax authority (AT).
4. Totals: Previsto (bills) / Recebido (bank) / Faturado (Vendus). The gap is unpaid bills plus
   "other" credits; fees are no longer part of it (wallet).
5. Open duplicate payments (`duplicatePaymentEasypayIds`) still waiting for a refund.

**Data (sketch):**
- `finances_bank_transactions` gains `reconciliation?: { kind: 'kidclub_bills' |
  'easypay_settlement' | 'other'; billingIds?: string[]; settlementId?: string; category?:
  string; confirmedBy: string; confirmedAt: Timestamp }`.
- `finances_easypay_settlements/{settlementId}`: the settlement + its ledger entries
  `[{ paymentId, type, paidCents, feeCents, netCents, billingId? }]` (a subcollection if a batch
  can get big). `finhubAdmin` rules, same as the bank collections.
- The KidClub bill gains `bankTransactionId?`, always written server-side. **When it ships, add
  it to "Cross-App Data Contracts" in the root CLAUDE.md.**
- Matching = pure functions in `packages/shared/lib/bankReconciliation.ts`, unit-tested the way
  `functions/src/kidclub/reconciliation.ts` is. The EasyPay fetch and writes live in functions and
  reuse `easypay.ts`'s headers and guard (add a `get` helper next to `post`).

**KidClub-side changes** (small, separate PR, `kidclub-feature` agent):
- `markBillingPaid`: also accept `finhubAdmin` (so Marisa can do it), and an optional
  `bankTransactionId` that it stores on the bill.
- Send `key: billingId` on new `POST /single` payments, so ledger entries carry the bill id in
  `payment_key` and the link survives retries. Keep matching old payments by `easypayId`.
- Cobranças: a read-only "✓ Conciliado" badge when `bankTransactionId` is set.

## 5. Traps

1. **Double counting** (email handoff §3.1). v1 must not create confirmed `finances_events` from
   reconciled credits; if a later version does, only after `balanceAsOf`.
2. **Never auto-mark paid.** `markBillingPaid` issues a legal Vendus invoice. Suggest, and Renato
   confirms. A "confirm all N clear matches" button is OK only if it lists them first.
3. **EasyPay is a billing integration.** Run `.claude/skills/sandbox-first-billing` and
   `.claude/skills/new-metered-api-checklist` before the first call. It's read-only, but still:
   cap pages per run (e.g. 20), at most 3 retries with backoff, back off on 429, no schedule in v1.
4. **Bills with several EasyPay attempts:** look up `paidEasypayId`, then `easypayId`, then
   `previousEasypayIds`. A capture that lands on a bill already paid by another id is a duplicate
   payment; the webhook already flags those in `duplicatePaymentEasypayIds`.
5. **The real statement is financial and personal data.** Never commit it. Fixtures must be
   anonymised (names, IBANs, descriptions).
6. **Two deploy paths.** FinHub deploys by hand (`deploy-finances.yml`); functions ship with the
   KidClub pipeline. Keep function changes backward-compatible with whatever FinHub UI is live.
7. **Dates:** `paidAt` = the bank movement date, in Lisbon; `markBillingPaid` rejects future
   dates.

## 6. Suggested build order

1. **Parent transfers:** statement page for NoisyPhocus listing credits, match suggestions,
   confirm via `markBillingPaid`, plus the KidClub PR (`finhubAdmin`, `bankTransactionId`).
   Needs Renato's BPI sample.
2. **Monthly check page** (read-only).
3. **EasyPay settlements:** sync callable + settlement matching, plus the KidClub PR that sends
   `key`.
4. **"Other" rules**, then fold the result into the accountant pack (email handoff step 5).

Step 1 of the emails → expenses handoff (a statement page with `docStatus` for debits) is the
**same page**. Build it once; whichever feature starts first builds it. Each step is its own
`agent/` branch off `staging` (after #75/#76 merge), PR → `staging`. Update `STATUS.md` as you go.

## 7. Still needed from Renato

1. **The BPI sample** (agreed): it shows what parents write in the description, and how EasyPay
   payouts appear (does the settlement `description` show up on the line?).
2. **EasyPay API key scopes:** check in the EasyPay back office that the key has
   `settlement:read` and `report:read`. Better: create a separate read-only key for this, stored
   as its own secret, so reconciliation can never create or refund a payment.
3. **Party balances paid by transfer or cash with no bill:** are they invoiced in Vendus today,
   and how? If not, they should get a KidClub bill (then they're matchable, and invoiced like
   everything else) rather than land in "other".
4. **Cash deposits:** always party money, or monthly fees too? Cash has no name on the statement,
   so these will always be matched by hand.
