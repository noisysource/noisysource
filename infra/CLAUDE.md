# Infrastructure

> **Context**: See root `../CLAUDE.md` for full group architecture overview.

## Overview
All infrastructure is owned and managed by **NoisySource** across two GCP projects, regardless of which company an app belongs to.

---

## GCP Projects
| Project ID | Environment | Purpose |
|---|---|---|
| `noisysource-prod` | Production | All live apps |
| `noisysource-dev` | Development | All dev/test apps |

---

## Firebase Projects
Firebase projects map 1:1 with GCP projects:
- `noisysource-prod`
- `noisysource-dev`

All apps share the same Firebase project per environment. Firestore collections are namespaced per app (e.g. `finances_`, `tasks_`, `kidclub_`).

---

## Hosting Configuration
Each app has its own Firebase Hosting target defined in `firebase.json`.

```
/infra/firebase/
├── firebase.json          ← multi-site hosting config
└── .firebaserc            ← project aliases (prod / dev)
```

### Hosting Targets
| Target name | App | URL pattern |
|---|---|---|
| `kidclub` | KidClub | kidclub.noisyphocus.com |
| `social` | Social | social.noisysource.com |
| `finances` | Finances | finances.noisysource.dev (IAP) |
| `domotics` | Domotics | domotics.noisysource.dev (IAP) |
| `tasks` | Tasks | tasks.noisysource.dev (IAP) |

> URLs above are placeholders — update with actual domains.

---

## GCP IAP (Identity-Aware Proxy)
Private apps (Finances, Domotics, Tasks) are protected by GCP IAP.

```
/infra/gcp/
├── iap-config.md          ← IAP setup steps and config per app
└── environments.md        ← env-specific notes
```

### IAP-Protected Apps
- `finances`
- `domotics`
- `tasks`

### How IAP Works Here
- Firebase Hosting serves the app
- GCP Load Balancer + IAP sits in front
- Only authenticated Google accounts in the allowed list can access
- No Firebase Auth needed in these apps — IAP handles identity

### IAP Setup Reference
> Document the actual IAP setup steps in `/infra/gcp/iap-config.md` during infra setup.

---

## Cost Notes
- Firebase Spark (free) plan covers most internal usage
- Cloud Functions: 2M calls/month free — sufficient for all apps combined
- Firebase Hosting: 10GB storage / 360MB/day free
- Firestore: 1GB storage / 50K reads / 20K writes per day free
- Upgrade to Blaze (pay-as-you-go) only if free tier is exceeded — costs remain very low at this scale
