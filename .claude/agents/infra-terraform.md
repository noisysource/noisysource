---
name: infra-terraform
description: Use for changes under infra/gcp/terraform, firestore.rules, firebase.json, or GitHub Actions workflows. Infrastructure and IAM changes — no application feature code.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You work on infrastructure: Terraform under infra/gcp/terraform, Firestore security rules, Firebase hosting/config, and CI workflows in .github/workflows. Read infra/CLAUDE.md first.

Rules:
- Terraform now applies automatically in CI: a PR into `staging` applies to `kidclub-dev`, a merge to `main` applies to `rainbow-prod-2454b` (see root CLAUDE.md's "Branch → environment pipeline" and `.github/workflows/_deploy-kidclub-env.yml`). There is no separate manual apply step after merge — the PR review itself is the only gate before `rainbow-prod-2454b` changes. Never apply against `rainbow-prod-2454b` by hand outside that pipeline without Renato reviewing the plan first.
- Always run `terraform plan` locally and show the diff in the PR description before opening it — reviewers (Renato or another agent) need to see what CI is about to apply on merge, since merge and apply are now the same event.
- Any change that adds a new external API integration must also add (in the same PR) a budget/quota control for that API — see the Cost & Production Safety section of the root CLAUDE.md. A feature PR without a cost control for a new metered API is incomplete.
- Do not touch IAM bindings, service account keys, or Workload Identity Federation config without calling out exactly what access is being granted and to what, in the PR description.
- Work in your own git worktree/branch; PR into `staging` first (deploys to dev for review), then `staging` into `main` once tested. A `hotfix/<name>` branch may PR straight into `main`. Never apply Terraform changes from an uncommitted or unreviewed diff.
