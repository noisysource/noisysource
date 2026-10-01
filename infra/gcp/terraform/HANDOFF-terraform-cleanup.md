# HANDOFF — Terraform / prod IAM cleanup

**Status:** not started. Written 2026-10-01 for the `infra-terraform` agent. No fixed date — pick up when
Renato has time. Read root `CLAUDE.md` first (pipeline, prod `terraform apply` is OFF).

## Context
Prod (`rainbow-prod-2454b`) Terraform state is mostly empty, so prod `apply` is disabled in CI
(`run_terraform: false` in `deploy-prod.yml`). Prod IAM grants are therefore done **by hand** and then
recorded in `iam.tf` as `prod_ci_*` resources (see the existing ones). Follow that pattern: write the
resource, and give Renato the exact one-off `gcloud` command to apply it. Do not enable prod apply.

## Tasks
1. **Prod CI can set invoker on new functions.** Every new callable fails the prod deploy at "Unable to set
   the invoker" (hit on 2026-10-01 for `claimFamilyByEmail`, `getInvoicePdf`, `resetStuckPayment`; fixed by
   hand with `allUsers` → `roles/run.invoker`). Add `prod_ci_run_admin` (`roles/run.admin` for
   `github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com`) to `iam.tf`, plus the command:
   `gcloud projects add-iam-policy-binding rainbow-prod-2454b --member=serviceAccount:github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com --role=roles/run.admin`
   Then remove "Deploy lessons #2" workaround notes from `apps/noisyphocus/kidclub/STATUS.md`.
   Check whether dev's CI SA has the same gap.
2. **Codify the Gmail sender grant.** Since #63, `sendEmailFromOutbox` signs as `GMAIL_SENDER_SA` with no key.
   Prod: `237627939595-compute@developer.gserviceaccount.com` has `roles/iam.serviceAccountTokenCreator` on
   `gmail-sender-prod` (granted by hand 2026-10-01). Dev: runtime is `gmail-sender-kidclub-dev` itself;
   it would need TokenCreator on itself (only matters if dev ever sends for real — externalGuard blocks it).
   Add a `google_service_account_iam_member` for this. Careful: dev CI runs `apply` on every staging PR,
   and SA-level IAM needs `iam.serviceAccounts.setIamPolicy`, which dev's CI SA may not have (see the
   comments at the top of `iam.tf` about roles/editor not covering setIamPolicy).
3. **Remove the dead SA secrets.** `SA_CLIENT_EMAIL`/`SA_PRIVATE_KEY` are no longer used (they held an old
   project's account, which is what broke email from 2026-08-01). Remove them from `secrets.tf` and from
   `functions.tf`'s `secret_environment_variables`. After that's merged and deployed, Renato deletes the two
   secrets in prod and dev, and the three old user-managed keys on `gmail-sender-prod`
   (`6e9c3df9…`, `d23edcc9…`, `a9b84999…`, all from Sept 2025). Confirm nothing else reads those secrets first
   (`grep -r SA_PRIVATE_KEY`).
4. **`.firebaserc`**: `default` is still `rainbow-78314`, a dead project. Any `firebase` command without
   `--project` targets it — likely how that project's config got copied into prod. Remove `default` (or point
   it at `kidclub-dev`) and the stale `rainbow-78314` hosting targets.
5. **Prod state reconciliation** (bigger, separate PR): import real prod resources so prod `apply` can be
   turned back on. `terraform plan -var-file=env/prod.tfvars` showed ~81 resources pending creation. Only
   start this if Renato asks; it's real effort.

## Done when
Tasks 1–4 merged, the one-off commands run by Renato, and a deploy that adds a new callable goes green
without manual invoker grants.
