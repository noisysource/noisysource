# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-20

## Currently working on
Rebuilt the CI/CD pipeline at Renato's request (see root `CLAUDE.md`'s "Branch → environment
pipeline" for the full model: PR into `staging` auto-deploys to kidclub-dev, merge to `main`
auto-deploys everything to prod, hotfix branches PR straight to `main`, `staging` auto-syncs
after every `main` merge). `agent/cicd-staging-prod-pipeline` → `staging` PR went green and
was merged (#12). Now promoting to `main`: PR opened as `agent/cicd-prod-prep` → `main`
(branched from `staging`'s tip, so it carries everything from #12 plus one more fix — see
point 9 below).

**This is the pipeline's first real run, and it's earning its keep** — every failure below
was a genuine pre-existing gap the old manual-deploy flow never surfaced, not something this
session introduced:

1. `Invalid workflow file` on first push — reusable `workflow_call` jobs don't get to request
   their own `permissions`, they inherit (capped) from the caller. Fixed: added explicit
   `permissions: { contents: read, id-token: write }` to the calling `deploy` job in both
   `deploy-dev.yml` and `deploy-prod.yml`.
2. `firebase deploy --only functions` 403'd on every secret (`SA_CLIENT_EMAIL`,
   `VENDUS_API_KEY`, etc.) — the CI deploy SA (`gmail-sender-kidclub-dev`) had never been
   granted `secretmanager.secretAccessor` on any of them; nothing in Terraform granted it.
   Fixed: new `google_secret_manager_secret_iam_member` resource in
   `infra/gcp/terraform/secrets.tf`, one per tracked secret.
3. That fix only works if Terraform's `apply` runs *before* the functions deploy step in the
   same job — it was previously last. Reordered `_deploy-kidclub-env.yml`: terraform first,
   then rules/indexes, then functions/hosting.
4. `EASYPAY_WEBHOOK_URL` was used by real function code (`easypay.ts`, `billing.ts`) but was
   never added to Terraform's tracked `secret_ids` list, and the secret already existed in
   GCP (created by hand, like the others originally were) — so just adding it to the list
   would have made `apply` try to create a duplicate and fail. Imported it into kidclub-dev's
   state by hand (`terraform import ... projects/kidclub-dev/secrets/EASYPAY_WEBHOOK_URL`)
   before pushing the code change. **Prod's state still needs the same import** — see Next
   step.
5. `terraform apply` also needs `-var="billing_account_id=..."` (no default in `budget.tf`,
   required on every apply regardless of environment) — never wired into CI before. Added via
   a `BILLING_ACCOUNT_ID` GitHub repo secret + `secrets: inherit` on both callers (reusable
   workflows don't inherit repo secrets automatically either). **Renato needs to add this
   secret in GitHub repo Settings → Secrets → Actions** — value is the billing account linked
   to kidclub-dev, looked up via the Cloud Billing API this session (not written here on
   purpose — check `gcloud billing accounts list` or GCP console if you need it again).
6. Before pushing, ran `terraform plan` against real kidclub-dev state and found ~31 items of
   *pre-existing* drift unrelated to this work (Cloud Function configs catching up to what's
   actually deployed, a new Firebase Storage bucket resource, and — notably — enabling
   `places.googleapis.com`). Checked it against `quotas.tf`: the Places API's hard daily quota
   cap (100 autocomplete requests/day) was already verified live on 2026-09-14, so this wasn't
   new uncapped exposure, just Terraform catching up to already-intentional, already-guarded
   config. Applied that full plan by hand against kidclub-dev with Renato's explicit sign-off.
7. That apply surfaced two more real, pre-existing gaps: (a) `triggerInvoiceGeneration` was
   listed in `functions.tf`'s tracked function set since 2026-07-27 with **no corresponding
   function in `functions/src` at all** — pure dead config, predates this session entirely.
   Removed it. (b) Four real, already-deployed functions (`tuyaSetState`, `tuyaGetDevices`,
   `getKidclubVatSummary`, `setBillingLineItemExcludedDays`) had never been imported into
   Terraform state, so `apply` tried to create them fresh and got `409: already exists`.
   Imported all four. One follow-up apply hit a transient "Container Healthcheck failed" on
   two of them mid-rollout — checked directly against the Cloud Functions API afterward: both
   are `state: ACTIVE` and serving, and a final `terraform plan` now reports **"No changes.
   Your infrastructure matches the configuration"** — kidclub-dev is fully reconciled.
8. Next CI run got past all of the above and failed differently: 5 resources
   (`dev_sa_bq_job_user_prod`, `dev_compute_sa_bq_job_user_prod`, `billing_cutoff_agent_prod`,
   `combined_budget`, and last session's own `gmail_sender_service_usage_consumer_prod` grant)
   all manage IAM/billing policy **on `rainbow-prod-2454b` or its billing account directly**,
   and `roles/serviceusage.serviceUsageConsumer` (granted last session) only lets a service
   account *be granted* roles on another project — it doesn't let it *read or manage* that
   project's IAM policy, which Terraform itself needs to diff these resources at all.
   **This is a materially bigger decision than every fix before it**: closing this gap the
   same way means the dev-project CI service account (`gmail-sender-kidclub-dev`, federated
   via GitHub Actions Workload Identity) gets IAM-admin rights on the **prod** project itself.
   Presented the tradeoff directly to Renato — grant it, vs. excluding these 5 resources from
   CI's automated apply and keeping them human-applied like before (arguably the more
   conservative default) — and **Renato explicitly chose to grant it**. Added
   `roles/resourcemanager.projectIamAdmin` on `rainbow-prod-2454b` and `roles/billing.admin`
   on the billing account, both to `gmail_sender`, plus `cloudbilling.googleapis.com` enabled
   on kidclub-dev (a prerequisite the billing-account grant needed, separate from the role
   itself — hit its own `SERVICE_DISABLED` error, fixed by adding it to `project.tf`'s API
   list rather than just clicking it on in the console).
   **Read this if you're the next session touching prod IAM**: this SA can now read/modify
   prod's IAM policy and the billing account's. If its WIF-federated credentials were ever
   compromised, the blast radius includes prod IAM, not just kidclub-dev. That tradeoff was
   made knowingly, but it's worth re-confirming it still feels right before doing more here.
   Applied by hand against kidclub-dev; final `terraform plan` → no changes, fully reconciled.
9. Before opening the `main` promotion PR, ran `terraform plan -var-file=env/prod.tfvars`
   by hand against the real `rainbow-prod-2454b` state prefix — the check flagged as a
   prerequisite in point 3 below. Result: **81 resources pending creation, 0 to change**.
   Prod's Terraform state is essentially empty — nobody has ever run `terraform apply`
   against it; everything live in prod (functions, hosting, IAM, rules, Firestore) was set
   up out-of-band (firebase CLI, gcloud, console clicks), never imported into Terraform
   state. The plan also hard-errors on a `storage.tf` data lookup expecting an existing
   `rainbow-prod-2454b.firebasestorage.app` bucket that doesn't exist — Firebase Storage was
   likely never activated for this project via the console (see `storage.tf`'s own comment:
   "must be activated via the Firebase Console once").
   Presented this to Renato as a three-way choice — skip terraform for prod and merge
   everything else, hold the whole merge until state is reconciled, or attempt the blind
   81-resource apply anyway — and **Renato chose to skip terraform for prod, for now**.
   Added a `run_terraform` input (default `true`) to the reusable `_deploy-kidclub-env.yml`,
   set `false` in `deploy-prod.yml`. Hosting, Firestore rules/indexes, and functions still
   deploy to prod automatically on merge — same as what's already done by hand today, so no
   new risk there. Only the terraform step is paused.

## Last completed
- All fixes above (1-9) pushed. Points 1-8 are on `staging` (merged via PR #12). Point 9 is
  on `agent/cicd-prod-prep`, PR opened against `main`:
  https://github.com/noisysource/noisysource/pull/new/agent/cicd-prod-prep
- `BILLING_ACCOUNT_ID` repo secret added by Renato.
- `terraform validate` passes locally; full `terraform plan` reviewed before every apply, and
  before this promotion PR was even opened.
- kidclub-dev's Terraform state is fully clean (`terraform plan` → no changes) as of this
  session — confirmed via both `terraform plan` and, for the functions specifically, a direct
  Cloud Functions API check.
- Auto mode's Bash permission classifier was blocking `git commit`/`git add` specifically
  around this terraform/IAM work (even after the underlying `terraform apply` itself
  succeeded) — Renato asked to loosen it; added `Bash(git commit *)`, `Bash(git add *)`,
  `Bash(git status *)` to `.claude/settings.local.json`'s allow list (personal, gitignored,
  not team-wide).

## Next step
1. Review and merge `agent/cicd-prod-prep` → `main`. On merge, `deploy-prod.yml` runs
   automatically: hosting, Firestore rules/indexes, and functions deploy to prod — terraform
   apply is skipped (point 9). Watch that run; it's the pipeline's first-ever prod deploy.
2. Separately, as its own deliberate piece of work (not blocking the merge above): reconcile
   prod's Terraform state so `run_terraform` can go back to `true` for prod. This means, at
   minimum: fix the `storage.tf` bucket-name/activation issue, then `terraform import` each
   of the 81 pending resources against real prod infra one at a time (or in batches, verifying
   each), the same pattern used for dev's smaller gaps (points 4, 7) but at much larger scale
   — this is real, careful work, not a quick unblock.
3. Also still true for whenever terraform *does* get re-enabled for prod: prod's CI service
   account (`github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com`) is **not**
   the same identity as `gmail_sender` (prod's `gmail_sender_sa_id` is `gmail-sender-prod`, a
   different account). Every permission fix in this session targeted `gmail_sender` — prod's
   CI SA will need its own equivalent grants before its terraform step can safely run.
4. Decide whether to bring `deploy-finances.yml` onto the same staging/main model — not done
   in this session, flagged as a follow-up in CLAUDE.md.

## Open questions for Renato
- None blocking the `main` merge — it's ready.
- Two things worth a deliberate look once the merge is in, not urgent: (a) is
  `roles/resourcemanager.projectIamAdmin` on prod for a dev-project CI service account the
  long-term shape you want, or should it get narrowed later to a custom role scoped to just
  the specific bindings CI manages? (b) when/whether to prioritize the prod Terraform state
  reconciliation (point 2 above) — it's real effort, not urgent unless something starts
  depending on Terraform managing prod resources.

## Anything risky in flight
- **This PR changes how prod gets deployed** — merge to `main` now deploys hosting,
  Firestore rules/indexes, and functions to prod automatically (previously always a manual,
  human-run command). Terraform apply is deliberately excluded for now (point 9). No branch
  protection backs any of this up per Renato's explicit choice; PR review is the only gate.
- **The dev-project CI service account now has IAM-admin rights on the prod project and prod's
  billing account** (see point 8 above) — a deliberate, explicit trade Renato chose after
  being shown the alternative. Real increase in blast radius if that WIF-federated credential
  is ever compromised; worth being aware of, not something to forget was decided this way.
- Manual `terraform apply`/`import` was run directly against kidclub-dev this session (see
  points 6-8) — real dev infra changed outside the PR flow, deliberately, with Renato's
  sign-off, to give the pipeline's first automated run a clean starting point. One apply hit
  a transient container health-check error on 2 functions mid-rollout; verified both are
  `ACTIVE`/serving directly via the Cloud Functions API afterward, and state is now fully
  reconciled (`terraform plan` → no changes) — but worth a manual click-through of
  `getKidclubVatSummary` and `setBillingLineItemExcludedDays` on kidclub-dev if you want
  extra confidence beyond what this session verified.
- Stale worktree/branch `agent/kidclub-cicd-automation` (2 days old, based on an old `main`,
  mixed with ~60 unrelated file changes to billing/models) was found and deliberately NOT
  built on or merged — flagged for Renato to delete.
- Unrelated, still open: a unified client calendar (`agent/family-calendar` branch,
  `/client/calendar`). Built, not deployed/reviewed yet, needs a Firestore composite index —
  once this pipeline is live, that branch's own PR-to-staging will handle the index deploy
  automatically instead of needing a manual one.
