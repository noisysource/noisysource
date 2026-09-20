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

## Parallel session (2026-09-20) — billing double-discount fix
A different agent, working concurrently, investigated "igbpinto@gmail.com's billing looks
wrong." Confirmed in **prod** (read-only): a transport subscription (Carolina Almeida,
`XiblZZlEVZHsSLFdN5z5`) was billed €117.60 instead of the correct €168 — a 30% discount
(20% school + 10% multi-trip) was being applied twice. Root cause: `computeLineItems()` in
`functions/src/kidclub/billing.ts` read `sub.originalFee ?? sub.monthlyFee` as the *gross*
transport fee, but `discountRecalc.ts` overwrites `monthlyFee` with the already-discounted
price, and self-enrolled subscriptions never get `originalFee` set — so billing re-applied
`appliedDiscounts` on top of an already-net price. Under-bills, doesn't overcharge.
**Scope: 8 of 23 active transport subscriptions** affected (see the PR/commit for the full
list — José Eduardo, Vasco Moura, Maria Manon, Diogo Mogo, Carolina Almeida, Bernardo Mogo,
Gil Figueiredo, Leonardo Marques). Study room subs not currently affected, but
`discountRecalc.ts`'s study-side calc has the same latent shape of bug, flagged not fixed.

**Status as of this merge conflict resolution**: `agent/billing-double-discount-fix` PR was
opened and **has been merged into `main`** (PR #13, confirmed via `git log`) — the code fix
for `computeLineItems()` is now in `main`. **Still not done**, per that session's own notes:
deploy functions to dev and verify, deploy to prod (`deploy-functions.yml`, manual), then run
`backfillBillingSchedules` to recompute the 8 affected families' pending billing totals (a
prod write — that session flagged it needs a decision from Renato since it's a standing-write
question per CLAUDE.md's no-standing-prod-write-access rule, even though the callable itself
already exists and already runs this logic on every subscription write). Worth noting: once
`agent/cicd-prod-prep` merges, functions deploy to prod automatically on every `main` merge —
so this fix's Cloud Function code will actually reach prod on that merge, without a separate
manual `deploy-functions.yml` run. The backfill itself still needs to be triggered separately
regardless.

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
   apply is skipped (point 9). Watch that run; it's the pipeline's first-ever prod deploy, and
   it's also what actually gets the billing double-discount fix's code (already merged into
   `main` as of PR #13) onto prod for the first time.
2. After that deploy, verify the billing double-discount fix landed correctly (a transport
   billing line item matches the sub's `monthlyFee`), then run/trigger `backfillBillingSchedules`
   to recompute the 8 affected families' pending billing totals — check result counts against
   the 8 names in the "Parallel session" note above before trusting it's fully caught. This is
   a prod write; flagged as its own open question below.
3. Separately, as its own deliberate piece of work (not blocking the merge above): reconcile
   prod's Terraform state so `run_terraform` can go back to `true` for prod. This means, at
   minimum: fix the `storage.tf` bucket-name/activation issue, then `terraform import` each
   of the 81 pending resources against real prod infra one at a time (or in batches, verifying
   each), the same pattern used for dev's smaller gaps (points 4, 7) but at much larger scale
   — this is real, careful work, not a quick unblock.
4. Also still true for whenever terraform *does* get re-enabled for prod: prod's CI service
   account (`github-action-1020915538@rainbow-prod-2454b.iam.gserviceaccount.com`) is **not**
   the same identity as `gmail_sender` (prod's `gmail_sender_sa_id` is `gmail-sender-prod`, a
   different account). Every permission fix in this session targeted `gmail_sender` — prod's
   CI SA will need its own equivalent grants before its terraform step can safely run.
5. Decide whether to bring `deploy-finances.yml` onto the same staging/main model — not done
   in this session, flagged as a follow-up in CLAUDE.md.
6. Separately, decide on the "As minhas faturas" feature work (dead `invoices` collection,
   flagged in an earlier session) and scope it as its own task when ready.

## Open questions for Renato
- None blocking the `main` merge — it's ready.
- Billing fix: OK to run `backfillBillingSchedules` against **prod** once the fix is deployed?
  It recomputes every family's billing, not just the 8 affected ones — low risk (it's the same
  logic already running on every subscription write) but it is a prod write, flagging per the
  no-standing-write-access rule.
- Two things worth a deliberate look once the merge is in, not urgent: (a) is
  `roles/resourcemanager.projectIamAdmin` on prod for a dev-project CI service account the
  long-term shape you want, or should it get narrowed later to a custom role scoped to just
  the specific bindings CI manages? (b) when/whether to prioritize the prod Terraform state
  reconciliation (point 3 above) — it's real effort, not urgent unless something starts
  depending on Terraform managing prod resources.

## Anything risky in flight
- **8 active prod transport subscriptions are currently under-billed** (double-discounted —
  see "Parallel session" above) until the fix (already merged into `main`) actually deploys
  to prod and a backfill runs. No prod data was changed investigating this originally — reads
  only. Worktree `.claude/worktrees/billing-double-discount-fix` still exists — remove it,
  its branch is merged.
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
- Unrelated, still open from a prior session: `git worktree list` shows several other stale
  worktrees not cleaned up (`claim-studyroom-fix`, `deploy-functions-workflow-fix`, plus some
  pre-convention ones outside `.claude/worktrees/`). Worth Renato clearing out whichever are
  merged/abandoned.
- Also unrelated, paused mid-session on 2026-09-18: a unified client calendar
  (`agent/family-calendar` branch, `/client/calendar`) for cancelling study/transport days
  in one place instead of per-subscription. Built, builds clean, not deployed/reviewed yet.
  Needs a Firestore composite index deployed (`firestore.indexes.json`, committed on that
  branch) before it's usable — once this pipeline is live, that branch's own PR-to-staging
  will handle the index deploy automatically instead of needing a manual one.
