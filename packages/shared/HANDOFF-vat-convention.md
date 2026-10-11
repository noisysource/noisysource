# HANDOFF — One VAT convention for FinHub and KidClub

> Written 2026-10-11 for the agents implementing it (`finances-app` for PR 1, `kidclub-feature`
> for PR 2) and for Renato. Facts below were verified on `staging` that day; re-check the code
> before relying on a line number. The convention itself is also summarised in the root
> CLAUDE.md, "Cross-App Data Contracts".

## 1. What Renato decided

- **Both apps treat VAT the same way.** Today they don't (see §2).
- **Transparency:** whenever a price is set up or shown (a subscription, a party, a recurring
  cost), admins always see the amount **with VAT, without VAT, and the VAT itself**. Clients
  should see it too: parties already do on `staging`; subscriptions are next.
- **Costs are always visible both with and without VAT**, side by side, ideally on one summary
  page per company (FinHub's "Resumo do mês", which grows out of Custos do mês).
- **Typed by hand:** the person says whether the amount includes VAT. **From bank statements or
  emails:** the amount already includes VAT.
- **Existing FinHub recurring entries:** Renato doesn't remember whether he typed them with or
  without VAT, and will **re-enter them all**. No data migration; flag them instead (PR 1).
- **KidClub VAT rates (Renato, 2026-10-11):** **23% for parties and the study room, 6% for
  transport.** Enrollment fee and insurance: not stated yet (Q2).
- **Families see the VAT breakdown on subscriptions in PR 2**, not later.
- **EasyPay commission:** Renato believes the % is charged **before VAT** (he funds the EasyPay
  wallet with €100 by transferring €123; the commission comes out of the €100). To confirm (Q3).

## 2. What exists today (verified 2026-10-11)

**FinHub**
- `RecurringEntryDoc.amountCents` + `ivaRatePct` (`packages/shared/models/RecurringEntry.ts`).
  The model says the amount is **VAT-exclusive**, and the IVA page and Custos do mês add VAT on
  top (`apps/noisysource/finances/src/lib/recurringSchedule.ts` `recurringIvaInQuarter`,
  `src/lib/api/domains/costSummary.ts`). But the forecast (`generateRecurringEvents` in
  `packages/shared/lib/eventGenerators.ts`) uses the same amount as the cash leaving the
  account, i.e. **VAT-inclusive**. The form only says "Taxa de IVA", never which one it expects.
  Whatever Renato typed, one side is wrong.
- The forecast also ignores the commission model: it uses a commission entry's fallback
  `amountCents`, not `commissionPct` × KidClub volume.
- **EC income:** `generateEcEvents` books the payment as days × `dailyRateCents`, with no VAT.
  The client actually pays that + `ivaRatePct` (default 23), so forecast cash-in is understated.
  The VAT collected isn't income, though: it's owed to the state in the quarterly return.
- Rates are **percent integers** (23).

**KidClub**
- Rates are **fractions** (0.23): transport config `vatRate`, whose **code default is 0.23**
  (`AdminTransportationConfig.tsx`, `TransportPlannerPage.tsx`) although transport's real rate is
  **6%**, so check the saved `config` value; `PARTY_VAT_RATE` in
  `packages/shared/models/PartyConfig.ts`, mirrored in `functions/src/kidclub/partyDepositLogic.ts`.
- **Parties (#81, merged to `staging` 2026-10-11, not yet in prod):** `Booking.total` and the
  party config are **before VAT**. Every party page now shows subtotal / IVA / total / deposit
  via `packages/shared/models/partyPricing.ts`. The deposit is taken from the VAT-inclusive total.
- **Billing:** each line's `amount` is sent to Vendus as `gross_price`
  (`functions/src/kidclub/billing.ts`), i.e. **VAT-inclusive**. `BillingRecord.total` is what the
  family pays, VAT included. The VAT rate actually applied comes from the Vendus **product** each
  line is mapped to (`PRODUCT_STUDY`, `PRODUCT_TRANSPORT`, `PRODUCT_ENROLLMENT_FEE`,
  `PRODUCT_INSURANCE`), not from KidClub's config.
- **Transport (live in prod, unverified):** the client page
  (`src/pages/client/TransportSubscriptionDetailPage.tsx`) shows
  "€{monthlyFee}/mês + €{monthlyFee × vatRate} IVA". Billing sends the line amount as
  VAT-inclusive. Nobody has confirmed whether families are billed `monthlyFee` or
  `monthlyFee × 1.23`. If it's `monthlyFee`, the page promises a higher price than the invoice
  (or the VAT is inside the price, and the page is wrong).
- **Study room, enrollment fee, insurance:** no VAT shown anywhere, to admins or families.
- `functions/` can't import `@shared` at runtime (see the header of `billing.ts`); shared logic
  is mirrored there with a parity test. `partyDepositLogic.ts` is the existing example.

## 3. The convention

1. **Stored amounts on anything that is a payment or an invoice are VAT-inclusive:** recurring
   entries, expenses, bank transactions, billing lines and totals, invoices. Net and VAT are
   always derived, never stored as the primary value.
2. **Every such amount carries an explicit VAT code:** `23 | 13 | 6 | 0 | isento |
   autoliquidacao | por_confirmar`. `autoliquidacao` = reverse charge (foreign B2B such as
   Anthropic, Google: no PT VAT on the invoice). `isento` = exempt (e.g. insurance, bank fees).
   `por_confirmar` = unknown; it is **never** silently treated as 0. Naming is up to the
   implementer; the set of cases isn't.
3. **Price lists may stay net:** KidClub party and transport config, the EC daily rate. They're
   price lists, not payments, and changing their storage touches live billing. They must be
   labelled "sem IVA" wherever they're edited, and converted through the shared helper.
4. **Rates are percent integers** in all new code. KidClub's fractions are converted at its
   boundary; don't migrate KidClub config in this pass.
5. **One helper:** `packages/shared/lib/vat.ts` — split a VAT-inclusive amount into
   `{ netCents, vatCents }` (`vat = round(gross × r / (100 + r))`, `net = gross − vat`), build a
   gross amount from net, the list of VAT codes with labels, and a formatter. Work in cents. Mirror
   it in `functions/src/lib/vat.ts` with a test that keeps both identical. `partyVatBreakdown`
   keeps its API but uses the helper inside.
6. **Display, both apps:** the VAT-inclusive amount is the main number, with "sem IVA €X · IVA
   23% €Y" next to it. Summary pages show two columns, com IVA / sem IVA. For families
   (consumers), the main price must be the VAT-inclusive one; Portuguese consumer price rules
   expect the final price including taxes. The breakdown sits beside it.
7. **Input:** typed amounts get a "com IVA / sem IVA" switch next to the field (default com
   IVA), converted to VAT-inclusive on save. Bank-statement and email amounts are VAT-inclusive;
   their VAT code comes from the invoice or the vendor rule, otherwise `por_confirmar`.

## 4. Work split

**PR 1 — shared helper + FinHub** (`finances-app` agent, branch off `staging`)
- `packages/shared/lib/vat.ts` + the `functions/` mirror + tests.
- Recurring entries: amount = VAT-inclusive, VAT code instead of a bare rate, and the com/sem IVA
  switch on the form. Existing entries have no marker saying which convention they follow: show
  them with an "IVA por confirmar" badge, list them separately on the IVA page, and set the
  marker when Renato re-saves one.
- `recurringSchedule.ts`, `costSummary.ts` and `VatPage.tsx` use the helper. Custos do mês shows
  com IVA / sem IVA columns (first step towards "Resumo do mês" for every company).
- Commission entries: fee = volume × % **before VAT** (pending Q3), VAT added on top, and the
  form label says "% sem IVA".
- Forecast: use `recurringMonthlyAmountCents` for commission entries; EC payments include VAT in
  cash-in.

**PR 2 — KidClub** (`kidclub-feature` agent, branch off `staging`)
1. **Read-only check first, report to Renato before changing anything.** Plain version: a family
   looking at a transport subscription sees e.g. "€100/mês + €6 IVA". Is the invoice they actually
   pay €100 (VAT inside) or €106? Do the same for the study room, enrollment fee and insurance.
   Compare what the client pages show, the billing docs' line amounts and `total`, and the VAT
   rate on the real Vendus invoices (the existing read-only `getKidclubVatSummary` groups by
   rate). Also confirm the saved transport `vatRate` is 0.06 and the Vendus transport product
   applies 6%, and the study room product applies 23%. Use dev first; prod reads only per the
   root CLAUDE.md prod-access rule. See Q1.
2. **Admin:** every place a subscription price is set or shown (transport config, study room
   config, enrollment and insurance fees, the unified families/subscriptions admin page) shows sem
   IVA / IVA / com IVA. Parties are done (#81).
3. **Families:** subscription setup and detail pages show the VAT-inclusive price first, with the
   breakdown, matching what parties already do.
4. Use `vat.ts`; rates converted from KidClub's fractions at the boundary.

**Email → expenses** (`apps/noisysource/finances/HANDOFF-email-expenses.md`) follows the same
convention: bank-transaction amounts are VAT-inclusive, and the VAT code comes from the matched
invoice.

## 5. Questions for Renato

1. **Transport:** if the check shows families are billed `monthlyFee` with VAT inside it, which
   is right: the page's "+ IVA" (prices go up by 23%) or the invoice (fix the page)? This changes
   what families pay, so it's your call after the check, not the agent's.
2. **VAT rates — partly answered 2026-10-11:** parties and study room 23%, transport 6%. Still
   open: **enrollment fee and insurance** (insurance is usually exempt; confirm with the
   accountant against what the Vendus products are set to).
3. **EasyPay:** confirm the commission is before VAT from one real EasyPay fee invoice (it shows
   base + IVA). The EasyPay API/sandbox is a fallback if no invoice is at hand.
4. ~~Families seeing the VAT breakdown on subscriptions~~ — answered: **in PR 2.**

## 6. Don'ts

- Don't change any amount a family is billed, or any Vendus product's VAT setting, without
  Renato's explicit decision (Q1, Q2).
- Don't migrate KidClub price config storage in this pass.
- Sandbox-first for anything that creates Vendus or EasyPay documents
  (`.claude/skills/sandbox-first-billing`).
- Keep the `functions/` mirror and its parity test in the same PR as any change to `vat.ts`.
