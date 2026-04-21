# App: KidClub (Noisy Phocus)

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/`.

## Purpose
Public-facing website for **KidClub** (Arco-Íris da Pequenada), owned by **Noisy Phocus**. Located in Coimbra — Avenida da Guarda Inglesa, Lote E.

## Visibility & Access
- **Public** — fully internet-facing
- No authentication required for customers
- Admin area protected by Firebase Auth (role-based)

## Status
✅ Live in production — refactor and feature work in progress.

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite, TypeScript |
| Styling | Tailwind CSS |
| Backend | Firebase Cloud Functions (shared `/functions`) |
| Database | Firestore (`kidclub` named database) |
| Auth | Firebase Auth (admin users only) |
| Hosting | Firebase Hosting |

## Firebase
- Dev project: `kidclub-dev` → site `kidclub-dev-arcoiris`
- Prod project: `rainbow-prod-2454b` → site `rainbow-prod-2454b-arcoiris`
- Firestore database name: `kidclub` (not `(default)`)

---

## Key Features
- **Party bookings** — customers book birthday parties (feature-flagged)
- **Summer/Christmas camps** — camp sign-ups (feature-flagged)
- **Study room** — after-school tutoring subscriptions (feature-flagged)
- **Transportation** — school transport subscriptions (feature-flagged)
- **Admin panel** — calendar, employees, expenses, HR, timesheets, email centre
- **Client portal** — families view schedules, invoices, children profiles
- Feature flags controlled via Firestore `config/featureFlags` document

## Firestore Collections
All prefixed with `kidclub_` (or under the `kidclub` named database). Key collections:
- `config/featureFlags` — feature toggles
- `config/studyCenter` — study room pricing config
- `events` / `eventModifications` — calendar events
- `bookings` — party bookings
- `families` / `children` — client family model
- `employees` — staff records
- `expenses` / `incomes` — financial tracking
- `emailOutbox` — triggers `sendEmailFromOutbox` function

---

## Local Dev
```bash
pnpm dev:kidclub        # runs on http://localhost:5173
pnpm dev:kidclub:prod   # dev server against prod Firebase
```

## Deploy
```bash
# Build + deploy to prod
pnpm --filter kidclub build
firebase deploy --only hosting:kidclub --project=rainbow-prod-2454b
```

---

## Post-Migration TODOs
- [ ] Review and clean up component structure
- [ ] Move any remaining inline backend logic to `/functions/src/`
- [ ] Align naming conventions with monorepo standards
- [ ] Review and update Firestore security rules
- [ ] Fix `SocialShare` placeholder URL in footer
