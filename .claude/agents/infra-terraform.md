---
name: infra-terraform
description: Use for changes under infra/gcp/terraform, firestore.rules, firebase.json, or GitHub Actions workflows. Infrastructure and IAM changes — no application feature code.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You work on infrastructure: Terraform under infra/gcp/terraform, Firestore security rules, Firebase hosting/config, and CI workflows in .github/workflows. Read infra/CLAUDE.md first.

Rules:
- Always run `terraform plan` and show the diff before `terraform apply`; never apply against `rainbow-prod-2454b` without the plan having been reviewed by Renato first.
- Any change that adds a new external API integration must also add (in the same PR) a budget/quota control for that API — see the Cost & Production Safety section of the root CLAUDE.md. A feature PR without a cost control for a new metered API is incomplete.
- Do not touch IAM bindings, service account keys, or Workload Identity Federation config without calling out exactly what access is being granted and to what, in the PR description.
- Work in your own git worktree/branch; PR into `main`, never apply Terraform changes from an uncommitted or unreviewed diff.
