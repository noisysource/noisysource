# Release test plan — KidClub + FinHub

> For Renato, to simulate real scenarios on **dev** before promoting `staging` → `main` (prod).
> Written 2026-10-12. Later sessions **append** their scenarios to §6 instead of writing a new
> plan. Keep this file current until the release is done, then archive it (rename with the date).

## 0. What's going to prod

**KidClub, new in this release** (in `staging`, not in `main`):
- **#81 Party prices 2026/27 + VAT:** every party page shows subtotal / IVA 23% / total /
  deposit; families pick quantities for per-unit extras; the deposit is 50% of the
  **VAT-inclusive** total (it used to be 50% of the pre-VAT total). Prod `config/party` already
  has the new prices; prod has no party bookings yet.
- Docs only: #80, #83.
- Already in prod, but `staging` needs it before testing: **hotfix #84** (Vendus client-creation
  loop), brought into `staging` by **#86**.

**FinHub, new in this release.** Prod FinHub still runs a **build from 2026-07-31** (it still has
Cash Flow). Its prod deploy job (`deploy-finances.yml`) was disabled (`if: false`) from the April
repo migration until **#88**, which puts FinHub in the same pipeline as KidClub: the
`staging` → `main` PR now deploys FinHub to prod too. So this is FinHub's first real release in
months:
- **#75 Cost model:** Fixo/Comissão recurring costs (EasyPay = % of KidClub's paid volume),
  recibo verde contracts, Payroll limited to the selected company, `/noisyphocus/costs`
  (Custos do mês), dev build fixed (`build:staging`), no-cache headers.
- **#82 One menu:** the "A ver" picker (Casa / NoisySource / NoisyPhocus), the same menu
  structure for every company, Cash Flow removed (→ Contas), Portuguese labels.
- **#85 BPI PDF statements:** the account import accepts the monthly BPI PDF as well as XLSX,
  with a line-by-line balance check that refuses the whole import on any mismatch.

**Domotics, rides along:** **#73** heat pump fault codes (Zantia E-codes in the floor plan,
corrected datapoint map). The release pipeline only deploys KidClub's hosting, rules, indexes and
functions, and #73 touches none of them, so nothing changes live. The domotics app and the Pi
bridge are deployed separately (the bridge by hand, per #73's notes).

**Already in prod (regression checks only):** event-sourced billing, absences and credits,
family calendar, the unified families/subscriptions admin page, payments page (one list, months
in order, MB WAY only), payment retry and admin reset (#57), bank transfer + proof + "Marcar como
pago" (#78), email composer (#59), financial summary for both pricing models (#71), no child home
address (#70), duplicate-invoice fix (#74), Vendus client-loop fix (#84).

## 1. Before you start testing

1. **Merge #86** (main → staging sync) so dev runs the Vendus hotfix too.
2. **Merge #83** (this file, the VAT handoff, docs only).
3. **Run "Deploy Finances" on `staging`** (GitHub → Actions → Deploy Finances → Run workflow →
   branch `staging`). This also tests the fixed dev build. KidClub deploys to dev automatically
   on each merge into `staging`; wait for that run to go green.
4. **Decide where your real FinHub data lives** (see §5, Q1). It changes what "FinHub in prod"
   means.

**URLs (dev):** KidClub `https://kidclub-dev-arcoiris.web.app` · FinHub
`https://kidclub-dev-finhub.web.app`

**What dev can't do (expected, not bugs):**
- **EasyPay** runs against its **sandbox**: payments work end to end, no real money.
- **Vendus** is blocked on dev: a paid bill shows `invoiceError` "Vendus invoicing is disabled
  on kidclub-dev". That's the expected end state of every payment test.
- **Emails** are never sent from dev. They appear as docs in `_apps/arcoiris/emailOutbox`.
- **File uploads** (payment proofs, insurance documents) work on dev only. Firebase Storage
  isn't active on prod (#85 notes), so check §5 Q3 before relying on them in prod.

**Accounts:** your admin account, plus at least one test parent account (a second Google account,
or impersonate a test family from the admin). Use test families only; dev data is separate
from prod.

## 2. KidClub — scenarios

Each scenario is a real-life story. ✅ = expected result. **NEW** = changed in this release.

### K1. A new family joins (study room)
1. As a new parent: log in → complete the profile (name, phone, NIF, payment method MB WAY).
   ✅ No child home address is asked.
2. Add a child, then enroll them in the study room (`/client/enroll/study`): pick days and hours
   (quarter-hour slots).
3. As admin: Famílias e inscrições (`/admin/subscriptions`) → the family → approve the
   subscription. ✅ An "Inscrição aprovada" email doc appears in the outbox.
4. As the parent: Calendário. ✅ The child's days show.
5. Pagamentos. ✅ The first bill has the month + Taxa de Inscrição €35 + Seguro €25 (if not paid
   before).
6. Pay with MB WAY (sandbox). ✅ Bill → paid, then `invoiceError` (Vendus blocked on dev).
7. As admin: Cobranças (`/admin/billing`). ✅ The bill shows paid + an invoice-error badge, and
   "Tentar faturar novamente" is offered.

### K2. Transport with a sibling
1. Same family: enroll a second child in Transporte, biweekly pattern.
2. As admin: approve; Configuração → Descontos (`/admin/config/descontos`): the sibling discount
   applies to the second child. ✅ The subscription card shows the discount; parents see the
   final price only.
3. Planeador de Transporte (`/admin/transport-planner`). ✅ Both children on the right days, and
   off-pattern weeks empty.
4. As the parent: the transport subscription page. ✅ Note what VAT line it shows. This is the
   open VAT question in `packages/shared/HANDOFF-vat-convention.md`; just write down what you see.

### K3. Absences and the credit
1. As the parent: cancel 3 study-room days in the current month from the calendar.
2. ✅ The absences show with the child's name; the bill updates once the 3-absence threshold is
   reached (credit on the bill).
3. As admin: Calendário (`/admin/calendar`) → a day → inline editor → mark one more absence.
   ✅ Same effect, recorded as staff.

### K4. Payment problems
1. Start an MB WAY payment and let it fail or expire in the sandbox. ✅ The bill shows failed and
   the parent can retry (#57).
2. As admin, on a bill stuck in "processing": use the reset action for stuck payments (#57).
   ✅ It goes back to pending.
3. Bank transfer (#78): Cobranças → "Dados para transferência" → a test IBAN. As the parent:
   Conta → Método de pagamento → Transferência bancária. Pagamentos → ✅ IBAN + amount +
   suggested description. "Enviar comprovativo" → upload a PDF → ✅ "A aguardar confirmação"
   and an email doc to admin@kidclub.pt in the outbox.
4. As admin: banner "mensalidade com comprovativo" → "Marcar como pago" → ✅ paid (+
   `invoiceError` on dev). Double-click "Marcar como pago": ✅ only one payment recorded.

### K5. A birthday party — **NEW**
1. As the parent: Festas → Nova → Festa B, 17 children, 10 cachorros, the decoration pack.
   ✅ Summary: **Subtotal €327.00 · IVA 23% €75.21 · Total €402.21 · Sinal €201.11**.
2. Every party page (list, detail, booking) shows subtotal / IVA / total. ✅ No page shows the
   pre-VAT amount as "Total".
3. As admin: Festas → Reservas (`/admin/parties`) → confirm. Configuração
   (`/admin/party-config`): a per-unit extra has a quantity field.
4. As the parent: pay the deposit (sandbox). ✅ The billing doc's `total` is **201.11**.

### K6. Summer camp
1. As admin: Campos (`/admin/camps`) → create a camp with dates and price.
2. As the parent: Campos → subscribe a child. ✅ A deposit bill.
3. As admin: confirm; create the balance bills. ✅ The balance bill = price − deposit.

### K7. Admin month-end
1. Famílias e inscrições → "Recalcular tudo". ✅ No bill that's paid or invoiced changes.
2. Resumo Financeiro (`/admin/financial-summary`). ✅ Both pricing models show; the totals match
   the subscriptions.
3. Email center (`/admin/email-center`): write an email with variables (child's name), choose an
   audience, save it as a template, send to a test family. ✅ One outbox doc per recipient,
   variables filled in, listed in history.

## 3. FinHub — scenarios

Log in at the dev URL. ✅ Login works; it failed before #75 because the dev build used prod's
config.

### F1. Find your way around — **NEW**
1. ✅ Visão geral, Previsão, Créditos at the top, then the "A ver" picker.
2. ✅ Casa: Rendimento · Recorrentes · Contas · Empréstimos · Seguros · IRS.
   ✅ NoisySource: Clientes · Contratos · Salários · Recorrentes · Contas · Seguros · IVA.
   ✅ NoisyPhocus: KidClub · Contratos · Salários · Recorrentes · Custos do mês · Contas · Seguros · IVA.
3. On Contas, switch company. ✅ You stay on Contas. On NoisySource → Salários, switch to Casa.
   ✅ You land on Contas.
4. Reload on Visão geral. ✅ The picker remembers the company. `/noisysource/cashflow` → ✅ Contas.

### F2. Bank statements — **NEW (PDF)**
1. NoisySource → Contas → the BPI account → Importar extrato → drop the monthly **PDF**.
   ✅ Preview with movements; balance check passes; import. ✅ The account balance = the
   statement's closing balance and date.
2. Import the same PDF again. ✅ All lines counted as duplicates; nothing added.
3. Try the **XLSX** of the same month. ✅ Refused: mixing formats for the same dates would
   duplicate movements.
4. Drop a statement that belongs to a different account, or a month already imported as XLSX.
   ✅ Refused, with the reason shown in the modal.
5. Contas → pencil on an account → change the balance and its date. ✅ Saved (replaces Cash Flow).

### F3. NoisyPhocus's month — **NEW**
1. Contratos: add the driver (normal contract, with SS) and the teacher (recibo verde).
   ✅ Recibo verde hides SS and Benefits.
2. Salários. ✅ Only NoisyPhocus's two people. NoisySource → Salários still shows Renato and Marisa.
3. Recorrentes → "+ Nova entrada" → expense: Vendus (Fixo) and EasyPay (Comissão, its %).
   ✅ "comissão X%" badge on EasyPay.
4. IVA → this quarter. ✅ EasyPay's base = KidClub's paid volume × %. ✅ "IVA liquidado" shows
   KidClub's real Vendus figures (that function reads Vendus, read-only, even on dev).
5. Custos do mês. ✅ One line per worker, Vendus, EasyPay and a VAT line; check the total by hand.
   ⚠️ Known: VAT is counted twice if you typed amounts with VAT. That's fixed by the VAT session
   (§6); note it, don't report it as new.
6. KidClub (revenue page). ✅ Matches KidClub's Cobranças for the month.

### F4. NoisySource's month
1. Clientes: the EC contract, mark a few days off in the month. ✅ The expected invoice drops by
   those days × daily rate.
2. Recorrentes and IVA. ✅ Same numbers as before the release.
3. Previsão. ✅ The 12 months show EC payments, salaries and recurring costs for all companies.
   ⚠️ Known: NoisyPhocus salaries are missing from the forecast (STATUS.md "known bugs").

### F5. Household
1. Casa → Rendimento, Empréstimos, Seguros, IRS. ✅ They load with your data.
2. IRS simulator. ✅ Runs for the current year with both incomes.
3. Créditos (top). ✅ All companies' credits together.
4. Vault. ✅ Opens and lists entries.

## 4. Going to prod

Only after §2 and §3 pass on dev.

**KidClub (+ Firestore rules, indexes, functions):**
1. Open a PR **`staging` → `main`**. Opening it deploys to prod (only `staging` as head does).
   `ci-checks.yml` runs build/typecheck alongside.
2. Check the PR's commit list: it should be #81, #75, #82, #85, #80, #83, #86, #73 (+ any VAT
   PRs if you wait for them). Anything else, stop and ask.
3. When the deploy check is green, smoke-test **prod**, read-only:
   - kidclub.pt loads; you can log in as admin; Cobranças and Famílias e inscrições load.
   - A party page shows subtotal / IVA / total (look, don't book).
   - Firebase console → Functions → logs: no new errors in the first ~15 minutes, in particular
     none from `syncVendusClient` or `createPartyDeposit`.
4. Merge. The merge re-deploys and triggers the staging sync. If the sync fails again (#80), merge
   `main` into `staging` by hand like #86.

**FinHub (automatic with KidClub, once #88 is in `staging`):**
1. Decide Q1 below **before opening the `staging` → `main` PR**: opening it deploys FinHub to
   prod too. Check #88 is in that PR's commit list. Without #88, FinHub doesn't deploy; run
   "Deploy Finances" on `main` after the merge instead.
2. The deploy job builds FinHub with the prod build and refuses to deploy if the bundle's
   `projectId` isn't `rainbow-prod-2454b`. In the run's log: ✅ "Check both builds target
   rainbow-prod-2454b" and "Deploy FinHub Hosting" are green.
3. Smoke test `https://rainbow-prod-2454b-finhub.web.app`: log in; the picker shows; Contas
   loads your accounts.

**Rollback:** Hosting: Firebase console → Hosting → the site → previous release → Rollback.
Functions: revert the merge on `main` (a PR), which redeploys the previous code.

## 5. Open questions for Renato (before FinHub goes to prod)

1. **Where does your real FinHub data live today, dev or prod?** Everything tested above ran on
   dev. If your real accounts, contracts and recurring entries are on dev, prod FinHub would open
   empty, and the data would need copying or re-entering. (You're re-entering recurring entries
   anyway after the VAT work.)
2. ~~**FinHub prod deploys from now on**~~ — answered 2026-10-12: automatic, in the same pipeline as
   KidClub (#88). `deploy-finances.yml` stays as a manual fallback (dev from `staging`, prod
   from `main`).
3. **Firebase Storage on prod:** needed for payment proofs (KidClub) and insurance documents
   (FinHub). Enable it before relying on those in prod? It also needs the stricter storage rule
   flagged in `apps/noisysource/finances/HANDOFF-email-expenses.md` §3.4.
4. **Release now, or wait for the VAT work?** Recommendation: release what's in `staging` now.
   It's tested and small on the KidClub side. The VAT PRs then go in a second, smaller release,
   with their scenarios added to §6.

## 6. Added by later sessions

_Each session that ships something for this release adds its scenarios here, in the same format
(story → steps → ✅ expected), and notes which section above it changes._
