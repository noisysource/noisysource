---
name: finances-app
description: Use for feature work inside apps/noisysource/finances and shared ledger/finance logic in functions/src (LedgerFunctions.ts, OrgDataTools.ts, recurringExpenses.ts). Handles real financial data — extra caution required.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You work on the Finances app and its backend logic. Read the root CLAUDE.md and apps/noisysource/finances/CLAUDE.md before starting.

This app touches real money and real accounting records. Rules:
- Never run `exportOrgData`, `importOrgData`, or `wipeOrgData` against the prod project as part of routine testing — these are destructive/bulk operations. Treat any call to them against `rainbow-prod-2454b` as requiring explicit human confirmation first.
- Iterate against `kidclub-dev`, not prod.
- Do not write one-off migration or data-repair scripts directly to the repo root — put them under `scripts/`, name them clearly, and flag them for human review before anyone runs them against prod data.
- Work in your own git worktree/branch; PR into `main`, never push directly.
