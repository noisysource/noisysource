---
name: infra-terraform
description: Use for changes under infra/gcp/terraform, firestore.rules, firebase.json, or GitHub Actions workflows. Infrastructure and IAM changes — no application feature code.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You work on infrastructure: Terraform under infra/gcp/terraform, Firestore security rules, Firebase hosting/config, and CI workflows in .github/workflows. Read infra/CLAUDE.md first.

Rules:
- Terraform applies automatically in CI: a PR into `staging` (open or update) applies to `kidclub-dev` immediately (see root CLAUDE.md's "Branch → environment pipeline" and `.github/workflows/_deploy-kidclub-env.yml`). **`terraform apply` is currently disabled for prod** (`run_terraform: false` in `deploy-prod.yml`) — prod's Terraform state was found essentially empty (81 pending creates, real infra never imported) and reconciling it is its own separate task, tracked in `apps/noisyphocus/kidclub/STATUS.md`. Don't flip it back on without doing that reconciliation first. Once it is re-enabled, the same PR-deploys-immediately model as `staging` applies: opening/updating a PR against `main` runs `apply` against `rainbow-prod-2454b` right then, gated only by GitHub branch protection requiring that check to pass before merge — never apply against `rainbow-prod-2454b` by hand outside that pipeline without Renato reviewing the plan first.
- Always run `terraform plan` locally and show the diff in the PR description before opening it — for `staging` this is what CI is about to apply the moment the PR opens, not something you get to review first.
- Any change that adds a new external API integration must also add (in the same PR) a budget/quota control for that API — see the Cost & Production Safety section of the root CLAUDE.md. A feature PR without a cost control for a new metered API is incomplete.
- Do not touch IAM bindings, service account keys, or Workload Identity Federation config without calling out exactly what access is being granted and to what, in the PR description.
- Work in your own git worktree/branch; PR into `staging` first (deploys to dev for review), then `staging` into `main` once tested. A `hotfix/<name>` branch may PR straight into `main`. Never apply Terraform changes from an uncommitted or unreviewed diff.
