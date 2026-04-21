# Infrastructure

> **Context**: See root `../CLAUDE.md` for full group architecture overview.

## Overview
All infrastructure is owned and managed by **NoisySource** across two active GCP projects.

---

## GCP Projects (actual IDs)
| Project ID | Environment | Purpose |
|---|---|---|
| `rainbow-prod-2454b` | Production | All live apps |
| `kidclub-dev` | Development | All dev/test apps |

> Project IDs retain legacy names from before the monorepo migration. Rename is planned as part of future infra cleanup.

### Terraform state
Stored in GCS bucket `rainbow-terraform-state`. Prefix per environment (`kidclub-dev`, `rainbow-prod-2454b`).

### Authentication for Terraform
Use `GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)` as env prefix when running terraform commands — ADC (application-default) has been unreliable on this machine.

---

## Firebase Hosting Targets
Configured in `/firebase.json` and `/.firebaserc` at monorepo root.

| Target | App | Firebase site ID (dev) | Firebase site ID (prod) |
|---|---|---|---|
| `kidclub` | KidClub | `kidclub-dev-arcoiris` | `rainbow-prod-2454b-arcoiris` |
| `finances` | Finances | `kidclub-dev-finhub` | `rainbow-prod-2454b-finhub` |

> Site IDs also retain legacy names. Rename via `firebase hosting:sites:create` when infra is cleaned up.

---

## CI/CD (GitHub Actions)
Workflows in `/.github/workflows/`. Auth uses Workload Identity Federation (no long-lived keys).

| Workflow | Trigger | SA used |
|---|---|---|
| `build-and-deploy-kidclub.yml` | push to main/staging or manual | `gmail-sender-kidclub-dev` (dev), `github-action-1020915538` (prod) |
| `deploy-finances.yml` | manual | same SAs |
| `deploy-functions.yml` | manual | same SAs |

WIF pool lives in `kidclub-dev` project (`projects/245453200769/locations/global/workloadIdentityPools/github-pool`). Both dev and prod SAs are bound to `noisysource/noisysource`.

---

## Terraform (`/infra/gcp/terraform/`)
Manages: APIs, Firebase project + hosting sites, Firestore database, Cloud Functions infrastructure, IAM, Workload Identity.

```bash
# Always prefix with token
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) terraform init -backend-config="prefix=kidclub-dev" -reconfigure
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) terraform apply -var-file="env/kidclub-dev.tfvars"
```

---

## Firestore Databases
| Project | Database name | Region |
|---|---|---|
| `kidclub-dev` | `kidclub` | `europe-west3` |
| `rainbow-prod-2454b` | `(default)` | `eur3` |

---

## Cost Notes
- Firebase Spark (free) plan covers most internal usage
- Cloud Functions: 2M calls/month free
- Firebase Hosting: 10GB storage / 360MB/day free
- Firestore: 1GB / 50K reads / 20K writes per day free
- Upgrade to Blaze (pay-as-you-go) only if free tier is exceeded
