# HANDOFF — Google Cloud reorganisation

**Started:** 2026-11-10, with Renato. **Read first:** root `CLAUDE.md` and `infra/CLAUDE.md` (the
current layout table).

## Why
NoisySource is the IT provider: it runs and pays for everything. Noisy Phocus is the company
behind KidClub. Until now every app (KidClub, FinHub, Domotics) shared two projects and one
Firestore database. The goal is one folder per company, with each company's apps in its own
projects and its own database.

## Decided (2026-11-10)
- **KidClub keeps `kidclub-dev` / `rainbow-prod-2454b`.** Project IDs can't be renamed, and
  moving KidClub would put parents' logins, EasyPay webhooks, kidclub.pt and Vendus at risk
  to get rid of an ID nobody sees. Display names are now KidClub Dev / KidClub Prod.
- **FinHub, Domotics and Tasks move to `noisysource-dev` / `noisysource-prod`.** Social will
  probably get its own project when built, so public sign-ups don't share a login pool with
  the private tools.
- **All billing goes through NoisySource Central Billing** (`01B2DE-83C5F5-B12BC9`).
- **Cross-company data goes through functions with read-only cross-project access.** Each
  company writes only to its own database. Browsers can't do this anyway (a Firebase login
  belongs to one project). FinHub reads KidClub billing; KidClub reads FinHub's
  `costSummary`.
- **Jarvis** (`noisysource-agent`) is Renato's NoisySource agent: Workspace APIs only, no
  billing, keyless. It runs on Renato's laptop for now by impersonating the SA.

## Done on 2026-11-10 (by gcloud, outside git)
- Folders **NoisySource** (`864094752425`) and **Noisy Phocus** (`939404799814`). Both KidClub
  projects moved into Noisy Phocus.
- `noisysource-dev` / `noisysource-prod` linked to Central Billing. They're empty.
- The projects had moved from "My Billing Account" (`012710-30B4D5-DCC57E`) to Central
  Billing that day, around 12:00–13:00 UTC. That left every budget watching nothing.
  Re-created by hand on Central: KidClub Prod €20 (50/90/100%) and KidClub Dev €10 (80%).
  The €50 cap (`budget.tf`) now covers the whole account and feeds the cutoff topic. CI's
  create got a 403, so it was created by hand and imported into the dev state (details in
  `budget.tf`). Budget id: `7b8bb0dc-7204-4c51-afce-f3005747a471`.
- **Found along the way:** `functions.tf` / `billing-cutoff.tf` let Terraform own each
  function's runtime settings, which `firebase deploy` also sets. Since the per-part dev
  deploys (2026-10-18), a Terraform-only PR no longer runs Functions afterwards. So PR #140's
  first run stripped the secrets off 20 dev functions, switched their service account, and
  raised max instances to 20. Fixed in the same PR (`ignore_changes` now includes
  `service_config`). Prod wasn't affected, because prod doesn't run Terraform. **Restored
  on 2026-11-10 at 17:26 UTC** with
  `FUNCTIONS_DEPLOY_UNCHANGED=true firebase deploy --only functions:<the 20> --project kidclub-dev`.
  A plain deploy doesn't fix this: Firebase skips functions whose code hasn't changed and
  doesn't notice their settings were overwritten. While fixing this, re-running PR #137's dev
  deploy (re-running one job of a reusable workflow re-runs all of it) also put #137's
  Firestore rules over #138's on dev. Those were restored at 17:24 from #138's
  `firestore.rules`.
- Dev CI SA `gmail-sender-kidclub-dev` granted `roles/billing.costsManager` on Central (by
  Renato). The `billing.admin` grant left Terraform (see the end of `iam.tf`).
- `noisysource-agent` ("Jarvis") created in the NoisySource folder, with no billing. It has the
  Gmail, Drive, Calendar, Sheets, Docs and IAM Credentials APIs, and SA
  `noisysource-agent@noisysource-agent.iam.gserviceaccount.com` (display name Jarvis,
  client ID `118081944723204748322`, no keys). Renato (`admin@noisysource.com`) has
  `roles/iam.serviceAccountTokenCreator` on it.

## Next steps, in order
1. **Check after merge:** run
   `gcloud billing budgets list --billing-account=01B2DE-83C5F5-B12BC9 --billing-project=kidclub-dev`.
   It should show three budgets, with the €50 one publishing to
   `projects/kidclub-dev/topics/billing-budget-cutoff-trigger`.
2. **Billing export for Central Billing.** This is console-only. Go to Billing → NoisySource
   Central Billing → Billing export → BigQuery → Standard usage cost, and pick project
   `rainbow-prod-2454b`, dataset `billing_export`, where the old export already lives. Then
   change `functions/src/getGcpCosts.ts`, which hardcodes the old account's table
   `gcp_billing_export_v1_012710_30B4D5_DCC57E`, to read that table (history up to
   2026-11-10) plus the new `gcp_billing_export_v1_01B2DE_83C5F5_B12BC9`. Until then,
   FinHub's Google cost screen stops at 2026-11-10.
3. **Jarvis Workspace access.** Waiting on Renato working out what the agent does. Set it up
   at admin.google.com → Security → API controls → Domain-wide delegation, using client ID
   `118081944723204748322` and only the scopes needed. **kidclub.pt is in the same
   Workspace**, so this grant lets the SA act as any user in both domains for those scopes.
   Keep the scopes minimal, and consider a dedicated mailbox (e.g. `agent@noisysource.com`).
   From the laptop: ADC (Renato) → impersonate the SA → IAM Credentials `signJwt` for the
   delegated token. That's the same keyless pattern `SendEmailFromOutbox` uses.
4. **Domotics → NoisySource projects.** It's the smallest move: private, and no prod deploy
   yet. It replaces the "Domotics in prod" checklist in root `CLAUDE.md`, so don't create
   `rainbow-prod-2454b-domotics`. It needs:
   - Firebase added to the `noisysource-*` projects, plus a Firestore database and a hosting
     site
   - `/functions` split into per-project codebases (KidClub vs NoisySource), with shared
     helpers staying shared
   - the Legrand/Netatmo/Tuya secrets and `domotics_config/*` docs copied over
   - a bridge Auth user in the new project, and the Pi's `GCLOUD_PROJECT` changed
   
   One bridge serves one project. Renato decides which one gets live data.
5. **FinHub → NoisySource projects**, together with FinHub v2 (branch
   `agent/finhub-v2-noisysource`). It needs:
   - the cross-project reads (a FinHub function SA with `roles/datastore.viewer` on the
     KidClub project, and the reverse for `costSummary`)
   - moving any real `finances_entities` data (STATUS said none existed as of 2026-10-12;
     check again)
   - updating the Cross-App Data Contracts in root `CLAUDE.md`
6. **Cleanup:**
   - remove the FinHub/Domotics sites, rules, functions and secrets from the KidClub projects
   - split CI and Terraform per project
   - optionally move the Terraform state bucket, WIF pool and billing cutoff into a
     NoisySource project
   - fix `.firebaserc`'s `default` (the dead `rainbow-78314`)
   - close "My Billing Account" and its three leftover budgets (console)
7. **Second KidClub facility.** This is a separate KidClub app track (`kidclub-feature`), not
   infrastructure. The proposal is a `clubId` in the data, inside the same project. Today
   `_apps/arcoiris` is hardcoded in `apps/noisyphocus/kidclub/src/lib/db.ts` and about 10
   files in `functions/src/kidclub`.

## Open questions for Renato
- **Second club:** data inside the KidClub project? Is it the same company (NIF, Vendus
  account, EasyPay)? Can one family have children in both clubs?
- **`virtual-hybrid-43xkp`:** billed to `01914B-C628E5-7B7AC1`, which
  `admin@noisysource.com` can't see, in a folder it can't read. It has Gemini Code Assist and
  Security Command Center APIs enabled. Keep it, move it to Central, or shut it down?
- **Domotics bridge:** which project gets the live data once Domotics moves.
- **Firestore region for `noisysource-*`:** proposed `europe-west3` single-region, the
  cheapest and the same as dev. KidClub prod uses multi-region `eur3`.

## Gotchas
- gcloud's active account is `admin@noisysource.com` and its default project is
  `noisysource-prod`. Billing and budget commands need `--billing-project=kidclub-dev` (or
  any billed project with the API enabled).
- Claude Code's auto mode blocks IAM grants and secret writes. Renato runs those himself.
