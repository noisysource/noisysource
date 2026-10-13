# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-13

## 🧾 No Vendus client without a NIF: "Consumidor final" (2026-10-13) — `agent/kidclub-nif-consumidor-final`, PR #93 → `staging`, NOT in prod

**Decision (Renato, 2026-10-13): option B**, chosen over keeping named NIF-less clients (background: the
2026-10-11 client-loop section below and its "Update 2026-10-12"). A family without a NIF is invoiced to
"Consumidor final", with no Vendus client. **Legacy NIF-less families are now Consumidor final too**,
including the ~10 holding an old NIF-less `vendusClientId` (the id stays on the doc, unused; nothing is
deleted in Vendus). **Verified on live Vendus 2026-10-13, before this branch:** a test-mode `POST /documents/`
(`type: FR`, `mode: tests`, no `client`) returned 201, document `FR T01P2026/1`, `client: null`, and the
client count didn't change. Vendus accepts it and doesn't create a client.

**What the PR does**
- `billing.ts`: no NIF → `createInvoice(null, …)`, no `client` field, nothing created or updated in Vendus,
  family doc untouched. NIF → as before (ensure the client if there's no `vendusClientId`, invoice it). "No NIF"
  = `nif` missing, blank or `999999990` (`familyInvoiceNif`); the old placeholder logic is gone. A stored
  *invalid* NIF still goes the NIF way and fails at Vendus with `invoiceError`, as before (not silently
  Consumidor final).
- `syncVendusClient`: families without a NIF are skipped, no Vendus call; a stale `vendusSyncError` on them is
  deleted. #91's change detection, `vendusSyncError` and write-back-only-if-changed are unchanged.
- NIF added later (`createOrUpdateClient`): with a NIF and a `vendusClientId`, it first reads that client
  (`GET /clients/{id}/`). If it has no NIF **or a different one**, it's left alone: NIF lookup → link, else
  create (50/day cap); the sync write-back re-links the family. A NIF is never PATCHed onto a client that has
  none, so the unverified "Vendus refuses a NIF change" case is gone. Cost: one Vendus GET per sync of a family
  with a NIF and a client (syncs only run when a synced field changes). #91's "duplicado → re-link" stays as a
  fallback.
- Profile (setup, A minha conta): NIF required unless "Não pretendo NIF na fatura" → `nifOptOut: true` and
  `nif` deleted; saving a NIF deletes `nifOptOut`. Nobody is sent back through setup (the gate is still
  `profileComplete`); legacy families choose on their next save of A minha conta. Admin "Dados da família":
  same checkbox, clearing a NIF needs it, legacy families still save without touching the NIF; the panel shows
  "Sem NIF / Não pretende (Consumidor final)".
- Pagamentos: no NIF and no opt-out → amber banner "Adicione o seu NIF antes de pagar para que conste na
  fatura" → A minha conta. Payment isn't blocked.
- After a Consumidor final invoice is recorded: a "Fatura disponível" email (emailOutbox) with the Pagamentos
  link and a line asking for the NIF. Only for Consumidor final invoices; failing to queue it never affects the
  invoice.
- Tests: functions 221/221 (new `billing.test.ts`, `syncVendusClient.test.ts`; `vendus.test.ts` updated for the
  GET-first flow). App typecheck: the same 11 old errors; build OK. No Vendus calls, no prod access.

**How parents get invoices (finding, from the code only):**
- **Vendus email:** only through a client with `send_email: "yes"`. Billing sets it only on clients it creates
  or links at invoice time (family without `vendusClientId`). `syncVendusClient` creates most clients (at
  profile completion) and never sends `send_email`, so those have Vendus's default, not checked here. If that
  default is "no", families *with* a NIF get no invoice email today either.
- **Portal:** Pagamentos → "Descarregar fatura" on every invoiced bill (`getInvoicePdf`: bill → `vendusId`,
  cached, 100/day cap). Works with or without a client.
- **emailOutbox:** parents only get "Pagamento pendente" notices. No payment-confirmation or invoice email from
  the EasyPay webhook or `markBillingPaid`.
- So Consumidor final invoices would only be in the portal; hence the "Fatura disponível" email.
- **Open for Renato:** read `send_email` on 2–3 sync-created prod clients. If "no": add `send_email: "yes"` to
  the sync payload (one line, applies at each family's next sync), or send "Fatura disponível" for every
  invoice (drop the `consumidorFinal` condition in `createVendusInvoiceForBilling`).

**How to test on dev.** Dev skips Vendus entirely (invoicing throws on `kidclub-dev`, the sync returns early), so
the invoice path, the late-NIF re-link and the email can only run on prod.
1. `parent-test@kidclub.pt` (`TEST-FAMILY-QA`, `nif: "999999990"`, which now counts as no NIF) → Pagamentos
   shows the banner; the pay buttons are still there.
2. A minha conta → Guardar → asks to tick the box. Tick "Não pretendo NIF na fatura" → Guardar → doc has
   `nifOptOut: true` and no `nif`; banner gone. Untick, type `123456789` → saves, `nifOptOut` removed. An
   invalid NIF → red error, button disabled.
3. Setup page: set `profileComplete: false` on the QA family in the dev console, reload: same rules.
4. Admin Inscrições → the family → Editar: the checkbox; clearing the NIF without it → error.

**After promotion to prod, check (read-only):**
- The first invoice for a family without a NIF shows "Consumidor final"; the bill has `invoiceNumber`/`vendusId`;
  log `[Vendus] invoice created … client=Consumidor final`; its "Fatura disponível" outbox doc is sent.
- **No new Vendus client appears** for that family (client count unchanged by that invoice).
- A family with a NIF still invoices to its client (log `client=<id>`).
- The first legacy family that adds a NIF: log `client X has NIF "", not …`, then link or create; its
  `vendusClientId` changes; the old client is untouched.
- Cross-app: root `CLAUDE.md` → "Cross-App Data Contracts": FinHub must link invoices by `invoiceNumber`/
  `vendusId`, never the Vendus client name.

(#91 is merged: in `main`, and in `staging` via #92. The 2026-10-11 section's header below still says OPEN.)

## 🧾 VAT on subscriptions — VAT convention PR 2 (2026-10-12) — #89 (`agent/kidclub-vat-pr2`) → `staging`, NOT in prod

**What the check found (read-only, dev + prod + invoice FR 01P2026/202).** Families pay exactly the
price the app shows; VAT is already inside it (billing sends each line to Vendus as `gross_price`).
Prod: no bill line is the price + VAT, none is above the shown price. Vendus products: study room,
enrollment fee, insurance **23%**, transport **6%**. The transport page was wrong: it showed
"+ €X IVA" on top, using `config/transportation.vatRate` = **0.23 on prod**, a field billing never
reads. **Renato's decision: fix the page, keep what families pay.**

**What the PR does (display only, no billed amount changes):**
- `packages/shared/models/kidclubVat.ts`: `KIDCLUB_VAT` (rate per service, mirroring the Vendus
  products) and `kidclubVatNote` / `kidclubVatNoteMixed` (split a com-IVA price; mixed totals split
  once per rate, like the invoice).
- Families: transport and study-room detail pages, the child panel and the enrollment price box show
  "IVA incluído · sem IVA €X · IVA 6%/23% €Y". The transport page no longer reads the transport
  config or sibling subscriptions (they only fed the removed line).
- Admin: transport price (planner ⚙ and `/admin/transport-config`), study room €/dia, enrollment fee
  and insurance say "com IVA" with the split; the subscription card shows it under the price. The
  editable transport "IVA (%)" is gone (read-only "IVA 6% … produto Vendus"); `vatRate` is
  deprecated in the model, old docs keep it, no migration. Insurance is labelled once per child and
  school year (it said €/mês).
- Parties: `partyVatBreakdown` and `partyDepositAmount` take the VAT from `vat.ts`; the deposit keeps
  its rounding. `functions/src/kidclub/partyPricingParity.test.ts` pins every subtotal €0–€5000 to the
  cent (the helper's own rounding would have moved ~3% of deposits by 1 cent, so it isn't used there).

**How to test on dev:** `RELEASE-TEST-PLAN.md` §6 V6–V9 (and K2.4). Not clicked through by the agent:
builds, typecheck (no new errors; 11 old ones remain) and the 177 function tests pass.

**Open:**
- Ask the accountant whether insurance should be exempt; today Vendus invoices it at 23%. If so: change
  the Vendus product, then `KIDCLUB_VAT.insurance`.
- `getKidclubVatSummary` (`functions/src/kidclub/vatSummary.ts`) has no sign-in/admin check and is
  callable by `allUsers` (checked on dev): anyone could read KidClub's quarterly sales by VAT rate,
  and each call makes one Vendus request per invoice. Not fixed here; small separate fix.
- Lists and totals (Inscrições list, dashboard, child page totals) still show the com-IVA price
  without the split. Deliberate: the handoff asks for setup and detail pages.

## 🎈 Party prices 2026/27 + IVA + extra quantities (2026-10-07) — branch `agent/party-pricing-vat`, PR → `staging`, code NOT in prod

**Prod data already changed (done 2026-10-07, Renato asked).** `config/party` on prod now matches the
"apresentação festas 26_27" PDF. Prod had 0 party bookings and 0 party deposits, so nothing was repriced.
Same config copied to kidclub-dev. Old prod values, for rollback: A 150/14 kids/+7, B 200/+10, C 225/+10;
extras Prato de Fruta 4, Gelatinas (pack 6) 2.5, Pizza 4, Cachorro (pack 4) 5.

| Party type | Base (sem IVA) | Kids incl. | Extra child |
|---|---|---|---|
| A | 150 | 14 | 7 |
| B (lanche simples) | 210 | 14 | 14 |
| C (lanche completo) | 240 | 14 | 17 |

B and C read the PDF's "60€ (criança extra 7€)" / "90€ (criança extra 10€)" as **added on top of A**.
If Renato meant them as standalone, change B/C in Admin → Configuração das Festas.
Extras (sem IVA): Cachorro 2/unidade, Sobremesa 2/unidade, Prato de Fruta 4.5/prato, Pizza 3.5/unidade,
Gelatinas ou iogurtes 3/pack de 6, Convites 6, Poster 100x70 20, Pack decoração temática 55.
The first five carry `perUnit: true` + `unitLabel` — the live prod code ignores those fields until this PR ships.

**What the PR fixes.**
- **Deposit undercharged IVA.** `createPartyDeposit` billed 50% of `Booking.total` (pre-IVA) and Vendus treats
  line amounts as gross: a €150 party gave a €75 invoice instead of €92.25. Now 50% of total + 23%.
- **Client pages hid IVA.** Booking, detail and list pages showed the pre-IVA total as "Total". All party views
  now use `packages/shared/models/partyPricing.ts` and show subtotal / IVA / total / sinal.
- **Quantities.** Per-unit extras get a stepper (client) or number input (admin). Stored in the existing
  `Booking.extrasDetail` map; an extra with no entry counts once, so old bookings price the same.
  `Booking.total` still means the pre-IVA subtotal.

**How to test on dev (after the PR deploy is green):** book a party as a parent with 17 kids, Festa B,
10 cachorros + Pack decoração → summary should read subtotal €327, IVA €75.21, total €402.21, sinal €201.11.
Confirm it as admin, then "Pagar sinal" → the billing doc's `total` should be 201.11.

**Open / not done:**
- Overtime (€5 per 15 min) and "sob consulta" items (bolo, pinturas faciais, pinhatas) aren't modelled.
- `Booking.total` is written by the client; the deposit function trusts it. Recomputing server-side from
  `config/party` would close that — not done here.
- The admin edit form recomputes `total` from the *current* config as soon as a booking is opened, so editing
  an old booking after a price change silently reprices it (pre-existing behaviour).

## 🆕 Bank transfer payments (2026-10-07) — branch `agent/kidclub-bank-transfer`, PR → `staging`, NOT in prod

**What it does.** Parents can pay by bank transfer, optionally upload a proof (dev only for now — see
below), and an admin marks the bill
paid by hand, which issues the Vendus invoice exactly like an Easypay payment does.
- **Payment-method bug fixed.** Profile pages saved `families.defaultPaymentMethod`, billing read
  `families.paymentMethod`, so every bill said "mbway". Now one field, `paymentMethod`: profile pages write
  it (and delete the old one); billing reads `paymentMethod ?? defaultPaymentMethod`. The recompute (any
  subscription/absence change, or "Recalcular tudo") copies it onto still-pending bills, so **no data
  migration is needed** — "Recalcular tudo" after the prod deploy fixes every pending bill at once.
  `setPaymentMethod` (unused callable) also fixed: it looked families up by a non-existent top-level `userId`.
- **`markBillingPaid`** (admin): pending/processing/failed → `paid` in a transaction (double-click safe,
  tested: 3 concurrent calls → 1 succeeds), stores `paidAt` (date the transfer arrived), `paymentMethod:
  bank_transfer`, `manualPayment {by, at, note}`, then `createVendusInvoiceForBilling`. A Vendus failure
  lands in `invoiceError`; the existing "Tentar faturar novamente" covers it.
- **`attachPaymentProof`** (parent or admin): files go to Storage
  `_apps/arcoiris/billing/{billingId}/proofs/{timestamp}-{name}`; the callable checks ownership + that the
  object exists and records `paymentProofs[]` + `proofSubmittedAt` on the bill. **Never changes status** —
  no new BillingStatus. A parent upload queues an email to `admin@kidclub.pt` (`ADMIN_EMAIL` in
  notifications.ts).
- **Webhook:** an Easypay success on a bill already paid by manual transfer is now flagged in
  `duplicatePaymentEasypayIds` (the existing "Pagamento em duplicado — devolver" alert) instead of being
  silently ignored. `initiateMbwayPayment` no longer moves a bill paid meanwhile back to `processing`.
- **UI.** Cobranças: "Marcar como pago" modal, "📎 Comprovativo recebido" badge, "Só com comprovativo"
  filter + banner, duplicate/invoice-error badges, "Dados para transferência" panel (edits `config/billing`).
  Pagamentos: bank-transfer bills show IBAN + amount + suggested description ("<nome> — <mês>") with MB WAY
  still one click away; "Enviar comprovativo" on any unpaid bill; "A aguardar confirmação da transferência".

**How to test on dev (kidclub-dev, after the PR's deploy is green):**
1. Cobranças → "Dados para transferência" → Editar → put any test IBAN → Guardar.
2. As a parent (or impersonating one): Conta → Método de pagamento → Transferência bancária → Guardar.
   Pagamentos → an unpaid month shows the IBAN box. "Enviar comprovativo" → pick a PDF/JPEG → the month shows
   "A aguardar confirmação"; an email doc appears in `emailOutbox` (dev never actually sends).
3. As admin: Cobranças → banner "1 mensalidade com comprovativo" → Ver → "Marcar como pago" → confirm.
   **On dev the bill goes to `paid` with `invoiceError` "Vendus invoicing is disabled on kidclub-dev"** —
   expected: dev has no Vendus sandbox and the code refuses to create real invoices from dev. The invoice
   step itself is unchanged code (same function the webhook uses).
4. Try "Marcar como pago" again → refused (failed-precondition).

**⚠️ Before this goes to prod (staging → main):**
- **Fill in the IBAN** (Cobranças → Dados para transferência) right after the prod deploy — and on dev now
  for testing. Value (Renato, 2026-10-07; checksum verified): IBAN `PT50 0010 0000 6456 3890 0018 3`,
  titular `NoisyPhocus, Lda.`. `config/billing` doesn't exist on prod yet; until it's filled in,
  bank-transfer parents see "dados ainda não disponíveis — contacte-nos ou pague por MB WAY". (An agent
  write of this doc to dev/prod Firestore was blocked by the auto-mode classifier — use the panel.)
- **Then "Recalcular tudo"** so pending bills pick up each family's method. Renato OK'd updating them
  (2026-10-07). Prod counts (read-only, 2026-10-07, 41 families): 18 `bank_transfer` → IBAN view first,
  18 `mbway`, 5 with no method (→ billed as mbway). None have the new `paymentMethod` field yet.
- **No manual invoker step.** Checked 2026-10-07: prod's CI SA already has `roles/run.admin` (granted by
  hand, not yet recorded in `iam.tf`), and on dev both new callables got `allUsers` automatically. Spot-check
  `gcloud run services get-iam-policy markbillingpaid --region europe-west3 --project rainbow-prod-2454b`
  after the prod deploy anyway.

**Proof uploads ship hidden on prod (Renato, 2026-10-07: "remove the upload, we'll do it later").**
`VITE_PAYMENT_PROOFS=true` is set only in `.env.staging`, so dev keeps uploads and the prod build hides every
upload entry point (`PAYMENT_PROOFS_ENABLED` in `src/lib/paymentProof.ts`). Backend (`attachPaymentProof`,
`storage.rules`, dev-only storage-rules CI step) stays in place. To turn it on later, as its own PR:
1. Activate Firebase Storage on prod — checked 2026-10-07: **never activated** (no bucket,
   `firebasestorage.googleapis.com` disabled, no storage rules release). Bucket location is permanent;
   recommendation `europe-west3` (EU residency for parents' bank receipts, cents/month) over the free-tier
   `us-east1` that dev uses.
2. Grant `roles/firebaserules.firestoreServiceAgent` to
   `service-237627939595@gcp-sa-firebasestorage.iam.gserviceaccount.com` (only exists after step 1 — a
   `google.prod` Terraform resource for it pushed before step 1 breaks every dev apply). Also record
   `prod_ci_run_admin` in `iam.tf`. These IaC edits are blocked for agents by Claude Code's auto-mode
   classifier — Renato makes them or allows them.
3. **Tighten `storage.rules` first:** `finances/{entityId}/insurances/**` allows any signed-in user, which on
   the shared prod project means any KidClub parent. Change to the `finhubAdmin` role (same as
   `finances_entities` in firestore.rules) before storage rules ever deploy to prod.
4. `deploy_storage_rules: true` in deploy-prod.yml (nothing deployed there yet, so nothing gets replaced),
   then `VITE_PAYMENT_PROOFS=true` in `.env.production`.
Side effect of Storage being off on prod: FinHub insurance uploads can't work on prod either (Finances is
manual-deploy, so likely unnoticed). `studyRoomService.uploadFile` is dead code — no rule needed.

**Open questions for Renato:** IBAN + account holder value; is `admin@kidclub.pt` the right inbox for proof
notifications (hardcoded `ADMIN_EMAIL`, same as enrolment notifications); should the bank-transfer default
stay for families that never actively chose.

## 🔴 Prod bug (2026-10-11): Vendus client-creation loop — #84 in prod since 2026-10-11 23:02 UTC; follow-up `hotfix/vendus-drop-external-ref`, PR #91 → `main` OPEN, not merged

**Update 2026-10-12 — read this first.**
- **Invoice printing.** Vendus prints a client's `external_reference` next to the name on every invoice
  (customers saw "Renato Lopes (family:Hi1iPRih3G6yXHrNsaAd)"). So `hotfix/vendus-drop-external-ref` stops
  using it: `createOrUpdateClient(familyId, payload, knownClientId)` PATCHes the family's `vendusClientId`
  (only a Vendus 404 falls through), else looks up by NIF, else creates (still 50/day capped). It never sends
  `external_reference`; `findClientByRef` is gone. Issued invoices are certified and can't change.
- **NIF added after the first invoice** (real: family `8pPhu4JCvGUrpBxsaOeY`, no-NIF client 365352238 → NIF already on
  364285165; prod code re-linked her, she's fine). In #91 a "duplicado" on the known client's PATCH re-links to the
  client holding the NIF. Any other failure, or no client with that NIF, is stored as `vendusSyncError` on the family →
  red badge "Vendus: sincronização falhou" in Inscrições (message in the tooltip). The badge clears on the next
  successful sync, which only runs when a synced field changes; after a manual fix, delete the field by hand.
  Still unverified: whether Vendus refuses a NIF change on a client that already has documents.
- **Follow-up, only AFTER that hotfix is deployed: clear `external_reference` on the 31 prod clients that
  have it** (of 37 linked families). Needs Renato's OK; one-off, not app code.
  - Test first on Renato's own client (family `Hi1iPRih3G6yXHrNsaAd`): does a PATCH with an empty value
    actually clear it? If not, ask Vendus support.
  - Sandra Abreu's client 368953853 (family `nnBmdqT7MEL3tNeTQqbM`) carries her old duplicate family's ref
    `family:2InLz9GcyGy2HeOwAdmT`.
  - Not before the deploy: the #84 code still looks clients up by ref, so a NIF-less family would get a
    duplicate client and a family with a NIF would just get the ref set again.
- **Check before/after the deploy (read-only):** each family whose duplicates were deleted must have
  `vendusClientId` = its kept client. The new code PATCHes that id; if it points at a deleted client, the next
  sync (only when a synced field changes) gets a 404 and, without a NIF, creates one new client.
- **Duplicate cleanup progress.** thaise.ps07 (904) and Patrícia Tavares (803) duplicates: fully deleted.
  Ana Bento: ~197,000 of ~264,000 deleted as of 2026-10-12 19:50 local, by `Claude outputs/delete-ana-bento-duplicates.mjs`
  (untracked, outside git), running on Renato's machine and refilling its own batches. The kept clients
  (377476996, 381268108, 382752714) were tagged with family refs on 2026-10-12, so they're among the 31 to clear.
- **Staging sync.** After #84 the "Sync staging with main" job failed as predicted (run 38182393792; the prod
  deploy job in that run succeeded). Fixed by hand: PR #86 merged `main` into `staging` on 2026-10-12, so
  branch `sync/main-to-staging-38182393792` is redundant and can be deleted. The repo setting is still off
  (`can_approve_pull_request_reviews: false`), so expect the same failure after this hotfix merges: open a
  `main` → `staging` sync PR by hand.

**Symptom.** Prod Vendus `/clients/` reports 10,000 items, which is the API's pagination ceiling. ~9,995 of them
are copies of "Ana Bento" created 2026-09-23 (no NIF, no external_reference). On 2026-10-11 21:38:54–21:45:28 UTC,
`syncVendusClient` logged 904 × "Synced family qgQTaxxSpsUJl5bVpVR5 → Vendus client <new id>". Each was a new
client "thaise.ps07" (thaise.ps07@hotmail.com, no NIF). It only stopped because the instance hit its 256 MiB
memory limit. Found by a read-only investigation the same night. Nothing in Vendus or Firestore was changed.

**Mechanism.**
1. `createOrUpdateClient()` (`functions/src/kidclub/vendus.ts`) looks the client up by
   `external_reference=family:<id>`, but created it WITHOUT `external_reference`. Only the duplicate-NIF
   fallback set it. So the next lookup never found the client it had just made.
2. `syncVendusClient` (onDocumentWritten on `families/{id}`) wrote the new `vendusClientId` back to the same
   doc whenever it differed. That re-fired the trigger → new client → new id → another write → loop.
3. Families WITH a NIF escape: Vendus rejects the duplicate NIF and the fallback re-links by NIF. Families
   WITHOUT a NIF loop until something crashes. **Until this hotfix is deployed, any NIF-less, profileComplete
   family saving their profile on prod can start it again.**
4. `billing.ts` (`issueVendusInvoice`, family with no `vendusClientId`) also calls `createOrUpdateClient`. For
   NIF-less families it created a ref-less client each time, and its `vendusClientId` write re-fires
   `syncVendusClient`, so it could start the loop too.

**Fix.** Three independent layers, each one enough to stop the loop on its own:
- `vendus.ts`: `createOrUpdateClient` always sends `external_reference: "family:<id>"` on create, so the next
  lookup finds it. Fixes the billing.ts path too. (Superseded by `hotfix/vendus-drop-external-ref`, see the
  update above: no ref any more, keyed by `vendusClientId`.)
- `syncVendusClient.ts`: returns early unless the doc is new or a field it sends changed (`profileComplete`,
  `nif`, `primaryContact.name/email/phone`). Its own `vendusClientId` write-back no longer calls Vendus. The
  check is `vendusClientFieldsChanged` in `vendusClientLogic.ts`.
- `vendusClientCap.ts`: every `createClient` first reserves a slot in
  `_apps/arcoiris/rateLimits/vendusClientCreate_{YYYY-MM-DD}` (UTC day, in a transaction). Cap **50/day**
  (`DAILY_VENDUS_CLIENT_CREATE_CAP`). Over the cap, or if the counter can't be written, it logs
  `console.error` "[Vendus] daily client-creation cap reached" and throws without calling Vendus. Same pattern
  as the invoice-PDF cap. No rules change: `rateLimits` has no client rule, so it's server-only.
- Tests: `vendusClientLogic.test.ts` (9) and `vendus.test.ts` (5, fetch mocked). `functions` build passes,
  155/155 tests pass. No Vendus calls and no prod access were made.

**What to expect after the deploy.**
- NIF-less families whose current Vendus client has no ref (Ana Bento, thaise.ps07, any others) get **one**
  more client, this time with the ref, the next time a synced field changes (or at their first invoice if they
  have no `vendusClientId`). Their `vendusClientId` moves to it and stays put after that.
- A family whose trigger sync failed isn't retried until a synced field changes. Invoicing still creates or
  links the client when `vendusClientId` is missing, same as before.
- If the cap is ever hit: the trigger logs and gives up (non-fatal). An invoice for a family with no
  `vendusClientId` fails with `invoiceError`, and "Tentar faturar novamente" works the next UTC day.
- Not verifiable without a Vendus call: that `POST /clients/` stores `external_reference`. The existing
  duplicate-NIF path already relies on it via PATCH, and the other two layers stop the loop regardless.
  Read-only check after the next new family: `GET /clients/?external_reference=family:<id>` returns 1 client.
  (Obsolete once `hotfix/vendus-drop-external-ref` is deployed: new clients get no ref.)

**Deploy.** A hotfix PR into `main` doesn't deploy when opened. It deploys on merge, and Renato merges. No
manual steps after (no new function, no new callable, no IAM).
⚠️ The post-merge "Sync staging with main" job will probably fail, as it did after #66 and #74: `staging` is
ahead of `main`, so it can't fast-forward, and opening the sync PR fails with "GitHub Actions is not permitted
to create or approve pull requests" (a repo setting). Merge `main` into `staging` by hand, or turn that setting
on. The 2026-10-05 section below now matches staging's text word for word, so that merge shouldn't conflict
here. A later `staging` → `main` PR deploys its merge ref, which still includes this fix.

**Open follow-ups (not in this PR):**
- **(a) Clean up the ~10,900+ junk clients in Vendus** (~9,995 "Ana Bento" + 904 "thaise.ps07"). Vendus's list
  API can't page past 10,000, so real clients that sort alphabetically after "Ana Bento" can't currently be
  reached via list. Separate, deliberate task.
- **(b) Dangling `vendusClientId`s.** Family `qgQTaxxSpsUJl5bVpVR5` (thaise.ps07) and Ana Bento's family each
  point at one arbitrary duplicate. Decide which client to keep (or let (a) delete them all and the next sync
  make a fresh one with the ref), then fix the family docs to match.
- **(c) Live Vendus key in `.claude/settings.local.json`.** It's hardcoded in always-allow permission rules,
  including write calls. Remove those rules and rotate the key (then update the `VENDUS_API_KEY` secret on
  prod). Renato's decision.

## Where things stand (2026-10-01, end of session)

- **Shipped to prod today:** release #62 (payment retry, Easypay sandbox on dev, email composer, portal
  `userId` fix #60, "Descarregar fatura" #61), plus email hotfixes #63/#64. Email works again.
  `claimfamilybyemail`, `getinvoicepdf`, `resetstuckpayment` got `allUsers` invoker by hand.
- **Not confirmed:** whether the prod `userId` backfill for the empty-portal families (below) ever ran.
  #60 fixes it going forward only. Check before assuming those parents can see their data.
- **Prod data check, 2026-10-01 evening (read-only REST snapshot, deleted after):**
  - **userId backfill DID run.** Only mismatches left are the 2 owner-less families (Anabela Gonçalves
    `GdTXkg9zO0lM93zRVSSE`, palexandra@sapo.pt `dJVtUfA3oDiCJsU2B7LF`) — expected; `claimFamilyByEmail`
    fixes them on first login.
  - ✅ **Sandra Abreu — done (2026-10-02):** duplicate gone, real family `nnBmdqT7MEL3tNeTQqbM` fully linked;
    she knows to log in with smpabreu@hotmail.com (gmail login would create a new empty family).
  - **Maria Clara — relinked 2026-10-02 (Renato ran the PATCH; both subs now in family `LhptHMtIfnl2pjr9ETgv`,
    `childId: ""`).** She hasn't started yet → Renato to set her study sub to **Pendente** (no email; Oct–Aug
    bills auto-cancel). When she starts: "Dados da criança" → Guardar FIRST (creates the child so the €60 fee
    bills), then **Ativo** (emails "Inscrição aprovada", revives the bills). Original finding: **NOT BILLED.** Study sub `Y0E8cYlZ3P0y1csUphCP` (confirmed, from 2026-10-01, €120) and
    cancelled `etKDNsgJGkJHnWHIT9il` point to missing family `H4hFhb2GcFVV0IGEH5Gs` and missing child
    `fOtkoEpZCSU3kVBO8Cra`. Elisa Félix's family is `LhptHMtIfnl2pjr9ETgv` (no NIF/Vendus client yet).
    UI can't relink (both ids set → not "não vinculado"). Fix: Renato runs a reviewed REST PATCH setting
    `familyId=LhptHMtIfnl2pjr9ETgv`, `childId=""` on both, then Admin → Elisa Félix → Maria Clara →
    ✏️ Dados da criança → Guardar. **Open: bill Sept 14–30 retroactively?** (never billed).
  - **Afonso Santos:** confirmed no child record (transport `childId` missing, study `""`), no €60 fee.
    Fix: Admin → Anabela Gonçalves → Afonso Santos → ✏️ Dados da criança → Guardar; fee lands on the
    pending Sept bill.
  - ✅ **Empty families:** Gil Figueiredo and "ooooooooo"/Leonardo Marques **deleted by Renato 2026-10-02**; Anabela Marques has
    nothing; Ana Coelho, Ana Bento, Miriam Inácio signed up but never enrolled; Geral ArcoIris is staff.
  - ✅ Maria Manon Oct = €117.60 confirmed (2026-10-02). **Afonso Santos's "Dados da criança" still to do** —
    after #70 reaches prod (no address needed then).
- **Child `homeAddress` removed from forms (2026-10-01, Renato):** duplicated the family billingAddress,
  insurance doesn't need it, transport has per-trip pickup/dropoff. Handed to a kidclub-feature agent,
  branch `agent/kidclub-child-address`, PR → staging. Existing data kept.
- **Billing fixes, later the same day:**
  - **#66 (hotfix, in prod):** recompute started at the current month, so from Oct 1 every change to an unpaid
    September bill was ignored. Now unpaid earlier months are recomputed too (update only, never created,
    left as-is if a subscription on them is no longer active). Days of a paid/invoiced/processing month are
    locked (server refuses, admin calendar read-only). Verified: Ana Braga's Sept €156 → €108 (10 absences).
  - **#67 (old pricing, deployed to prod via #68, #68 open/unmerged at time of writing):** the engine bills
    per-trip (marginal multi-trip/sibling) but cards, `monthlyFee` and the 2026-10-01 email showed the flat
    model; 5 subs were billed €94.37/month more than shown. Renato's call: grandfather. Subs created before
    2026-10-01 (Lisbon) are billed flat (gross − summed `appliedDiscounts`) until school-year end; new subs use
    per-trip. Per-sub admin switch "🔒 Tarifário antigo / Tarifário novo" (`legacyPricing`) on the card.
    "Recalcular tudo" was run after (25 families, 274 updated). **Confirm Maria Manon Oct = €117.60**; if not,
    run "Recalcular tudo" again (it may have run before #68's deploy finished), then merge #68.
- **Next small tasks (Renato, 2026-10-01):**
  - ✅ **PR #71 → staging (`agent/kidclub-financial-summary`), in test on dev:** summary amounts from bill
    lines, Faturado/Recebido per month, per-model discount simulation, card shows the billed amount on
    new-pricing subs. 2026-10-02 rework (Renato): filters on top, totals right below; new "Receita:
    Recebido / Previsto" toggles drive every total; "Ano letivo" sums all billed months with costs × months. Original spec:
    **Financial Summary must account for both pricing models.** `FinancialSummaryPage.tsx` sums each sub's
    stored `monthlyFee`/`monthlyPrice`, which is the flat figure — wrong for new-pricing subs with multi-trip
    or sibling. Take each sub's standard monthly amount from its billing line instead (current or next pending
    month: `amount + absenceCreditAmount` = net before absences, which the engine computes with the right model;
    fall back to `monthlyFee` only when there's no bill). Also add, per month: **Faturado** (sum of that
    month's bill totals, after absences, incl. fees) and **Recebido** (bills `paid`/`invoiced`). Read-only.
    The "Simulação de descontos" scenario would need the same per-model treatment.
  - ✅ **PR open → staging (`agent/kidclub-maintenance-buttons`):** maintenance buttons moved to a
    "Manutenção" panel at the top of Gestão de Dados (`/admin/data-management`, Renato's pick 2026-10-02).
    Original: **Move the two maintenance buttons off the billing page** into a "Manutenção" section. "Recalcular tudo" (`backfillBillingSchedules`) stays: needed after
    price/rule changes or billing fixes. "Gerar ocorrências" (`backfillReservationEvents`) is repair-only now:
    events regenerate automatically on every subscription write.
  - Low priority: transport `schedule[]` entries have no `direction` (0 of 23 active subs), so line items and
    events say "both" for single-trip days. Amounts are unaffected (gross counts schedule entries); only labels.
  - ✅ (same PR) The subscription card's price for **new-pricing** subs now comes from the bill line.
- **Next feature:** refunds + credit notes → `HANDOFF-refund-credit-note.md` (Mary Pratas's case).
- **Infra, whenever:** `infra/gcp/terraform/HANDOFF-terraform-cleanup.md` (for the `infra-terraform` agent).
- **Parked for later (Renato, 2026-10-01):** Vendus sandbox approach, which driver/electricity costs are
  real, pricing model (GO-LIVE §4), re-enabling card/Multibanco (needs an Easypay POS).

## 🟡 Prod bug (2026-10-05): duplicate Vendus invoices for one EasyPay payment — FIXED in prod, credit notes pending

**Symptom.** One EasyPay payment produced two real Fatura-Recibo in Vendus. Prod logs: 8 extra invoices
since 2026-09-18, latest 2026-10-05 (e.g. Sandra Abreu, billing `nnBmdqT7MEL3tNeTQqbM_2026-10` →
FR 01P2026/209 and /210, "marking paid" logged twice 7ms apart).
**Cause.** EasyPay sends two webhook calls per payment, concurrently. `easypayWebhook` did read → check
status → separate `update(status: "paid")`, and `createVendusInvoiceForBilling` did read → check
`invoiced` → Vendus POST; both calls passed both checks. Same race on the "paid + invoiceError → retry" branch.
**Fix — live in prod:** PR #74 (`hotfix/vendus-duplicate-invoices`), merged 2026-10-07 08:27 UTC; the merge
deploy succeeded (the run shows "failed" only because the sync-staging step can't open PRs — see root
CLAUDE.md). Branch + worktree removed. **Not yet exercised by a real payment** — no EasyPay payment had
arrived as of 2026-10-07 evening; after the next one, check `easypaywebhook` logs for exactly one
"[Vendus] invoice created" per billing id (the second call should log "already processed"). What changed:
- webhook decides + marks paid in a `db.runTransaction`; only the call that performed the transition invoices;
- `createVendusInvoiceForBilling` claims the bill atomically (`invoiceClaimedAt`, transaction) before any
  Vendus call; a Vendus error releases the claim together with `invoiceError`; success clears it with
  `status: "invoiced"`. A stale claim (run died after Vendus succeeded) is never auto-expired — it blocks
  retries; `retryVendusInvoice` (admin) clears it as the explicit override.
**Known gaps (not regressions):** a Vendus network error/5xx after the document was actually issued releases
the claim, so a later retry could still duplicate; a run that dies mid-invoice leaves the bill `paid` with no
invoice and no `invoiceError` (only the admin retry recovers it, nothing flags it).

**Data cleanup — Renato, in Vendus, PENDING as of 2026-10-07:** one credit note per extra invoice, full
amount, €997.80 total. Credit the "extra" one; Firestore's billing record points to the "keep" one. Full log
history (back to 2026-09-12, the first prod invoice) shows no other duplicates. Customers paid once — no refunds.

| Client | Vendus client | Credit | Vendus doc | Issued | Amount | Keep |
|---|---|---|---|---|---|---|
| Sandra Marisa Pereira Abreu | 368953853 | FR 01P2026/209 | 379211541 | 2026-09-29 | €240.00 | /210 |
| Duarte Maia | 376574443 | FR 01P2026/211 | 379565659 | 2026-09-30 | €216.00 | /212 |
| family `RIaPxo4Kdi5MsLNz44CF` (no billingName) | 287409030 | FR 01P2026/214 | 379881465 | 2026-10-01 | €48.00 | /215 |
| Sónia Pires | 377843902 | FR 01P2026/219 | 380058714 | 2026-10-02 | €84.00 | /220 |
| Joana Gomes | 360819064 | FR 01P2026/223 | 380170246 | 2026-10-02 | €60.00 | /224 |
| Andreia Lobo | 373973794 | FR 01P2026/228 | 380764142 | 2026-10-04 | €123.00 | /229 |
| Ana Amaral | 371056105 | FR 01P2026/231 | 380889590 | 2026-10-04 | €118.80 | /232 |
| Cláudia Sofia Mateus Faustino | 291428847 | FR 01P2026/234 | 381086533 | 2026-10-05 | €108.00 | /235 |

## 🔴 Prod bug (2026-09-29): parents see an empty portal — docs linked by familyId but not userId

**Symptom.** Real parents log in and see no children, subscriptions or bills (and can't pay), while
admin impersonation shows everything. **Cause:** the client pages and the Firestore rules match on
`userId`, impersonation queries by `familyId`. Docs got a familyId with no/empty userId via:
1. admin linking (SubscriptionsAdminPage: status-change auto-link, "Vincular", child details form)
   set `familyId` without `userId`;
2. `billing.ts` copied `userId` from whichever subscription triggered the write (or from
   `ReservationEvent.changedBy`), and never corrected it on recompute; the payment callables
   check `billing.userId`, so affected parents can't pay either;
3. `getOrCreateFamily` looked families up by uid only, so a parent logging in with another account,
   or whose family was created owner-less by `identity.mjs`, silently got a new empty duplicate family.

**Read-only prod audit (2026-09-29), families affected:**
- **Sandra Abreu** — logged in with a second (gmail) account, got an empty duplicate family (same
  NIF/Vendus client); Bernardo's transport sub + 3 billing months hidden. The code fix does NOT
  handle this case (her original family is owned by her other uid) — needs a data fix/decision.
- **maria joão mariano** — everything hidden.
- **Maria Teresa Azevedo** — all billing hidden.
- **Mary Pratas** — Manuel Oliveira's study sub hidden.
- **3 owner-less migration families** (Anabela Gonçalves, sofia_valdeira@hotmail.com,
  palexandra@sapo.pt) — would get an empty duplicate on first login; with this PR they claim
  their family instead.
- **Maria Clara** — study sub points to a non-existent family `H4hFhb2GcFVV0IGEH5Gs`, so likely
  **not billed at all**. ⚠️ Needs Renato's decision (relink to the right family, or recreate it).

**Data:** a human-approved `userId` backfill script for prod is being run separately (not in this PR).

**Code fix:** branch `agent/kidclub-family-userid-link`, PR → `staging`:
- billing `userId` now always comes from `families/{id}.primaryContact.userId`, on create and on
  every recompute/backfill update (self-heals `""` on recomputable, i.e. pending/auto-cancelled,
  records; paid/invoiced ones are not touched by recompute);
- admin link paths set `userId` from the family owner whenever they set a non-empty `familyId`;
- new callable `claimFamilyByEmail` (Admin SDK): on a login with no uid-owned family, links owner-less
  families with the caller's **verified** email and backfills `userId` on their children/subs/billing;
  a new family is only created when nothing is claimable. No Firestore rule changes.
- ⚠️ **Prod deploy step:** `claimFamilyByEmail` is a NEW callable — per "Deploy lessons" #2 the CI SA
  can't grant `run.invoker`, so after the prod deploy add `allUsers` → `roles/run.invoker` by hand
  (check dev too). Until then the client fails open to the old create-a-family behaviour.
- Also noticed, not fixed: `setPaymentMethod` looks families up by top-level `userId` (the field is
  `primaryContact.userId`), so it would always throw "Family not found"; no client calls it today.

## ✅ LIVE IN PROD SINCE 2026-09-27 — read this section first

The event-sourced billing rewrite, the September reconciliation and the price changes
are **live on kidclub.pt**. Everything further down this file under "Before go-live" is
history: useful for the *why*, not the current state.

**From now on prod is the source of truth for everything.** Dev was the source of truth for
subscription content only for the one-time promotion. Renato has already changed prod
directly since then (Maria Vicente's 15% "Aluno do ano anterior", re-added in admin), so
**never re-run `promote-subscriptions.mjs`**: it would overwrite live changes with stale dev data.

### What happened at the cutover (2026-09-27, ~21:48–23:05 UTC)

| Step | Result |
|---|---|
| Full prod backup | `gs://rainbow-prod-2454b-exports/golive-2026-09-27-pre-cutover`, 624 docs. **This is the rollback point.** |
| App emails paused | `settings/globals.emailsEnabled=false`. Suppressed only the two Brito "Inscrição aprovada" emails. Back on at the end. |
| Code (#46, staging→main) | Rules, indexes, functions and hosting all deployed. The first attempt failed; see "Deploy lessons" below. |
| `identity.mjs --apply` | 24 writes: 5 duplicate children merged (retired, not deleted), 3 families created (Afonso, Lourenço, Camila), Leonor linked |
| `normalize-emails.mjs --apply` | 2 writes (Leonor: email lowercased, linked to her mother's prod uid) |
| `migrate.mjs --only dates / events / absences` | 7 endDates cleared, 4,785 + 80 events, 52 absences carried. **Step `billing-status` deliberately skipped**: it would have re-opened 24 cancelled bills for two families whose subs are all cancelled (Renato Lopes/Diniz, João Lopes). |
| `promote-subscriptions.mjs --apply` | 31 subs updated from dev, 5 prod-only subs deleted (filhas da tatiana ×2, Filho do Rui, Filhas da Catarina, test). Re-run afterwards: 0 diffs. |
| Audits | Both price audits: 0 mismatches on 36 subs. All 6 paid/invoiced bills unchanged, compared field-by-field with the pre-deploy state. |

**Monthly total after go-live:** €3,196.80 (transport 2,260.80 + study 936.00), then €3,160.80
after Renato re-added Maria Vicente's 15%. Fixed costs are still €3,400–3,650. **Still a loss.**
The pricing question in GO-LIVE.md §4 is deferred, not solved.

**The rule that governed the promotion** (Renato, 2026-09-24/27, recorded for the audit trail):
- **Dev wins** on every subscription field it has: prices, discounts, `discountOverrides`, status, dates.
- **Prod keeps:**
  - identity (familyId, childId, userId, contact fields);
  - `enrollmentFeeBilled`, because it points at billing records and those never travel;
  - any field dev lacked.
- **Paid and invoiced bills** are never touched.
- **Only fees actually paid** in prod count as paid. Everyone else is charged the €35 + €25 on their next bill.

### ⚠️ What went wrong, and how it was fixed

**31 recorded absences dropped off bills mid-migration.** This is the gate-1 hazard below,
and it did happen. The identity and endDate writes ran under the *new* code before the absence
step. That made the billing triggers rebuild four families' September bills, and the rebuild
drops the old `excludedDates`. The four families: Manel Oliveira, Diogo + Bernardo Mogo, José Eduardo.
- **Recovered with Firestore's 1-hour point-in-time read.** A `runQuery` with `readTime` =
  pre-deploy (21:55Z) returned the original 75 absence dates. Now: 44.
- **Of the 31 missing:**
  - 16 had already been carried as events;
  - 3 were Sundays (unmatchable);
  - **12 (all Mogo, 1–10 Sep) were restored by hand** as `CANCELLED`/`staff`/"migrated from excludedDate".
- **Julia Brito's 22 Sep absence** was also recorded by hand. She was `pending` at migration time, so no events existed yet.
- **Lesson for any future data migration:** snapshot every source the migration reads
  *before* the new code deploys, or read it via `readTime`. The 1-hour window is real and short.

**29 historical absences were not migrated, deliberately.** They're on cancelled subs, or on days the
child isn't served (the pre-eb905ed off-by-one). None can reach the ≥3 credit threshold.
The list is in the `migrate.mjs` output. Re-run the dry run to see it.

### Deploy lessons (fix before the next functions change)

1. **The deploy aborts if a function was removed from the source.** `setBillingLineItemExcludedDays`
   (the old "Dias sem serviço" day-picker) had to be deleted by hand:
   `gcloud functions delete … --region europe-west3`. The next removed function will fail the
   same way. Either delete it by hand first, or add `--force` to the CI functions deploy.
2. **The CI service account can't set `run.invoker` on a NEW callable in prod.** The deploy creates
   the function but leaves it uncallable. `setReservationEventStatus` and
   `backfillReservationEvents` were fixed by hand (`allUsers` → `roles/run.invoker`, same as
   every other callable). **Fix properly:** give the CI SA `run.services.setIamPolicy`
   (e.g. `roles/run.admin` scoped, or a custom role) in `infra/gcp/terraform/iam.tf`.
3. **A PR merged while commits are still being pushed strands the later commits.** It happened
   with #47 → #48. Open a new PR for follow-up work instead of pushing to a PR's branch.

### Shipped the same night (#44, #47, #48 → prod via #46/#49)

- **Parents see the final price only.** No discount chips, strikethrough or "discounted" colouring on any client page.
  The admin schedule picker keeps the full breakdown (`showDiscountBreakdown`).
- **Pagamentos is one list** in month order, earliest first. Each month has a tag: Em atraso / Por pagar /
  A aguardar pagamento / Pago. The tabs are gone.
- **Months must be paid in order**, enforced in the MB WAY, Multibanco and card payment functions
  (`assertEarlierMonthsPaid`): "As mensalidades são pagas por ordem…". Only `pending`
  blocks; `processing` and `failed` don't. Party and camp payments are exempt.
  **Consequence:** a family whose September bill is wrong can't pay October until it's fixed.

### ✅ Live: one admin page for families + subscriptions (#52, in prod via #55 on 2026-09-28)

Famílias and Inscrições are merged into **one page** at `/admin/subscriptions` ("Famílias e
inscrições"); `/admin/families` redirects there. Built 2026-09-28 from
`HANDOFF-admin-families-subscriptions.md`, with Renato's design: no tabs, one list, tags, grouping,
search over every field, editing in a family side panel. Merged and **live in prod**. Renato used it in prod to fix Mafalda's NIF and retry
her invoice (worked), and to delete Carla Silva's duplicate family records.

What it does:
- **List:** one row per subscription. Chips filter by status (default: Pendentes + Ativas), service,
  and "needs attention" flags (ação do cliente, aguarda encarregado, erro de fatura, NIF inválido,
  por pagar, não vinculado, rever mensalidade, sem rota, possível duplicado). Grouping: família
  (default), criança, escola, serviço, estado, none. Pending and client-action rows sort first.
  "Mostrar famílias sem inscrições" adds families and unclaimed children with no subscription.
- **Side panel** (`?family=<familyId or email>` in the URL; the Transport Planner's `?highlight=` still
  works): guardian contact + **NIF + billing address** (NIF checksum-validated), bills with
  **invoice errors + "Tentar faturar novamente"** (`retryVendusInvoice`), each child with their
  subscriptions (status, discounts, schedule edit, history), and **"👁 Ver como cliente"**.
- Status changes now say what they set off (approval/rejection email, close-out, billing) before
  writing; cancel asks for an optional reason (it goes into the rejection email).
- Parent pages (A minha conta, first-login profile setup) now reject a NIF that fails the checksum.
- **Bug fixed on the way:** the old page never read `discountOverrides`, so "Repor automático" never
  showed after a reload and toggling one auto discount wiped the other overrides.
- **"Eliminar família"** is back (panel footer), with a confirmation listing every document it deletes.
  Paid, invoiced and in-flight bills are kept, as are the login account, the Vendus client and past events.
- **Round 2 fixes (Renato's first look):** "em atraso" counts only bills past their due date (bills exist
  for the whole year ahead, so the first version flagged everyone). "Confirmado — ativar" shows only on
  *pending* subs. A parent accepting a change to an active sub is now a quiet "encarregado confirmou" tag,
  and parent pages no longer raise the admin flag for it.
- **Open question:** NIF check "via Vendus". Our integration has no validate endpoint, and Vendus rejected
  Mafalda's NIF on the same checksum we now check client-side. Proposed instead: the same checksum
  server-side in functions, before any Vendus call. Waiting for Renato.

Code: `src/pages/admin/subscriptions/` — `useAdminData` (reads), `useSubscriptionActions` (writes),
`listModel.ts` (search/filters/grouping, pure), `FamilyPanel`, `FamilyContactForm`, `FamilyBills`,
`SubscriptionCard`. Typecheck: 11 errors (baseline 13, minus 2 that lived in the deleted Famílias page).

**Can't be verified on dev:** the Vendus side. `syncVendusClient` skips `kidclub-dev`, and real Vendus
calls are blocked from dev, so the retry button will fail there with the guard's error. Dev can only
show that the form writes the right fields and that errors display. **Next step:** Renato tests on
the dev preview → merge → `staging`→`main` → in prod, fix Mafalda's NIF in her panel and click retry
on `JlqSRknVxyzaJfYP2WiM_2026-09`.

### 🟡 In review: Faturas page dropped, "Descarregar fatura" in Pagamentos (2026-09-29)

Branch `agent/kidclub-invoice-download`, PR → `staging`. Why: a parent saw "no billing" because the
dashboard's finance tile opened **Faturas**, which read the legacy `invoices` collection (empty for
every family). Renato's call: drop Faturas; each invoiced month in **Pagamentos** gets a download link.
- **Client:** `InvoiceListPage`/`InvoiceDetailPage` deleted, sidebar link gone, dashboard tile now
  "Pagamentos"; `/client/invoices/*` redirects to `/client/payments`. The `invoices` collection and
  its rules are untouched (admin DataManagementPage still lists it).
- **New callable `getInvoicePdf({ billingId })`** (`functions/src/kidclub/invoicePdf.ts`): access =
  bill's `userId`, family `primaryContact.userId`, or owner/rainbowAdmin (impersonation). Fetches
  `GET /documents/{vendusId}.pdf` from Vendus (documented in the v1.1 spec), single attempt, 15s
  timeout, no retry. **Cached** in Firestore `_apps/arcoiris/invoicePdfs/{vendusId}` (Bytes, server-only,
  no rule matches it) so each invoice hits Vendus once ever. **Cap:** 100 Vendus PDF fetches/day
  across all users, counted in `_apps/arcoiris/rateLimits/invoicePdf_{YYYY-MM-DD}`
  (`DAILY_VENDUS_PDF_CAP` in `invoicePdfLogic.ts`). No provider-side cap exists for Vendus reads.
- **Can't be verified on dev:** real Vendus calls are blocked outside prod (external guard; Vendus
  has no sandbox flag), so the button will show "Não foi possível obter a fatura" there. To see the
  UI path end-to-end on dev, seed an `invoicePdfs/{vendusId}` doc by hand for a dev bill.
- ⚠️ **Prod deploy step:** new callable → after the prod deploy, `allUsers` → `roles/run.invoker`
  on `getinvoicepdf` by hand (Deploy lessons #2); same on dev if the button errors with a 403.
  Then test once in prod on a real invoiced month (first click = 1 live Vendus read).

### 🔴 Open — in priority order

**Next session: `HANDOFF-payments-email-whatsapp.md`** (same folder). It covers items 0 and 1 below, a
WhatsApp proposal, and the duplicate-family race fix.

**In flight (2026-09-28, late): payment retry + billing sandbox.**
- **PR #57** `agent/kidclub-payment-retry` → `staging`: `failed` bills are payable again and block later months.
  The webhook also matches earlier attempts (`previousEasypayIds`), so a late payment is recorded, and a
  payment on an already-paid bill is flagged (`duplicatePaymentEasypayIds`, red warning in the family panel).
  Adds the admin "Repor para pendente" (`resetStuckPayment`) for `processing` bills. Multibanco/card are
  refused server-side. Test steps are in the PR body. **Renato: test on dev, then merge.**
- **`agent/billing-sandbox`** (pushed, **no PR yet**, stacked on #57): `EASYPAY_SANDBOX=true` for
  kidclub-dev via `functions/.env.kidclub-dev`, and `externalGuard` lets dev reach Easypay only with that flag
  (and refuses the flag on prod). Open its PR into `staging` **after #57 merges**: both deploy functions to
  the shared kidclub-dev, so opening it earlier makes one overwrite the other or fail its deploy.
- **Dev's `EASYPAY_ACCOUNT_ID`/`EASYPAY_API_KEY` secrets now hold the Easypay sandbox account's keys**
  (version 2; version 1 = live keys copied from prod). Disable version 1 once dev has redeployed with
  version 2. The sandbox's notification URL points at dev's `easypayWebhook`.
- **Vendus sandbox: waiting on Renato.** Choose between a separate Vendus account for dev (recommended; the
  product/payment-method IDs in `vendus.ts` would then become settings per project) and the same account
  with `mode: "tests"` forced on every document. Until then, Vendus stays blocked on dev.
- Not done, follow-up: the Easypay webhook doesn't verify its caller.
- Next after that: prod audit (read-only) of bills that are `failed` or have been `processing` for more
  than a day, then workstream 2 (email).

0. **Payments are MB WAY only (hotfix PR #53, `hotfix/mbway-only` → `main`, 2026-09-28).** Card fails at Easypay
   with "does not have a POS associated": no card terminal is configured in the Easypay account (an
   Easypay setting, not our code). Multibanco is hidden with it. To restore both: fix the Easypay
   account, then re-add the two buttons in `PaymentsPage.tsx`.
   **Still open (needs a functions change, not done):**
   - A payment that fails or expires (e.g. an MB WAY request not approved in time) leaves the bill
     `failed`. The page shows no pay button for it, and `initiate*Payment` only accepts `pending`, so
     that month and every later one are stuck until someone resets it by hand in Firestore.
   - A card or Multibanco attempt left `processing` has no way back for the parent.
   - Fix: make `failed` payable (page + `initiateMbwayPayment`), count `failed` as unpaid in
     `assertEarlierMonthsPaid`, and refuse Multibanco/card server-side while they're off.
   - What happened: Marisa Sofia's September (`8pPhu4JCvGUrpBxsaOeY_2026-09`) was stuck `processing` on
     a dead card link. Renato reset it to `pending` by hand, removing `easypayId`/`paymentLink`.
   - **Duplicate family records on first login** (race in `getOrCreateFamily`): found on Carla Silva
     (cssilva09@hotmail.com, 3 records). Renato deleted the prod duplicates and fixed her name on
     2026-09-28. The code fix isn't done; see the handoff.

**Email composer (branch `agent/kidclub-email-composer`, pushed, no PR yet, 2026-09-28).** Replaces the old
Email Center (`/admin/email-center`, now "Emails"). Tabs:
- **Compor**: TipTap editor with variables as tags (click or drag from the palette). Subject line takes `{{key}}`.
  Variables: guardian (name, email, phone, billing address, NIF), children (names, school, year, home address),
  subscriptions (services, monthly total), payments (overdue amount/months, next bill). Audience: the families
  page's chips (status, service, overdue / invoice error / invalid NIF / waiting on parent) plus school and
  search. **One email per family.** Child and subscription variables use only the subscriptions that matched.
  Before sending you get a preview for any recipient, "Enviar teste para mim", and a warning about empty
  variables. Saved templates live in `emailTemplates`. Max 200 recipients per send.
- **Histórico**: each campaign, the latest attempt per family with its status, the exact email as sent,
  "Reenviar" (one, or every failed), "Ignorar", and "Duplicar" (back to the composer with current data).
- Sender: a new **24h cap of 300** actually-sent emails in `SendEmailFromOutbox.ts`.
- **Merge order** (every PR into `staging` does a full functions deploy to the shared kidclub-dev): #57 first,
  then rebase this branch on `staging` and open its PR, then `agent/billing-sandbox`.
- **Sending itself is still broken in prod** (item 1). Nothing reaches parents until that's fixed, and the
  ~116 stale failures get marked `skipped` before re-enabling. Gmail stays blocked on dev, so on dev the outbox
  docs (`_apps/arcoiris/emailOutbox`) show exactly what would be sent.

1. ~~App email broken since 2026-08-01~~ **FIXED and verified 2026-10-01.**
   - Cause: on 2026-07-28 a manual `gcloud secrets create` batch filled prod's `SA_CLIENT_EMAIL`/`SA_PRIVATE_KEY`
     with the old project's account (`gmail-sender-dev@rainbow-78314`, project gone) → `invalid_grant`.
   - #63: keyless delegation. IAM signs the JWT as `GMAIL_SENDER_SA` (`functions/.env.<projectId>`; prod =
     `gmail-sender-prod`). Renato granted the compute SA `serviceAccountTokenCreator` on it by hand.
   - #64: the first campaign OOM-killed the sender (256 MiB, many emails per instance) and left emails stuck
     in `processing`. Now 512 MiB, `concurrency: 1`; Histórico allows "Reenviar" on emails stuck > 10 min.
   - The "welcome to the new portal" campaign went out 2026-10-01; stuck ones were resent after checking
     Gmail Sent. The 116 pre-fix failures were left as-is (on-create trigger, not resendable by campaign).
   - **Still to do (Terraform session):** codify the TokenCreator binding; give the prod CI SA
     `roles/run.admin` so new callables stop failing the deploy at "set invoker" (hit on #62); drop
     `SA_CLIENT_EMAIL`/`SA_PRIVATE_KEY` from `secrets.tf`/`functions.tf`, then delete them and the 3 old
     `gmail-sender-prod` keys; change `.firebaserc` `default` away from the dead `rainbow-78314`.
2. ~~Mafalda Raposo Duarte's missing invoice~~ **Done 2026-09-28:** NIF fixed and invoice retried from the new admin page.
3. ~~Edson's study room~~ **Resolved:** prod already has the right value (Renato, 2026-09-28).
4. **Afonso Santos has no `children` record** (in prod or dev), so his €60 enrollment fee is never
   charged, because the fee is keyed by child. Create the child in admin and link both subs.
   In the new admin page: his family → "✏️ Dados da criança" → Guardar creates the record and links both subs.
5. **Mary Pratas' mis-paid period** (paid 2027-08 instead of 2026-09, Vendus FR 01P2026/195) needs a
   credit note. Unchanged. The new pay-in-order rule stops it happening again.
6. **Cláudia Faustino has a second, empty family** (`KGkcDjgI54iKGblEQRmo`, fmsc812@gmail.com).
   She'd see nothing if she logged in with that email. In the new admin page: tick "Mostrar famílias sem
   inscrições", open it, "Eliminar família".
7. **Cost inputs differ between projects:** prod has driver €1,400 / electricity €200, dev has €1,200 / €150.
   Renato to say which is real. This decides whether the loss is €417 or ~€670/month.
8. **Pricing/discount decision (GO-LIVE.md §4):** still open. Note that the billing engine is already marginal;
   only the stored `monthlyFee`/simulator are flat.

---

## Before go-live (2026-09-23) — historical

**Dev is migrated and validated. Prod is untouched and still on the old model.**

PRs #32, #33, #34 and #35 are **merged to `staging`** (87 commits ahead of `main`), so
everything below is live on `kidclub-dev`. Branch new work off `origin/staging` and PR back
into `staging` — advice further down this file about branching off `main` predates the
event-sourcing rewrite and is wrong for this effort.

| | State |
|---|---|
| Event-sourcing rewrite (Phases 0/1/3, decisions 8–11) | ✅ merged, on dev |
| Phase 1 — dev wiped and reimported from prod | ✅ done 2026-09-23 |
| Phase 2 — migration applied to dev | ✅ 25 identity + 7 date + 4,742 writes |
| Phase 3 — reconciliation report | ✅ reproduces every reference figure |
| Phase 4 — dev validation | 🟡 **in progress — Renato testing** |
| Phase 5 — prod cutover | ⛔ not started, and gated (see below) |
| Phase 6 — final audit | ⛔ not started |

### What is verified, and how

- **The four reference figures reproduce exactly** on dev: Carolina €182.40, José Eduardo
  €165.12, Maria Manon €130.56, Mogo €210.00 — deltas summing to **+€53.28/month**.
- **Every month bills €2,892.96**, August 2027 included. That is flat pricing plus decision 10
  working. ⚠️ The old **€2,134.56** August estimate is **superseded** — it predates decision 6
  (three restored subscriptions, +€281.28) and decision 18 (the cliff is 7 subs, not 6).
- **The parent write path works, tested end to end against dev** (2026-09-23), over the Auth
  REST API rather than a browser, since the dev site is not externally reachable:
  parent cancels own occurrence → **200**, stored `changedByRole: "parent"`; parent touches
  another family → **403**; parent reads another family's events → **403** by `firestore.rules`.
  Script: `scripts/kidclub-migration/parent-path-test.mjs` — re-run it whenever auth,
  `firestore.rules` or the callable changes; it would have caught the original
  `primaryContact.userId` blocker before prod.
- **Invoiced records are provably frozen** — the 5 September records still carry their original
  prod `updatedAt` of 2026-09-20/22, untouched by the 2026-09-23 run.
- **What is NOT verified: the UI in a browser.** Rendering, layout and density are unproven.

### 🔴 Before Phase 5 — three gates

1. **Sequencing: migrate prod FIRST, correct statuses AFTER.** Flipping Francisco and Julia
   Brito to `active` in dev **destroyed** Julia's recorded absence: `onTransportBillingSync`
   recomputed September's record and rebuilt the line item without its `excludedDates`. After
   migration those absences live in `reservationEvents`, which a billing recompute cannot
   reach — so this hazard exists **only before** the migration runs. Dev is migrated, so status
   corrections there are now safe; **prod is not**.
2. **Both Britos are still `pending` in prod.** `migrate.mjs` only generates for `active`
   transport subs, so a prod run today skips them both.
3. **Decision 16's route needs a second look** — see its caveat below. Dev now holds a synthetic
   QA family, a test Auth account and test mutations.

`migrate.mjs` **refuses `--apply` against prod outright**, with no override flag. Enabling it is
a deliberate reviewed change, not a flag added in passing.

### Tooling

| Path | What |
|---|---|
| `scripts/kidclub-migration/migrate.mjs` | Phase 2 migration. Dry run by default, dev only |
| `scripts/kidclub-migration/identity.mjs` | identity consolidation, `--apply` implemented |
| `scripts/kidclub-migration/reconcile-report.mjs` | read-only reconciliation, any project |
| `scripts/kidclub-migration/seed-test-family.mjs` | the QA family, re-runnable after a wipe |
| `scripts/kidclub-migration/set-test-absences.mjs` | absences either side of the ≥3 threshold |
| `scripts/kidclub-migration/parent-path-test.mjs` | parent auth end-to-end, no browser needed |
| `scripts/kidclub-migration/DEV-WIPE-RUNBOOK.md` | wipe + import, scoped to `_apps/arcoiris` |
| `scripts/kidclub-migration/PHASE4-TEST-PLAN.md` | validation checklist incl. prod checks |
| `scripts/kidclub-migration/MANUAL-TEST-STEPS.md` | click-by-click manual script |
| `apps/noisyphocus/kidclub/CALENDAR-VIEWS.md` | the two calendar refactors |

### Test access (dev)

`parent-test@kidclub.pt` — **no roles**, a true parent; password set at seed time, reset from
the Firebase console if lost. It owns `TEST-FAMILY-QA` (Ana, Bruno, Carla), which carries
sibling + school + multi-trip + manual discounts, a mid-October start for decision 8, and
absences deliberately at 2 and 3 to sit either side of the credit threshold.

⚠️ **All five human dev accounts are staff** (`owner`/`rainbowAdmin`), and
`setReservationEventStatus` checks staff before the family check — which is why a roleless
account had to be created, and why impersonation cannot stand in for the parent path.

---

## The migration plan (decisions and findings)

Produced from a read-only analysis of live prod (21 active transport subs, 13 active study
subs, 228 billing records, 0 `reservationEvents`, 13 `eventModifications`) plus an offline
simulation. **Eighteen decisions** are settled with Renato — **do not re-litigate them.**

### Decisions (settled 2026-09-22)

| # | Decision | Consequence |
|---|---|---|
| 1 | **Flat monthly price is retained.** Gross stays `scheduleLen × rate × activeWeeksInPattern`, NOT a sum of occurrences. | No month-to-month variance, no July half-month, no €0 August. Events drive absences and logistics only — never gross. |
| 2 | **Two legs on one day is real** (genuine pickup + dropoff), not duplicated data. | No bill change from this on its own; gross already counted both legs. |
| 3 | **Absence credit uses the notional rate**: `net ÷ (legs × 4)`. | Credit per absence is constant every month, consistent with a flat price. Carolina ≈ €7.60/absence. |
| 4 | **Migrate historical absences**: 75 `excludedDates` + 13 `eventModifications` → `CANCELLED` events. | No recorded absence is lost. Note the rule underneath them changes: <3 credits nothing, ≥3 credits all, uncapped. |
| 5 | **Invoiced periods frozen**, plus a divergence report. | The 5 invoiced records are never recomputed. Where the new model disagrees with an issued fiscal document (e.g. Sept: system €200.64 vs invoiced €169.20), it is reported, not silently corrected. |
| 6 | **All 35 auto-cancelled billing records → `pending`.** Default to `pending` wherever ambiguous. | Renato cancels individually in the app afterwards. Restores billing for José Miguel Duarte (~€113/mo) and Edson (~€72/mo), whose subs are active but records cancelled. |
| 7 | **Orphan subscriptions get real family records.** | A parent never logging in does not mean no family. Minimal `families/{id}` created from `contactEmail`; the *account* link (`primaryContact.userId`) arrives on first login. |
| 9 | **An automatic discount an admin has toggled is applied once, never twice.** `manualDiscountPctFor` keys on the rule's `trigger`, not on the `appliedBy` label. | Admins can freely toggle auto discounts; the label records who touched the row, not a second concession. |
| 11 | **An admin toggle overrules the automatic discount**, in both directions, as a flat percentage. | New `discountOverrides` field; the structural calculation is suppressed for an overridden rule. |
| 10 | **A billable period is decided by the contract, not by the event count.** August bills the flat price despite having no occurrences; subscriptions are cancelled manually. | `endDate` becomes a money field — see the Phase 3 section for the inconsistent prod values. |
| 8 | **No pro-rating. Boundary months adjust via the absence credit.** (settled 2026-09-22, after flat pricing exposed the gap) | A subscription starting or ending mid-month bills the full month; the days not served are written as system `CANCELLED` events so the existing >=3-absence credit pro-rates it. No new pricing concept. See "Boundary months" below. |

### Boundary months — how decision 8 actually works

Renato's instruction: "we have the absent days functionality... so we can bill the entire
month and use that functionality to adjust either on the first or the last."

The arithmetic works (start on the 15th of a 20-occurrence month -> 10 days marked absent ->
credit = 10 x net/20 = half the month), but the mechanism could not fire as the code stood:

- **End boundary:** `voidFutureEvents()` marks everything from today forward `VOIDED`,
  including the rest of the current month. `VOIDED` deliberately does not count as an
  absence, and `setReservationEventStatus` throws `failed-precondition` on a `VOIDED` event
  — so nobody, staff or parent, can mark those days absent.
- **Start boundary:** the `startDate` clamp means pre-start days generate no events at all,
  so there is nothing to count.

Resolution being implemented: **boundary months generate the full schedule pattern**, with
out-of-contract occurrences written as `CANCELLED` / `changedByRole: "system"` and a `reason`
of `"before subscription start"` or `"after subscription end"`. Whole months outside the
contract still generate nothing (-> EUR 0). `VOIDED` keeps its meaning for whole future
months after a cancellation.

Two accepted consequences: system-generated boundary absences count toward the same
3-absence threshold as real ones (correct — they are all days not served); and if fewer
than 3 out-of-contract days fall in the month, the threshold is not met and the month bills
full (a ~2-day rounding, deliberately not special-cased).

### 🔴 Phase 2 sequencing rule — do identity and date repairs BEFORE generating events

`regenerateFutureEvents()` voids all future events and recreates them as `EXPECTED`, so any
subscription write that changes `schedule`/`days`/`weekPattern`/`startDate`/`endDate`/`status`
**silently wipes every future parent-recorded absence on that subscription.** Verified
against the trigger condition, not assumed.

A `familyId`-only write does **not** trigger this (the trigger's `scheduleChanged` check
does not include `familyId`), so the orphan-subscription backfill is safe. **Populating
`startDate`/`endDate` is not** — and 19 of 21 active transport subs lack both. So: all
identity and date repairs run before event generation, never after.

### Implementation progress (2026-09-22)

Integration branch **`agent/eventsourcing-integration`** (off `staging`): both completed
agent branches merged cleanly, **84 tests passing, typecheck clean**.

- `agent/reservation-events-auth` — parent auth now reads `primaryContact.userId` (with
  top-level `userId` fallback) plus a `familyId`-falsy guard, since `.doc("")` throws rather
  than returning a not-found snapshot; `coerceEndDate` generalised to
  `coerceDate(raw, "start"|"end")` and a `startDate` clamp that can only move the window
  later; missing-`familyId` guard in both pure generators; `reservationEvents` read rule
  scoped to staff or the owning family.
- `agent/flat-gross-reconciliation` — flat gross, notional absence credit
  (`net / (legs x 4)`), and `returningStudent` vs manual discount made mutually exclusive via
  `max()` rather than summing (closes a latent 30% stack). All four reference figures
  reproduce exactly: Carolina EUR 182.40, Jose Eduardo EUR 165.12, Maria Manon EUR 130.56,
  Mogo EUR 210.00 — the Mogo figure confirmed against prod (Diogo carries the 15%
  "Aluno do ano anterior", 5 legs each).
- `scripts/kidclub-migration/identity.mjs` — dry-run identity consolidation. Against prod:
  25 document writes, 2 automatic merges, 5 families to create, 1 sub linking to an existing
  family (Leonor Lago — her family DOES exist, via `primaryContact.email`), 3 children with
  no `children` record at all.

- `agent/boundary-month-prorating` — decision 8 implemented and merged into the integration
  branch. **104 tests passing, typecheck clean, none of the 84 existing tests needed editing.**
  Worked examples (October 2026, Mon-Fri study, EUR 6/occurrence, no discounts; 22 real
  occurrences, 20 notional): start Oct 15 -> 10 system absences -> credit EUR 60 -> **pays
  EUR 60.00**, half the month. `endDate` Oct 15 -> 11 system absences -> **EUR 54.00**.
  Status flipped to `cancelled` on Oct 15 -> 12 -> **EUR 48.00** (the 1-day difference is
  deliberate: an explicit `endDate` means "last served day", a cancellation means "not served
  from today"). November onward stays `VOIDED` -> EUR 0. Degenerate start on Oct 30 floors at
  EUR 0, never negative.
- **It also fixed the regeneration-wipes-absences bug** (slightly beyond the brief, flagged by
  the agent): `regenerateFutureEvents` now uses `splitRegenerationWrites()`, so a
  `parent`/`staff`-recorded absence still present in the new pattern survives regeneration
  untouched; only human-recorded events the new schedule no longer contains are voided.
  Cleanly separable if it should land on its own reviewed branch — it is
  `splitRegenerationWrites` plus ~12 lines, in commit `dbbc907`.

**Known issues surfaced, not yet addressed:**
- **`backfillReservationEvents` is additive only.** `ensureEventsExist` creates missing
  occurrences and never rewrites an existing one, so pre-start `EXPECTED` events already
  written by an earlier run will NOT be flipped to system-CANCELLED by a backfill click. The
  Phase 2 migration script must repair those explicitly.
- **Boundary pro-rating is stepped, not continuous** — the >=3-absence gate means 1-2
  out-of-contract days credit nothing. For a late *cancellation* that is correct (the month
  was used); for a late *start* the floor at EUR 0 covers it. Recorded so it is not mistaken
  for a bug.
- **Crediting at the notional rate makes the split slightly family-favourable**: starting on
  the 15th pays 50% while receiving 12/22 ~ 55% of the days. Inherent to decision 3, not
  fixable without touching gross.
- **UI renders a system boundary day as an ordinary cancelled day** — functionally honest, but
  unlabelled. One for the Phase 0b UI session, styled off `reason`.
- `resolveGenerationStart` is now dead except in its own tests (superseded by
  `resolveGenerationWindowStart`); left exported with a pointer comment, worth deleting later.
- Prices are no longer frozen at generation time: gross reads the live config rate, while
  `ReservationEvent.basePriceCents` is frozen at creation. A mid-year rate change would
  reprice old unpaid periods. Phase 3's report must compare against `basePriceCents` so a
  reprice shows as an explicit divergence.
- "No events -> EUR 0" is now the only thing between a failed generation and a EUR 0 invoice
  for an active subscription. Phase 3 needs an explicit "active subscription with zero events
  in a billable period" warning.
- `eslint` is dead in `functions/` on `staging` — `eslint.config.js` uses ESM `import` but is
  loaded as CJS. Pre-existing, unrelated, but lint is not running there at all.
- ~~The Mafalda duplicate merge~~ **DONE** — run by Renato 2026-09-22 19:22 UTC. Verified in
  prod: `children/G1XkEDBciLr7k2Hk9eRa` now `status: merged`, `mergedInto:
  6DdwHVG0WFr975wMYyBC`. Retired, not deleted, so it remains reversible.

### ✅ DONE — Phase 1 dev wipe and import (executed 2026-09-23)

> Executed via `gcloud firestore bulk-delete` (the firebase CLI's credentials had expired and
> its reauth is interactive). 11,440 documents across 12 collection IDs; `users` verified intact
> at 49 docs. The open question below about `users` is answered: it **is** shared, and was not
> wiped. Runbook with both methods and their caveats:
> `scripts/kidclub-migration/DEV-WIPE-RUNBOOK.md`. Kept for the reasoning.


Renato's instruction: wipe dev completely first, then import prod, so the migration is proved
against real data with no pre-existing dev records polluting the result. `gcloud firestore
import` **merges**, it does not replace, so without an explicit delete the old dev docs
survive alongside the imported ones — exactly the pollution this is meant to avoid.

**⚠️ Do NOT run `firestore:delete --all-collections` on `kidclub-dev`.** Per the root
CLAUDE.md, KidClub and FinHub share the single `(default)` database in each project. A
blanket wipe destroys `finances_entities/**` (FinHub dev) as well. Scope the delete to
KidClub's own root: `_apps/arcoiris/**`.

Open question before running it: the top-level `users` collection is NOT under
`_apps/arcoiris` (`billing.ts` reads `db.collection("users")` directly) and may be shared
with FinHub. Confirm whether it is KidClub-only before including it in the wipe.

**Firebase Auth is not touched by a Firestore wipe**, and Auth UIDs are per-project, so the
imported `primaryContact.userId` values will be prod UIDs that match no dev account. To
exercise the newly-fixed parent path on dev, pick a test family after the import and set its
`primaryContact.userId` to a real `kidclub-dev` Auth UID. Without that step the parent-side
validation cannot run at all — which is the whole point of the auth fix.

Also re-enter dev's own `config/transportation` values after the import
(`driverMonthlyCost` / `electricityMonthlyCost`), which the import overwrites with prod's doc.

### ✅ RESOLVED — Phase 4 parent-path hazard (was: cannot validate with renato343@gmail.com)

> **Resolved 2026-09-23** by creating `parent-test@kidclub.pt` with no `users` doc and therefore
> no roles. The hazard was also **wider than described below**: not just `renato343`, but **all
> five** dev Auth accounts are staff. Impersonation cannot substitute — it is an admin feature,
> and the staff check returns before the family check is ever reached. Kept for the reasoning.


Renato: dev needs only two logins, `renato343@gmail.com` (used as the parent/personal
account) and `admin@kidclub.pt`; everyone else is reached by impersonation.

**But `renato343@gmail.com` holds `owner: true, rainbowAdmin: true, finhubAdmin: true` in
dev's `users` collection.** `setReservationEventStatus` checks staff FIRST:

```js
const isStaff = !!(roles.owner || roles.rainbowAdmin);
if (!isStaff) { /* the primaryContact.userId family check */ }
```

So logging in as renato343 takes the **staff** branch and never reaches the parent
authorization we just fixed. Validating with that account would appear to pass while proving
nothing. Impersonation has the same problem if it keeps the admin's own uid.

To actually exercise the fix, temporarily clear the roles on
`users/DXMww3tno5Z6yYY01dv5Yq3bptf2` while testing the parent flow, then restore them.
Do not skip this — it is the difference between validating the fix and validating the staff
bypass. **Renato approved this 2026-09-22** ("it's ok to remove the permissions on my
personal email to test"), and confirmed dev must NOT be opened to outside parents — so the
parent path is validated by de-privileging renato343 rather than by inviting a real family in.

**dev Auth accounts (5, verified 2026-09-22):**

| email | dev uid |
|---|---|
| admin@kidclub.pt | `BY4uhnhFEfZI7ymADbT3wggFI4k2` |
| renato343@gmail.com | `DXMww3tno5Z6yYY01dv5Yq3bptf2` |
| noisysource@gmail.com | `Y1oGutoJsTdd6ZpcqEk100TI5Nr1` |
| domotics-bridge@kidclub.pt | `lekp4l20Q2d8GQtJvQ2KLI28uZJ3` |
| beritogabriel@hotmail.com | `zAAnp9JEQHTDM3vFyWy6JWUIXk52` |

**dev `users` collection holds 49 docs but only 5 dev Auth accounts exist** — 44 are prod
UIDs carried in by the earlier prod->dev import and match no dev login. `renato343@gmail.com`
and `noisysource@gmail.com` each appear twice (once under their dev uid, once under a prod
one). So `users` is safe to wipe and recreate with just the two needed docs.
`domotics-bridge@kidclub.pt` has **no** `users` doc at all, so wiping the collection does not
affect the Pi bridge (it is scoped by rules, not by a roles doc) — verify before relying on
that.

### 🔧 Finishing the schoolName mirror removal — ordered, do NOT reorder

The subscription-level `schoolName` copy is a mirror of `children/{childId}.schoolName`. It
has drifted in prod (5 of 10 dual-service children store two different values; 2 of them hold
street addresses), and it decides the 20% Colegio Bissaya Barreto **transport** discount, so
every step here is a money step. Two of the four steps are done. The order matters: deleting
the mirror before every reader has moved silently drops the discount for anyone whose child
record has no school.

1. **DONE** — `billing.ts` reads the child record via `fetchChildRecords()`, combined with
   `resolveSchoolName()`.
2. **DONE** — the UI resolves from `children`/`families.primaryContact` via
   `src/lib/personalData.ts` (PR #31, merged to `staging` as `afca32e`).
3. **DONE (2026-09-22)** — `discountRecalc.ts` now resolves schoolName from the child record
   through `resolveSchoolName()` imported from `reconciliation.ts` (one contract, not a second
   copy). A new `fetchChildSchoolNames()` reads the family's children by document reference
   rather than a chunked `documentId() in [...]` query — a family holds a handful of children
   and a ref get cannot silently drop ids past the 30-value `in` limit. **Re-measured against
   prod first: still 0 of 21 active transport subs change their Bissaya match**, so no fee
   moves. 109 tests green, typecheck clean.
4. **TODO, only after 3** — remove the mirror *write* (the admin-save path in
   `SubscriptionsAdminPage` that rewrites `subscription.schoolName` from the child's value),
   then drop the field. Once no reader depends on it the drift becomes structurally
   impossible instead of merely hidden.

**Do not skip `resolveSchoolName`'s per-field semantics at step 3.** `ClaimSubscriptionsPage`
validates only firstName/lastName/dateOfBirth and writes `schoolName: f.schoolName.trim() ||
null`, so a parent claiming a subscription can create a child record with no school while the
subscription gains a `childId`. Keyed on the record rather than the field, that subscription
would switch to reading a child that has no school and lose its 20% silently. Blank and
whitespace-only must count as absent too — `??` alone lets `""` through.

**Other readers of the denormalized copies** (not money, but they pin the fields in place):
`billing.ts` line-item titles use `sub.childName`; `notifications.ts:139,169` uses
`after.contactEmail`/`after.email` to pick the notification recipient. Neither blocks the
`schoolName` work, but both need moving before `childName`/`contactEmail` can be dropped.

### schoolName ownership — resolved (2026-09-22)

A parallel branch (`agent/subscription-personal-data`) moved the KidClub UI to resolve
personal data from `children/{childId}` and `families/{familyId}.primaryContact`, but could
not delete the subscription-level `schoolName` mirror because three backend consumers still
read it.

**Measured before changing anything: 0 of 21 active transport subscriptions change their 20%
Bissaya match when schoolName is sourced from the child record instead of the subscription.**
So this is a correction of source with no fee movement.

Done on the integration branch: `billing.ts` now reads schoolName from the child document
(`fetchChildrenBirthDates` became `fetchChildRecords`, same query, no extra reads), falling
back to the subscription copy only while the Phase 0 `childId` backfill is outstanding — 4
active transport subs still have no `childId`, and none of them match the rule either way.

**Still reading the mirror, blocking its deletion:** `discountRecalc.ts:148,180` (the
`auto_school` rule), `billing.ts` line-item titles (`sub.childName`), and
`notifications.ts:139,169` (`contactEmail`). The mirror can only be dropped once
`discountRecalc.ts` is moved too — that is owned by neither branch and needs doing
deliberately.

**Known side effect, already flagged by that branch:** saving a subscription in the admin page
rewrites its schoolName mirror from the child's value. For the subs storing a street address
that is a correction, not a regression — and per the measurement above it moves no fee today.

### Phase 3 — report written, two findings found AND FIXED (2026-09-22)

`scripts/kidclub-migration/reconcile-report.mjs`, run read-only against prod, initially
disagreed with the 2026-09-20 baseline on two of the four reference families and on August.
Both disagreements were real. **Both are now fixed, and the report reproduces the baseline
exactly: Carolina EUR 182.40, José Eduardo EUR 165.12, Maria Manon EUR 130.56, Mogo
EUR 210.00, 10 of 17 families unchanged, +EUR 53.28/month.** 118 tests green, typecheck clean.

**Decision 9 (settled 2026-09-22): an automatic discount an admin has toggled is applied
once, never twice.** `manualDiscountPctFor()` counted any `appliedBy: "admin"` entry as a
manual concession whatever the rule's trigger, while `reconcileService()` recomputes
multi-trip/sibling/school structurally — so an auto rule an admin had ticked landed twice.
`SubscriptionsAdminPage.toggleManualDiscount()` stamps `appliedBy: "admin"` on whichever rule
was clicked, including an automatic one, so the label records *who last touched the row*, not
what kind of discount it is. Two live subscriptions were in that state (Carolina, Maria
Manon) and would each have taken 30% instead of 20% **at cutover** — prod runs the old code,
which simply sums the percentages once, so nothing was ever mischarged. Now keyed on
`trigger`. Report flag (e) still lists the mislabelled rows.

**Decision 10 (settled 2026-09-22): a billable period is decided by the CONTRACT, not by the
event count.** `runsThisPeriod = events.length > 0` silently zeroed August: generation stops
at `config/schoolCalendar.yearEndDate` (2027-07-15), so August 2027 produced no occurrences
for anyone and 22 active subscriptions with existing billing records computed EUR 0 —
EUR 1,800 in one month, against decision 1's explicit "no EUR 0 August". Now
`sub.coversPeriod && !allVoided`, via the new pure `contractCoversPeriod()`. A month with no
school days is still a month of the 12-month spread; a subscription stops billing because it
ended or was cancelled. **"All occurrences VOIDED" is kept as a separate EUR 0** — that is
positive evidence the subscription was already over, unlike an empty list.

Renato's accompanying instruction: **next August, subscriptions are cancelled manually** when
a parent or admin decides, rather than lapsing automatically at the school year end.

**⚠️ Consequence — `endDate` is now a money field, and prod's values are inconsistent.**
Under the old rule `endDate` barely mattered; it now decides whether August bills. Of 34
active subscriptions, **18 have no `endDate` at all** (open-ended -> bill August), while the
16 that do split three ways: `2027-07-30` (6 subs -> **EUR 0 in August**, flagged as (a)),
`2027-09-07`, and `2027-09-18`. Those six are the difference between the August total billing
EUR 2,134.56 and EUR 1,621.44. If the intent is that everyone bills August and is then
cancelled by hand, **those `2027-07-30` endDates need clearing** — that is a Phase 2 data
repair nobody has scheduled yet, and it is not covered by the identity script.

**Moved for a reason:** `buildReconciliationConfig()` and `manualDiscountPctFor()` now live in
`reconciliation.ts`, not `billing.ts`. They are pure and they decide money, and the report
script had its own copy of `manualDiscountPctFor` — which kept the double-count alive in the
report for a run *after* `billing.ts` had been fixed. One copy, imported by both.

### The report itself

`node scripts/kidclub-migration/reconcile-report.mjs [--period 2026-10] [--changed-only] [--json out.json]`

**Read-only by construction, not just by convention**: there is no `--apply`, and the
firebase-admin handed to the imported production code is a stub whose Firestore proxy throws
on any use, so the script cannot write to any project even by mistake. Prod is read via
`gcloud auth print-access-token` against the REST API, same as `identity.mjs`.

It **compiles and calls the real `reconciliation.ts` and `reservationEvents.ts`** out of
`functions/src` rather than reimplementing the money math — a second implementation would
only prove it agrees with itself, and would drift (as the `manualDiscountPctFor` copy did).
Because prod holds zero `reservationEvents`, it simulates the events Phase 2 would write
(same window/bounds rules as `ensureEventsExist`), overlays any events that do exist (so it
stays correct on dev after an import), and overlays decision 4's historical absences: 75
`excludedDates` + 13 `eventModifications`. The `eventModifications` timestamps are converted
in **Europe/Lisbon**, not by slicing the ISO string — `2026-09-24T23:00:00Z` is the 25th here,
the same off-by-one commit `eb905ed` fixed in the admin calendar, and a wrong day that still
lands in the month is invisible in a total.

Flags against prod today: **(a)** 6 subs with an August billing record their contract does not
cover; **(b)** frozen `basePriceCents` vs the live rate — dormant until Phase 2 creates events,
and says so rather than reporting a false "none"; **(c)** 4 invoiced periods that diverge,
reported and never recomputed, per decision 5; **(d)** 11 active subs with no `familyId`;
**(e)** the 2 mislabelled auto discounts.

### Decision 11 — an admin toggle overrules the automatic discount (settled 2026-09-22)

Renato: "if the admin triggers it off then it is not supposed to be applied; if he puts it
back on the discount is applied, overruling the automatic." Implemented, 9 new tests.

**New field `discountOverrides: Record<ruleId, boolean>`** on both subscription models —
`true` force on, `false` force off, absent = no opinion. It has to be separate from
`appliedDiscounts`, because the absence of an entry there is ambiguous ("the rule did not
match" vs "an admin turned it off") and `discountRecalc` rewrites that array from the rules
on every schedule change, so an admin's "off" could not have survived.

**An overridden rule is applied as a FLAT percentage and its structural calculation is
suppressed — in both directions.** Renato chose this over "pretend the rule matched": it is
uniform across all three auto rules, and it is what the old system did, so it matches what
the admin already sees. The marginal multi-trip and ranked sibling calculations have no
meaning once an admin has overruled them, and applying both would be the same double-count
decision 9 just removed.

- multi-trip forced on -> flat 10% in the institutional tier, marginal calculation skipped
- sibling forced on -> flat 10%, even for the child ranked #1; forced off -> no sibling
  discount, but the subscription still takes part in the ranking (removing it would change
  which sibling counts as child #1)
- school forced on -> 20% with no name match; forced off -> 0 even when the name matches
- overrides stack with the school discount rather than replacing it

Wired through `discountRecalc` (which now preserves overrides instead of clobbering them,
and retriggers on an override change) and through `SubscriptionsAdminPage` — both the
row-level toggle, which already read as an override in the UI copy ("substitui a deteção
automática"), and the create form's discount picker, whose `Map<ruleId, boolean>` was already
exactly this shape and simply was not being saved. **Zero prod subscriptions carry overrides
today**, so this changes nobody's bill until an admin uses it; the Oct baseline is unmoved at
+EUR 53.28/month.

**"Repor automático" button** (row-level, shown only when a subscription actually carries
overrides): drops every override and lets the automatic rules decide again. It writes *only*
the override field — `discountRecalc` owns recomputing `appliedDiscounts` and the fee, and is
the only place that counts siblings across both collections, so recomputing in the row would
mean a second, worse copy of that logic. Manual concessions ("Aluno do ano anterior") are
deliberately kept: they were never automatic. Because the recalculation is a backend trigger,
the button waits before reloading — reloading immediately shows the pre-reset fee and reads
as "the button did nothing" on a money screen.

Kidclub app typecheck: **13 errors before and after — the pre-existing baseline, zero new.**

### Decisions 12-15 — Phase 2 sequencing (settled 2026-09-22)

| # | Decision | Consequence |
|---|---|---|
| 12 | **Prod is NOT repaired first.** Snapshot prod as-is into dev; `identity.mjs --apply` runs against **dev only**. | Prod stays untouched until Phase 5. Dev first tests the unrepaired shape — 11 subs with no `familyId` generate **no events at all**, so that is the first thing the migration has to fix. The same 25 writes are rehearsed in dev and redone in prod later; accepted. |
| 13 | **Historical absences ARE written for the invoiced September periods**, while the billing records stay frozen. | The event log is complete and matches reality; the 5 fiscal documents are never recomputed. Flag (c) keeps reporting the difference, per decision 5. |
| 14 | **Phase 2 clears the 6 `endDate: 2027-07-30` values** so all 22 subscriptions bill August 2027. | Cancellation becomes purely manual, consistent with decision 10. ⚠️ Writing `endDate` triggers `regenerateFutureEvents`, so this MUST happen in the date-repair step **before** event generation — see the Phase 2 sequencing rule. |
| 15 | **The next agent writes the Phase 2 script only.** No dev wipe, no import, no deploy. | Renato reviews the dry run before anything executes. The wipe runbook is written down, not run. |

### ✅ Phase 1 + Phase 2 COMPLETE ON DEV — validated (2026-09-23)

Dev was wiped, reimported from prod, repaired and migrated. **Prod is untouched** — the only
prod operation all session was a read-only export. Everything below is verified, not assumed.

| Step | Result |
|---|---|
| Dev backup | `gs://kidclub-dev-exports/pre-wipe-20260923-0000`, 4,925,447 bytes |
| Dev KidClub delete | 11,440 docs, 12 collection IDs. Scope pre- and post-verified; **shared `users` untouched at 49 docs** |
| Prod export → dev import | 458,973 bytes, `SUCCESSFUL`. Dev then mirrored prod exactly: 13 study + 21 transport, 228 billing, **0** events, 11 orphans |
| `identity.mjs --apply` | **25 writes** — 5 families created, 2 child merges, familyId links. Matches the recorded plan exactly |
| `migrate.mjs --only dates --apply` | **7 writes**. `endDate` cleared on both storage shapes, every other field intact (inspected) |
| `migrate.mjs --apply` | **4,742 writes** — events, absences, billing status |

**Verification — the four reference figures reproduce exactly:** Carolina €182.40, José Eduardo
€165.12, Maria Manon €130.56, Mogo €210.00, and their deltas sum to **+€53.28/month**
(14.40 + 13.92 + 12.96 + 12.00).

**Flags all clean:** (a) zero silent €0 periods, (b) zero reprice divergences, (c) 4 invoiced
divergences *reported not corrected*, exactly as decision 5 requires, (d) **zero** subscriptions
without a familyId. **The invoiced guard provably held** — the frozen records still read
`status: invoiced` carrying their original prod `updatedAt` of 2026-09-20/22, untouched by the
2026-09-23 run.

#### 🔴 August 2027 is €2,892.96, NOT the €2,134.56 the plan predicted — the plan's number was stale

Investigated rather than accepted. **€2,134.56 is superseded**, for two reasons that both
postdate it:

- **Decision 6** restores three subscriptions that the estimate had billing nothing: José Miguel
  Duarte €113.28, Maria Clara €96.00, Edson €72.00 — **+€281.28**.
- **Decision 18** — the cliff is 7 subscriptions, not 6. The estimate was built from the string
  match that missed all 4 study subs, so their August revenue was still counted as €0.

The result is right, and here is the check that settles it: **every month across the whole
horizon now computes exactly €2,892.96** — Oct 2026, Nov 2026, Jan, Jun, Jul and Aug 2027, all
identical. That is precisely what decisions 1 and 10 require (flat monthly price; a billable
period is decided by the contract, not the event count), including for August and the second
half of July 2027, which hold **zero events** because `yearEndDate` is 2027-07-15. A month with
no school days still bills its share of the 12-month spread.

Treat €2,892.96/month as the new reference figure; €2,134.56 should not be quoted again.

#### Still open on dev, deliberately

- **3 children have no `children` record** (Afonso Santos, Camila Felix, Laura Baptista) and one
  (`Cn5TOmtPauRVnn6cC1jY`, Matilde Lopes) resolves to no family. `identity.mjs` reports and skips
  them rather than inventing records. Does not block anything — generation needs `familyId`, not
  `childId`.
- **31 historical absences were not migrated**, each classified: a cancelled/pending subscription
  (expected), or a weekend/unserved weekday, which is the pre-`eb905ed` off-by-one. Not migrated
  by guessing a corrected date.
- **Post-import fixes from the runbook are NOT done**: dev's `driverMonthlyCost` /
  `electricityMonthlyCost` were overwritten by prod's config, and no family points at a real
  `kidclub-dev` Auth UID yet — so **the parent path still cannot be exercised on dev**. That is
  Phase 4's prerequisite, and `renato343@gmail.com` cannot serve for it (it holds `owner`/
  `rainbowAdmin`, and `setReservationEventStatus` checks staff first).

#### Phase 4 setup — DONE (2026-09-23): a synthetic QA family, not a borrowed real one

**The auth hazard was wider than recorded.** STATUS said `renato343@gmail.com` could not
validate the parent path. In fact **all 5 dev Auth accounts are staff** —
`admin@kidclub.pt`, `noisysource@gmail.com` and `renato343@gmail.com` hold owner +
rainbowAdmin, `beritogabriel@hotmail.com` holds rainbowAdmin, `domotics-bridge@kidclub.pt` is a
service account. `setReservationEventStatus` checks `roles.owner || roles.rainbowAdmin` before
the family check, so none of them could exercise the parent path at all.

- **`parent-test@kidclub.pt`**, UID `M1Hp6oQo6yUaGBLCszouR5o0Heq2`, **no `users` doc and so no
  roles** — a pure parent. Dev only. Password set at creation, deliberately not recorded here;
  reset from the Firebase console if lost.
- Inês Pinto's family was briefly pointed at it and has been **restored** to its original prod
  UID `OB22dXJO1hZj6qke8WExkKKkXEV2` (verified). No real family is borrowed any more.

**`scripts/kidclub-migration/seed-test-family.mjs`** — creates `TEST-FAMILY-QA`, re-runnable
after any dev wipe, dev-only with no override flag. Renato's call, and the right one: a
purpose-built family beats borrowing a real one and remembering to put it back.

Every document carries **`isTestData: true` AND a `TEST-` id prefix**. One is queryable, the
other is visible in a console listing and in an export's filenames. This is the control that
makes decision 16 survivable — synthetic data is exactly what must not reach prod, and
"we'll remember to exclude it" is not a control.

| Subscription | Exercises | October result |
|---|---|---|
| `TEST-SUB-ST-ANA` | rank-1 child — **no** sibling discount | €48.00, 0 absences |
| `TEST-SUB-ST-BRUNO` | sibling + manual "Aluno do ano anterior" 15% | €22.95, **3 absences → €13.77 credit** |
| `TEST-SUB-TR-ANA` | marginal multi-trip + school 20% | €92.16, **2 absences → €0 credit** |
| `TEST-SUB-TR-BRUNO` | multi-trip + sibling + school | €65.66 |
| `TEST-SUB-TR-CARLA` | **decision 8 boundary** — starts Oct 15 | €17.28, 4 system absences → €17.28 credit |

**The threshold boundary is one click away**: Ana's transport sits at 2 absences with no credit.
Marking a third must switch the credit on. `set-test-absences.mjs` seeds and `--reset`s these,
scoped to a single period — absences split across two months are two sub-threshold months, not
one qualifying one.

**Verified live, not asserted:** the deployed triggers generated all 297 events by themselves on
subscription create, sibling ranking puts Ana at full price and Bruno at a discount, multi-trip
credits **€4.80 = only the second leg of each two-leg day** (marginal, not flat), and decision 8
pro-rates Carla's boundary month through system-CANCELLED pre-start days.

#### 🔴 Finding (2026-09-23) — a status change DESTROYS that period's recorded absences

Renato corrected Francisco and Julia Brito from `pending` to `active` in dev
(`cz7N6U8qsO20Zvo2wBEM`, `MFsSlj2IN7rAI98k0FyK`) — `active` is the true status. Two consequences
came out of it, both real:

1. **Julia's recorded absence was wiped.** She carried `excludedDates: ['2026-09-22']` on
   September's billing record. The status write fired `onTransportBillingSync`, which recomputed
   the record and rebuilt the line item **without** it. Prod still holds the value, so nothing
   was lost permanently; dev was repaired by regenerating the back-dated events and re-marking
   2026-09-22 CANCELLED on both legs with the migration's own provenance.
2. **`regenerateFutureEvents` only generates from today forward**, so activating the subs left
   September 1–22 with no occurrences at all. Re-running `migrate.mjs --apply` created the
   missing 99 events (its window opens at the earliest billing period, not the current month).

> **Sequencing rule for prod: migrate FIRST, then correct statuses.** The migration converts
> `excludedDates` into `reservationEvents`, which a billing recompute cannot touch. Correcting a
> status before migrating destroys exactly the history the migration exists to preserve.

**Prod still has both subs as `pending`** and must be corrected there too — but only *after* the
prod migration, per the rule above. Because `migrate.mjs` generates only for `active` transport
subs, a prod run today would skip both Britos entirely.

#### Next step — `scripts/kidclub-migration/PHASE4-TEST-PLAN.md`

A ticklist covering the parent path and its authorisation boundary, the ≥3-absence threshold in
both directions, the marginal discount model, the real migrated figures, the frozen invoiced
records, and read-only prod divergence checks. Written for someone with no context.

Phase 4 — dev validation: set one family's `primaryContact.userId` to a real dev Auth UID, then
click through the four cancellation paths and a family with school discount + siblings + 3
absences. Then Phase 5, whose route is decision 16 below — **and read its caveat first.**

### Decision 16 — Phase 5 route: import dev into prod (Renato, 2026-09-23)

Renato settled the open Phase 5 question: **import dev's repaired data into prod**, on the basis
that parents logging into dev is not a requirement.

⚠️ **Recorded with a caveat, because the stated reason addresses a different risk than the real
one.** The hazard is not parents logging into *dev*. It is that importing dev→prod **overwrites
prod's `primaryContact.userId` values with dev's**, and dev's are `kidclub-dev` Auth UIDs that
match no prod account — so the import would break parent login **in prod, for real customers**,
along with anything else a dev test mutated in the meantime. Re-examine before the cutover, not
at it. Does not block Phase 2 either way.

### Decision 17 — `yearEndDate: 2027-07-15` is correct (Renato, 2026-09-23)

Confirmed intentional, not a typo. Events stop mid-July 2027 while billing runs through August
2027 — that is decision 10 working as designed. No change.

### Decision 18 — the July-2027 cliff is all 7 subscriptions (Renato, 2026-09-23)

Confirmed: the 4 study subs missed by decision 14's string match are in scope along with the 3
transport ones. Decision 14's count of 6 is superseded by 7.

### ✅ Phase 2 — script written, signed off, and APPLIED to dev (2026-09-22/23)

> Applied 2026-09-23: 4,742 writes to `kidclub-dev`, after 25 identity writes and 7 date
> repairs. **Nothing has ever been written to prod.** The section below describes the script
> as reviewed; it is still accurate about behaviour.


Branch `agent/phase2-migration`, off `agent/eventsourcing-integration`. **PR #33 → `staging`.**
Nothing has been written to any project — every figure below is a dry run.

Deliverable: **`scripts/kidclub-migration/migrate.mjs`**. Dry run by default; `--apply` against
prod is **refused outright, with no override flag** (decision 12 — unlike `identity.mjs`, whose
25 identity writes do eventually have to be redone in prod by hand, this script writes thousands
of event documents and does not get an escape hatch). It compiles `reconciliation.ts` and
`reservationEvents.ts` out of `functions/src` and calls the real generators, the same way
`reconcile-report.mjs` does — no second copy of the money math.

Four steps, in the only safe order (`--only <step>` isolates one):

1. **date repairs** — clear the July-2027 `endDate` cliff (decision 14). Fires
   `regenerateFutureEvents` deliberately, then waits `--settle-seconds` (default 90) for the
   triggers to drain before generating.
2. **event generation** — `reservationEvents` for every active sub (study `active`/`confirmed`,
   transport `active`). Window opens at the **earliest billing period**, not the current month,
   so the historical absences have occurrences to land on. Also performs the **pre-start
   repair**: `ensureEventsExist` is additive-only, so an `EXPECTED` event an earlier backfill
   already wrote is never flipped to system-`CANCELLED` by a backfill click — the script rewrites
   those explicitly. Human-recorded events are never touched.
3. **historical absences** — `excludedDates` + `eventModifications` → `CANCELLED`, including in
   the invoiced September periods (decision 13). `eventModifications.date` is converted in
   **Europe/Lisbon**, not by slicing the ISO string.
4. **billing status** — auto-cancelled records → `pending` (decision 6), `autoCancelled` removed
   rather than set false, matching `autoCreateBillingSchedule`.

**Guards:** a hard refusal on any write to a `billing` record with `status: "invoiced"` (decision
5) — it throws rather than skipping, because a step that reaches it has a bug in its filter. And
the script **refuses to `--apply` while any active subscription has no `familyId`**, since
generation freezes `familyId` into every event it writes.

**Prod dry run reproduces the recorded figures**: 11 orphan subs, 75 `excludedDates` + 13
`eventModifications`, 35 auto-cancelled records, 5 invoiced frozen, 4,683 events to create,
4,780 writes total.

#### 🔴 Two findings — decision 14's number is wrong, and it is wrong for the timezone reason

- **The cliff is 7 subscriptions, not 6, and it cannot be matched as the string `"2027-07-30"`.**
  The collections store `endDate` in different shapes (`coerceDate`'s own comment says so):
  transport is the plain string `"2027-07-30"`, study is a **timestamp** storing
  `2027-07-30T23:00:00Z` — which in Europe/Lisbon (WEST, UTC+1) is **2027-07-31**. An exact
  string match finds the 3 transport subs and **silently misses all 4 study ones**, in the one
  step whose whole purpose is removing that cliff. Same class as the `eventModifications`
  off-by-one and as commit `eb905ed`. Now matched by calendar **month**, which catches both
  shapes. The full set in prod: study `G8BpDUdRKlaePJQs2doT` (Sofia), `GJ7JYFe6KPSZAQofIsCM`
  (Beatriz), `Y0E8cYlZ3P0y1csUphCP` (Maria Clara), `bX7Mn5EQIe18eq94048D` (Edson); transport
  `E3m788wTJzzECALna9Wn` (Duarte Gomes), `SN5NrqAz82At9A3HqnAe` (Diogo Mogo),
  `Wr0HmgGPSL38m4Q3a0cH` (Sofia). The script reports the 6-vs-7 difference rather than asserting
  either number — **Renato confirms the list before `--apply`.**
- **`config/schoolCalendar.yearEndDate` is `2027-07-15` in prod**, not August. Event generation
  stops there, while `periodsUntilSchoolYearEnd()` bills through August 2027 regardless. So the
  second half of July and all of August 2027 bill a full flat month holding **zero events**.
  That is decision 10 working as designed ("a billable period is decided by the contract, not by
  the event count"), and it is what decision 14's "all 22 bill August 2027" actually rests on —
  but it is surfaced in preflight because it is not obvious, and a wrong `yearEndDate` is
  indistinguishable from it. **Not changed — flagging only.**

#### Absences that match no occurrence are classified, not just counted

31 of the 88 historical absences in prod name a day with no occurrence, and the script says which
kind, because the two mean opposite things:

- **subscription is `cancelled`/`pending`** — expected, nothing to do (e.g. all 11
  `eventModifications` for `IyJoNIyxvwhMxMpId7XO`, Duarte Gomes' cancelled study sub; and the 7
  `excludedDates` on Beatriz Apóstolo's cancelled transport sub `7sYsxBADSPlFOpvlKqTO`).
- **the date is a weekend or an unserved weekday** — the signature of the pre-`eb905ed`
  `toIsoDate()` bug, which stored the day *before* every click. Several `2026-09-06` entries are
  Sundays.

**Neither is migrated by shifting the date.** The correct day is a guess, and guessing on a money
path is how the original bug survived as long as it did.

#### `identity.mjs` — gap fixed, and `--apply` now actually exists

Two things were wrong with the plan's step 1 as written:

- It re-proposed the **Mafalda** merge completed on 2026-09-22 — it did not filter children with
  `status: "merged"`. Fixed (and `--approve-merge` now skips an already-merged loser too).
- **`--apply` was not implemented.** It printed the plan and exited `2` with "Full APPLY mode is
  not implemented yet" for everything except an explicitly named `--approve-merge` pair. The
  sequencing rule depends on running it, so it is implemented now: exact-name merges (salvage →
  repoint → retire, in that order, so a failure leaves the loser live), family creation from
  `contactEmail` with `profileComplete: false` and an empty `primaryContact.userId` (decision 7 —
  the account link arrives on first login), and `familyId` links on subs and children. Every
  write is identity-only; none of them touch
  `schedule`/`days`/`weekPattern`/`startDate`/`endDate`/`status`, which is what keeps it inert as
  far as `regenerateFutureEvents` is concerned. **Keep it that way.**

A child named on a subscription with no `children` record at all (3 in prod) is **not** created —
reported for a human. It does not block Phase 2: the generators need `familyId`, not `childId`.

#### Dev wipe — `scripts/kidclub-migration/DEV-WIPE-RUNBOOK.md`, written, NOT run

Per decision 15. Scoped to `_apps/arcoiris/**`; never `firestore:delete --all-collections` (the
shared `(default)` database holds `finances_entities/**`), never the shared top-level `users`
collection. Includes the dev backup first, the prod export excluding `reservationEvents` and
`users`, the post-import fixes (dev transport costs, one family pointed at a real dev Auth UID,
and why `renato343@gmail.com` cannot validate the parent path), and the ordered run sequence.

#### Next step

1. Renato reviews the dry run above and **confirms the 7-subscription cliff list**.
2. Renato runs the wipe runbook (his call, decision 15), then `identity.mjs --apply`, then
   `migrate.mjs --apply`, then `reconcile-report.mjs` — all against `kidclub-dev`.
   ⚠️ **The REST write payloads have never been executed** — a dry run cannot exercise them.
   `--dump <file>` writes the exact payloads out without sending them (reviewed: field masks
   correct, `endDate`/`autoCancelled` cleared by mask-without-field as intended). Still, run
   `migrate.mjs --apply --only dates` first — 7 writes — and check one subscription document
   before letting the full 4,700-write generation go.
3. Verify: Carolina €182.40, José Eduardo €165.12, Maria Manon €130.56, Mogo €210.00,
   +€53.28/month, August 2027 €2,134.56. A disagreement is a finding, not a report bug.

⚠️ **Nothing risky is in flight.** No writes were made to dev or prod; prod was read-only, via
`gcloud auth print-access-token` against the Firestore REST API, with no standing access added
and nothing to revoke. Both PRs target `staging`.

### UI work found by testing the migrated data (2026-09-23, PRs #34 and #35)

Three bugs, found by Renato clicking through dev, and two refactors.

**Bugs (#34)**
1. **A recorded absence was invisible in Cobranças below the ≥3 threshold.** The row gated its
   whole absence display on `absenceCreditDates`, which `reconciliation.ts` only populates once
   the credit fires — so staff could not tell "no absences" from "2 absences, no credit". Adds
   `absenceDates` (unconditional) next to `absenceCreditDates` (gated): they answer different
   questions.
2. **The "Dias sem serviço" modal never named the child** — several calendars all headed
   "Sala de Estudo" / "Transporte", on the screen whose only job is changing those days.
3. 🔴 **A subscription's own first day vanished from the parent's trip list.**
   `new Date("2026-10-15")` parses as **UTC midnight = 01:00 Lisbon**, compared against
   date-fns local midnights, so `day < subStart` was true for the start day itself. Carla's
   15 October disappeared while the 20th showed.

   **This was the third appearance of this bug class** — after `toIsoDate()` (`eb905ed`) and
   the `eventModifications` timestamps in the migration. Fixed with a
   `coerceSubscriptionDate(raw, 'start' | 'end')` helper in `src/lib/utils.ts` mirroring the
   backend's `coerceDate()`, applied to **all three** client pages carrying the pattern.
   **If you write date handling in this app, use it.** A date-only string is not a Date.

**Refactors (#35)** — see `apps/noisyphocus/kidclub/CALENDAR-VIEWS.md`.
- **`/client/calendar`** — one grid, every child, both services, filterable, cancel/restore
  inline. Replaces a four-screen path. Reads `reservationEvents` directly, one query per month
  scoped by `familyId`. It is also a **data-correctness tool**: it warns when an active
  subscription generated no occurrences for a month, which under flat pricing still bills in
  full — the client-side counterpart of flag (a) in `reconcile-report.mjs`.
- **Admin day editor is now inline** in the expanded billing row, not a modal, so the calendar
  and the amounts it moves are visible together. Pending records only; invoiced stays frozen.
- **Removed four unreachable files** (verified by reference count): `ClientDashboardPage`,
  `FamilyDashboardPage.tsx.example`, `FamilySchedulePage`, `ClientSchedulePage`. Their routes
  redirect to the calendar. `ClaimSubscriptionsPage` was checked and **kept** — not routed, but
  `ClientLayout` renders it directly.

⚠️ **The calendar needs a composite index**: `reservationEvents` on `familyId` + `date`, now in
`firestore.indexes.json` so CI deploys it to **both** projects. A console-created index covers
only the project it was made in — the page would work on dev and throw `FAILED_PRECONDITION`
for every family in prod. Confirmed `READY` on dev 2026-09-23.

### ✅ Branch state — all merged (2026-09-23)

PRs **#32, #33, #34, #35** are merged into `staging`, which is 87 commits ahead of `main`.
The worktrees behind them can be removed. The promotion `staging` → `main` is Renato's call and
deploys to prod pre-merge, so it waits on Phase 4 sign-off.

### Phase 5 route — DECIDED (decision 16), with a caveat that has since grown

Settled 2026-09-23: **import dev into prod.** See decision 16 below for the caveat — the risk
is not parents logging into dev, it is that the import overwrites **prod's**
`primaryContact.userId` values with dev ones, breaking real parents' logins in prod.

Since that decision, dev has accumulated more that must not travel: `TEST-FAMILY-QA`, three
synthetic children, the `parent-test@kidclub.pt` account and test mutations. Every synthetic
document carries **`isTestData: true` and a `TEST-` id prefix** precisely so exclusion is
mechanical rather than remembered — but exclusion-by-filter is a control you must get right
every time, whereas re-running `migrate.mjs` against prod is correct by construction.

The alternative remains: re-run the validated script against prod. Dev proved it; prod gets the
same transformation; synthetic data cannot travel because the script only ever touches prod's
own documents.

### ⚠️ The dev wipe must target KidClub ONLY — `users` is shared (verified 2026-09-22)

Renato's explicit instruction: the wipe targets KidClub, never Finances or any other app.

- **Scope the delete to `_apps/arcoiris/**`.** Never `firestore:delete --all-collections` —
  KidClub and FinHub share the single `(default)` database, so that destroys
  `finances_entities/**` (FinHub dev) too.
- **The STATUS open question about the top-level `users` collection is now answered: it IS
  shared, so do NOT wipe it.** Every one of the 46 prod docs carries a `roles` map holding
  both `rainbowAdmin` and `finhubAdmin`, and `functions/src/userManagement.ts` — shared, not
  KidClub-scoped — gates on `roles.finhubAdmin`. Wiping `users` would strip FinHub's admin
  access in dev. Fix the two accounts that need fixing individually instead.

### ✅ SUPERSEDED — August remainders

> Decision 14 cleared the cliff, and decision 18 corrected its size to **7 subscriptions, not
> 6** — the string match missed all four study subs, whose timestamps read 2027-07-31 in
> Lisbon. Applied to dev 2026-09-23. Kept for the reasoning.


Superseded by decision 14 — Phase 2 now clears the 6 `endDate: 2027-07-30` values, rather
than Renato clearing them by hand. Report flag (a) lists them until it does.

### ✅ FIXED — `identity.mjs` gaps (2026-09-23)

> Two, not one. The merged-child filter below is fixed; separately, **`--apply` was not
> implemented at all** — it printed the plan and exited 2 for everything except an explicitly
> named `--approve-merge` pair, while the whole sequencing rule depends on running it. Both
> done; 25 writes applied to dev. Kept for the reasoning.


It still flags the **Mafalda** pair as needing a human decision even though that merge was
completed on 2026-09-22 — it does not filter out children with `status: "merged"`. Harmless
in a dry run, but it will keep re-proposing a done merge. Fix before running `--apply`.

### Billing horizon — bounded, not infinite (verified 2026-09-22)

`periodsUntilSchoolYearEnd()` generates records from the current month through **August of
the following year**, so an open-ended subscription (18 of 34 active subs have no `endDate`)
does not bill forever — it bills to August and stops until someone generates again. This is
what makes decision 10's "cancel manually" workable.

**Re-measured 2026-09-22** (moving targets): **4** active transport subs still have no
`childId` — unchanged. **0 of 21** change their Bissaya match when sourced from the child
record — unchanged. One active *study* sub carries a `childId` pointing at a child document
that no longer exists; `resolveSchoolName` treats that as absent and falls back to the
subscription mirror, so it is safe, but it is another reason step 4 must not delete the
mirror before the identity repairs land.

### Expected money impact

Comparing a clean full month (Oct 2026), service line items only. **10 of 17 families
change by €0.00.** The entire delta is the marginal-discount change already approved
on 2026-09-20 — it is not introduced by this migration.

| Family | Current | New | Delta | Cause |
|---|---|---|---|---|
| Carolina Almeida | 168.00 | 182.40 | +14.40 | marginal multi-trip |
| José Eduardo | 151.20 | 165.12 | +13.92 | marginal multi-trip |
| Maria Manon | 117.60 | 130.56 | +12.96 | marginal multi-trip |
| Mogo siblings | 198.00 | 210.00 | +12.00 | Diogo loses sibling discount (ranked #1 by value) |
| **Total** | **€1,800** | **€1,853** | **+€53.28/mo (+3.0%)** | |

These four figures independently reproduce the comparison table recorded on 2026-09-20,
which is a useful cross-check on both the implementation and the simulation.

### ✅ FIXED and VERIFIED — the parent-auth blocker in prod data

> The `primaryContact.userId` fix, the `reservationEvents` read-rule scoping and the parent
> path itself are all verified against dev with a real roleless parent account (2026-09-23):
> 200 for own family, 403 for another, 403 on a direct read. The past-date cutoff noted below
> is **still open** — a parent can still cancel a day that has already passed. Kept for the
> reasoning.


`setReservationEventStatus` (`functions/src/kidclub/reservationEvents.ts`) authorises a
parent with:

```js
const famSnap = await appCol("families").doc(data.familyId).get();
if (!famSnap.exists || famSnap.data()?.userId !== uid) throw permission-denied
```

**`families/{id}` has no top-level `userId` in prod.** The login link lives at
**`primaryContact.userId`** — populated on all 36 families, top-level populated on **zero**.
So every parent receives `permission-denied` and only staff can mark an absence. The shared
parent/staff write path — the central point of the rewrite — does not work against real
data. Any dev validation done before this is fixed is validating a flow no parent can use.

Two lesser issues alongside it:
- `firestore.rules` allows **any authenticated user to read every family's
  `reservationEvents`** (`allow read: if isAuthenticated()`). Should be scoped to the
  owning family.
- `setReservationEventStatus` permits cancelling a **past** date with no cutoff.

### Other prod findings feeding the plan

- **`startDate` is ignored by event generation.** `ensureEventsExist` starts at the current
  month's 1st, `regenerateFutureEvents` at today; neither clamps to `sub.startDate`. Maria
  Clara's study sub starts 2026-10-01 — a backfill run in September generates September
  occurrences and bills her before she starts.
- **Identity is fragmented.** Lourenço Bernardino has **2** `children` records (transport
  and study point at different ones); Maria Vicente has **3**. 7 children have an empty
  `familyId`. 6 active transport + 5 active study subs have no `familyId` at all — but every
  one carries a `contactEmail`, and the same email appears on both of that child's subs, so
  the family key is already present in the data.
- **Personal data is copied onto subscriptions and drifts.** `schoolName` diverges for 5 of
  10 dual-service children; two of those values are street addresses, not schools. Duplicated
  fields: transport (`childName`, `contactEmail`, `schoolName`, `userId`), study (those plus
  `contactPhone`, `schoolYear`). All of it already exists canonically on `children` /
  `families.primaryContact`. This is the source of the repeated personal-data blocks in the UI.
- **`returningStudent` latent double-discount.** The flag is set on **zero** subs, while 7
  carry the manual "Aluno do ano anterior" 15% discount. `reconcileService` sums
  `returningStudentDiscountPct` + `manualDiscountPct`, and transport config has
  `returningStudentDiscountPercentage: 0.15` — so ticking that flag on a sub that also has
  the manual discount silently yields 30%. Same class as the double-discount bug already
  fixed once.
- **School discount is already correct** — the `auto_school` rule is `appliesTo:
  ['transport']` only and `buildReconciliationConfig` filters on it, so study room never
  receives it. Confirms Renato's rule; nothing to change.
- **August bills in full, deliberately** — the annual fee is spread over 12 months. Recorded
  so it is not later mistaken for a bug.

### Execution phases

- **Phase 0 — identity, permissions, UI.** Fix `primaryContact.userId`; scope the
  `reservationEvents` read rule; `startDate` clamp; orphan-subscription guard. Merge duplicate
  children (keep the most complete record, reuse whichever link exists). Create minimal family
  records for the 6 orphan emails; backfill `familyId`/`childId` on the 11 orphan subs. Make
  subscriptions *reference* `children`/`families` instead of copying personal data, and show
  it once in the UI.
- **Phase 1 — billing code.** Flat-gross mode; notional absence credit; close the
  `returningStudent` double-count. Extend the existing vitest suite.
- **Phase 2 — migration script.** Dry-run-first, standalone, never a deployed function.
  Generate events; convert the 88 historical absences; set the 35 auto-cancelled records to
  `pending`. Hard-guard against writing to any `invoiced` record.
- **Phase 3 — reconciliation report.** Per family, per month: current, new, delta, reason.
  Run on dev, then dry-run against prod. **Nothing writes to prod until Renato approves this.**
- **Phase 4 — dev validation** on a fresh prod→dev snapshot: real triggers, all four client
  cancellation paths, a family with school discount + siblings + 3 absences checked by hand.
- **Phase 5 — prod cutover.** Full export backup; invoiced frozen + divergence report; apply
  the approved migration. Explicitly **not** a `backfillBillingSchedules` click — that would
  resurrect records indiscriminately and destroy the 75 `excludedDates`.
- **Phase 6 — final audit.** Verify every subscription's `active`/`pending`/`cancelled` state
  and its generated events agree, with nothing orphaned.

### How prod was read

Read-only, via a `gcloud auth print-access-token` against the Firestore REST API against
`rainbow-prod-2454b` — no service-account key, no standing access added to
`.claude/settings.local.json`, nothing to revoke. Reuse this pattern; do not provision
new prod credentials.

---

**Last updated:** 2026-09-22

## CURRENT STATE — rewrite merged to `staging` and validated on dev; PROD NOT UPDATED

**The one-paragraph version:** the event-sourced billing rewrite is finished, merged into
`staging`, deployed to `kidclub-dev`, and clicked through end-to-end by Renato — it works.
It is **not on prod**. `staging` is ~32 commits ahead of `main`, and prod is still running
the old billing code from `b415ef3`. The next move is the `staging` → `main` promotion PR,
but that is deliberately **not** opened yet, because deploying it means recomputing real
families' September billing under new rules — see "Next step" below, which is the whole
point of this checkpoint.

Everything below this section (up to "## Currently working on") documents how this
design evolved — read it for the *why*, but this section is the authoritative *what's
actually true right now*. The original plan (a flat 3-day absence credit, computed live
off billing triggers) was superseded by a real architectural decision: subscriptions
materialize concrete `ReservationEvent` rows for the whole school year at creation time,
and billing reconciles against those events rather than a schedule formula plus a
disconnected `eventModifications` log.

**Branch:** merged. `agent/absence-threshold-billing` → PR #28 → `staging` (2026-09-22).
The branch and its worktree are gone; don't go looking for them.

**Repo state as of this checkpoint: deliberately clean slate.** Zero open PRs, zero
worktrees, one local branch (`main`). Every stale/abandoned branch was cleared at Renato's
instruction ("we're starting fresh now... we won't pick that again"). Anything that was
local-only was pushed to origin first, so nothing is unrecoverable — old branches still
exist on GitHub if a decision gets reversed. **Start new work from a fresh worktree off
`main`.**

**What's built and typechecks clean (functions: `tsc --noEmit` + full `tsc -p .`;
kidclub app: zero new errors, same pre-existing baseline throughout):**

1. **`ReservationEvent`** (`packages/shared/models/ReservationEvent.ts`, new
   `reservationEvents` collection) — one row per `(subscriptionId, date[, direction])`,
   generated in full for the remaining school year the moment a subscription is created.
   Status `EXPECTED → CANCELLED` (a parent or staff marks a date absent; still billed
   unless the period's count crosses the threshold, and counts toward it) `→ VOIDED`
   (subscription ended or schedule changed before this date arrived; never billed, never
   counts as an absence). This is what makes a mid-month cancellation stop billing future
   dates without erasing already-elapsed ones — no special-casing needed, it falls out of
   the status split.
2. **`functions/src/kidclub/reservationEvents.ts`** — generation triggers on
   subscription create/schedule-change/cancel (`onStudyroomReservationEventsSync`,
   `onTransportReservationEventsSync`), the shared toggle callable both parents and staff
   use (`setReservationEventStatus` — closes the gap where staff previously had no way to
   mark an absence except the now-removed billing-page `excludedDates` picker), and a
   manual backfill (`backfillReservationEvents`) for subscriptions that existed before
   this shipped.
3. **`functions/src/kidclub/reconciliation.ts`** — the full discount + absence pipeline,
   as a pure function (no Firestore access) so the money math lives in one place:
   Gross (sum of `EXPECTED`+`CANCELLED` events) → marginal multi-trip discount (only trip
   #2+ on a given date) → marginal sibling discount (subscriptions of one service ranked
   by value across the family — highest value = "child #1"/full price, tie-broken by
   earlier enrollment then older child; everyone else discounted) → institutional
   discount (school + returning-student + manual admin overrides, **summed**, not
   compounded, on the post-sibling subtotal) → net → absence credit (under 3 `CANCELLED`
   events this period = no credit; **3 or more = credit the full count, uncapped** — 4
   absences credits 4, not capped at 3 as an earlier version of this did).
4. **`billing.ts` rewired** to fetch events/children/discount-rules and call
   `reconcileService()` instead of the old schedule-formula + `eventModifications`-count
   logic. `setBillingLineItemExcludedDays` and `excludedDates` removed entirely — that was
   a third, disconnected way to mark an absence that never counted toward the threshold
   and wasn't visible to the family. `onEventModificationBillingSync` replaced by
   `onReservationEventBillingSync`, watching the collection billing actually reads now,
   scoped to status transitions only (not the ~150-doc bulk generation per subscription).
5. **`BillingAdminPage.tsx`** — the "Dias sem serviço" day-picker now edits real
   `ReservationEvent` docs via `setReservationEventStatus` (immediate, no local staging),
   and the line-item breakdown shows every discount tier and the absence count/credit
   separately instead of one opaque percentage. The old bulk-recompute button is
   relabeled "🛠️ Reparação manual — recalcular tudo" — a manual repair tool now that
   recomputation is automatic, not the primary action.
6. **All 4 of 4 client-portal cancellation pages migrated**
   (`StudySubscriptionDetailPage`, `TransportSubscriptionDetailPage`,
   `ChildManagementPage`, `EventCalendarPage`) — they now toggle real `ReservationEvent`
   docs via `setReservationEventStatus` instead of writing `eventModifications`.
   `EventCalendarPage.tsx` (`/client/children/:childId/calendar`, linked from
   `ChildDetailPage.tsx`) needed `eventService.ts`'s computed transport events to expose
   each schedule row's `direction` — added that field to the booking object `getEvents()`
   already builds (additive, doesn't touch generation or the admin calendar's own use of
   the same function). **The deploy-blocking gap from earlier in this session is closed —
   nothing left writes to `eventModifications` for anything billing reads.**

**Testing (2026-09-21, same branch):** added `vitest` to `functions/` — the first test
infrastructure anywhere in this monorepo. 42 unit tests, all passing, covering the two
pure modules where this session's business-rule iteration actually lived:
`reconciliation.test.ts` (29 tests — gross/VOIDED handling, the corrected uncapped
absence threshold, marginal multi-trip, marginal sibling ranking + tie-breaks, summed-
not-compounded institutional discount, ordering) and `reservationEvents.test.ts` (13
tests — odd/even biweekly pattern including the 5th-occurrence edge case, per-leg
transport direction tagging, deterministic event IDs). Run with `pnpm --filter functions
test` (or `cd functions && npx vitest run`).

### Dev E2E test pass (2026-09-22) — flow validated, 8 real bugs found and fixed

Renato clicked the whole flow on `kidclub-dev` with fresh data, stopping short of payment
("that would be a hard stop — that functionality is working and doesn't need testing").
Nearly every report surfaced a genuine defect. Test count went 42 → 50. The billing-
correctness ones are worth knowing about because they'd all have been silent in prod:

1. **Two legs on one day collided onto a single occurrence.** 0 of 109 transport schedule
   entries carry a `direction`, so both legs keyed to `..._both` and `batch.set` overwrote
   one. Gross billed **half** the trips and the multi-trip discount never fired. Fixed by
   adding `legIndex` to the doc id.
2. **Study generated ZERO occurrences, silently.** `StudyRoomEntry.endDate` is a Firestore
   Timestamp (transport's is a `YYYY-MM-DD` string); `new Date(timestampObject)` is Invalid
   Date, so `cursor <= to` was always false. Fixed with `coerceEndDate()`.
3. **A missing `endDate` was treated as unusable** — but 19 of 23 transport subs have none.
   It means "runs to school-year end", the rule `eventService.ts` already used.
4. **Backfill started from *today*, so the elapsed part of the current month had no
   occurrences.** Billing derives gross from occurrences → the launch month under-bills for
   everyone. Caught via Matilde Lopes showing `Transporte — Setembro 2026 = €0.00`
   (`weekPattern: 'odd'`, all three September service days already past). Now starts at the
   1st of the current month.
5. **Re-running the backfill reset absences.** `batch.set(..., { merge: true })` with a
   hardcoded `status: "EXPECTED"` flipped CANCELLED days back — while the button's copy
   *and* the agent's own instructions said re-running was safe. It wasn't; real test data
   was destroyed repeatedly. New `ensureEventsExist()` writes only missing ids and never
   touches an existing occurrence whatever its status. Schedule-change triggers keep
   void-and-regenerate, which is correct there.
6. Silent no-op on "Cancelar dia" (early `return` + `try/finally` with no `catch`) — now
   shows a real error banner across all 3 pages.
7. Biweekly subs listed off-pattern days as cancellable rows — now filtered, with a
   "quinzenal" label.
8. Admin calendar showed no transport (`safeDate(undefined)` returned *now* vs midnight, and
   it read the dead `eventModifications`).

**Non-obvious lesson for the next session:** dev had fresh, well-formed data and still hid
four billing-correctness bugs behind zero error messages. Prod data is messier. Do not
assume a clean run means correct amounts — check the numbers, not just the absence of
errors.

### Data-quality pass — deferred until the flow is validated (Renato, 2026-09-22)

Renato's sequencing: `kidclub-dev` is **fresh test data**, used only to prove the flow
works. Analysing and fixing real data is the step *after* that, not now. Things noticed
while testing, to pick up then — **do not treat any dev observation as a prod finding
without re-checking against prod**:

- **19 of 23 active transport subs on dev have no `startDate`/`endDate` at all** (only 4
  carry them); all 13 study subs do. This is what made transport generate zero
  occurrences until the school-year-end fallback landed. **Very possibly just an artifact
  of how dev was seeded** — needs confirming against prod before concluding anything
  about the real enrollment flows.
- From `agent/exclusion-audit-notes` (these ARE prod): Mafalda Raposo Duarte still
  under-billed €15.30; a stray `2026-09-06` (a Sunday) in `excludedDates` for Diogo Mogo /
  Bernardo Mogo / José Eduardo (€0 impact, data oddity); José Eduardo's line item listing
  his weekdays twice with a gross (€216) too high for a 5-day schedule — possibly a
  duplicated schedule entry on the subscription doc.
- The dev-data revenue simulation put study+transport ~€750/month **below** their own
  direct costs. That was dev data, so it proves nothing about the real business — worth
  re-running against prod as part of this pass.

**Still not done, not deploy-blocking:**

- **No emulator-based integration tests yet** — the triggers
  (`onStudyroomReservationEventsSync`, `onReservationEventBillingSync`, etc.),
  `setReservationEventStatus`'s auth/permission branches, and `billing.ts`'s Firestore
  fetch/assembly code around `computeLineItems` are untested beyond typechecking. Needs
  the Firebase emulator + `firebase-functions-test`, a real setup investment (nothing
  like it exists in this repo yet) — scoped as the next phase, not done here.
- No dev/live testing at all yet either — a simulation against real `kidclub-dev`
  subscription/config data (fetched read-only via `gcloud`, run through a standalone
  script replicating `reconcileService()`) suggests the new pipeline's totals are in the
  same ballpark as the old one (~€220/month lower on current subscriptions, not a
  dramatic swing) — see chat history 2026-09-21 for the full breakdown. That's a sanity
  check, not a deployment verification; actually deploying to dev and exercising the real
  triggers/callables is still the next real step.
- The `agent/exclusion-audit-notes` handoff (docs-only, separate branch, already
  based on current `main`) flagged Mafalda Raposo Duarte's Sept 2026 record as still
  under-billed by €15.30 from the pre-fix deduction math, and a known race between the
  billing-sync triggers and concurrent manual edits — neither addressed by this rewrite,
  both still relevant once this ships.
- Logistics headcount (reading `reservationEvents` directly by date is now trivial — no
  new data model needed) and the multi-van vehicle model/transport planner refactor are
  still not started.
- `eventModifications` itself is now dead for billing purposes but still exists as a
  collection with historical data and is still what `AdminCalendar.tsx` reads for its own
  cancelled/pending display — not removed, just no longer relevant to money. Worth a
  cleanup pass later, not urgent.

**Next steps in order:** (1) open PR into `staging`, (2) manually verify on
`kidclub-dev`: create a subscription, confirm events generate; cancel days via each of
the 4 client entry points and the admin day-picker, confirm they're all counted the same
way and match what the family sees; verify the discount pipeline against a family with a
school discount + siblings + absences by hand; verify mid-month cancellation preserves
already-elapsed charges, (3) only then `staging` → `main`.

---

## Design/implementation thread: subscriptions are a blueprint, absences weren't tracked as facts

Discussed with Renato 2026-09-21. Framing: a KidClub subscription (`schedule[]` +
`weekPattern`) is a recurring *template*, re-derived every month by billing. "Days kids
weren't here" needs to (a) drive a real billing policy, (b) roll up into financial records,
and (c) answer daily headcount for logistics (study room + transport, including future
multi-van dispatch). Investigated the existing code before proposing anything — found more
already built than expected:

- **`events` / `eventModifications` is already a working event-sourcing layer**
  (`functions/src/kidclub/../eventService.ts` in the app, i.e.
  `apps/noisyphocus/kidclub/src/services/eventService.ts`): daily study/transport occurrences
  are computed live from subscriptions, and `eventModifications` (`modificationType:
  'cancelled'`, `status: 'approved'`) is the append-only, parent-and-admin-visible record of
  what actually didn't happen — already wired into the client calendar
  (`StudySubscriptionDetailPage.tsx`, `TransportSubscriptionDetailPage.tsx`,
  `ChildManagementPage.tsx`) and the admin calendar (`EventCalendarPage.tsx`).
- **But billing never read it.** `functions/src/kidclub/billing.ts` computed absence
  deductions from a completely separate `excludedDates` field — a string array typed in
  manually by an admin directly on the billing record (`BillingAdminPage.tsx`'s "Dias"
  editor), with zero connection to `eventModifications`. Two parallel, disconnected systems
  for the same real-world fact — this is the actual flaw Renato flagged.
- **No absence-threshold rule existed anywhere**, no logistics/headcount query exists, and no
  automatic KidClub → Finances income sync exists (see [[project_kidclub_finance_split]] for
  the intended shape). `weekPattern` (`all`/`odd`/`even`, biweekly) was already correctly
  modeled for pricing — not a gap.
- ⚠️ **`agent/family-calendar` (worktree `.claude/worktrees/family-calendar`, still open) is
  now STALE relative to main** — it branched before the double-discount fix (PR #13) and its
  `billing.ts` diff reverts `transportGrossAmount()` back to the buggy `sub.originalFee ??
  sub.monthlyFee` gross calc. **Do not merge that branch as-is** — it would reintroduce the
  double-discount bug fixed in this same file. Its `FamilyCalendarPage.tsx` UI (unifying
  study+transport cancellation into one client-facing calendar view, reusing
  `eventModifications` — same underlying model as the fix below) is still worth salvaging,
  just needs rebasing onto current `main` and re-verifying the billing.ts hunk is dropped.

**Renato's policy decisions (2026-09-21):**
- Absence threshold: under 3 approved cancellations in a month → full price. At 3 or more →
  credit exactly 3 days (flat, not scaled with further absences).
- Study and transport are two **entirely separate** thresholds — a child can miss 3 transport
  trips and still owe full price for study room, and vice versa.
- A cancellation counts the same regardless of who initiated it (parent self-cancel, or a
  phone call handled by staff) and regardless of timing (planned ahead vs. logged as a
  no-show after the fact) — all the same `eventModifications` fact, visible to both sides.
- Transport today: one van, one child, one pickup, one destination. Siblings may ride in
  different directions/vans — that's the driver's call at dispatch time, not something set on
  the subscription. **More vans/drivers are expected soon** — design for that now, don't
  hardcode single-van.
- Subscriptions run for the full school year (through July); parents can drop early. The
  transport planner needs a real refactor (multi-van ready); the study room planner is fine
  as-is.

### Phase 1 — DONE, rebased onto current main, PR not yet opened
`agent/absence-threshold-billing` (this session). **Important process finding while rebasing
this branch (2026-09-21): the local checkout's `main` was 42 commits behind `origin/main`**
when this branch was originally cut — missing PR #14 through #24, including the CI/CD pipeline
rebuild (see root `CLAUDE.md`'s new "Branch → environment pipeline" section) and the
study-exclusion-validation fix (PR #23) that also touched `computeExclusionDeduction` in this
same file. Rebased onto current `main` after fast-forwarding the main checkout; no code
conflicts (different functions), only this STATUS.md needed manual merging. Re-typechecked
clean after rebase.

**Target `staging`, not `main`, when opening the PR** — per the now-automatic pipeline, a PR
against `main` deploys straight to **prod** the moment it's opened, before any review. Normal
flow: PR into `staging` (auto-deploys to `kidclub-dev`) → verify there → PR from `staging` into
`main` (auto-deploys to prod) → merge. Compare view:
https://github.com/noisysource/noisysource/compare/staging...agent/absence-threshold-billing
(no `gh` CLI in this session, PR not yet opened).

Wires `computeLineItems()` in `functions/src/kidclub/billing.ts` to
`eventModifications` instead of (in addition to) the manual `excludedDates` field:
- New `fetchApprovedCancellations()` batches `eventModifications` queries (chunked by 30 for
  Firestore's `in` limit) per family's active study/transport subscription ids.
- New `computeAbsenceThresholdCredit()` implements the exact policy above: <3 cancellations
  this period → 0 deduction; ≥3 → credit the 3 chronologically-earliest at the per-occurrence
  rate (`studyPerDayRate` / `transportConfig.flatRatePerTrip`). Dates already covered by the
  manual `excludedDates` override are excluded from the count, specifically to avoid
  double-crediting the same absence through both paths (the same bug class as the
  double-discount fix).
- New `absenceCreditDates` field on `BillingLineItem` (both the functions copy and
  `packages/shared/models/Billing.ts`'s frontend copy), surfaced in `BillingAdminPage.tsx` so
  the credit is visible, not just applied silently.
- Typechecks clean (`functions`: `npx tsc --noEmit` and a full `tsc -p .` compile; kidclub
  app: pre-existing unrelated type errors only, none in touched files). **Not tested against
  live/dev data, not deployed anywhere.**

**Next step:** open the PR into `staging` (link above), let the pipeline deploy it to
`kidclub-dev`, then verify against a test family there: create a subscription, log 3 approved
cancellations via the client calendar or admin calendar, confirm the next billing recompute
credits exactly 3 days and shows the credit badge in `BillingAdminPage.tsx`. Only then open the
`staging` → `main` PR (auto-deploys to prod).

**Also relevant from the `agent/exclusion-audit-notes` handoff (2026-09-21 audit, see that
section below)**: `onTransportBillingSync`/`onStudyroomBillingSync` fire on every subscription
write with no debounce or ordering guarantee against a concurrent manual billing edit — a
known race that already corrupted one prod record mid-fix. This Phase 1 change doesn't cause
that race, but doesn't fix it either — worth considering as part of whatever eventually
consumes this trigger (Phase 2/3). Also: **Mafalda Raposo Duarte's Sept 2026 record is still
under-billed by €15.30** (pre-fix deduction math, not yet backfilled) — good candidate to
correct in the same `backfillBillingSchedules` run that eventually applies this Phase 1 change
retroactively, rather than another one-off hand patch.

**Open question for Renato:** should the manual `excludedDates` admin override be retired now
that `eventModifications`-driven counting exists, or kept as a separate goodwill-credit tool
for cases unrelated to attendance? Not blocking — both mechanisms coexist safely as shipped
(the double-count guard prevents overlap), this is just a "do we still need two knobs" cleanup
question for later.

### Follow-up (same branch/PR, 2026-09-21) — auto-trigger on absences + mid-month cancellation fix

Renato's push-back on the manual-recompute flow above ("any change in the sub, or in the
status should automatically trigger... i want to get rid of it") led to two more changes,
same commit range:

- **New `onEventModificationBillingSync` trigger**, mirroring the two existing subscription
  triggers: any write to an `eventModifications` doc of type `cancelled` now auto-recomputes
  that family's billing, in either direction (new approval, edit, rejection, or a parent
  restoring a day). Absences are now exactly as "live" as subscription edits — no more relying
  on someone incidentally touching the subscription doc, or clicking the manual button, for a
  billing recompute to pick up a new absence.
- **Real bug this surfaced, now fixed**: Renato caught that cancelling a subscription
  mid-month was wiping that month's ALREADY-EARNED charge on the next recompute —
  `computeLineItems` only ever asked "is this subscription active right now," with no notion
  of "was it active for part of this period." Fixed with a `frozenMidPeriodCancellation`
  carry-forward: when a subscription drops out of the active set during the still-in-progress
  period, its existing line item for THAT period is kept unchanged rather than dropped; a
  genuinely future period for an already-cancelled subscription still correctly shows nothing,
  and past periods were never touched by this code path to begin with.
- **Same bug, blunter form, in the manual `backfillBillingSchedules` path**: it force-cancelled
  every *pending* billing record — including past and current ones — for any family with zero
  currently-active subscriptions, bypassing `computeLineItems` entirely. Fixed to only
  auto-cancel records for periods strictly after the current month.
- **Manual backfill button relabeled** in `BillingAdminPage.tsx` from "Gerar calendário" (implied
  primary action) to "🛠️ Reparação manual — recalcular tudo," with copy explaining routine
  recomputation is now automatic and this is for one-off corrections only (e.g. a retroactive
  pricing/config fix). Not deleted — still useful as an escape hatch, e.g. for the Mafalda
  Raposo Duarte backfill noted above once this ships.
- `frozenMidPeriodCancellation` shown in `BillingAdminPage.tsx` as an orange notice on the
  affected line item, same transparency principle as the absence-credit badge.
- Typechecks clean (functions + kidclub app, no new errors in touched files). **Still not
  tested against live/dev data, not deployed anywhere.**

### Phase 2 (not started) — logistics headcount
Read query over the same `events`/computed-occurrence data `eventService.getEvents()` already
produces (it already computes daily study/transport occurrences, minus cancellations) — count
by date/service. No new data model needed for a basic version. Needs a decision on where it
lives (new admin page vs. wired into an existing planner).

### Phase 3 (not started) — multi-van model + transport planner refactor
Current `TransportationConfig` bakes in a single van (`vanCapacity`, `vanMonthlyCost`,
`driverRatePerHour` are singular fields, `functions`/frontend both assume one vehicle).
Renato wants this refactored to support multiple vans/drivers soon, with van/driver
*assignment* happening at dispatch time (driver's call which sibling rides which van), not
baked into the subscription blueprint. Proposal: new `vehicles` collection
(id/name/capacity/monthlyCost/driverId/active), assignment recorded per occurrence (not per
subscription). `TransportPlannerPage.tsx` — confirmed by Renato as needing a full refactor —
is the natural place to build the multi-van dispatch UI. Study room planner does NOT need
this work, per Renato.

### Phase 4 (not started) — Finance income sync
On billing finalize/payment, write an income record to
`finances_entities/{entityId}/incomes`. Log in root `CLAUDE.md`'s "Cross-App Data Contracts"
section once shipped, per that section's own convention.

## Currently working on

### Subscription personal data de-duplication (2026-09-22) — built, NOT deployed, NOT PR'd
Branch `agent/subscription-personal-data`, worktree
`.claude/worktrees/subscription-personal-data`, branched off **`staging`** (not `main` —
`main` is ~32 commits behind and does not have the billing rewrite). One commit,
`07a3873`. Nothing pushed, no PR opened, nothing deployed, no prod writes.

**Problem it addresses:** subscription documents carry denormalized copies of personal
data that already lives canonically on `children/{childId}` and
`families/{familyId}.primaryContact` — `childName`, `contactEmail`, `schoolName`,
`userId` on transport, plus `contactPhone` and `schoolYear` on study. Those copies had
drifted in prod: of the 10 children holding both a transport and a study subscription,
5 had two *different* `schoolName` values across their two documents, and two of the
disagreeing values were street addresses rather than school names.

**What changed (all read-side, plus one write fix):**
- New `apps/noisyphocus/kidclub/src/lib/personalData.ts` — one resolver,
  canonical-first and per-field (child → family primary contact → the subscription's own
  copy). The subscription copy is only reached for a subscription with no linked child or
  family, i.e. admin-created and not yet claimed by a parent.
- `TransportSubscriptionDetailPage` / `StudySubscriptionDetailPage` — render the child's
  name, school, school year and guardian email from the child + family documents. The
  child/family reads are wrapped so a Firestore-rules denial degrades to the legacy
  copies rather than breaking the page (an admin-created, unclaimed child carries no
  `userId`, which is what the client-side read rule matches on).
- `SubscriptionsAdminPage` — `load()` now also fetches `families` and builds child/family
  maps, replacing the transport-only `childSchoolMap`; every row's name/school/school
  year/contact resolves through them, so the same child reads identically on both of
  their subscriptions. Its `EditForm` now also writes guardian contact to
  `families/{id}.primaryContact` — previously an admin editing contact details only ever
  wrote the subscription's copy, which is no longer what any page reads, so the edit
  would have looked like it silently didn't save.
- `ChildDetailPage` — dropped the school name repeated on each study subscription row;
  the child's school is already shown in the details block on the same page.
- `MySubscriptionsPage` needed no change: it already grouped by child and read
  `child.schoolName`. Its unclaimed-by-email fallback list still reads the subscription's
  own `childName` on purpose — those subscriptions have no child to resolve from.

**Deliberately NOT done — read this before assuming the copies are gone.** The
subscription-level copies are still written, now as a mirror of the canonical record
rather than an independent per-subscription edit. They have to be, because
`functions/src/kidclub` still reads them:
- `billing.ts` reads `sub.childName` (line-item titles) and `sub.schoolName`.
- `reconciliation.ts` reads `item.sub.schoolName`.
- `discountRecalc.ts` reads `x.schoolName` to resolve the `auto_school` rule — which is
  what drives the **20% Colégio Bissaya Barreto transport discount**. That rule is
  untouched, as instructed.
- `notifications.ts` sends approval/rejection emails to `sub.contactEmail`.

`billing.ts` and `reconciliation.ts` were left alone on purpose: `agent/flat-gross-reconciliation`
owns them. **That side is now done and has reported back (2026-09-22):**
- `billing.ts` reads `schoolName` from `children/{childId}` — `fetchChildrenBirthDates`
  became `fetchChildRecords` and returns it from the same query, so no extra reads.
  104 tests green, typecheck clean.
- **Zero fee movement, measured.** Across all 21 active transport subscriptions, none
  change their 20% Bissaya Barreto match when `schoolName` comes from the child record
  instead of the subscription. The two address-valued ones (Maria Vicente, Camila Felix)
  match the rule under neither source, and neither do their child records. So the
  "money change falling out of a cosmetic edit" warning below is real in principle but
  empirically nil today — the mirror rewrite on admin save is safe. The warning in
  `ChildDetailsForm` stays anyway, since it is about what the field *can* do, not about
  today's data.
- **Sequencing constraint from that side:** 4 active transport subs still have no
  `childId`, so they cannot resolve from a child record at all. `billing.ts` keeps the
  subscription copy as a fallback for exactly those, to be removed once the Phase 0
  `childId` backfill lands. None of the 4 match the rule either way.

**Still blocking deletion of the mirror, and owned by nobody:**
- `discountRecalc.ts:148,180` — `x.schoolName`. **This is the real one.** Neither branch
  touches it; the mirror cannot be dropped until it moves to the child record too. Needs
  doing deliberately, by someone, and it is not in anyone's current scope.
- `billing.ts` line-item titles (`sub.childName`) and `notifications.ts:139,169`
  (`contactEmail`) — same story, lower stakes.

**Consequence worth stating plainly:** the UI is now consistent, but the *stored* drift
is untouched. Prod's 5 mismatched children still have two different stored `schoolName`
values, and `discountRecalc` still resolves the school discount from the subscription's
possibly-stale one. Editing a subscription in the admin page rewrites its mirror from the
child's value — which for a sub whose stored value is a street address may legitimately
change whether the 20% discount matches, and therefore the fee. That is a correction, not
a bug, but it is a fee-changing side effect of an otherwise cosmetic-looking edit, so
don't be surprised by it.

**Second commit (`ec97f46`) — the admin page restructure.** The read-side fix above stopped
the *display* diverging, but the admin page still showed and separately edited the same
child's details once per subscription, which is what let them diverge in the first place.
So the list is now **family → child → subscriptions**:
- Family row has a contact editor (`FamilyContactForm`) writing
  `families/{id}.primaryContact` — guardian name/email/phone, once per family.
- New child row groups that child's subscriptions under one header (name, school · year)
  with a details editor (`ChildDetailsForm`) writing `children/{childId}` — name, date of
  birth, school, school year, home address, once per child.
- `EditForm` lost the entire `EnrollmentDetailsForm` block and all its child/family
  writes. It now covers only schedule, week pattern, discounts, fee and the internal note.
- Subscription cards no longer repeat the child's name or school; they lead with the
  service type.

Both new forms write the canonical record and then mirror `childName`/`schoolName`/
`schoolYear`/contact onto **every** affected subscription in one pass. That is what
actually converges the stored drift, rather than only hiding it: editing one child fixes
both of their documents. `ChildDetailsForm` shows a warning when the school field changes,
because the fee can move with it.

**Tested on dev and passed (2026-09-22).** PR #31 → `staging`, both `kidclub-dev` deploys
green, clicked through by Renato against the prod data copy (which still carries the
drifted `schoolName` values, so the fix was exercised on the real shape of the bug). Build
passes; `tsc --noEmit` is at 13 errors vs the 16 on `origin/staging` — zero new, three
pre-existing ones resolved (two in `SubscriptionsAdminPage`, one `zod` resolution fixed by
`pnpm install`). Merged to `staging`.

**One deliberate behaviour worth revisiting if it proves noisy:** saving a child's details
sets `clientReviewPending` on *every* subscription that child holds, not just one — so the
parent is asked to confirm once per subscription. That is intentional (the change really
does affect all of them) but it is more nagging than the old per-subscription edit.
Renato saw it during testing and did not object; flagging it as a tuning knob, not a bug.

### Prod data pass — still the other open thread
Renato has a plan for it and wants it started in a **fresh session**, as a read-only
"Looking" task, not a build task. See Next step #1.

Sections below this line are history from earlier in the week, kept for the *why*.

### Dev/prod external-system isolation (2026-09-21) — stopgap fix, real fix still needed
Checked whether `kidclub-dev` can actually reach real external systems, prompted by all the
IAM work this week. Found: **`kidclub-dev`'s Vendus and EasyPay secrets hold the exact same
live credentials as prod** (byte-identical, confirmed by comparing — never printed the actual
values). `EASYPAY_SANDBOX` exists as a code path in `easypay.ts` but is never set anywhere in
the repo, so it always falls through to the live EasyPay API regardless of environment.
`vendus.ts` has no sandbox/test-mode branching at all. This directly contradicts CLAUDE.md's
sandbox-first-billing rule and meant any billing/payment/email action triggered from dev hit
the real Vendus account, real EasyPay account, and real Gmail send-as identity.

**Renato's call: block it hard for now, even if it breaks dev functionality**, rather than
wait for real sandbox credentials. Added `functions/src/externalGuard.ts` —
`assertExternalCallsAllowed(system)` throws immediately unless
`GCLOUD_PROJECT === "rainbow-prod-2454b"`. Wired into the three actual external-call choke
points (confirmed these are the only files touching vendus.pt/easypay.pt or sending real
email): `vendus.ts`'s `request()`, `easypay.ts`'s `post()`, `SendEmailFromOutbox.ts` (start
of the try block, before the existing Firestore-based kill switch even runs). Any code path
that hits Vendus, EasyPay, or Gmail-send from `kidclub-dev` now throws immediately instead of
making a real external call — matching billing/discount/camp/enrollment flows that depend on
these will error out in dev until this is properly fixed.

**Not done — real fix, tracked as follow-up**: get actual Vendus and EasyPay sandbox
credentials, store them in `kidclub-dev`'s own copies of these secrets (currently just
mirrors prod's), and set `EASYPAY_SANDBOX=true` for dev's function deploy. Once that's done,
this guard can be relaxed to allow dev through to the real sandbox endpoints instead of
blocking outright.

### 1. Billing double-discount bug — FIXED, deployed to prod, partially backfilled
Investigated "igbpinto@gmail.com's billing looks wrong". Root cause: `computeLineItems()` in
`functions/src/kidclub/billing.ts` read `sub.originalFee ?? sub.monthlyFee` as the *gross*
transport fee, but `discountRecalc.ts` overwrites `monthlyFee` with the already-discounted
price once any discount fires, and subscriptions from the client self-enroll flow never get
`originalFee` set — so billing silently re-applied `appliedDiscounts` a second time. This
under-billed customers (never overcharged). 8 of 23 active transport subs were affected.

Fixed on branch `agent/billing-double-discount-fix` (PR #13, merged to `main`): gross is now
derived from schedule length × `flatRatePerTrip` × weeks-in-pattern, same formula
`discountRecalc.ts` already uses, instead of trusting a field that can silently already be net.
**Deployed to prod** (`onStudyroomBillingSync`, `onTransportBillingSync`,
`backfillBillingSchedules`, `setBillingLineItemExcludedDays` — the 4 functions that actually
use the fixed logic). Verified live: Carolina Almeida's October billing line item now shows
the correct **€168** (was €117.60).

**Still under-billed, not yet backfilled**: José Eduardo (Miguel Melo) and Diogo+Bernardo Mogo
(Sandra Abreu) — only Carolina Almeida's family has actually been recomputed so far (via a
verification touch). Either trigger a no-op write on those subscriptions or run
`backfillBillingSchedules` (recomputes everyone, not just these — confirm on dev first, and
see the open question below on running it against prod).

Study room subs are NOT currently affected by this exact bug (0 of 14 missing `basePrice`),
but `discountRecalc.ts`'s study-side gross calc (`x.basePrice ?? x.monthlyPrice`) has the same
latent shape — not fixed, no live instance found, flagging only.

### 2. Discount *model* itself — confirmed wrong, NOT yet implemented
Separately from the bug above: Renato confirmed the discount model that's actually live (flat
% off the whole gross once a threshold is met — e.g. multi-trip discount applies to ALL trips
that day, sibling discount applies to a sibling's ENTIRE fee) is **not** the intended design.
Intended model is **marginal/per-unit**:
- Multi-trip: within a day, the first (chronologically earliest) trip is full price; every
  trip after it that same day gets the multi-trip discount.
- Sibling: order children family-wide by earliest subscription/enrollment date; the
  first-enrolled child's subscriptions stay full price; every subsequent child's subscriptions
  get the sibling discount.
- School discount (and flat manual discounts like "Aluno do ano anterior") still apply last,
  as a flat % on the resulting sum — no natural per-unit basis for those.

Comparison table run against 5 real prod subscriptions showed real, not-cosmetic differences
(e.g. Carolina Almeida: €168 flat vs **€182.40** marginal; José Eduardo: €151.20 vs
**€165.12**; Diogo Mogo loses his sibling discount entirely once his sibling-enrollment-order
is accounted for, since he was enrolled before his brother). **This needs its own implementation
pass** — touches `discountRecalc.ts`, `billing.ts`, and the `AppliedDiscount` display model
(admin discount badges, client "was €X now €Y" comparisons currently assume one flat % per
discount, which doesn't hold once multi-trip/sibling are marginal). Not started. See Backlog
section below.

### 3. Financial Summary — decoupled from Route Planner, deployed to dev only
`FinancialSummaryPage.tsx` was silently showing driver/electricity cost as €0 because it
derived them from the latest saved snapshot in `transportRoutes`, which was **empty in prod**
(nobody had ever run/saved a route plan) — meaning the page's "profit" figure was fake. Real
driver wage is **€1,400/month**; plugging that in flips prod from an apparent +€1,271.60/month
"profit" to roughly **−€440/month** loss once corrected for other data-quality issues found
along the way (an orphaned, never-actually-billed subscription for Leonardo Marques inflating
revenue by €240/mo, and 3 subs with stale `monthlyFee` fields inflating it by €72/mo more).

Refactored (branch `agent/financial-costs-decouple`, currently mid-merge-conflict-resolution
with `main` — see Next step #1):
- Removed the `transportRoutes`-snapshot dependency and the override/fallback chain entirely.
- Added `driverMonthlyCost` / `electricityMonthlyCost` as direct fields on
  `TransportationConfig` (alongside existing `vanMonthlyCost`), with a new **"Custos Fixos"**
  panel on the page itself — Van/Motorista/Eletricidade/Professora/Renda all inline-editable,
  saving straight to `config/transportation`/`config/studyCenter`.
- `TransportPlannerPage.tsx` is untouched — it keeps planning routes and saving its own
  `transportRoutes` version snapshots; Financial Summary just no longer reads them.
- Fixed one cosmetic bug post-deploy: the "Custos Fixos" KPI subtitle said "van + motorista +
  professora + renda", missing "eletricidade" even though it was already correctly included
  in the total — fixed and redeployed.

Typecheck + build both pass. **Deployed to dev only** (`kidclub-dev-arcoiris.web.app`), smoke-
tested manually by Renato (entered €1400/€300 into the new panel, numbers computed correctly:
€3787 revenue − €3750 costs = +€37, 1% margin — dev's own subscription data, not prod's).
**Not merged to main / not deployed to prod yet.**

### 4. Prod → dev data sync — done
At Renato's request, did a full (non-anonymized) copy of KidClub's real data from
`rainbow-prod-2454b` into `kidclub-dev`, to give dev realistic subscription/family data for
testing (e.g. the Financial Summary work above). Method: `gcloud firestore export` (scoped to
`billing, children, config, eventModifications, families, financialEvents, invoices, settings,
studyroom, subscriptionVersions, transportationSubscriptions, users` — deliberately excluding
`emailOutbox`/`emailCampaigns` so nothing risks re-queuing real emails) → copied the export
between each project's own `*-exports` GCS bucket → `gcloud firestore import` into
`kidclub-dev`. Verified Inês Pinto's family record landed correctly. Temporary export files
deleted from both buckets afterward.

**Side effect (expected, flagged beforehand):** the import overwrote dev's `config/transportation`
doc wholesale, clearing the `driverMonthlyCost: 1400` / `electricityMonthlyCost: 300` Renato had
just entered for testing (prod's doc doesn't have those fields set) — needs re-entering in dev
if still wanted there (see Next step #4).

**Caveat:** Firebase Auth UIDs are per-project — copied `users/{uid}` docs and every
subscription's `userId` field still reference prod UIDs, which don't correspond to real dev
Auth accounts. Fine for admin-side testing (Financial Summary, billing admin), but per-family
client-login testing against this data won't work without also creating matching dev Auth
accounts.

### 5. CI/CD pipeline — rebuilt, now fully live (separate, now-closed thread of work)
Rebuilt the whole deploy pipeline this week (see root `CLAUDE.md`'s "Branch → environment
pipeline" for the full model). Now **fully merged and operational**, not in-progress:
- PR into `staging` → auto-deploys app/rules/indexes/functions/terraform to `kidclub-dev`.
- PR into `main` → auto-deploys app/rules/indexes/functions to prod immediately (before
  merge) — **`terraform apply` stays disabled for prod specifically**, see below.
- Merge to `main` → re-deploys + `sync-staging` fast-forwards `staging` to match.
- **GitHub branch protection is now configured on `main`**: the `deploy` check must pass
  before merge is even clickable. This was the missing piece that made the whole thing
  trustworthy — closed out this session.

Getting the first real prod deploy green took a long chain of IAM fixes, all against prod's
CI identity `github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com` (a
completely different identity from dev's `gmail-sender-kidclub-dev`, which is why none of
dev's earlier fixes carried over automatically). It now has, granted by hand and documented
in `infra/gcp/terraform/iam.tf`/`secrets.tf`/`billing-cutoff.tf` (not yet applied via
Terraform, since terraform apply is off for prod):
`datastore.indexAdmin`, `secretmanager.secretAccessor` + `secretmanager.viewer` (on all 7
secrets — accessor alone isn't enough, viewer is what `firebase deploy`'s validation step
actually needs), `serviceusage.serviceUsageAdmin`, `iam.serviceAccountUser` (project-wide,
for functions' actAs), `cloudscheduler.admin`, `pubsub.editor`.

**`billingCutoff` no longer deploys to prod at all** — it's the "combined dev+prod billing
circuit breaker" singleton agent, and GCP's `iam.disableCrossProjectServiceAccountUsage` org
policy (confirmed enforced on `rainbow-prod-2454b`) categorically blocks prod's CI identity
from acting as its dev-project service account, no IAM grant can override that. Traced
further and found the prod copy would've been permanently untriggered anyway (its Pub/Sub
topic and the budget that publishes to it only exist in dev's Terraform state) — so rather
than build a redundant prod-native agent, `functions/src/billingCutoff.ts`'s export is now
conditional on `GCLOUD_PROJECT === "kidclub-dev"`.

**Prod's Terraform state is still essentially empty** (81 resources pending creation, real
infra was never imported — found via `terraform plan -var-file=env/prod.tfvars`) — `apply`
stays off for prod (`run_terraform: false` in `deploy-prod.yml`) until that's deliberately
reconciled as its own task. Not urgent; app/rules/indexes/functions/hosting all deploy fine
without it.

### 6. Study-room exclusion calendar — two real bugs found via a live prod case, both fixed
Renato reported Susete Luis's billing looked wrong: the "Dias sem serviço" admin calendar
showed 3 marked study-room days but the billing row's pills showed 7, and the 4 extra ones
couldn't be unmarked. Two distinct bugs, found by reading actual prod data
(`_apps/arcoiris/billing/A7OXOljX1W9xrEn5mhP8_2026-09`, read-only via `gcloud` access token
against the Firestore REST API):

- **Deduction math bug** (`computeExclusionDeduction()` in `functions/src/kidclub/billing.ts`):
  the `"study"` branch deducted for every entry in `excludedDates` with no check that the date
  actually fell on a real schedule day — `"transport"` right below it already did this
  correctly. A stale/bogus date could silently discount a day the child was never billed for.
  Fixed to mirror the transport branch (checks `weekdayOfIsoDate(entry)` against `sub.days`).
  Same schedule-day check also added to `setBillingLineItemExcludedDays` as a second line of
  defense on save.
- **UI bug** (`ServiceCalendar` in `BillingAdminPage.tsx`): the calendar only renders a
  clickable cell for actual schedule days, so once a non-schedule-day entry exists in
  `excludedDates` there was literally no control to remove it — clicking "Guardar" always
  resent the untouched orphan. Fixed by listing any orphaned entries as removable chips below
  the calendar (same styling as the pills already shown elsewhere on the row).
- **Root cause of the orphaned entries, found investigating further**: `toIsoDate()` in
  `BillingAdminPage.tsx` built the ISO date string via `.toISOString()`, which converts to
  UTC. Every calendar cell's `Date` is constructed from local year/month/day, so in any
  timezone ahead of UTC (Portugal is UTC+1/WEST right now) that conversion silently rolls the
  date back by one day before saving — **every click on this calendar was saving the day
  before the one actually clicked.** This is the real, still-live source of the orphaned
  dates (not a stale schedule-change carry-forward, which was the original working theory).
  Fixed by computing the ISO string from local date components instead of `toISOString()`.

Shipped as **`hotfix/exclusion-calendar-timezone`** (PR opened directly against `main` per the
new hotfix path — deploys to prod immediately on PR open, ahead of merge) since it was active
data corruption; checks/deploy were running as of this note. The deduction-math + orphan-chip
fix is on `agent/study-exclusion-validation`, merged with current `main` here, not yet opened
against `staging`.

**Both fixed and confirmed — `hotfix/exclusion-calendar-timezone` merged to `main` and live in
prod** (deploy went green on PR open, merged after). `agent/study-exclusion-validation`
(deduction-math + orphan-chip fix) still needs its PR opened against `staging` — not urgent,
see Next step.

**Verifying the timezone fix in prod surfaced a third, unrelated bug** (see backlog item below
for the real gap this points at): re-marking Susete Luis's days in the live (fixed) calendar
produced a UNION of the old corrupted dates (which had no UI control to remove, since that fix
wasn't deployed yet) plus the new correct ones — 8 study entries, 14 transport entries — not a
clean replace. Investigating the resulting €0 transport deduction (should have been non-zero
for the real dates in there) found that Beatriz Apóstolo's transport subscription
(`transportationSubscriptions/7sYsxBADSPlFOpvlKqTO`) had a **pending cancellation request**
from the parent (`cancelRequested: true`, `feeReviewRequired: true`, submitted 2026-09-18,
never actioned by an admin) that had wiped `schedule: []` on the live subscription doc — while
September's billing record still carried the old Wed/Fri schedule in its own cached
`scheduleDays`/`tripsByDay`. `computeExclusionDeduction` reads the *live* subscription's
schedule, so with it empty, every excluded transport date deducted €0 regardless of validity.

At Renato's explicit instruction ("we haven't addressed what happens to billing when a
subscription changes mid-cycle — treat this one as if it's active and will continue to be,
fix the general problem separately"): restored the subscription to its pre-cancellation state
using `subscriptionVersions` history (which had the exact prior `schedule` — Wed/Fri, 14:00,
Escola Quinta das Flores → Kid Club) — `schedule` restored, `cancelRequested`/
`adminReviewPending`/`feeReviewRequired`/`cancelledAt` cleared, `lastClientAction` reset to
`"confirmed"`, `status` left `"active"` (was never actually changed). Confirmed the *study*
subscription (`studyroom/GJ7JYFe6KPSZAQofIsCM`) was untouched by the same request — only
transport was affected.

With the subscription restored, hand-corrected Susete Luis's Sept 2026 billing record with the
actually-intended dates (4 study absences, 7 transport absences — both at €6/unit): study
€48→€24, transport €48→€6, total €90. **This got overwritten twice more** by
`onTransportBillingSync` firing (with execution delay) off the subscription-restore write and
recomputing the record from whatever `excludedDates` happened to be present at that moment —
see the audit note below for the general risk this points at. Took six prod writes total
across the full saga (€114→€138→€156→€132(union)→€90→reverted to €132 by the trigger
race→**€90 again, confirmed stable this time**) before it actually stuck — worth Renato
knowing this one record's edit history is not "clean" if it's ever audited, though the final
state is correct and verified (`scheduleDays`/`tripsByDay` also confirmed intact). Several of
these writes required Renato to run the `curl` command himself — the auto-mode permission
classifier started blocking repeated prod-write `curl` calls from this session after several
in a row ("Modify Shared Resources" / "Blocked by classifier"), which is a harness-level gate,
not something an in-chat "yes go ahead" satisfies.

**Status: closed.** Susete's record is correct and stable. The deduction-math + orphan-chip
fix (`agent/study-exclusion-validation`) went through `staging` → `main` cleanly and is live in
prod. See the audit note under the "billing records don't react to subscription changes"
backlog item above for what turned up scanning the rest of the pending records — one real
still-open under-billing (Mafalda Raposo Duarte), left for the new architecture effort rather
than another one-off patch.

## Last completed
- **prodata reconciliation (2026-09-23)**: compared the team's manually-kept
  `prodata/studyroom.pdf` (week 21-25 Sep 2026 timetable) and `prodata/transport.xlsx`
  against `kidclub-dev`. Root cause of most drift: `WeekSchedulePicker` only offered a
  30-minute grid, so real route times (07:20, 15:40, 17:15, 18:15) were forced onto rounded
  half-hours — 16 of 19 children disagreed on time alone. Fixed the picker to quarter-hour
  granularity (`agent/quarter-hour-slots`, commit b0cd52a, **not yet pushed or PR'd**) and
  normalised 73 time entries in dev (72 transport `pickupTime` + Laura Baptista's study-room
  Monday). Comparison scripts are in this session's scratchpad, not the repo.

**2026-09-22 session (this checkpoint):**
- **PR #28 merged to `staging`** — the full event-sourced billing rewrite, plus the 8 fixes
  from the dev E2E pass. 50 unit tests passing.
- **PR #29 merged to `staging`** — two CI fixes. (a) prod now only deploys from a PR whose
  *head* is `staging`; `branches: [main]` filters the PR's **base**, not its head, so before
  this a stray `agent/*` → `main` PR (opened by accident via GitHub's "Compare & pull
  request" banner, which defaults the base to the repo default branch) turned every push to
  that branch into a live prod deploy — it happened three times in one session. (b) a
  `concurrency` group per environment, because two deploys to the same project raced on the
  terraform state lock. Note #29's own first deploy failed on exactly that lock — the fix
  isn't active until it's merged.
- **PR #19 merged to `staging`** — `externalGuard.ts` blocks live Vendus/EasyPay/Gmail from
  `kidclub-dev`. Blunt stopgap, see Next step #5.
- **PR #20 closed unmerged** — the financialEvents model. Written against the pre-rewrite
  `billing.ts`: still carries `computeExclusionDeduction`, `applyDiscounts` and
  `transportGrossAmount` (all deleted by #28), and its `emitEffectiveEventsForBilling` is
  anchored on the removed `setBillingLineItemExcludedDays`. A rebase resurrects the old
  discount pipeline rather than resolving. Rebuild against the new model, don't rebase.
- **Full repo cleanup** — 22 worktrees → 0, all stale branches cleared, 2 invisible orphan
  directories deleted. See CURRENT STATE.
- Carried over, still true: billing double-discount fix merged (PR #13), deployed to prod,
  verified for Carolina Almeida; José Eduardo + Mogo siblings never backfilled.
- Financial Summary refactor: deployed to dev only; its branch was cleared in the cleanup
  (commits remain on origin as `agent/financial-costs-decouple`).
- Prod → dev data sync: done, verified, temp export files cleaned up from both buckets.
- CI/CD pipeline: fully merged to `main`, branch protection configured, first real prod
  deploy went green.
- `agent/impersonation-billing-fix` (from the 2026-09-18 session) — confirmed merged into
  `main` (PR #11) a while back; the "prod ahead of main" risk from that session is resolved,
  no longer worth tracking.
- Study-room exclusion calendar: found + fixed both the deduction-math bug and the timezone
  off-by-one that was silently corrupting every saved exclusion date. Timezone fix shipped as
  a hotfix PR straight to `main` (checks running as of this note); the deduction-math + orphan
  cleanup UI fix is merged with current `main` on `agent/study-exclusion-validation`, PR not
  yet opened against `staging`.

## Next step

**Everything below the first item is downstream of a decision only Renato can make.**

1. **Decide how prod September is handled — THIS IS THE BLOCKER.**
   Opening `staging` → `main` deploys prod (pre-merge), and immediately after that the
   `📅 Gerar ocorrências` backfill has to run on prod, because without occurrences every
   line item computes as €0.00. But that backfill also makes the triggers recompute
   September billing for **real families** under the new pipeline (marginal multi-trip,
   marginal sibling, summed institutional %, 3+-absence uncapped credit). Amounts will
   move. The unanswered question is whether any September invoices already went out on
   prod under the old math — if so, stored amounts shift underneath documents families
   have already seen.
   Renato said (2026-09-22) he has a plan for the data and wants to start it in a **fresh
   session**. That session is the one that answers this.
   Suggested shape, not yet agreed: a **read-only** old-vs-new diff of prod September
   totals for a handful of real families *before* anything is deployed or backfilled.
   That fits the "Looking" container in root CLAUDE.md — no worktree, prod reads added to
   a gitignored `.claude/settings.local.json` for that session only and removed after.
   Note the earlier revenue simulation was run against **dev** data and does **not**
   answer this.

2. **Then**: open the `staging` → `main` promotion PR (~32 commits). This is also what
   finally moves prod off the stale `b415ef3` it's been pinned to since the accidental-
   deploy incident.

3. **Immediately after that deploy**: run `📅 Gerar ocorrências` on prod. Safe to re-run
   now (see bug 5 above) — it only fills gaps. Verify a couple of families' amounts by
   hand before trusting the batch.

4. **Land the `iam.tf` patch** saved at
   `scratchpad/prod-ci-index-admin-iam.patch` (session `4601ed1f`). 19 lines documenting
   the `roles/datastore.indexAdmin` grant made **by hand on prod on 2026-09-20** to unblock
   the first-ever `firestore:indexes` deploy. Prod Terraform doesn't know this grant
   exists; this patch is the only written record. It was rescued from an uncommitted
   worktree during cleanup — if the scratchpad is gone, it's gone.

5. **Real fix for dev's billing credentials.** PR #19 merged a *blunt stopgap*:
   `externalGuard.ts` throws unless `GCLOUD_PROJECT === "rainbow-prod-2454b"`. That means
   billing/camp/enrollment flows that call Vendus, EasyPay or Gmail now **error out in
   dev** by design. The real fix is still open: obtain actual Vendus + EasyPay sandbox
   credentials, put them in `kidclub-dev`'s own secrets (they currently mirror prod
   byte-for-byte), set `EASYPAY_SANDBOX=true` for dev, then relax the guard.

6. Lower priority, carried over and still true: re-enter `driverMonthlyCost: 1400` into
   dev's Custos Fixos panel (cleared by the prod→dev import); decide on the dead
   `invoices` collection behind "As minhas faturas"; prod Terraform state reconciliation;
   decide whether `deploy-finances.yml` joins the staging/main pipeline.

7. **Emulator-based integration tests for the triggers and callables** — designed and
   documented during the rewrite, never built. The 50 unit tests only cover the two *pure*
   modules (`reconciliation.ts`, `reservationEvents.ts`). Every bug in the dev test pass
   above lived in the Firestore-touching glue that has no tests at all. That is not a
   coincidence.

## Open questions for Renato
- **prodata reconciliation (2026-09-23) — RESOLVED except where noted.** Renato's calls:
  Afonso Santos / Bernardo Mogo / Diogo Mogo / Leonor Lago are all genuinely active — the
  Mogos and Leonor are absent from the route tabs because **another driver** covers them, so
  the sheet is incomplete there, not dev. Sofia Carvalho is **Wednesday + Thursday** for both
  services (dev was already correct; studyroom.pdf's Friday entry is simply wrong — do not
  trust that row). Laura Baptista uses transport as the tiebreaker. Test data deleted.
  Remaining originally-flagged conflicts, for the record:
  - **João Lopes** — RESOLVED 2026-09-23: he dropped out, dev is correct, the sheets are
    stale for him. Left `cancelled` in both collections. See "Anything risky in flight".
  - **Edson** — RESOLVED 2026-09-24: the red in studyroom.pdf carries no meaning we need to
    act on; Renato confirmed his subscription is correct as it stands. Study-room Monday is
    16:00 per the sheet, transport stays `cancelled`. Nothing further to do.
  - **Camila Felix** — RESOLVED: sheets won, now 2 days in both collections; transport
    €120 -> €48 and study €120 -> €48.
  - **José Eduardo** — transport sheet marks him *Quinzenal* (fortnightly); dev has
    `weekPattern: "all"` at full €151.20. Roughly halves his fee if the sheet is right.
  - **Maria Clara** — dev has 16:30 vs the PDF's 17:00, Wednesday missing, a duplicate
    cancelled doc, and both `childId` and `familyId` dangling.
  - **Afonso Santos** — active transport in dev (Tue+Wed 14:00) corroborated by nothing:
    on the roster but absent from the route tabs and the attendance list.
  - **Sheet gaps, dev likely right**: Bernardo Mogo, Diogo Mogo and Leonor Lago are active
    in dev and on both the roster and attendance list, but have no rows in any weekday route
    tab — 12 trips/week the team's sheet does not cover.
- **13 non-cancelled subscriptions in dev have an empty or dangling `childId`** (Afonso
  Santos, Camila Felix, Laura Baptista, Laura Mendes, Leonor Lago, Maria Clara and others).
  Breaks child linking and anything downstream of it, including sibling discounts.

- **Were any September 2026 invoices already issued on prod under the old billing math?**
  Everything in Next step #1 hinges on this.
- Do the old and new pipelines agree on real prod families, or does the new model change
  amounts materially? Unknown — only dev data has been measured.
- The financialEvents work (closed PR #20) is still *wanted*, just superseded. When should
  it be rebuilt against the new event-sourced model? Commits remain on
  `agent/financial-events-model` on origin for reference.
- Still open from earlier: is `roles/resourcemanager.projectIamAdmin` + `roles/billing.admin`
  on prod for dev's CI service account the long-term shape, or should it narrow to a custom
  role?

## Anything risky in flight
- **BUG (found 2026-09-23, affects prod): changing a study-room subscription's days does not
  reprice it.** `discountRecalc.ts` is asymmetric — transport recomputes gross from the
  schedule (`scheduleLen * flatRatePerTrip * activeWeeksInPattern`, line ~152) but study room
  takes the *stored* value (`const grossFee = x.basePrice ?? x.monthlyPrice ?? 0`, line ~185)
  and never derives it from `days.length`. Study-room base should be
  `config/studyCenter.monthlyPricePerWeekday` (24) x weekdays. So any admin or client edit
  that changes study-room days leaves the price at whatever the enrolment form first
  computed. Also note `basePrice` is **not** in `triggerFieldsChanged`, so correcting a base
  price by hand does not fire a recalc either — both fields must be written together.
  Surfaced by editing 3 subs in dev (Camila Felix was left at 5 days' price on 2 days =
  €72/mo overbilled; Laura Mendes and Maria Clara were €24/mo under). Fixed those 3 in dev by
  hand; **the code is still wrong and prod is unaudited** — any prod study-room sub whose days
  were ever edited is mispriced. Needs a real fix plus a prod audit of
  `basePrice == 24 * days.length`.
- **Stale fees are wider than the three children already tracked below.** Touching just 15
  subscriptions in dev during the 2026-09-23 reconciliation caused two silent corrections:
  José Miguel Duarte €115.20 → €100.80 (never given the 10% multi-trip discount he
  qualified for) and Vasco Moura €120 → €96 (20% school discount listed in
  `appliedDiscounts` but never applied to the fee). Both were pre-existing errors that only
  surfaced because `discountRecalc` re-ran on write. **Any active subscription not written
  recently may be carrying a wrong fee** — this needs a deliberate recalc sweep, not
  incidental discovery. Same class as the under-billing item below, but not limited to those
  three children, and confirmed in dev only — prod not yet checked.
- ~~PR #36 conflicts with this file.~~ RESOLVED 2026-09-24: `agent/status-consolidate`
  carries #36's consolidation **plus** the reconciliation notes, merged by hand. Merge that
  branch and close #36; do not merge both.
- **dev holds a copy of prod's data (see "Prod -> dev data sync" below), so the 2026-09-23
  reconciliation IS the prod audit, done in dev on purpose.** The intended path is: fix it
  here, verify here, then move the corrected data to prod. That promotion has NOT happened
  and is the outstanding piece of work — see "Next step". It needs a real plan: the dev docs
  now differ from prod in schedules, prices, base prices and deletions, and prod may also
  have drifted on its own since the sync, so this is a reconciled-migration problem, not a
  blind copy.
- **dev was reconciled to the manual sheets on 2026-09-23; prod was not.** Applied to dev:
  73 time normalisations, 12 structural day/leg corrections, 3 study-room base-price repairs,
  and deletion of all 10 test/synthetic records (9 `TEST-*` docs + a junk `test` transport
  sub). dev and prod now deliberately differ until the same pass is replayed against prod as
  its own reviewed task. Fee movements in dev: Manuel Oliveira €102→€126 (2 missing
  Arco-Íris→home legs added), Camila Felix €120→€48 transport + €120→€48 study (5 days→2),
  Lourenço Bernardino €38.40→€19.20 (extra Monday leg removed), Laura Mendes study
  €86.40→€108, Maria Clara study €96→€120, plus the two stale-fee corrections noted above.
- ~~Both reconciliation branches awaiting review.~~ RESOLVED 2026-09-24: all five merged
  (#37 #38 #39 #40 #41; #36 closed as superseded). `staging` HEAD `5602c75`, deployed to
  dev, **no PRs open**. dev is clean and current. Verified at three levels rather than on a
  green check: the bundle carries the generated quarter-hour picker
  (`D2(13,19).filter(t=>t>="13:30")` with `[0,15,30,45]`), the eventService status fix
  (`"confirmed","active"`), and `toLowerCase`; and the deployed Cloud Function was tested
  behaviourally — a 1-day study-room sub went €24 → €48 on adding a day and back to €24 on
  removing it, record restored identically. Before the fix it would have stayed at €24.
  Worth remembering for next time: an open PR's preview deploy can land *after* a `staging`
  push on that shared project and overwrite it — check which ran last, not which merged last.
- **João Lopes (João Duarte Silva Lopes): CANCELLED, settled.** He appears in
  studyroom.pdf (Wed+Fri) and on the September attendance list, which briefly looked like a
  conflict — but Renato confirmed 2026-09-23 that he dropped out. The PDF simply predates his
  2026-09-22 withdrawal. Both subs were reverted to their exact pre-session state (status,
  cancelledAt, and days back to Wed+Fri 16:00). **Do not "fix" this again** from the sheets —
  the sheets are stale for him, not dev.
- ~~Three worktrees are live.~~ RESOLVED 2026-09-24: all removed, including the stale
  pre-existing `status-cleanup` one. Every branch was confirmed pushed and identical to
  origin first, so nothing was lost. `git worktree list` shows only the main checkout.

- **Open worktree `.claude/worktrees/subscription-personal-data`** (branch
  `agent/subscription-personal-data`, off `staging`) — one unpushed commit, no PR, not
  deployed. Remove it once the work lands or is abandoned. Note this breaks the
  "deliberately clean slate" the 2026-09-22 checkpoint describes, on purpose.
- **Deploy order with `agent/flat-gross-reconciliation` matters, and is settled:** this
  branch goes **first**, that one second. This branch touches no functions/rules/infra, so
  its `kidclub-dev` deploy syncs functions at staging's current state — which means
  deploying it *after* that branch would silently revert that branch's `billing.ts` on the
  shared dev project. (This is the known shared-`kidclub-dev` collision in the Backlog
  below, in its overwrite form rather than its delete-refusal form.) Deploying it first is
  neutral. Whichever merges to `staging` second should also expect a **STATUS.md
  conflict** — both branches rewrote overlapping sections of this file.
- **`discountRecalc.ts:148,180` still reads `sub.schoolName` and nobody owns it.** Until
  that moves to the child record, the subscription mirror has to keep being written.
- **Prod is running billing code ~32 commits behind `staging`.** Not broken — it's the old,
  working pipeline — but every fix from the dev test pass above (including the leg-collision
  bug that halves transport gross) is **absent from prod**. Prod has been pinned to
  `b415ef3` since the accidental-deploy incident.
- **The prod backfill will move real money numbers.** See Next step #1. Do not run it
  casually to "see what happens" — it recomputes every family.
- **`kidclub-dev` billing/email flows now throw by design** (PR #19). If a future session
  finds Vendus/EasyPay/Gmail failing on dev, that is the guard working, not a regression.
- **The 2026-09-20 prod IAM grant exists only as a scratchpad patch** (Next step #4).
- **Two orphaned worktree directories were found and deleted** on 2026-09-22 — one dating to
  **July 31** — both holding `.env.production`. `git worktree list` could not see them
  (their `.git` admin dirs were gone), so `git worktree prune` would never have cleared
  them. If worktrees get abandoned again, that is the failure mode: invisible to git,
  holding prod config. This is the second time; root CLAUDE.md already warns about it.
- Carried over, unverified since: **José Eduardo and the two Mogo siblings may still be
  under-billed in prod** from the older double-discount bug — code fix is live, their
  records were never recomputed. Worth re-checking as part of the data pass, but note the
  new pipeline changes how those amounts are derived anyway.
- Carried over: **the old timezone bug likely corrupted other families' exclusion dates**
  before it was fixed. `excludedDates` no longer exists in the new model, so this is now a
  *historical data* question, not a live one — relevant to the data pass.

## Backlog — bigger features surfaced but not started
- **Billing page refactor — stop clients paying the wrong period** (surfaced 2026-09-24,
  confirmed by Renato as a real incident, not a data glitch): a parent can pay *any* period
  offered to them, including one eleven months out. Mary Pratas (Manuel Oliveira's family)
  paid **2027-08 instead of 2026-09** — €142.80, `paidAt` 2026-09-18, Vendus invoice
  `FR 01P2026/195`. She clicked the last row instead of the first.

  Why this is worse than a single mis-click: the record went `paid` → `invoiced`, which is
  terminal, and `isRecomputable()` only recomputes `pending` or auto-cancelled records — so
  the wrong-period payment is **frozen against every future recompute** and will never
  self-correct. Meanwhile her actual September invoice is still `pending` and will keep being
  rewritten. A real Vendus fiscal document also exists against the wrong period, so unwinding
  it is a credit-note problem, not a Firestore edit.

  Scope, roughly: the payment UI should default to (and probably restrict to) the oldest
  unpaid period rather than presenting all twelve as equal choices; out-of-order payment
  should be either blocked or an explicit, confirmed action. Needs a decision on what to do
  with the one already-wrong record before prod — it is NOT fixable by re-running any
  migration script. Pairs naturally with the "billing record already generated for the current
  period" design question above, since both are about which billing rows may still move.
- **`kidclub-dev` is a shared Firebase project that every branch's `staging` PR deploys a full
  functions sync to** (surfaced 2026-09-21, Renato wants this picked up next). Any branch with
  in-progress functions work that gets deployed to dev directly (not yet merged to `staging`)
  leaves those functions live on the shared project. The next unrelated branch's CI deploy
  then fails, because `firebase deploy` refuses non-interactively to delete a remote function
  missing from the deploying branch's own source — exactly what happened with
  `onBillingPaidEffectiveEvents` from the paused `agent/financial-events-model` branch
  blocking `agent/study-exclusion-validation`'s unrelated deploy. This will keep recurring
  with several branches/worktrees active in parallel (see `git worktree list` — a dozen-plus
  open at once is normal here). Needs a real fix, not a repeated one-off
  `functions:delete` — options roughly: (a) give each in-progress branch its own preview
  Firebase project/channel instead of sharing `kidclub-dev` wholesale, (b) scope CI's deploy
  to `--only functions:<changed-ones>` instead of a full sync so it never considers deleting
  functions it doesn't know about, (c) some convention/discipline around manually-deployed
  test functions being cleaned up before pausing a branch. Not scoped further — flagging as
  the next thing to design, per Renato's explicit instruction.
- **Billing records don't react to a subscription changing mid-cycle** (surfaced 2026-09-21,
  Renato's explicit instruction: "that reveals a problem we haven't addressed — update the
  notes so we can deal with it"). A billing record (`billing/{familyId}_{yyyy-mm}`) is a
  snapshot generated once (`computeLineItems()`) and then edited in place (exclusions,
  status). Nothing re-syncs it when the underlying subscription changes afterward — schedule
  edit, cancellation, price change, discount change. Concretely hit this with Beatriz
  Apóstolo's transport: a parent-submitted cancellation request wiped the live subscription's
  `schedule` to `[]` pending admin review, while September's already-generated billing record
  kept its own cached (now stale) `scheduleDays`/`tripsByDay` — so editing exclusions on that
  record recomputed deductions against a schedule that no longer existed, silently zeroing
  them out. Worked around this one instance by reverting the subscription (see section 6), but
  the general question is unanswered: **what should happen to a billing record already
  generated for the current period when its subscription is edited, cancelled, or has a
  pending change requiring review?** Needs a real design decision — options roughly are (a)
  freeze the record's own cached schedule/price as the source of truth for that period no
  matter what the live subscription later does (probably right for a period already in
  progress), (b) recompute in place when the subscription changes, prorating for the change
  date, or (c) block subscription edits/cancellations from taking effect until the current
  period's billing record is closed/paid. Needs to account for both admin-approved changes and
  client self-service requests (like this cancellation) that sit in a pending-review state.
  Not scoped further than this — flagging as the next thing to design, not started.

  **Audit of pending billing records, done 2026-09-21** (per Renato: a dedicated agent is
  being spun up to design the proper architecture for this whole area — subscription-change
  sync AND the double-discount backfill below — this audit's findings are input for that
  effort, not yet acted on individually):
  - Scanned all 164 pending `billing/*` records for `excludedDates` entries that don't land on
    a real schedule weekday (the symptom of both the timezone-shift bug and the plain
    deduction-math bug, both now fixed in code but not retroactively applied to
    already-computed amounts).
  - **Susete Luis / Beatriz Apóstolo** (`A7OXOljX1W9xrEn5mhP8_2026-09`) — the case that started
    this whole investigation (see section 6). Fully corrected by hand: total **€90** (study
    €24/4 exclusions, transport €6/7 exclusions), subscription's `schedule`/`scheduleDays`/
    `tripsByDay` all restored. Took four manual prod writes to land correctly — two of them got
    silently overwritten by `onTransportBillingSync` firing (with execution delay) off an
    unrelated subscription write and recomputing using whatever `excludedDates` happened to be
    in the record at that moment. **Real finding, separate from the architecture question**:
    `onTransportBillingSync`/`onStudyroomBillingSync` fire on *every* write to a subscription
    doc and immediately recompute that family's whole billing schedule — there is no debounce
    and no ordering guarantee relative to a concurrent manual/admin edit of the same billing
    record. Worth the new agent considering as part of the redesign, not just the "subscription
    changed" case.
  - **Mafalda Raposo Duarte** (`JlqSRknVxyzaJfYP2WiM_2026-09`) — **still under-billed, not yet
    corrected**. Study-room line item: schedule is Tue/Wed/Fri, 5 dates excluded but only 2
    (both Tuesday) are real; stored amount (€35.70) reflects the old pre-fix math (all 5
    counted). Correct amount is **€51** (verified against her transport line item on the same
    record, whose math was already correct and computes exactly that for the same discount
    rate). Under-charged by €15.30 on this one line item. Needs the same kind of backfill as
    the double-discount bug below — good candidate to fix via whatever `backfillBillingSchedules`
    run addresses that one, rather than another one-off hand patch.
  - Diogo Mogo, Bernardo Mogo, José Eduardo (all transport, `nnBmdqT7MEL3tNeTQqbM_2026-09` /
    `zsKcaaic4P5nhDP6Z2Ms_2026-09`) — each has one stray `2026-09-06` (Sunday) in
    `excludedDates` alongside a legitimate ~7-day absence block on real schedule days.
    Confirmed harmless: transport's deduction math already correctly ignores non-schedule-day
    entries, so it's a €0-impact data oddity, not a bug instance. No action needed.
  - **Unrelated oddity spotted in passing, flagging only**: José Eduardo's line item title
    lists his schedule days twice (`"2ª, 3ª, 4ª, 5ª, 6ª, 3ª, 4ª, 5ª, 6ª"`) and his gross (€216)
    looks too high for a 5-day/week schedule at the standard rate — possibly a duplicate
    schedule-entry bug on his subscription doc. Not investigated further, not part of this
    audit's scope, just noted so it isn't lost.
- **Discount model rework** (surfaced 2026-09-20): live discount logic is flat-%-off-gross;
  confirmed intended design is marginal/per-unit (multi-trip: only the 2nd+ trip in a day is
  discounted; sibling: only the 2nd+ enrolled child is discounted; school/manual discounts
  stay flat on the resulting sum). Touches `discountRecalc.ts`, `billing.ts`, and the
  `AppliedDiscount` display model across several admin/client pages. Needs its own scoping
  pass before implementation — see "Currently working on" #2 above for the full spec and
  worked examples.
- **Transport Route Planner rework** (surfaced 2026-09-20, no prior note found anywhere in
  this repo's docs or memory before now): `TransportPlannerPage.tsx` currently owns route
  planning AND used to be the only source of driver/electricity cost for the Financial
  Summary page (now decoupled, see above). The planner itself hasn't been touched — it's a
  large (2300+ line) page that still needs a proper look: `transportRoutes` was completely
  empty in prod (nobody had ever saved a route plan), which is how the driver-cost blind spot
  happened in the first place. Worth a dedicated pass to figure out why it's never been used,
  whether it should feed anything else now that Financial Summary doesn't depend on it, and
  whether its own cost-estimate model (`driverRatePerHour`, `consumptionPer100km`,
  `electricityPricePerKwh`) is still the right shape for actual route planning. Not scoped
  further than this — flagging as a known future feature, not a plan.
