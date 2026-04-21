# App: Tasks

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/tasks/`.

## Purpose
Internal tool for managing everyday tasks, tracking events, and organising operational activity across NoisySource.

## Visibility & Access
- **Private** — not internet-facing
- Protected by **GCP Identity-Aware Proxy (IAP)**
- No Firebase Auth needed (IAP handles identity)

## Status
🆕 To be built from scratch

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Backend | Firebase Cloud Functions (shared `/functions`) |
| Database | Firestore |
| Auth | GCP IAP |
| Hosting | Firebase Hosting (dev environment only) |

---

## Key Features (planned)
- Task creation, assignment, and tracking
- Event logging and timeline view
- Status workflows (to do, in progress, done)
- Recurring tasks support
- Activity history / audit trail

---

## Firestore Collections
> To be defined during build. Prefix all collections with `tasks_`.

---

## Notes
- IAP setup reference: `../../../infra/gcp/`
- Keep it simple — this is an internal ops tool, not a full project management suite
