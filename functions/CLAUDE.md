# Shared Firebase Cloud Functions

> **Context**: See root `../CLAUDE.md` for full group architecture and stack overview.

## Purpose
All Firebase Cloud Functions shared across every NoisySource app. No app should contain its own backend logic — everything lives here.

---

## Current Functions (all 2nd gen, nodejs22, europe-west3)

| Function | Type | Trigger | App |
|---|---|---|---|
| `sendEmailFromOutbox` | Background | Firestore create on `emailOutbox/{id}` | shared |
| `getUsageSnapshot` | Callable (HTTP) | on-demand | shared |
| `expandTemplatesInRange` | Callable (HTTP) | on-demand | finances |
| `postPlannedInstance` | Callable (HTTP) | on-demand | finances |
| `exportOrgData` | Callable (HTTP) | on-demand | finances |
| `importOrgData` | Callable (HTTP) | on-demand | finances |
| `wipeOrgData` | Callable (HTTP) | on-demand | finances |
| `createRecurringExpenses` | Callable (HTTP) | on-demand | finances |
| `impersonateUser` | Callable (HTTP) | on-demand | admin |

Source files in `src/`:
- `index.ts` — entry point, exports all functions
- `SendEmailFromOutbox.ts` — email sender via Gmail
- `LedgerFunctions.ts` — ledger/template operations (finances)
- `OrgDataTools.ts` — org data export/import/wipe (finances)
- `recurringExpenses.ts` — recurring expense creation (finances)
- `usage.ts` — usage snapshot
- `impersonation.ts` — user impersonation (admin)

---

## Conventions
- Functional style, no classes
- Each domain folder exports its own functions, `index.ts` aggregates
- Use **callable functions** for app-triggered logic
- Use **background triggers** (Firestore) for reactive logic
- Env config via Firebase environment variables, never hardcoded

---

## Firestore
- Security rules are centralised — review on every change involving new collections
- Namespace collections per app (e.g. `kidclub_`, `finances_`)
- KidClub uses the `kidclub` named database (not `(default)`)

---

## Deployment
```bash
# Deploy all functions
firebase deploy --only functions --project=kidclub-dev
firebase deploy --only functions --project=rainbow-prod-2454b

# Deploy specific function
firebase deploy --only functions:sendEmailFromOutbox --project=kidclub-dev
```

Functions infrastructure (not code) is managed by Terraform — `lifecycle { ignore_changes = [build_config] }` is set so Terraform won't overwrite CI deployments.

---

## Adding a New Function
1. Create or update the relevant source file under `src/`
2. Export from `src/index.ts`
3. Update `firestore.rules` if new collections are involved
4. Add the function name to `local.callable_functions` in `infra/gcp/terraform/functions.tf` if it's a new callable
