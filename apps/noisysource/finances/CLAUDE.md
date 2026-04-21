# App: Finances

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/finances/`.

## Purpose
Internal finance management tool for NoisySource. Covers personal finances, company accounts, projects, and investment portfolios.

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
- Personal finance tracking (income, expenses, budgets)
- Company accounts management
- Project-based financial tracking
- Investment portfolio overview
- Integration with bank data (Nordigen/GoCardless API — TBD via Cloud Functions)

---

## Firestore Collections
> To be defined during build. Prefix all collections with `finances_`.

---

## Notes
- Previously explored with Nordigen/GoCardless API for Portuguese bank integration — revisit during build
- IAP setup reference: `../../../infra/gcp/`
