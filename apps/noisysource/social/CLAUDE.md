# App: Social

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/social/`.

## Purpose
Public-facing social platform by NoisySource. Accessible to anyone but requires an account to interact.

## Visibility & Access
- **Public** — internet-facing
- Authentication via **Firebase Auth**
- No IAP (this is user-facing, not internal)

## Status
🆕 To be built from scratch — concept to be defined

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Backend | Firebase Cloud Functions (shared `/functions`) |
| Database | Firestore |
| Auth | Firebase Auth |
| Hosting | Firebase Hosting |

---

## Key Features (planned)
> To be defined. Core concept and feature set not yet scoped.

---

## Firestore Collections
> To be defined during build. Prefix all collections with `social_`.

---

## Notes
- This is the only NoisySource app that uses Firebase Auth (not IAP)
- Security rules in `functions/firestore.rules` must account for user-scoped data access
- Being public-facing, Firestore rules here are the most critical — review carefully before launch
- Hosting on Firebase (prod and dev environments)
