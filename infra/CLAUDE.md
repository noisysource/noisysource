# Infrastructure

> **Context**: See root `../CLAUDE.md` for full group architecture overview.

## Overview
All infrastructure is owned and managed by **NoisySource**, and NoisySource pays for all of it.
Reorganised on 2026-11-10 into one folder per company; the plan and what's left are in
`gcp/HANDOFF-gcp-reorg.md`.

---

## GCP layout (org `kidclub.pt`)
| Folder | Project ID | Display name | Purpose |
|---|---|---|---|
| Noisy Phocus | `rainbow-prod-2454b` | KidClub Prod | KidClub live. **Still also hosts FinHub prod** until it moves |
| Noisy Phocus | `kidclub-dev` | KidClub Dev | KidClub dev. Still also hosts FinHub dev, the Terraform state bucket, the GitHub WIF pool and the billing cutoff |
| NoisySource | `noisysource-prod` | NoisySource Prod | Prod of the private tools. Domotics runs here with the house's live data (since 2026-11-16); FinHub and Tasks follow. Also the public website (site `noisysource-prod-website`, custom domain `noisysource.com`) |
| NoisySource | `noisysource-dev` | NoisySource Dev | Same, dev. Domotics runs here (rules, five functions, site `noisysource-dev-domotics`); website preview on `noisysource-dev-website` |
| NoisySource | `noisysource-agent` | Jarvis | Renato's NoisySource agent: Workspace APIs, SA `noisysource-agent@noisysource-agent.iam.gserviceaccount.com`, **no billing** |

> Project IDs can't be renamed; KidClub keeps `kidclub-dev` / `rainbow-prod-2454b` for good (display names say what they are).

### Billing
Every billed project is linked to **NoisySource Central Billing** (`01B2DE-83C5F5-B12BC9`, EUR).
Budgets on it: the €50 whole-account cap that feeds the automated cutoff (Terraform, `budget.tf`),
plus two email-only alerts created by hand: KidClub Prod €20 (50/90/100%) and KidClub Dev €10 (80%).
A budget only sees spend on its own billing account; check it whenever a project changes billing.
The old "My Billing Account" (`012710-30B4D5-DCC57E`) has no projects any more.

### Terraform state
Stored in GCS bucket `kidclub-terraform-state` (in `kidclub-dev` project), prefix per environment (`kidclub-dev`, `rainbow-prod-2454b`).

### Authentication for Terraform
Uses Application Default Credentials (ADC). One-time setup:
```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project kidclub-dev
```
After setup, plain `terraform` commands work without any prefix. ADC refresh tokens persist across sessions.

---

## Firebase Hosting Targets
Configured in `/firebase.json` and `/.firebaserc` at monorepo root.

| Target | App | Firebase site ID (dev) | Firebase site ID (prod) |
|---|---|---|---|
| `kidclub` | KidClub | `kidclub-dev-arcoiris` | `rainbow-prod-2454b-arcoiris` |
| `finances` | Finances | `kidclub-dev-finhub` | `rainbow-prod-2454b-finhub` |

> Domotics is not here any more: its target is in `firebase/noisysource/` (sites `noisysource-dev-domotics`, `noisysource-prod-domotics`). FinHub leaves next; the order and progress are in `HANDOFF-repo-restructure.md`.

---

## CI/CD (GitHub Actions)
Workflows in `/.github/workflows/`. Auth uses Workload Identity Federation (no long-lived keys).
Full flow (branches, when each fires) is in root CLAUDE.md's "Branch → environment pipeline" —
this table is just the file map.

| Workflow | Trigger | Deploys | SA used |
|---|---|---|---|
| `deploy-dev.yml` | PR opened/updated against `staging`, push to `staging`, or manual run on `staging` | to kidclub-dev, **only the parts the PR/push changed** (terraform, rules/indexes/storage rules, functions, KidClub/FinHub hosting; rules in `.github/scripts/deploy-parts.mjs`); a manual run deploys everything from `staging` | `gmail-sender-kidclub-dev` |
| `deploy-prod.yml` | PR opened/updated against `main` **whose head is `staging`**, or push to `main` | same, to rainbow-prod-2454b (deploys pre-merge only on the staging→main promotion PR; a PR into `main` from any other branch skips the deploy job entirely — see the header comment in that file for the incident that prompted the guard. `sync-staging` fast-forwards/PRs `staging` to match, only on the post-merge push) | `github-action-1020915538` |
| `deploy-noisysource-prod.yml` | push to `staging` (a merge), or manual run on `staging` | the NoisySource unit to noisysource-prod: only the parts the merge changed; a manual run deploys everything. No PR ever deploys here, and the prod account only accepts the `staging` branch's token | `github-deploy@noisysource-prod` |
| `_deploy-env.yml` | `workflow_call` only | the generic reusable deploy, used by the NoisySource unit: the `noisysource` job of `deploy-dev.yml` (noisysource-dev, SA `github-deploy@noisysource-dev`) and `deploy-noisysource-prod.yml` | (whichever caller passes in) |
| `_deploy-kidclub-env.yml` | `workflow_call` only | the reusable deploy logic both of the above call: a plan + build job, then one job per part (terraform → rules → functions → hosting), each with its own concurrency group | (whichever caller passes in) |
| `ci-checks.yml` | PR opened/updated against `main` | nothing — build/typecheck/terraform-validate only | n/a |
| `deploy-finances.yml` | manual | Finances hosting | `gmail-sender-kidclub-dev` (dev), `github-action-1020915538` (prod) |
| `deploy-functions.yml` | manual | functions only, fallback (normally deployed via the two above) | same SAs |

WIF pool lives in `kidclub-dev` project (`projects/245453200769/locations/global/workloadIdentityPools/github-pool`). Both dev and prod SAs are bound to `noisysource/noisysource`.

`terraform apply` in CI needs a `BILLING_ACCOUNT_ID` repository secret (no default in `budget.tf`,
required on every apply regardless of environment): `01B2DE-83C5F5-B12BC9`, NoisySource Central Billing.
The dev CI SA holds `roles/billing.costsManager` on that account, granted by hand (see the end of `iam.tf`).

---

## Terraform (`/infra/gcp/terraform/`)
Manages: APIs, Firebase project + hosting sites, Firestore database, Cloud Functions infrastructure, IAM, Workload Identity.

```bash
terraform init -backend-config="prefix=kidclub-dev" -reconfigure
terraform apply -var-file="env/kidclub-dev.tfvars"
```

---

## Firestore Databases
| Project | Database name | Region |
|---|---|---|
| `kidclub-dev` | `(default)` | `europe-west3` |
| `rainbow-prod-2454b` | `(default)` | `eur3` |
| `noisysource-dev` | `(default)` | `europe-west3` |
| `noisysource-prod` | `(default)`, created by the first Terraform apply (step 9) | `europe-west3` |

Today each KidClub database is shared by KidClub and FinHub (one rules file,
`/firestore.rules`); Domotics has the NoisySource ones to itself
(`firebase/noisysource/firestore.rules`). After the restructure each company has its own.

---

## Cost Notes
- Every billed project is on Blaze (pay-as-you-go) through Central Billing; the aim is to stay inside the free allowances
- Cloud Functions: 2M calls/month free
- Firebase Hosting: 10GB storage / 360MB/day free
- Firestore: 1GB / 50K reads / 20K writes per day free
