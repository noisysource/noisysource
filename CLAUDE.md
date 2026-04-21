# NoisySource — Group Architecture

## Group Overview
**NoisySource** is the parent group and handles all IT infrastructure, Firebase, GCP, and development for all companies within the group.

### Companies
| Company | Description |
|---|---|
| **NoisySource** | Parent group, IT owner, internal tooling |
| **Noisy Phocus** | Child company, owns KidClub |

---

## Monorepo Structure
```
/noisysource/
├── CLAUDE.md                        ← you are here
├── .code-workspace
├── functions/                       ← shared Firebase Cloud Functions (all apps)
├── apps/
│   ├── noisysource/                 ← NoisySource internal apps
│   │   ├── finances/                ← Finance management (private)
│   │   ├── domotics/                ← Home/building automation (private)
│   │   ├── tasks/                   ← Task management & event tracking (private)
│   │   └── social/                  ← Social platform (public, auth-required)
│   └── noisyphocus/
│       └── kidclub/                 ← KidClub public website (Noisy Phocus)
└── infra/
    ├── firebase/                    ← Firebase hosting configs per app
    └── gcp/                         ← GCP IAP, project configs, environments
```

---

## Tech Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Backend | Firebase Cloud Functions (shared, in `/functions`) |
| Database | Firebase Firestore |
| Auth | Firebase Auth (where applicable) |
| Hosting | Firebase Hosting |
| Infrastructure | Google Cloud Platform (GCP) |
| Private access | GCP Identity-Aware Proxy (IAP) |

---

## Environments
| Environment | Description | Access |
|---|---|---|
| **prod** | Live production | Public / IAP depending on app |
| **dev** | Development & internal testing | IAP-protected or local only |

Firebase projects:
- `noisysource-prod`
- `noisysource-dev`

---

## App Summary
| App | Company | Visibility | Auth | Status |
|---|---|---|---|---|
| KidClub | Noisy Phocus | Public | None | ✅ Existing (migrated) |
| Finances | NoisySource | Private (IAP) | GCP IAP | 🆕 To build |
| Domotics | NoisySource | Private (IAP) | GCP IAP | 🆕 To build |
| Tasks | NoisySource | Private (IAP) | GCP IAP | 🆕 To build |
| Social | NoisySource | Public | Firebase Auth | 🆕 To build |

---

## Shared Backend
All apps share Firebase Cloud Functions located in `/functions`.
- See `/functions/CLAUDE.md` for function conventions and structure
- Apps should never duplicate logic — always check `/functions` first
- Firestore security rules are also managed centrally

---

## Key Principles
- **Minimum cost**: prefer Firebase free tier, scale to zero wherever possible
- **Simplicity**: avoid over-engineering; use Firebase native features before adding custom infrastructure
- **Shared logic**: all business logic lives in `/functions`, FE apps are thin clients
- **WebSockets**: Domotics may require persistent WebSocket connections in the future — Cloud Run will be evaluated when that time comes
- **IT ownership**: NoisySource manages all infra regardless of which company owns the app
