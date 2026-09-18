# STATUS — KidClub

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-09-18

## Currently working on
Rebuilt the CI/CD pipeline at Renato's request, after the impersonation-billing fix session
exposed how bad the old manual-deploy flow actually was (a Firestore composite index nobody
remembered to deploy, a `firebase login` reauth blocking a fix from reaching prod on
schedule, and prod hosting having to be pushed ahead of a `main` merge to unblock a live bug).

New model — full detail in root `CLAUDE.md`'s "Branch → environment pipeline":
- Branch off `main` → PR into `staging` → **auto-deploys to kidclub-dev** (app, Firestore
  rules, Firestore indexes, functions, terraform apply) on every PR open/update.
- Tested on dev → PR from `staging` into `main` (runs build/typecheck/terraform-validate,
  no deploy) → merge → **auto-deploys everything to prod**, no separate manual step.
- `hotfix/<name>` branches off `main` directly, PRs straight to `main`, same prod pipeline.
  After any merge to `main`, a `sync-staging` job fast-forwards `staging` to match (or opens
  a sync PR if it can't), so dev doesn't drift behind a hotfixed prod.
- The old `build-and-deploy-kidclub.yml` looked like it auto-deployed on push to main/staging
  but actually didn't (its deploy job was gated to `workflow_dispatch` only) — removed,
  replaced by `deploy-dev.yml` / `deploy-prod.yml` / `ci-checks.yml` +
  reusable `_deploy-kidclub-env.yml`.
- Verified the Terraform GCS backend prefixes directly against the state bucket (read-only
  API call, not guessed) before wiring `terraform apply` into CI: `kidclub-dev` for dev,
  `rainbow-prod-2454b` for prod.
- Created the `staging` branch (didn't exist before), removed a stray committed `tfplan`
  file from git (now gitignored).
- Renato explicitly declined GitHub branch-protection rules on `main`/`staging` for now —
  merge access alone is the gate, no required review/status-check enforced by GitHub itself.

## Last completed
- Branch `agent/cicd-staging-prod-pipeline` pushed. **PR opened against `staging`, not
  `main`** — deliberately, so the first real run of the new dev pipeline is this change
  testing itself. Link: https://github.com/noisysource/noisysource/pull/new/staging...agent/cicd-staging-prod-pipeline
- `terraform validate` passes locally (`terraform init -backend=false` + `validate`).
- YAML for all 4 new/changed workflow files checked for basic validity (no `actionlint`
  available in this environment, so untested against GitHub's actual runner beyond that).
- NOT yet run for real on GitHub Actions — first PR open/push against `staging` is the real
  test, including whether the existing service accounts have enough IAM roles for
  `terraform apply` (untested — Renato explicitly chose "wire it and fix permissions if it
  fails" over pre-granting roles).

## Next step
1. Renato: open the PR link above (base `staging`), watch the Actions run. Two realistic
   failure points on the very first run: (a) `terraform apply` failing on a missing IAM role
   for the `gmail-sender-kidclub-dev@kidclub-dev.iam.gserviceaccount.com` service account —
   fix by adding the role in `infra/gcp/terraform/iam.tf` and applying once by hand; (b) the
   `sync-staging` job in `deploy-prod.yml` is untested until the first real merge to `main`
   happens under the new model.
2. Once dev deploy succeeds cleanly, merge this PR into `staging`, then open a second PR
   `staging` → `main` to promote the pipeline itself into prod.
3. Decide whether to bring `deploy-finances.yml` onto the same staging/main model — not done
   in this session, flagged as a follow-up in CLAUDE.md.

## Open questions for Renato
- None blocking — this is ready to test via the PR above.

## Anything risky in flight
- **This PR changes how prod gets deployed** (merge to `main` now deploys everything
  automatically, including a live `terraform apply` — previously that was always a manual,
  human-run command). No branch protection backs this up per Renato's explicit choice; the
  PR review itself is the only gate from now on. Worth being deliberate about who can merge
  to `main`/`staging` going forward.
- Stale worktree `agent/kidclub-cicd-automation` (2 days old, based on an old `main`, mixed
  with ~60 unrelated file changes to billing/models) was found and deliberately NOT built on
  or merged — flagged for Renato to delete (`git push origin --delete agent/kidclub-cicd-automation`
  after confirming nothing in it is wanted).
- Unrelated, still open: a unified client calendar (`agent/family-calendar` branch,
  `/client/calendar`) for cancelling study/transport days in one place. Built, not
  deployed/reviewed yet, needs a Firestore composite index deployed before it's usable —
  once this new pipeline is live, that branch's own PR-to-staging will handle the index
  deploy automatically instead of needing a manual `firebase deploy --only firestore:indexes`.
