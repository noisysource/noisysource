# HANDOFF — Refunds and credit notes (KidClub admin)

**Status:** not started. Written 2026-10-01 for the next agent (`kidclub-feature`). Renato asked for this
as the next feature.

## Why
A payment can land on the wrong bill, or a family can be overcharged, and today there is no way to fix
it in the app. The live case: **Mary Pratas paid the 2027-08 bill instead of 2026-09**. Vendus issued
invoice-receipt **FR 01P2026/195** against the wrong period. Fixing it needs a credit note in Vendus and
the two bills corrected in Firestore. The pay-in-order rule (`assertEarlierMonthsPaid`) stops this exact
case from recurring, but refunds and corrections will still come up.

## What exists today
- `functions/src/kidclub/vendus.ts` only creates `FR` (fatura-recibo) via `createInvoice`. There is no
  `NC` (nota de crédito) and no refund code anywhere in `functions/src`.
- Payments: Easypay (MB WAY only for now, card/Multibanco disabled). Webhook in `easypayWebhook`;
  bills live in `_apps/arcoiris/billing/{familyId}_{yyyy-mm}`.
- The admin "Famílias e inscrições" page (`src/pages/admin/subscriptions/`, `FamilyBills`) already lists
  each family's bills with invoice errors and "Tentar faturar novamente". It's the natural place for this.

## Scope (proposal — confirm with Renato before building)
1. **Credit note (NC) in Vendus** against an existing FR, full or partial, with a reason. Store the NC
   id/number on the bill (e.g. `creditNotes: [{ vendusId, number, amount, reason, at, by }]`).
2. **Bill correction**: move a payment from one bill to another (Mary Pratas's case: 2027-08 back to
   pending, 2026-09 marked paid and re-invoiced), or mark an amount as credit on the family to be used
   on the next bill.
3. **Money back (optional, ask first)**: Easypay refund of the original payment. Only if Renato wants actual
   refunds rather than credit carried forward. MB WAY refund support at Easypay must be checked first.
4. Admin UI in `FamilyBills`: "Emitir nota de crédito" / "Mover pagamento", each with a confirmation
   that states exactly what will be written to Vendus and Firestore.

## Rules that apply
- **Sandbox first** (`.claude/skills/sandbox-first-billing/SKILL.md`). Vendus has no sandbox on dev yet —
  that decision is still open (separate Vendus account vs. `mode: "tests"`); this feature probably forces it.
- No retries/loops on Vendus or Easypay calls; one attempt, visible error, manual retry button (same
  pattern as `retryVendusInvoice`).
- Paid/invoiced bills are never silently changed: every correction is an explicit, logged admin action.

## Done when
Mary Pratas's case can be fixed entirely from the admin page, and the NC appears in Vendus.
