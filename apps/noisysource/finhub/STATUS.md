# STATUS — FinHub (Strata)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task.

**Last updated:** 2026-11-23 (step 1: Strata brought into the monorepo, dev only)

## What this is
FinHub's new and only UI: the **Strata Treasury** app Renato generated in Google AI Studio
(repo `noisysource/Finhub`, 2026-11-23), moved here. Decided 2026-11-23 (Renato): one app;
Strata's screens and features replace the old FinHub UI (`apps/noisysource/finances`), which
stays live in the KidClub projects only until this one works, then is removed. The v2 engine
(`packages/shared/finhub`, cent-exact matching and forecast) goes **behind** Strata's screens,
not beside them.

- App: `apps/noisysource/finhub` (React 19, Vite 8, Tailwind 4, its own config; not
  `vite.config.base.ts`).
- Data: Firestore `finhub_users/{uid}/...` in `noisysource-dev` (Strata's model, under a
  renamed root). Rules: the FinHub block at the end of `firebase/noisysource/firestore.rules`
  (Strata's own rules + `isFinhubUser()`: `admin@noisysource.com`, verified).
- Backend: one callable, `finhubApi` (`firebase/noisysource/functions/src/finhub/`). `routes.ts`
  is Strata's Express server route by route; `api.ts` checks the caller and dispatches;
  `usage.ts` counts every Gemini call (retries included) in `finhub_usage/{yyyy-mm-dd}` and
  refuses past `FINHUB_AI_DAILY_CAP` (default 400/day). Gemini runs on **Vertex AI as the
  functions' service account** (no API key), models from params (`gemini-2.5-flash`, fallback
  `gemini-2.5-flash-lite`, region `europe-west4`).
- The app calls the backend through `src/lib/api.ts` (`apiFetch`, fetch-shaped), so the
  views are Strata's unchanged.
- Site (dev): `https://noisysource-dev-finhub.web.app`. **Not in prod yet.**

## Before Renato can test on dev (his, once)
1. **IAM, by hand** (CI can't set IAM; until this is applied, the PR's Terraform job fails
   closed and nothing of FinHub deploys). From `infra/gcp/terraform/noisysource`, for **both**
   projects (a merge into `staging` applies Terraform to `noisysource-prod` too):
   ```bash
   terraform init -backend-config="prefix=noisysource-dev" -reconfigure
   terraform apply -var-file=env/dev.tfvars \
     -target='google_project_service.apis["aiplatform.googleapis.com"]' \
     -target='google_project_iam_member.functions_runtime["roles/aiplatform.user"]'
   terraform init -backend-config="prefix=noisysource-prod" -reconfigure
   terraform apply -var-file=env/prod.tfvars \
     -target='google_project_service.apis["aiplatform.googleapis.com"]' \
     -target='google_project_iam_member.functions_runtime["roles/aiplatform.user"]'
   ```
   Then re-run the PR's "Deploy to Dev" run (or push to the branch).
2. **Sign-in domain:** Firebase console → `noisysource-dev` → Authentication → Settings →
   Authorised domains → add `noisysource-dev-finhub.web.app` (the site exists after step 1's
   re-run).
3. **Gmail/Drive in the app** (optional for a first look; upload works without it): the app
   asks Google for `gmail.readonly` and `drive` at sign-in. In Google Cloud console →
   `noisysource-dev` → Google Auth Platform → Audience, add `admin@noisysource.com` as a test
   user if the app is External in testing mode.
4. Open the site, sign in as `admin@noisysource.com`, and in the first screen choose the
   **blank** start, not "Load Sample Portfolio" (that one fills it with a made-up company).

## Next steps (agreed order, 2026-11-23)
1. ✅ This PR: Strata in the monorepo on `noisysource-dev`, AI behind sign-in and a daily cap.
2. **Document reading** from the Noisy Source Drive `2026` folder (one subfolder per month,
   Jan–Sep, plus Tesla invoices): payslips, BPI statements, invoices → structured facts.
3. **Suggestions**: from the facts, the EC contract, people/salaries, the BPI loan, recurring
   expenses, each "por confirmar"; Renato confirms in Strata's screens; confirmed items drive
   the v2 engine (forecast, matching). Noisy Source first.
4. Personal (Renato & Marisa) and Noisy Phocus (KidClub billing, read-only cross-project).
5. Read-only FinHub tools for Atlas.

## Before prod (open)
- **Provider-side AI cap.** Today the cap is in code only. Gemini 2.x on Vertex AI uses
  Google's shared quota (no per-project daily limit to lower), so the provider-side breaker
  should be the billing cutoff: extend it (`infra/gcp/terraform/billing-cutoff.tf`, KidClub
  root) to also disable `aiplatform.googleapis.com` on the NoisySource projects. Root
  CLAUDE.md requires this before the API ships to prod.
- Prod hosting: `noisysource-prod-finhub` in `env/prod.tfvars`, its target in `.firebaserc`,
  `.env.nsprod`, and the app in `deploy-noisysource-prod.yml`.
- Marisa's access: add her address to `FINHUB_USERS` (`access.ts`) and `isFinhubUser()`.
- Drive scope: the app asks for full `drive` (Strata's "file invoice into Drive" needs to
  write); narrow it if filing moves server-side.

## Risky / in flight
- `finhubApi` also deploys to `noisysource-prod` when this merges (functions are one
  codebase). It refuses everyone but the owner and does nothing until called.
- This PR changes `pnpm-lock.yaml` peer entries for other packages (Tailwind 4 brings
  `lightningcss`/`jiti@2`), and root `package.json` and `.github/`, so its dev deploy is
  **everything** in both units (same code as `staging` for the other apps).
- The FinHub rules test (`pnpm test:rules:finhub`) was written but not run: the emulator
  couldn't be downloaded in the session that wrote it. Run it once locally.
