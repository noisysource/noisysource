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
- **#87 (VAT PR 1)** adds `packages/shared/lib/vat.ts`, which the KidClub build includes, but no
  KidClub screen or billing changes. KidClub's own VAT work (transport, study room, fees) is
  PR 2, not in this release.
- Already in prod, but `staging` needs it before testing: **hotfix #84** (Vendus client-creation
  loop), brought into `staging` by **#86**.

**FinHub, new in this release.** Prod FinHub still runs a **build from 2026-07-31** (it still has
Cash Flow). Its prod deploy job (`deploy-finances.yml`) was disabled (`if: false`) from the April
repo migration. **#88** puts FinHub in the same pipeline as KidClub: once it's in `staging`, the
`staging` → `main` PR deploys FinHub to prod too. So this is FinHub's first real release in
months:
- **#75 Cost model:** Fixo/Comissão recurring costs (EasyPay = % of KidClub's paid volume),
  recibo verde contracts, Payroll limited to the selected company, `/noisyphocus/costs`
  (Custos do mês), dev build fixed (`build:staging`), no-cache headers.
- **#82 One menu:** the "A ver" picker (Casa / NoisySource / NoisyPhocus), the same menu
  structure for every company, Cash Flow removed (→ Contas), Portuguese labels.
- **#85 BPI PDF statements:** the account import accepts the monthly BPI PDF as well as XLSX,
  with a line-by-line balance check that refuses the whole import on any mismatch.
- **#87 VAT convention, PR 1 (merged into `staging` 2026-10-12):** recurring amounts are stored
  **with VAT** and carry a VAT code (23 / 13 / 6 / 0 / Isento / Autoliquidação / Por confirmar);
  the form has a "com IVA / sem IVA" switch. **Every existing recurring entry shows "IVA por
  confirmar"** until you re-save it (no migration; you re-enter them, §6 V1), and until then it's
  left out of the IVA page totals. The IVA page and Custos do mês take the VAT out of the amount
  instead of adding it on top (fixes the double count); Custos do mês has com IVA / sem IVA
  columns and no longer counts a contract's pay twice. EasyPay's % is before VAT, with VAT on
  top; the forecast charges it on each month's KidClub revenue. EC contracts are exempt
  (`isento`), so EC cash-in doesn't change.

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
3. **FinHub on dev:** once **#88** is merged, every PR into `staging` and every merge deploys
   FinHub to dev with KidClub; no manual step. Until then, "Deploy Finances" on `staging`
   (GitHub → Actions) does it by hand. KidClub deploys to dev automatically
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
3. Recorrentes → "+ Nova entrada" → expense: Vendus (Fixo, IVA 23%, the invoice amount "com
   IVA") and EasyPay (Comissão, "Comissão (% sem IVA)", IVA 23%). **Changed by #87.**
   ✅ "comissão X% sem IVA" badge on EasyPay; "sem IVA … · IVA 23% …" under each amount.
4. IVA → this quarter. ✅ EasyPay's base = KidClub's paid volume × %, and its IVA = 23% of that
   base. ✅ Vendus's base = amount ÷ 1.23 (VAT taken out, not added). ✅ "IVA liquidado" shows
   KidClub's real Vendus figures (that function reads Vendus, read-only, even on dev).
5. Custos do mês. **Changed by #87.** ✅ One line per worker, Vendus and EasyPay, in two columns,
   com IVA and sem IVA; no separate VAT line. ✅ A worker appears once ("Contrato — …" or "Recibo
   Verde — …"), not again as "Encargos Salariais". Check by hand: total com IVA − total sem IVA =
   the IVA under Software.
6. KidClub (revenue page). ✅ Matches KidClub's Cobranças for the month.

### F4. NoisySource's month
1. Clientes: the EC contract, mark a few days off in the month. ✅ The expected invoice drops by
   those days × daily rate.
2. Recorrentes and IVA. **Changed by #87.** ✅ Every entry you haven't re-saved has an amber
   "IVA por confirmar" badge, and the IVA page lists it under "IVA por confirmar — fora dos
   totais", so the IVA totals are lower until you re-enter them (§6 V1, V2). The EC income line
   shows "Isento de IVA".
3. Previsão. ✅ The 12 months show EC payments, salaries and recurring costs for all companies.
   ✅ EC payments are the same amounts as before #87 (EC is exempt).
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
2. Check the PR's commit list: it should be #81, #75, #82, #85, #80, #83, #86, #73 (+ #87, #88 and
   any later VAT PR if you wait for them). Anything else, stop and ask.
3. When the deploy check is green, smoke-test **prod**, read-only:
   - kidclub.pt loads; you can log in as admin; Cobranças and Famílias e inscrições load.
   - A party page shows subtotal / IVA / total (look, don't book).
   - Firebase console → Functions → logs: no new errors in the first ~15 minutes, in particular
     none from `syncVendusClient` or `createPartyDeposit`.
4. Merge. The merge re-deploys and triggers the staging sync. If the sync fails again (#80), merge
   `main` into `staging` by hand like #86.

**FinHub (automatic with KidClub, once #88 is in `staging`):**
1. Decide Q1 below **before opening the `staging` → `main` PR**: opening it deploys FinHub to
   prod too. Check #88 is in that PR's commit list. Without it, FinHub doesn't deploy; run
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
4. **Release now, or wait for the VAT work?** VAT PR 1 (#87, FinHub + the shared helper) is
   ready for review; KidClub's PR 2 isn't started. #87 changes no KidClub screen, so it can go in
   this release if it's merged and §6 V1–V5 pass. If it does, re-enter the recurring entries
   (V1) **where your real FinHub data lives** (Q1): on prod after the deploy if that's where it
   is, otherwise they stay "IVA por confirmar" there.

## 6. Added by later sessions

_Each session that ships something for this release adds its scenarios here, in the same format
(story → steps → ✅ expected), and notes which section above it changes._

### VAT convention, PR 1 — FinHub (#87)

Changes F3.3, F3.4, F3.5, F4.2 and F4.3 above. Rule: a recurring amount is what the invoice says,
**VAT included**, with a VAT code. "IVA por confirmar" means unknown; it's never treated as 0.

#### V1. Re-enter your recurring costs (one-time cleanup)
1. NoisySource → Recorrentes. ✅ Banner "N entradas têm IVA por confirmar"; each existing entry
   has an amber "IVA por confirmar" badge. Casa → Recorrentes: ✅ no VAT badge, banner or field.
2. Editar an entry with a Portuguese invoice (e.g. Google Workspace). ✅ Under the IVA buttons:
   "Entrada guardada antes da regra do IVA (taxa X%)…". Pick **23%**, type the invoice total,
   keep **com IVA**. ✅ Under the amount: "Guarda €X com IVA · sem IVA €Y · IVA 23% €Z". Save.
   ✅ Badge gone, "sem IVA … · IVA 23% …" under the amount, banner count down by one.
3. Editar Claude AI (Anthropic, reverse charge): pick **Autoliquidação**. ✅ No com/sem IVA switch;
   the line reads "Autoliquidação". Same for insurance or bank fees with **Isento**.
4. A cost you only know before VAT: pick 23%, switch to **sem IVA**, type 100. ✅ "Guarda 123,00 €
   com IVA". Save and reopen. ✅ The amount is 123,00 with "com IVA" selected.
5. New entry of type Transferência. ✅ No IVA block. Leaving the code on **Por confirmar** saves
   the amount as typed and keeps the badge.
6. Repeat for NoisyPhocus (Vendus, EasyPay; see V3). ✅ Banner gone when every entry has a code.

#### V2. The IVA quarter takes VAT out of the amounts
1. NoisySource → IVA → this quarter, after V1. ✅ A 23% monthly entry of 7,20 € shows base
   17,55 € and IVA 4,05 € for the quarter (5,85 € + 1,35 € a month: 7,20 × 23 ÷ 123 = 1,35).
   Before #87 it would have shown IVA 23% *on top* of 7,20 €.
2. ✅ Entries still "por confirmar" are listed under "IVA por confirmar — fora dos totais" with
   their amount, and aren't in IVA dedutível / liquidado.
3. ✅ Autoliquidação, Isento and 0% entries don't appear. The EC income isn't listed (exempt).

#### V3. NoisyPhocus's month, com IVA and sem IVA (Custos do mês)
1. NoisyPhocus → Recorrentes: Vendus = Fixo, 23%, the invoice total com IVA. EasyPay =
   Comissão, "% sem IVA" = its rate (e.g. 1,4), 23%, an estimate com IVA.
2. Custos do mês → this month. ✅ Two columns, com IVA and sem IVA. Vendus: com IVA = invoice
   total, sem IVA = total ÷ 1,23. EasyPay: sem IVA = KidClub volume × %, com IVA = that × 1,23.
   ✅ No "IVA dedutível (custos)" line. ✅ Software card: "sem IVA … · IVA …"; Total card: com IVA
   with "sem IVA …" under it.
3. With the driver's contract (F3.1): ✅ "Contrato — <name>" appears once, equal in both columns;
   no "Encargos Salariais — <name>" line.
4. Set one entry back to **Por confirmar**. ✅ Amber warning "1 custo tem IVA por confirmar e entra
   pelo valor guardado nas duas colunas…"; that line says "IVA por confirmar".
5. Compare a month opened before #87 (if any): it's recomputed on open, so ✅ the old extra VAT
   line disappears there too.

#### V4. The forecast follows KidClub for EasyPay
1. Previsão → NoisyPhocus → a month with KidClub bills (this month or next). ✅ EasyPay =
   (that month's KidClub line) × % × 1,23.
2. A month further out with no KidClub bills yet. ✅ EasyPay = the estimate you typed.
3. ✅ EC payments are unchanged (V2.3). Visão geral (Dashboard) still uses EasyPay's estimate;
   that's expected.

#### V5. EC contracts are exempt
1. NoisySource → Clientes → the EC contract → Guardar without changes. ✅ Saves as before.
2. Recorrentes → the EC income line. ✅ "Isento de IVA" under the amount, no badge.
3. Previsão. ✅ EC payment amounts identical to before saving.

**Still open (not a bug):** EasyPay's % is assumed to be before VAT (handoff Q3). Check one real
EasyPay fee invoice: if it shows base + IVA, V3/V4 are right; if the % already includes VAT, tell
the next session (the fix is one line in `recurringMonthlyAmountCents`).
