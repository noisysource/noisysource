# App: Finances (FinHub)

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/`.

## Purpose
Internal finance management tool for NoisySource group. Tracks cash flow across 3 entities (Private, NoisySource, NoisyPhocus) with forecasting, payroll processing, and tax simulation.

## Visibility & Access
- **Private** — not internet-facing
- Protected by **GCP Identity-Aware Proxy (IAP)** at hosting layer
- Firebase Auth (Google Sign-in) for app-level identity
- Only 2 users: Renato + Marisa (via noisysource@gmail.com)

## Status
🔨 Phase 1 complete — foundation clean, build passing. Phase 2 next (entity + account setup).

---

## Entities (hardcoded, not dynamic)
| ID | Name | Type |
|---|---|---|
| `private` | Private | Household (Renato + Marisa) |
| `noisysource` | NoisySource | Company |
| `noisyphocus` | NoisyPhocus | Company |

## People
- **Renato**: salary from NoisySource + Exquisite Talent (both Cat A)
- **Marisa**: salary from NoisySource + ASFD (both Cat A)

---

## Firestore Collections (`finances_entities/{entityId}/{collection}`)
All data lives under `finances_entities/{entityId}/` sub-collections in the **(default)** Firestore database.

| Collection | Purpose |
|---|---|
| `accounts` | Bank accounts, vouchers, bonds — per entity |
| `categories` | Income/expense categories |
| `employmentContracts` | NoisySource employment contracts (Renato, Marisa) |
| `people` | Reference data: Renato, Marisa |
| `companies` | Reference data: NoisySource, NoisyPhocus |

**Planned (Phase 2+):**
| Collection | Purpose |
|---|---|
| `finances_income_sources` | Per-person income sources (employer, gross, IRS%) |
| `finances_contracts` | EC project contracts (daily rate, period, expected days) |
| `finances_recurring` | Recurring income/expense/transfer templates |
| `finances_events` | Forecast entries (from recurring + one-offs) |
| `finances_payroll_runs` | Processed payroll records |
| `finances_irs_config` | Per-year IRS config (external income + withheld) |

> Note: `finances_income_sources`, `finances_recurring`, etc. are top-level collections (not entity sub-collections) to allow cross-entity queries for the overview dashboard.

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite (port 5174) |
| Backend | Firebase Cloud Functions (shared `/functions`) |
| Database | Firestore (`(default)` database, shared with KidClub) |
| Auth | Firebase Auth (Google) + GCP IAP |
| Hosting | Firebase Hosting (target: `finances`) |

---

## Key Features (build order)

### Phase 1 — Foundation ✅
- Fix `formatEUR` export
- Drop double-entry ledger (too complex for now)
- Replace OrgContext with EntityContext (3 hardcoded entities)
- New Firestore path: `finances_entities/{entityId}/`

### Phase 2 — Entities & Accounts
- Entity management (Private, NoisySource, NoisyPhocus)
- Account CRUD with types: `checking | savings | voucher | bonds`
- Voucher accounts: restricted spending, balance + monthly top-up tracking
- Accounts: BPI/CGD/Montepio/Revolut/CTT (Private), BPI (NoisySource), BPI (NoisyPhocus)
- Vouchers: Renato (Meal×NS, Child×NS×2, Education×Exquisite Talent), Marisa (Meal×ASFD, Child×NS)

### Phase 3 — Income Sources & Payroll
- Income source model per person (employer, gross, IRS%, SS%)
- EC project contracts (daily rate × expected days = estimated invoice)
- Payroll processing (NoisySource → Renato + Marisa)
- NoisyPhocus worker (recibos verdes, monthly, payment prompt)

### Phase 4 — Recurring & Events
- Recurring income/expense/transfer model (~90% of cash flow)
- 12-month event generation from recurring entries
- One-off entries (forecast simulation)
- Payment prompts

### Phase 5 — Cash Flow Forecast
- Per account: running balance trajectory
- Per entity: sum of all accounts
- Household total
- 12-month chart

### Phase 6 — IRS Simulator
- Combined household income (Renato + Marisa, all 4 sources)
- Portuguese IRS joint household brackets
- Settlement estimate: refund or owe
- Monthly projection

### Phase 7 — IRC Estimation
- Per company: projected profit × 21% IRC
- Pagamentos por conta (July, Sept, Dec, April settlement)
- Appear in company forecast as forecast outflows

### Phase 8 — Vouchers & CTT
- Voucher balance, top-ups, spending entries
- CTT Certificados de Aforro: balance tracking

---

## Routing
```
/                           → Overview (all entities)
/private/accounts           → Private accounts + vouchers
/private/income             → Income sources
/private/forecast           → 12-month forecast
/private/irs                → IRS simulator
/noisysource/accounts       → NoisySource BPI
/noisysource/revenue        → EC project contracts
/noisysource/payroll        → Payroll
/noisysource/expenses       → Recurring expenses
/noisysource/forecast       → 12-month forecast
/noisysource/irc            → IRC estimation
/noisyphocus/accounts       → NoisyPhocus BPI
/noisyphocus/expenses       → Worker + operating expenses
/noisyphocus/capital        → Debt tracker + repayment forecast
/noisyphocus/forecast       → 12-month forecast
/accounts                   → Legacy (will be per-entity in Phase 2)
/categories                 → Categories (admin)
/employment/contracts       → Employment contracts
/employment/payroll         → Payroll preview
/admin/*                    → Admin pages
```

---

## Notes
- IAP setup reference: `../../../infra/gcp/`
- Firestore database: `(default)` — same database as KidClub (scoped by collection prefix)
- NoisyPhocus income from KidClub: deferred to next iteration
- Bank integration (Nordigen/GoCardless): future, not current priority
- IRS: Renato + Marisa file jointly (declaração conjunta)
