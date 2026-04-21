# App: KidClub (Noisy Phocus)

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/kidclub/`.

## Purpose
Public-facing website for **KidClub**, owned by **Noisy Phocus**. This is the only Noisy Phocus app. IT and infrastructure are managed by NoisySource.

## Visibility & Access
- **Public** — fully internet-facing
- No authentication required
- No IAP

## Status
✅ Existing app — **migrated** into monorepo from standalone project
⚠️ Code cleanup pending — structure and conventions to be revised post-migration

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Backend | Firebase Cloud Functions (shared `/functions`) |
| Database | Firestore |
| Auth | None |
| Hosting | Firebase Hosting |

---

## Key Features
> To be documented after code cleanup and migration.

---

## Firestore Collections
> To be documented after code cleanup. Prefix all collections with `kidclub_`.

---

## ⚠️ Post-Migration TODOs
- [ ] Review and clean up existing component structure
- [ ] Move any inline backend logic to `/functions/src/kidclub/`
- [ ] Align naming conventions with monorepo standards
- [ ] Document actual features and collections here
- [ ] Review and update Firestore security rules

---

## Notes
- This was the original standalone project before the monorepo migration
- Owned by Noisy Phocus but fully managed by NoisySource IT
- Firebase Hosting configured for both prod and dev environments
