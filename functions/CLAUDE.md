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
- Single `(default)` database per project — all apps share it, scoped by collection prefix
- KidClub: `_apps/arcoiris/{collection}` — FinHub: `finances_entities/{entityId}/{collection}`
- FinHub can query KidClub collections directly for financial management

---

## Deployment
Automatic as part of the KidClub pipeline (see root CLAUDE.md) — a PR into `staging` deploys
functions to `kidclub-dev`, a merge to `main` deploys them to prod. `deploy-functions.yml`
still exists as a manual `workflow_dispatch` fallback (e.g. redeploying functions alone
without a full app build):
```bash
# Manual/fallback only
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
3. Update `firestore.rules` if new collections are involved — **including a rule for any new collection the function reads or writes**. Firestore denies by default, so a collection with no matching rule breaks every client read of it, even though the function's own Admin SDK writes bypass rules and look fine.
4. Add any composite index the function's queries need to `firestore.indexes.json`. An inequality (range) filter combined with an equality/`in` on a different field always needs one declared explicitly; pure-equality combinations don't.
5. **Do NOT add a new callable to `local.callable_functions` in `infra/gcp/terraform/functions.tf` in the same PR as its code.** That list creates each function from a dummy placeholder zip with `entry_point = <name>`, and CI runs `terraform apply` *before* `firebase deploy --only functions` — so a brand-new name there fails to create with "Container Healthcheck failed... failed to start and listen on PORT". Ship the code first, let the functions deploy create the function for real, then add it to that list in a follow-up PR if you want Terraform managing its service config.
