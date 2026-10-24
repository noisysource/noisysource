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
| Database | Firestore (`(default)` database, scoped under `_apps/arcoiris/`) |
| Auth | Firebase Auth (admin users only) |
| Hosting | Firebase Hosting |

## Firebase
- Dev project: `kidclub-dev` (NoisySource Dev) → site `kidclub-dev-arcoiris`
- Prod project: `rainbow-prod-2454b` (NoisySource Prod) → site `rainbow-prod-2454b-arcoiris`
- Firestore: `(default)` database, all KidClub data under `_apps/arcoiris/`

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
All under `_apps/arcoiris/` in the `(default)` database. Key collections:
- `config/featureFlags` — feature toggles
- `config/studyCenter` — study room pricing config
- `events` / `eventModifications` — calendar events
- `bookings` — party bookings
- `adhocEvents` / `adhocEventRegistrations` — one-off events (Halloween, strike days), open to guests; written only by Cloud Functions (`functions/src/kidclub/adhocEvents.ts`)
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
Automatic — see root CLAUDE.md's "Branch → environment pipeline". A PR into `staging`
deploys this app (+ rules/indexes/functions/terraform) to `kidclub-dev`; a merge to `main`
deploys everything to prod. You don't run these by hand in the normal flow.

Manual commands below are for local debugging only (e.g. a CI service-account permission
issue) — using them for a real deploy skips the PR review that's supposed to gate prod:
```bash
# Build + deploy to prod (manual/debug only — prefer the PR flow)
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

---

## Session start/end

Read `STATUS.md` (same folder) before starting work — it holds what's in progress, what's next, and anything open that needs Renato's decision. Update it before ending a session, even mid-task: current state, next concrete step, open questions, and anything risky left in flight. This is how Renato resumes cold after a context switch, so write it for someone with zero memory of this session, not as a changelog entry.
