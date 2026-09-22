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
- **Branch naming:** `agent/<short-task-name>` for agent-driven work (e.g. `agent/kidclub-sibling-discount`); `feat/<name>`, `fix/<name>`, `infra/<name>`, `chore/<name>` for human-driven work — matching the existing scoped commit prefixes (`feat(kidclub): ...`, `fix(domotics-bridge): ...`). All feature/bugfix branches, agent or human, branch off `main`. A hotfix (see below) uses `hotfix/<name>`.
- **Commit as you go**, using the existing `type(scope): message` convention seen in `git log` — small, reviewable commits, not one giant diff at the end.

### Branch → environment pipeline

Three branches carry meaning; everything else is a short-lived feature/fix/hotfix branch:

- **`main`** — prod source of truth. **Only a PR whose head is `staging` deploys to prod pre-merge** (`.github/workflows/deploy-prod.yml` → the reusable `_deploy-kidclub-env.yml`): KidClub hosting, Firestore rules, Firestore indexes, Cloud Functions (`terraform apply` is currently disabled for prod specifically — see the note further down). A PR into `main` from any *other* branch does **nothing** — the deploy job is skipped by a `github.head_ref == 'staging'` guard. That guard exists because `branches: [main]` only filters the PR's *base*: before it, any branch with an open PR against `main` — including one opened by accident via GitHub's suggested "Compare & pull request" banner, which defaults its base to the repo default branch — turned every later push to that branch into a live prod deploy. That really happened (2026-09-21/22): an `agent/*` branch silently deployed WIP Cloud Functions to prod three times over one session, and it had already happened once before on another branch. Merging is required as a **GitHub branch-protection rule**: the `deploy` check must pass before the merge button is even clickable. A merge itself (push to `main`) always re-runs the deploy against the merged state, and is what triggers `sync-staging` (below).
- **`staging`** — dev/staging integration branch. Opening or updating a PR that targets `staging` deploys a live preview to `kidclub-dev` the same way (`.github/workflows/deploy-dev.yml`) — app, rules, indexes, functions, terraform, against the dev project. This is where Renato actually clicks through a change before it goes anywhere near prod.
- **`hotfix/<name>`** — branches off `main` directly (skips `staging`) for an urgent prod fix. PR targets `main` directly. Since the head-branch guard above only lets `staging` deploy pre-merge, a hotfix PR does **not** deploy when opened — it deploys **on merge** (the push to `main`). If you want pre-merge deploy verification for hotfixes too, add `|| startsWith(github.head_ref, 'hotfix/')` to the deploy job's `if:` in `deploy-prod.yml`. Either way, after any merge to `main`, a `sync-staging` job automatically fast-forwards `staging` to match `main`, or opens a `sync/main-to-staging-*` PR if `staging` has diverged and can't fast-forward. This is what keeps dev from drifting behind a hotfixed prod — don't skip reviewing that sync PR if one appears.

Normal flow end-to-end: branch off `main` → PR into `staging` (deploys to dev automatically, iterate here) → once Renato's tested it on dev, open a second PR from `staging` into `main` (**this** is the one that deploys to prod, pre-merge — `ci-checks.yml` runs build/typecheck/terraform-validate on the same PR as a faster parallel signal, but the real gate is the deploy job) → once it's green, merge is unblocked by branch protection → merge re-deploys the final state and triggers staging auto-sync.

**Known consequence of deploy-on-PR**: prod can be running code from an open, unmerged `staging`→`main` PR between "deploy succeeded" and "someone actually merges." That's an accepted tradeoff (staging/dev already worked this way), not a bug — but it means an abandoned-but-deployed promotion PR leaves prod ahead of `main` until either merged or reverted with a real deploy, same as it would for dev.

- **Push and open a PR** rather than pushing directly to `staging` or `main` — same reasoning as always (diff review). **Always check the base branch when opening a PR**: GitHub defaults it to the repo's default branch (`main`), not `staging`, so a PR opened by clicking through the post-push banner will target the wrong branch. A stray `agent/*` → `main` PR is now inert rather than prod-deploying, but it's still the wrong target and will sit there confusing the next person.
- **`deploy-finances.yml` and `deploy-functions.yml` stay `workflow_dispatch`-only (manual)** — Finances hasn't been brought into the staging/main pipeline yet (functions get deployed as part of the KidClub pipeline already, since `/functions` is shared; these two workflows remain as manual fallback/emergency tools). Bringing Finances onto the same model is a known follow-up, not done yet.
- **Terraform in CI runs `apply`, not just `plan`, on every deploy** — the GCS backend prefixes are `kidclub-dev` (dev) and `rainbow-prod-2454b` (prod); verified directly against the `kidclub-terraform-state` bucket, don't assume/guess a different prefix if you're touching this. If a CI terraform step ever fails on a permissions error, the service account is missing an IAM role for whatever resource type triggered it — fix by adding the role in `infra/gcp/terraform/iam.tf` and having Renato apply it once by hand (CI can't grant itself permissions it doesn't have yet).
- **Clean up your worktree when the task is done:** `git worktree remove .claude/worktrees/<short-task-name>` after the branch is merged (or abandoned). A stale worktree is how real credentials end up copied into a forgotten folder (this happened once already — see the audit notes) — don't let it happen again.
- **Visibility:** if you're not sure what agents/worktrees currently exist, `git worktree list` from the main checkout shows every active one and its branch. Treat any worktree not shown there, or any branch you don't recognize, as something to ask about before building on top of it — this includes stale/abandoned branches pushed to origin that never got cleaned up; don't assume a branch that exists is safe to build on top of.

### Session start/end ritual

Renato works on this solo, alongside a full-time job elsewhere, switching between KidClub (live/prod), Finances, and Domotics in short, fragmented sessions. Losing track of where a given app was left is the main real cost of that switching — treat it as a correctness problem, not a nice-to-have.

- Each app (`apps/noisyphocus/kidclub`, `apps/noisysource/finances`, `apps/noisysource/domotics`) has a `STATUS.md`. Read it at the start of any session on that app. Update it before ending one — including mid-task, including when interrupted — with: what's currently in progress, what was last completed, the concrete next step, any open question that needs Renato's decision, and anything risky left in flight (a prod-touching change, an unreviewed PR, a new metered API call).
- Write `STATUS.md` for someone with zero memory of the session, because that's usually exactly who reads it next — Renato after a context switch, or a fresh agent with no prior context.
- A cross-app data/feature dependency (e.g. "KidClub now produces a field FinHub needs") goes in the "Cross-App Data Contracts" section below, not just in one app's STATUS.md, so the other app's agent finds it without being told where to look.

## Cross-App Data Contracts

Running log of data or behavior one app produces that another app consumes. Add an entry here whenever a change in one app matters to another; the consuming app's agent should check this section, not rely on being told verbally each time.

_(none yet — add entries as they come up, e.g.: "KidClub `families/{id}.transportDiscountTotal` (added <date>) — FinHub should read this for the sibling-discount income report instead of recomputing it.")_
