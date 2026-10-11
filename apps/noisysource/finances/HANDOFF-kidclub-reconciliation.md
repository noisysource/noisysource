# HANDOFF — KidClub bank reconciliation (FinHub)

> Written 2026-10-11 for the next agent picking this up cold. Read `STATUS.md` and
> `HANDOFF-email-expenses.md` (same folder) first: this feature shares that one's statement
> page and its double-counting trap. §7 lists what's still open with Renato. None of it blocks
> steps 1–2.

## 1. What Renato wants

A monthly task: upload the NoisyPhocus BPI statement and check that **every euro received has
an invoice**, that every paid bill has a Vendus invoice, and that the month's totals add up.

Decided with Renato (2026-10-08 / 2026-10-11):
- **It lives in FinHub, not KidClub.** It's the same statement the emails → expenses feature
  uses for the money going out, and it shows wages and every supplier, so it stays behind
  `finhubAdmin`. Only Renato/Marisa do this for now. If someone without FinHub access ever takes
  the task over, revisit (option then: import only the credits into KidClub).
- **The core output is a flag: "Sem fatura".** In Renato's words: "if there's a wire transfer
  or deposit that does not correspond to an invoice then we must have forgotten to invoice it."
  Flag only. No automatic invoicing. Cash deposits vary but are usually parties.
- **EasyPay pays out daily, at the full amount.** Fees are *not* deducted from payouts: Renato
  tops up an EasyPay wallet and EasyPay invoices that top-up. So fees are an expense (debit side,
  emails → expenses), not a gap to explain here.
- **Use EasyPay's API** to break each payout down into payments (§3), **with the existing API
  key** (Renato: no need for a separate read-only key).
- **Parties** are mostly paid by bank transfer or cash deposit; they should increasingly go
  through EasyPay. Party deposits already create `billing` docs (`type: party_deposit`,
  `bookingId`, `createPartyDeposit` in `functions/src/kidclub/billing.ts`); camps bill too.
- **Sample statement:** `prodata/Extrato_Conta_2026-09-30.pdf` in the **main checkout**
  (`~/dev/noisysource/prodata/`). It's gitignored (`*.pdf`), so it is *not* in worktrees; read it
  from that absolute path. Never copy it into the repo. Findings in §2a.

## 2. What already exists (verified 2026-10-11 against `main`)

- **Bank import:** BPI **XLSX only** (`src/lib/parsers/bpiXlsx.ts`) →
  `finances_bank_transactions/{id}` (signed `amountCents`, `date`, `description`, `entityId`,
  `accountId`) + `finances_bank_imports`. The model already allows `sourceFormat: 'pdf'` and a
  `storagePath`, but no PDF parser exists. Rules: `isFinhubAdmin() || isOwner()`. No
  reconciliation fields yet. Id = `bpiTxId()`: account + date + signed amount + hash of the
  description (see trap §5.8).
- **FinHub already reads KidClub bills:** `api.kidclub.listBilling()`
  (`src/lib/api/domains/kidclub.ts`), used by `NoisyPhocusRevenuePage` and `ForecastPage`.
- **The bill** (`packages/shared/models/Billing.ts`): `status` pending | processing | paid |
  invoiced | failed | cancelled | dry-run; `paymentMethod`; `total`; `billingName`;
  `easypayId` (latest attempt), `previousEasypayIds`, `paidEasypayId` (the attempt that paid;
  bills paid before that field existed don't have it); `paidAt`; `manualPayment`;
  `invoiceNumber` / `vendusId` / `invoiceError`; `duplicatePaymentEasypayIds`.
- **Vendus document listing already exists:** `listDocuments(dateFrom, dateTo)` in
  `functions/src/kidclub/vendus.ts` (paginated `GET /documents/`), used by `getKidclubVatSummary`
  (`vatSummary.ts`). **It filters `type=FR` only**, so invoices issued by hand as FT/FS, and
  credit notes (NC), are missed. Reconciliation needs all of them.
- **`markBillingPaid`** (`functions/src/kidclub/manualPayment.ts`): open bill → `paid` in a
  transaction → `createVendusInvoiceForBilling`. Inputs `billingId`, `paidAt` (yyyy-mm-dd, not in
  the future, Lisbon), `method: 'bank_transfer'` (the only accepted value), `note`. **Role check:
  `owner` or `rainbowAdmin` only.**
- **EasyPay client** (`functions/src/kidclub/easypay.ts`): only `POST /single`. It does **not**
  send a `key`, so EasyPay doesn't know our bill id. The sandbox is used on dev (`isSandbox`), and
  every call goes through `assertExternalCallsAllowed`.
- **Firebase Storage is not activated on prod** (KidClub STATUS, 2026-10-07). So v1 can't keep the
  uploaded PDF: parse it, store the transactions, and drop the file.
- On prod, 18 of 41 families pay by bank transfer (KidClub STATUS, 2026-10-07).

## 2a. What the real statement looks like (BPI PDF, September 2026)

- **Format:** BPI monthly "EXTRACTO DE CONTA", 2 pages, text-based PDF (no OCR needed; `pypdf`
  layout extraction reads it cleanly, and `pdfjs-dist` should too in the browser). Header:
  `Conta`, `Extracto 009/2026`, `Período De 01/09/2026 a 30/09/2026`. Columns: DATA MOV (dd/mm),
  DATA VAL (dd/mm), description, MOEDA, VALOR (PT format `1 254,00`, debit = `-`), SALDO.
- **The year isn't on the lines.** Take it from `Período`; mind a statement that spans
  December → January.
- **A blank DATA MOV means the same date as the line above.** Several lines have only DATA VAL.
- **It checks itself:** `SALDO ANTERIOR CONTABILISTICO` + every line = each line's `SALDO`, ending
  at `SALDO ACTUAL CONTABILISTICO`. The parser must verify this for every line and **refuse the
  import on any mismatch**. That's what makes PDF parsing safe.
- **Page 2 repeats the column header**; the footer is BPI legal text (overdraft rates). Ignore
  both.
- **Credit lines seen (18 in the month):**
  - `TRF SEPA+ INST <seq> DE <PAYER NAME>`: instant SEPA transfer (most common);
  - `TRF CR SEPA+ <seq> DE <PAYER NAME>`: regular SEPA transfer;
  - `TRF CR INTRAB <seq> DE <PAYER NAME>`: BPI-to-BPI transfer;
  - `<dd/mm> VENDAS EM TPA <batch> KIDCLUB  ARCO-IRIS ...`: **card terminal (TPA) sales**,
    one credit per day's batch, no customer name (2 in the month). Not in the earlier design;
    see §4.
  - **No EasyPay payouts and no cash deposits** this month. KidClub went live on prod on
    2026-09-27, so the first EasyPay payouts should appear in October.
- **The payer name is the bank account holder:** upper case, no accents, cut at ~40 characters,
  and **no month or reference text**. It's often the other parent, not the bill's `billingName`.
- **Debits** (out of scope here; they belong to emails → expenses): `TRF SEPA+ INST <seq> P/
  <IBAN>`, card purchases `<dd/mm> COMPRA EL-E ...`, direct debits `DD <company> <ref>`,
  `PAGAMENTO AO ESTADO`, `PAGSERV ...`, bank fees, and `MENSALIDADE TPA` (terminal rental) +
  its IVA.

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
- whether the existing key (`EASYPAY_API_KEY`) has the `settlement:read` and `report:read`
  scopes. If not, Renato adds them in the EasyPay back office;
- that `settlement.name` really equals the ledger's `transfer_batch`;
- that the ledger's net `amount` equals the paid amount, since fees come from the wallet. Handle
  both cases: if they differ, show the gap as fees, never as a mismatch;
- that settlements land on this BPI account (`destination.details.iban`);
- whether the sandbox returns any settlements. Probably not, so build and test the UI on dev
  against saved, anonymised fixtures.

## 4. Proposed design

**Monthly flow (NoisyPhocus entity):** upload the BPI PDF → parse and balance-check in the browser
→ store the transactions → fetch the month's Vendus documents and KidClub bills (and, from step 4,
EasyPay settlements) → the app suggests a match for each credit → Renato confirms or classifies →
monthly check page.

**What counts as invoiced: Vendus is the source of truth.** KidClub bills are the richest link
(family, payment method, EasyPay ids), but invoices issued straight in Vendus count too: before
go-live, parties, one-offs. So every credit must end up as one of:
- **matched to KidClub bill(s)** that are `paid` / `invoiced` (or open, then confirmed paid;
  see step 3);
- **matched to Vendus document(s)** with no KidClub bill (same amount, date window, client name
  if available);
- **classified as not revenue** (capital, loan, own-account transfer, refund received, interest),
  by hand, with an optional "remember for this description" rule;
- otherwise → **⚠️ Sem fatura**, the flag Renato wants.

**Matching per kind of credit:**
1. **Parent transfer** (`TRF … DE <payer>`). The amount must match exactly: a single bill or
   Vendus document, or several from the same family adding up (two months, siblings). Rank by:
   - a learned **payer → family** link (`finances_payer_aliases`, set whenever Renato confirms a
     match). This becomes the strongest signal after the first month;
   - name tokens against every name on the family (both parents/contacts, children's surnames),
     not just `billingName`;
   - date ≥ bill creation, `paymentMethod: bank_transfer` first.

   One clear candidate becomes a suggestion; zero or several → Renato picks, or it stays
   **Sem fatura**.
2. **Card terminal batch** (`VENDAS EM TPA`). No name. Match to Vendus documents / bills of the
   same or previous day whose amounts add up to the batch; otherwise **Sem fatura**. See §7.1.
3. **EasyPay payout** (step 4). Match when the amount equals `settlement.total_amount`, the date
   falls in `created_at` … +3 business days, and the description contains `EASYPAY` / the
   settlement description. Its ledger captures then map to bills, which the webhook should
   already have set to `paid` / `invoiced`. Flag: a capture with no bill; a bill paid via EasyPay
   that is in no settlement after a few days; refunds or chargebacks in the batch.
4. **Cash deposit** (none seen yet). No name, usually parties: same as the TPA batch.

**Monthly check page (read-only):**
1. Every credit is matched or classified. **Sem fatura** credits are the headline, with the total
   amount.
2. Every bill marked paid by hand (`manualPayment`) has a bank credit. If not, it was probably
   marked paid by mistake.
3. Every `paid` bill is `invoiced`, without `invoiceError`. Money received with no invoice issued
   is the case that matters for the tax authority (AT).
4. Totals: Previsto (bills) / Recebido (bank credits that are revenue) / Faturado (Vendus
   documents minus credit notes). The gap is unpaid bills plus Sem fatura credits; fees aren't
   part of it (wallet).
5. Open duplicate payments (`duplicatePaymentEasypayIds`) still waiting for a refund.

**Data (sketch):**
- `finances_bank_transactions` gains `reconciliation?: { kind: 'kidclub_bills' |
  'vendus_documents' | 'easypay_settlement' | 'not_revenue'; billingIds?: string[];
  vendusDocumentIds?: number[]; settlementId?: string; category?: string; confirmedBy: string;
  confirmedAt: Timestamp }`. No `reconciliation` on a credit = unreconciled; the app computes
  Sem fatura, it isn't stored.
- `finances_payer_aliases/{normalizedPayerName}`: `{ familyId, confirmedAt }`.
- `finances_easypay_settlements/{settlementId}` (step 4): the settlement + its ledger entries
  `[{ paymentId, type, paidCents, feeCents, netCents, billingId? }]`.
- All new collections: `finhubAdmin || owner` rules, same as the bank collections.
- The KidClub bill gains `bankTransactionId?` (step 3), always written server-side. **When it
  ships, add it to "Cross-App Data Contracts" in the root CLAUDE.md.**
- **Code layout:** PDF parsing in the browser (`src/lib/parsers/bpiPdf.ts`, next to `bpiXlsx.ts`,
  same `ParsedBpiStatement` output). Matching = pure functions in
  `packages/shared/lib/bankReconciliation.ts`, unit-tested the way
  `functions/src/kidclub/reconciliation.ts` is. Vendus and EasyPay reads live in functions
  (a callable, `finhubAdmin || owner`), reusing `vendus.ts` / `easypay.ts`.

**KidClub-side changes** (small, separate PRs, `kidclub-feature` agent):
- Step 3: `markBillingPaid` also accepts `finhubAdmin` (so Marisa can do it) and an optional
  `bankTransactionId` that it stores on the bill. If TPA payments need it (§7.1), a
  `card_terminal` method too.
- Step 4: send `key: billingId` on new `POST /single` payments, so ledger entries carry the bill
  id in `payment_key` and the link survives retries. Keep matching old payments by `easypayId`.
- A read-only "✓ Conciliado" badge in Cobranças once `bankTransactionId` exists.

## 5. Traps

1. **Double counting** (email handoff §3.1). v1 must not create confirmed `finances_events` from
   reconciled credits; if a later version does, only after `balanceAsOf`.
2. **Never auto-mark paid.** `markBillingPaid` issues a legal Vendus invoice. Suggest, and Renato
   confirms. A "confirm all N clear matches" button is OK only if it lists them first.
3. **Vendus and EasyPay are billing integrations.** Run `.claude/skills/sandbox-first-billing` and
   `.claude/skills/new-metered-api-checklist` before the first new call. Everything here is
   read-only, but still: cap pages per run (e.g. 20), at most 3 retries with backoff, back off on
   429, no schedule in v1. Dev has no Vendus sandbox (calls are refused there), and EasyPay's
   sandbox likely has no settlements: use anonymised fixtures on dev.
4. **Bills with several EasyPay attempts:** look up `paidEasypayId`, then `easypayId`, then
   `previousEasypayIds`. A capture that lands on a bill already paid by another id is a duplicate
   payment; the webhook already flags those in `duplicatePaymentEasypayIds`.
5. **The real statement is financial and personal data.** Never commit it. Fixtures must be
   anonymised (payer names, IBANs, account number). Don't paste real names into STATUS or PRs.
6. **Two deploy paths.** FinHub deploys by hand (`deploy-finances.yml`); functions ship with the
   KidClub pipeline. Keep function changes backward-compatible with whatever FinHub UI is live.
7. **Dates:** `paidAt` = the bank movement date (DATA MOV), in Lisbon; `markBillingPaid` rejects
   future dates.
8. **Transaction ids / dedup.** `bpiTxId()` hashes the description. PDF and XLSX describe the same
   movement differently, so importing both formats for the same month duplicates everything.
   Two identical lines (same day, amount and text) would collapse into one. For PDF, also include
   the running balance (`SALDO`) in the id, which is unique per line. Before the first prod import,
   check whether the NoisyPhocus account already has XLSX-imported transactions
   (`.claude/skills/prod-data-check`).
9. **`listDocuments` is FR-only** (§2). Widen it with a parameter, without changing
   `getKidclubVatSummary`'s behaviour by accident, or that page's VAT totals change.

## 6. Suggested build order

1. **BPI PDF import** for NoisyPhocus: parser + per-line balance check + store transactions (no
   file storage). Unit tests on an anonymised fixture built from the sample's structure.
2. **Read-only reconciliation:** credits vs KidClub bills + Vendus documents (all types), the
   **Sem fatura** flag, not-revenue classification, payer aliases, monthly check page. No writes
   to KidClub. This alone answers "what did we forget to invoice".
3. **Confirm an open bill from a transfer** → `markBillingPaid`, plus the KidClub PR
   (`finhubAdmin`, `bankTransactionId`).
4. **EasyPay settlements:** fetch + settlement matching, plus the KidClub PR that sends `key`.
   The first payouts should be on the October statement.
5. Fold the result into the accountant pack (email handoff step 5).

Step 1 of the emails → expenses handoff (a statement page with `docStatus` for debits) is the
**same page**. Build it once; whichever feature starts first builds it. Each step is its own
`agent/` branch off `staging` (after #75/#76 merge), PR → `staging`. Update `STATUS.md` as you go.

## 7. Still open with Renato (none of it blocks steps 1–2)

1. **Card terminal (TPA) sales:** what are they usually (parties at the door, monthly fees paid
   in person?), and is a Vendus invoice issued at the time? Matching works either way through
   Vendus documents; the answer decides whether `markBillingPaid` needs a `card_terminal` method.
2. **EasyPay payouts:** none in September. Confirm they land on this BPI account once October's
   statement is in (`settlement.destination` shows it too).
3. **API scopes:** the existing EasyPay key must have `settlement:read` and `report:read`. Check
   in the back office before step 4.

Answered 2026-10-11: the BPI sample (PDF, above), same EasyPay key is fine, and money with no
invoice is flagged, not invoiced automatically (cash deposits are usually parties).
