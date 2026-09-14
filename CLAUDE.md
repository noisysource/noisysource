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

Firebase/GCP projects (display names: "NoisySource Dev" / "NoisySource Prod"):
- prod: `rainbow-prod-2454b` (display: NoisySource Prod)
- dev: `kidclub-dev` (display: NoisySource Dev)

GitHub: `github.com/noisysource/noisysource`

---

## App Summary
| App | Company | Visibility | Auth | Status |
|---|---|---|---|---|
| KidClub | Noisy Phocus | Public | None | ✅ Live — refactor in progress |
| Finances | NoisySource | Private (IAP) | GCP IAP | ⚠️ Migrated, needs refactor |
| Domotics | NoisySource | Private (IAP) | GCP IAP | 🆕 To build |
| Tasks | NoisySource | Private (IAP) | GCP IAP | 🆕 To build |
| Social | NoisySource | Public | Firebase Auth | 🆕 To build |

---

## Shared Backend
All apps share Firebase Cloud Functions located in `/functions`.
- See `/functions/CLAUDE.md` for function conventions and structure
- Apps should never duplicate logic — always check `/functions` first
- Firestore security rules are also managed centrally

## Firestore Architecture
Single `(default)` database per project — both KidClub and FinHub share the same database within each environment. Collection scoping prevents conflicts:
- KidClub: `_apps/arcoiris/{collection}/...`
- FinHub: `finances_entities/{entityId}/{collection}/...`

This allows FinHub to read KidClub data directly for financial management (subscription revenue → income tracking).

---

## Key Principles
- **Minimum cost**: prefer Firebase free tier, scale to zero wherever possible
- **Simplicity**: avoid over-engineering; use Firebase native features before adding custom infrastructure
- **Shared logic**: all business logic lives in `/functions`, FE apps are thin clients
- **WebSockets**: Domotics may require persistent WebSocket connections in the future — Cloud Run will be evaluated when that time comes
- **IT ownership**: NoisySource manages all infra regardless of which company owns the app

---

## Cost & Production Safety

These rules exist because an uncapped, unrelated Google API (Routes API) once generated an unexpected ~€500 charge. The goal below is that a mistake costs a disabled feature, never surprise money.

- **Every metered external API must have a budget cap or quota limit set at the provider, before it ships** — not just be "free tier by default." A GCP budget alert alone is not enough; prefer a hard quota/cap that fails the call once exceeded over an alert that arrives after the money is spent.
- **No agent or session gets standing write or delete access to production Firestore, production billing systems (Vendus, EasyPay), or production GCP resources by default.** The `firestore-prod` MCP entry is deliberately not in the shared `.claude/settings.json` — see `mcp/firestore/index.js` and its README note. If a task genuinely needs prod reads, add it to your own gitignored `.claude/settings.local.json` for that session only, and remove it after.
- **`pnpm dev:*:prod` (dev server pointed at production Firebase) is for verifying against real data deliberately, not a default debugging step.** Prefer `pnpm dev:*` (dev project) for iterating, especially anything involving retries, loops, or a metered third-party API call.
- **Sandbox-first for billing/payment integrations.** Vendus and EasyPay both have sandbox environments; dev/staging should exercise those, never the live endpoints, until a change is deliberately being verified end-to-end. See `.claude/skills/sandbox-first-billing/SKILL.md`.
- **Never hardcode a live API token/secret into a command, a settings file, or an "always allow" permission rule.** Reference secrets via environment variables or `firebase functions:secrets`, never inline in a shell command that Claude Code then remembers as auto-approved.
- **A repeated/looping call to a metered API is the single biggest cost risk in this codebase** (it's what caused the €500 incident, and it's the same class of bug already seen in the domotics bridge retry logic). Any new integration with an external API should have an explicit max-retry/backoff and, where feasible, a per-run or per-day call cap in code, not just at the provider.

## Agent Workflow (branching, worktrees, commits, deploys)

This is a monorepo with several Claude Code sessions potentially running in parallel. To keep that safe and legible:

- **One task, one git worktree, one branch.** Never run a second piece of work by switching branches in the main checkout (`~/dev/noisysource`) — that yanks the working tree out from under anything else running there (other agents, a dev server, uncommitted changes). Instead: `git worktree add .claude/worktrees/<short-task-name> -b agent/<short-task-name>` and do the work there. `.claude/worktrees/` is gitignored — it's scratch space, not part of the repo.
- **Branch naming:** `agent/<short-task-name>` for agent-driven work (e.g. `agent/kidclub-sibling-discount`), matching the existing human convention of scoped commit prefixes (`feat(kidclub): ...`, `fix(domotics-bridge): ...`).
- **Commit as you go**, using the existing `type(scope): message` convention seen in `git log` — small, reviewable commits, not one giant diff at the end.
- **Push and open a PR against `main`** rather than pushing directly to `main`. Deploys are wired to `main`/`staging` (see `.github/workflows/`), so a PR is the checkpoint where you (or another agent doing review) actually look at the diff before anything can reach dev, let alone prod.
- **Deploys stay human-triggered for anything that touches prod.** `deploy-finances.yml` and `deploy-functions.yml` are `workflow_dispatch`-only (manual) — keep it that way. `build-and-deploy-kidclub.yml` auto-deploys on push to `main`/`staging`; an agent should only land on `main` via a reviewed PR, never push straight to it.
- **Clean up your worktree when the task is done:** `git worktree remove .claude/worktrees/<short-task-name>` after the branch is merged (or abandoned). A stale worktree is how real credentials end up copied into a forgotten folder (this happened once already — see the audit notes) — don't let it happen again.
- **Visibility:** if you're not sure what agents/worktrees currently exist, `git worktree list` from the main checkout shows every active one and its branch. Treat any worktree not shown there, or any branch you don't recognize, as something to ask about before building on top of it.
