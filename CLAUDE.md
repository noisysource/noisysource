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
├── firebase.json, .firebaserc, firestore.rules   ← one Firebase config for every app (today)
├── functions/                       ← shared Firebase Cloud Functions (all apps)
├── packages/shared/                 ← code shared by the apps
├── apps/
│   ├── noisysource/                 ← NoisySource internal apps
│   │   ├── finances/                ← Finance management (private)
│   │   ├── domotics/                ← Home/building automation (private)
│   │   ├── domotics-bridge/         ← the Raspberry Pi bridge (deployed by hand)
│   │   ├── tasks/                   ← Task management & event tracking (private, not built)
│   │   ├── social/                  ← Social platform (public, auth-required, not built)
│   │   └── website/                 ← noisysource.com, the public website (see its STATUS.md)
│   └── noisyphocus/
│       └── kidclub/                 ← KidClub public website (Noisy Phocus)
└── infra/
    ├── HANDOFF-repo-restructure.md  ← the plan to split all of this per project pair
    └── gcp/                         ← Terraform, GCP reorg handoff
```

**This layout is being restructured** to match the Google Cloud layout: one deploy unit per
project pair (`firebase/kidclub`, `firebase/noisysource`). Domotics has moved to the
`noisysource-*` projects (done 2026-11-16); FinHub follows. The plan, the PR order and its progress are in
`infra/HANDOFF-repo-restructure.md`; read it before touching `firebase.json`, the rules,
`functions/`, Terraform or the workflows.

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

Google Cloud layout (reorganised 2026-11-10; org `kidclub.pt`; every billed project is on **NoisySource Central Billing** `01B2DE-83C5F5-B12BC9`, because NoisySource pays for everything):
- Folder **Noisy Phocus** — KidClub's projects, for good (project IDs can't be renamed):
  - prod: `rainbow-prod-2454b` (display: KidClub Prod)
  - dev: `kidclub-dev` (display: KidClub Dev)
- Folder **NoisySource** — the IT company's own projects:
  - `noisysource-prod` / `noisysource-dev` (NoisySource Prod / Dev): billed. Domotics lives here since 2026-11-16 (its own rules, functions, site and pipeline, in `firebase/noisysource/`; the house's live data is in `noisysource-prod`). FinHub follows; until it has moved, it still runs in `rainbow-prod-2454b` / `kidclub-dev` as described below. **A merge into `staging` deploys the NoisySource unit to `noisysource-prod`** (`.github/workflows/deploy-noisysource-prod.yml`): for the private tools a merge is the release, and the `staging` → `main` promotion is KidClub's alone.
  - `noisysource-agent` (display: Jarvis): Renato's NoisySource agent. No billing, Workspace APIs only, keyless service account.

What was done in Google Cloud: `infra/gcp/HANDOFF-gcp-reorg.md`. The repo-side plan and what's left: `infra/HANDOFF-repo-restructure.md`.

GitHub: `github.com/noisysource/noisysource`

---

## App Summary
| App | Company | Visibility | Auth | Status |
|---|---|---|---|---|
| KidClub | Noisy Phocus | Public | None | ✅ Live — refactor in progress |
| Finances | NoisySource | Private (IAP) | GCP IAP | ⚠️ Migrated, needs refactor |
| Domotics | NoisySource | Private | Google sign-in, owner only (`admin@noisysource.com`) | ✅ Live on `noisysource-prod` |
| Tasks | NoisySource | Private (IAP) | GCP IAP | 🆕 To build |
| Social | NoisySource | Public | Firebase Auth | 🆕 To build |
| Website (noisysource.com) | NoisySource | Public | None | 🆕 First version: sites `noisysource-{dev,prod}-website`, custom domain waiting on DNS |

---

## Shared Backend
All apps share Firebase Cloud Functions located in `/functions`.
- See `/functions/CLAUDE.md` for function conventions and structure
- Apps should never duplicate logic — always check `/functions` first
- Firestore security rules are also managed centrally

## Firestore Architecture
**Today:** one `(default)` database per KidClub project (`kidclub-dev`, `rainbow-prod-2454b`), shared by KidClub and FinHub and kept apart by collection:
- KidClub: `_apps/arcoiris/{collection}/...`
- FinHub: `finances_entities/{entityId}/{collection}/...`, `finhub/{company}/events` (v2) and the other `finances_*` / `vault_*` roots

So today FinHub reads KidClub data directly.

**Where it's going** (decided 2026-11-10): each company gets its own database. Domotics already has its own (`domotics_*` collections in `noisysource-dev` / `noisysource-prod`, `europe-west3`, rules in `firebase/noisysource/firestore.rules`); FinHub moves there too, and each company writes only to its own. Cross-company reads go through Cloud Functions with read-only cross-project access: FinHub reads KidClub billing, KidClub reads FinHub's `costSummary`. Don't build new direct cross-app reads from the browser.

## Shared Integrations
Third-party accounts already set up that any app can build on. Credentials are never in the repo: **ask Renato for them before starting.**

- **Tesla Fleet API** (set up and tested 2026-10-26, then torn down). A developer app is registered at developer.tesla.com: client ID `be39cf7c-7435-456f-8cbe-327e2316b5bc`, grant types authorization code + client credentials, allowed origin `https://noisysource-energy.web.app`, redirect `http://localhost:8765/callback`, partner registration done for the EU region. A one-off local script proved it by downloading every Supercharger invoice for July–October 2026. Fits FinHub (Supercharger invoices → expenses) and Domotics (charging data, solar-surplus charging from the RENAC readings).
  - **Before using it, ask Renato** for the client secret (rotated after the test) and confirm the Tesla account and billing limit. It's metered (pay-per-use, $10/month credit), so run `new-metered-api-checklist`, cap calls in code, and never poll a sleeping car.
  - **Missing: the key-hosting website.** Tesla requires the app's public key (EC prime256v1) to stay hosted at `https://<origin>/.well-known/appspecific/com.tesla.3p.public-key.pem`. The `noisysource-energy` site and the key pair were deleted after the test, so none of this exists today. To use the API again: create the site (add it to `firebase.json` without the `**/.*` ignore the other sites have, or `.well-known/` is silently dropped; if the name can't be reused, change the allowed origin in the Tesla dashboard), generate a new key pair (private key outside the repo), host the public key, and re-register with `POST /api/1/partner_accounts`. Vehicle commands (charge amps, start/stop) also need that key paired to the car as a virtual key.
  - API notes from the test: `GET /api/1/dx/charging/history?startTime&endTime&pageNo&pageSize` (ISO 8601 with offset, pages start at 1, `sortBy=chargeStartDateTime` is rejected with 400); each session has `invoices[].contentId` and `fees[]` (`CHARGING` / `CONGESTION`, `totalDue`, kWh usage). `GET /api/1/dx/charging/invoice/{contentId}` returns the PDF. Login is OAuth authorization code at `auth.tesla.com`, tokens from `fleet-auth.prd.vn.cloud.tesla.com` with audience `https://fleet-api.prd.eu.vn.cloud.tesla.com`; refresh tokens are single-use, so save the new one on every refresh. Road-trip invoices come from Tesla's Spanish/French/Belgian companies, with foreign VAT.

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

## Everyday Workflow

Renato works this repo solo, alongside a full-time job elsewhere, switching between dev work and company management (finances, admin, vendor stuff) in short, fragmented sittings. The mental model is **three containers, not "one chat per thing":**

1. **Looking** (data checks, prod reads, "is this live/correct right now") — no worktree, no branch. It's read-only, so just work in the regular main-checkout session. For prod specifically, add the needed access to your own gitignored `.claude/settings.local.json` for that session and remove it after (see Cost & Production Safety) — never make prod access standing.
2. **Building** (a feature or bugfix — any actual code change) — always its own git worktree + branch, per "One task, one git worktree, one branch" below. This holds regardless of how small the fix is; the point of the rule is to keep code edits out of the main checkout, not to size-gate it.
3. **Managing** (finances/admin, non-code) — same as Looking, no worktree, but see "Session & token discipline" below for when this should split into its own session.

**The boundary that matters is "does this need a worktree," not "is this a new chat."** Staying in one chat for several small related things in the same app is fine. What forces a split is starting to edit code (→ container 2) or switching domains for anything non-trivial (→ see below).

**Found a bug or feature idea mid data-check?** Don't turn the investigation session into an editing session. Instead:
- **Small/quick fix** — ask for it to be handed off to the right scoped agent (`domotics-feature`, `kidclub-feature`, `finances-app`, etc.). It creates its own worktree/branch, does the fix, opens a PR, and reports back, while the investigation session stays uninterrupted.
- **Bigger feature** — don't build it inline. Note it (the relevant app's `STATUS.md` "Next step," or just say "remember this") and start a dedicated session for it later: a fresh terminal `cd`'d into a new `git worktree add`, or ask the current session to open one.

## Agent Workflow (branching, worktrees, commits, deploys)

This is a monorepo with several Claude Code sessions potentially running in parallel. To keep that safe and legible:

- **One task, one git worktree, one branch.** Never run a second piece of work by switching branches in the main checkout (`~/dev/noisysource`) — that yanks the working tree out from under anything else running there (other agents, a dev server, uncommitted changes). Instead: `git worktree add .claude/worktrees/<short-task-name> -b agent/<short-task-name>` and do the work there. `.claude/worktrees/` is gitignored — it's scratch space, not part of the repo.
- **Branch naming:** `agent/<short-task-name>` for agent-driven work (e.g. `agent/kidclub-sibling-discount`); `feat/<name>`, `fix/<name>`, `infra/<name>`, `chore/<name>` for human-driven work — matching the existing scoped commit prefixes (`feat(kidclub): ...`, `fix(domotics-bridge): ...`). All feature/bugfix branches, agent or human, branch off `staging` (their PR targets `staging`, so branching from anything else produces PRs that can't compute a merge ref or that patch files `staging` has since changed). A hotfix (see below) is the one exception: it branches off `main` and uses `hotfix/<name>`.
- **Commit as you go**, using the existing `type(scope): message` convention seen in `git log` — small, reviewable commits, not one giant diff at the end.

### Branch → environment pipeline

Three branches carry meaning; everything else is a short-lived feature/fix/hotfix branch:

- **`main`** — prod source of truth. **Only a PR whose head is `staging` deploys to prod pre-merge** (`.github/workflows/deploy-prod.yml` → the reusable `_deploy-kidclub-env.yml`): KidClub hosting, FinHub hosting, Firestore rules, Firestore indexes, Cloud Functions (`terraform apply` is currently disabled for prod specifically — see the note further down). A PR into `main` from any *other* branch does **nothing** — the deploy job is skipped by a `github.head_ref == 'staging'` guard. That guard exists because `branches: [main]` only filters the PR's *base*: before it, any branch with an open PR against `main` — including one opened by accident via GitHub's suggested "Compare & pull request" banner, which defaults its base to the repo default branch — turned every later push to that branch into a live prod deploy. That really happened (2026-09-21/22): an `agent/*` branch silently deployed WIP Cloud Functions to prod three times over one session, and it had already happened once before on another branch. Merging was meant to be gated by a **GitHub branch-protection rule** (the `deploy` check must pass before the merge button is clickable), but **it isn't enforced (verified 2026-10-12)**: this is a private repo on a free personal account, and GitHub answers "Upgrade to GitHub Pro or make this repository public" for both branch protection and rulesets. Until that changes, check the deploy is green yourself before merging. A merge itself (push to `main`) always re-runs the deploy against the merged state, and is what triggers `sync-staging` (below).
- **`staging`** — dev/staging integration branch. Opening or updating a PR that targets `staging` deploys a live preview to `kidclub-dev` (`.github/workflows/deploy-dev.yml`). This is where Renato actually clicks through a change before it goes anywhere near prod. **Dev deploys only the parts a change touches** (since 2026-10-18): a PR deploys what it changes on top of `staging`, and a push to `staging` (a merge) deploys what that push changed. Parts: terraform (`infra/gcp/terraform/`), Firestore rules / indexes / storage rules (each its own file), Cloud Functions (`functions/`), and KidClub / FinHub hosting (their app folders). Domotics is not a part of this unit: its folder deploys nothing here, and deploys through the NoisySource unit instead (below). A `packages/shared/` change deploys only the apps whose code imports the changed file (traced through imports, so a FinHub-only model doesn't redeploy KidClub); `pnpm-lock.yaml` deploys only the packages whose dependencies changed; docs (`*.md`), `scripts/`, `mcp/` and the Pi bridge deploy nothing; the pipeline itself (`.github/`), root `package.json`, `pnpm-workspace.yaml`, `firebase.json`, `.firebaserc`, root tsconfig/vite/tailwind/postcss config, and any file no rule knows about deploy **everything**. The rules live in `.github/scripts/deploy-parts.mjs` (with tests next to it); the "Plan + build" job's summary on each run says what deployed and why. Before this, every PR redeployed every part from its own branch, so parallel PRs kept reverting each other's previews on dev, and with one concurrency group for the whole environment, a queued run could be silently dropped (2026-10-17: #106's functions change never reached dev). Now each part is its own job with its own concurrency group: different parts never block or cancel each other; two runs touching the same part still queue on it. Consequences: dev is a patchwork, each part showing whatever last deployed it; a PR's preview of a part is replaced when another PR touching that part deploys or merges (merge `staging` into your branch and push to put yours back); a PR closed without merging leaves its preview behind until something redeploys that part. **Actions → Deploy to Dev → Run workflow** on `staging` puts all of `staging` back on dev. Domotics deploys to `kidclub-dev-domotics` like the other apps (since 2026-10-18; it was deployed by hand before), building with its committed `apps/noisysource/domotics/.env.staging`.
- **`hotfix/<name>`** — branches off `main` directly (skips `staging`) for an urgent prod fix. PR targets `main` directly. Since the head-branch guard above only lets `staging` deploy pre-merge, a hotfix PR does **not** deploy when opened — it deploys **on merge** (the push to `main`). If you want pre-merge deploy verification for hotfixes too, add `|| startsWith(github.head_ref, 'hotfix/')` to the deploy job's `if:` in `deploy-prod.yml`. Either way, after any merge to `main`, a `sync-staging` job automatically fast-forwards `staging` to match `main`, or opens a `sync/main-to-staging-*` PR if `staging` has diverged and can't fast-forward. This is what keeps dev from drifting behind a hotfixed prod — don't skip reviewing that sync PR if one appears. **Known gap (2026-10-07):** opening that sync PR currently fails (`GitHub Actions is not permitted to create or approve pull requests`), which marks the merge run as failed even though the prod deploy itself succeeded — check which job failed before assuming the deploy did. Fix: repo Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". Until then, sync `staging` by hand when it has diverged.

Normal flow end-to-end: branch off `staging` → PR into `staging` (deploys to dev automatically, iterate here) → once Renato's tested it on dev, open a second PR from `staging` into `main` (**this** is the one that deploys to prod, pre-merge — `ci-checks.yml` runs build/typecheck/terraform-validate on the same PR as a faster parallel signal, but the real gate is the deploy job) → once it's green, merge (check it's green first: branch protection isn't enforced, see above) → merge re-deploys the final state and triggers staging auto-sync.

**Known consequence of deploy-on-PR**: prod can be running code from an open, unmerged `staging`→`main` PR between "deploy succeeded" and "someone actually merges." That's an accepted tradeoff (staging/dev already worked this way), not a bug — but it means an abandoned-but-deployed promotion PR leaves prod ahead of `main` until either merged or reverted with a real deploy, same as it would for dev.

- **Push and open a PR** rather than pushing directly to `staging` or `main` — same reasoning as always (diff review). **Always check the base branch when opening a PR**: GitHub defaults it to the repo's default branch (`main`), not `staging`, so a PR opened by clicking through the post-push banner will target the wrong branch. A stray `agent/*` → `main` PR is now inert rather than prod-deploying, but it's still the wrong target and will sit there confusing the next person.
- **FinHub deploys with KidClub** (since 2026-10-12): the same reusable workflow builds FinHub (`build:staging` for dev, `build` for prod) and deploys `hosting:finances` in its own job. Everything a run is going to deploy is built first, in the "Plan + build" job, and it refuses to go on unless every built bundle's Firebase `projectId` is the target project (a dev build in prod deploys fine and then breaks login). **Prod always deploys every part** (`only_changed: false` in `deploy-prod.yml`): prod must match what's promoted, whatever the diff. **`deploy-finances.yml` and `deploy-functions.yml`** stay as `workflow_dispatch` manual fallbacks for redeploying one piece alone; `deploy-finances.yml` deploys dev only from `staging` and prod only from `main`.
- **Domotics deploys through the NoisySource unit only** (since 2026-11-16; steps and decisions in `infra/HANDOFF-repo-restructure.md`). Nothing of it is left in the KidClub unit: no rules block, no functions, no hosting target. A PR into `staging` previews on `noisysource-dev` (the `noisysource` job of `deploy-dev.yml`, build `build:nsdev`), and **the merge into `staging` deploys to `noisysource-prod`** (`deploy-noisysource-prod.yml`, build `build:nsprod`), so merging a Domotics PR is releasing it to the live house. Rules: `firebase/noisysource/firestore.rules`; callables: `firebase/noisysource/functions/src/domotics/`. The Pi bridge publishes to `noisysource-prod` as `domotics-bridge@kidclub.pt` (project and credentials in the Pi's `bridge.env`); the owner is `admin@noisysource.com`; the site is `noisysource-prod-domotics.web.app`. `noisysource-prod` is production: no standing write access, like KidClub's. One bridge serves one project.
- **Terraform in CI runs `apply`, not just `plan`, whenever it deploys** (on dev: any PR/push that touches `infra/gcp/terraform/` or something that deploys everything) — the GCS backend prefixes are `kidclub-dev` (dev) and `rainbow-prod-2454b` (prod); verified directly against the `kidclub-terraform-state` bucket, don't assume/guess a different prefix if you're touching this. If a CI terraform step ever fails on a permissions error, the service account is missing an IAM role for whatever resource type triggered it — fix by adding the role in `infra/gcp/terraform/iam.tf` and having Renato apply it once by hand (CI can't grant itself permissions it doesn't have yet).
- **Clean up your worktree when the task is done:** `git worktree remove .claude/worktrees/<short-task-name>` after the branch is merged (or abandoned). A stale worktree is how real credentials end up copied into a forgotten folder (this happened once already — see the audit notes) — don't let it happen again.
- **Visibility:** if you're not sure what agents/worktrees currently exist, `git worktree list` from the main checkout shows every active one and its branch. Treat any worktree not shown there, or any branch you don't recognize, as something to ask about before building on top of it — this includes stale/abandoned branches pushed to origin that never got cleaned up; don't assume a branch that exists is safe to build on top of.

### Session start/end ritual

Renato works on this solo, alongside a full-time job elsewhere, switching between KidClub (live/prod), Finances, and Domotics in short, fragmented sessions. Losing track of where a given app was left is the main real cost of that switching — treat it as a correctness problem, not a nice-to-have.

- Each app (`apps/noisyphocus/kidclub`, `apps/noisysource/finances`, `apps/noisysource/domotics`) has a `STATUS.md`. Read it at the start of any session on that app. Update it before ending one — including mid-task, including when interrupted — with: what's currently in progress, what was last completed, the concrete next step, any open question that needs Renato's decision, and anything risky left in flight (a prod-touching change, an unreviewed PR, a new metered API call).
- Write `STATUS.md` for someone with zero memory of the session, because that's usually exactly who reads it next — Renato after a context switch, or a fresh agent with no prior context.
- A cross-app data/feature dependency (e.g. "KidClub now produces a field FinHub needs") goes in the "Cross-App Data Contracts" section below, not just in one app's STATUS.md, so the other app's agent finds it without being told where to look.

### Session & token discipline

Renato is one person covering both the dev cycle and company management (finances, admin, vendor stuff), often in the same sitting, and sessions can run long. Long, topic-mixed sessions are the main token cost here — not parallel agents, which are already scoped by the worktree rules above.

- **Flag domain drift.** If a session that started as dev work (code, a bug, a feature) drifts into company-management territory (billing, vendor decisions, admin) — or vice versa — and it looks like that new thread will run for a while, ask once whether to continue in this session or start a fresh one. Don't decide unilaterally either way; it's a one-line check-in, not a hard rule.
- **Checkpoint at topic switches, not just at the end.** Treat a domain switch as a STATUS.md moment too, the same as ending a session — update the relevant app's STATUS.md before moving on, so nothing in flight gets lost when the topic changes.
- **Scope worktree agents narrowly.** When running multiple agents in parallel (2-3 is normal here), keep each one's task to one app/one file-area rather than needing the full cross-app picture — that's what keeps those sessions short, more than any model/effort tuning would.
- **Watch for drift continuously, not just at domain switches.** Any time a session starts running long, loses focus (several unrelated things stacked in one thread), or is clearly heading toward real spend, say so — don't wait to be asked and don't just push through. Name the specific signal ("this has drifted from the bug into an unrelated refactor," "this is the third topic in one session," "this is getting long/expensive") and suggest a concrete next step: write the open thread to the relevant `STATUS.md` and drop it, hand it off to a scoped worktree agent, or start a fresh session for it. Keep the flag itself to one or two lines — it's a nudge with a suggested action, not a report, and Renato decides, not the agent.
- **End-of-session nudge.** Before wrapping up a session (explicit "done for now," or a natural stopping point), check in briefly: run `/cost` to note the session's spend, confirm whether the relevant STATUS.md is current, and flag anything risky left in flight (per the ritual above). Keep this to one or two lines — it's a habit-forming nudge, not a report.

## Cross-App Data Contracts

Running log of data or behavior one app produces that another app consumes. Add an entry here whenever a change in one app matters to another; the consuming app's agent should check this section, not rely on being told verbally each time.

_(none yet — add entries as they come up, e.g.: "KidClub `families/{id}.transportDiscountTotal` (added <date>) — FinHub should read this for the sibling-discount income report instead of recomputing it.")_

- **VAT convention, both apps** (decided 2026-10-11; **FinHub + the shared helper done in #87; KidClub in PR 2, #89**): amounts stored on anything that's a payment or invoice (billing lines/totals, recurring entries, expenses, bank transactions) are **VAT-inclusive** and carry an explicit VAT code (`23 | 13 | 6 | 0 | isento | autoliquidacao | por_confirmar`, never a silent 0). Net and VAT are derived via `packages/shared/lib/vat.ts` (mirrored in `functions/`). Price lists keep their storage and are labelled wherever edited: KidClub party config and `Booking.total` and the EC daily rate are **sem IVA**; KidClub transport/study room prices, enrollment fee and insurance are **com IVA** (verified 2026-10-12: families are billed exactly those, VAT inside; Vendus rates study/enrollment/insurance 23%, transport 6%, in `KIDCLUB_VAT`, `packages/shared/models/kidclubVat.ts`). So a KidClub bill's `total` is gross; FinHub derives net per line type, or uses Vendus's per-rate figures. Rates are percent integers in new code. Both apps show the VAT-inclusive amount first, with "sem IVA · IVA" beside it. Details, current gaps and open questions: `packages/shared/HANDOFF-vat-convention.md`. Since #87, FinHub's `finances_entities/noisyphocus/costSummary/{yyyy-mm}` docs (for KidClub's future Resumo Financeiro) carry `totalCostCents` **com IVA** plus `totalNetCents` sem IVA; read through `CostSummaryDoc` in `packages/shared/models/CostSummary.ts`.
- **KidClub invoices without a NIF go to "Consumidor final", with no Vendus client** (decided 2026-10-13, Renato's option B; branch `agent/kidclub-nif-consumidor-final`, not in prod until promoted): from this change, a family without a NIF (`families/{id}.nif` missing/blank, or `999999990`) is invoiced with no `client` on the Vendus document, so the FR shows "Consumidor final" and Vendus's `client` is `null`. That includes ~10 families still holding an old NIF-less `vendusClientId`: it's no longer used, so the client name on their past invoices won't match their new ones. Families with a NIF are unchanged (invoiced to their client). `families/{id}.nifOptOut: true` means the parent ticked "Não pretendo NIF na fatura" (UI only; billing reads `nif` alone). **FinHub's KidClub reconciliation (`apps/noisysource/finances/HANDOFF-kidclub-reconciliation.md`) must link Vendus documents to bills through the bill's `invoiceNumber` / `vendusId` (on `_apps/arcoiris/billing/{id}`), never through the Vendus client name or id** (every Consumidor final document KidClub issues has a bill with those fields). Checked: `getKidclubVatSummary` (`functions/src/kidclub/vatSummary.ts`) only reads `taxes`, and `getInvoicePdf` (`invoicePdf.ts`) goes bill → `vendusId`, so neither assumes a client.
- **KidClub one-off events produce new kinds of billing** (added 2026-10-20, branch `agent/kidclub-events`, not in prod until promoted; details in `apps/noisyphocus/kidclub/STATUS.md`). (1) **Bills of their own:** `_apps/arcoiris/billing/{id}` with `type: "event"` and `eventRegistrationId`. For a **guest** (no KidClub account) `familyId` and `userId` are `""`, and the guest's NIF, if any, is in `guestNif`. So FinHub must not assume every bill has a family; link it to its Vendus document through `invoiceNumber` / `vendusId` as above. (2) **Lines on monthly bills:** a family can put an event on `billing/{familyId}_{yyyy-mm}`, as lines with `type: "event"` and `subscriptionId: "event:{registrationId}:{childIndex}"`. Every event line is **com IVA at 23%** (Vendus `PRODUCT_STUDY`, `KIDCLUB_VAT.event`). Registrations live in `_apps/arcoiris/adhocEventRegistrations`. KidClub's Resumo Financeiro doesn't count event lines yet; FinHub income reports should treat them as their own category (not study room) if they ever split income by service.
- **Atlas hears about visitors who wake it on noisysource.com** (added 2026-11-17, branch `agent/noisysource-website`; live in `noisysource-prod` once merged into `staging`). The website's `atlasGate` function (`firebase/noisysource/functions/src/website/atlasGate.ts`) writes one document per conversation to **`atlas_awakenings/{sessionId}`**: `who` (`recruiter | investor | manager | colleague | curious | other | unknown`), `why` (one line), `how` (`star | typed | unknown`), `ref` (referrer), `transcript` (`[{from: "visitor"|"atlas", text}]`, the phrase redacted as `[the phrase]`), `turns`, `unlockedTurns`, `unlocked` (they gave the right words), `role` (once unlocked: a key's role, or `auto` = Atlas's guess), `keyLabel` (which personal key, or `shared phrase`), `test` (the maker testing from the panel; such docs are already `seen: true`), `asleep`, `stoppedBy`, `createdAt`, `updatedAt` (no IPs or user agents, on purpose), and **`seen`** (set back to `false` on every new message). Atlas (`atlas@kidclub.pt`) and the owner may read them and update **only** `seen` (rules in `firebase/noisysource/firestore.rules`). That's how Atlas tells Renato "somebody's trying to reach you". **Atlas may also read and write `atlas_gate/access`**, the roles × topics matrix and personal keys (`{topics: {profile|infrastructure|business|product|apps: string}, roles: {recruiter|investor|manager|colleague|curious|other: Topic[]}, keys: [{phrase, role, label, enabled}]}`; the gate re-validates it with `cleanAccess` in `atlasGateLogic.ts`), so the switches can move into the Atlas app. The gate itself has no tools and no private data and never talks to Atlas. **Changing these fields means telling Atlas.**
- **Atlas reads and runs the house through the Domotics backend** (added 2026-11-16, branch `agent/atlas-house`; live in `noisysource-prod` once merged into `staging`). Atlas is Renato's assistant, **outside this monorepo** (repo `noisysource/Atlas`, on his Mac). It signs in as its own Firebase Auth user `atlas@kidclub.pt` (verified; `isAtlas()` in `firebase/noisysource/firestore.rules`, `requireOwnerOrAgent` in `firebase/noisysource/functions/src/auth.ts`), and every change it makes waits for Renato's OK in Atlas. It depends on: (1) the document shapes of `domotics_state/tuya`, `domotics_energy/{date}`, `domotics_climate/{date}`, `domotics_incidents` and `domotics_config/{automation,tariff,warm_by}` (`guard` too until 2026-11-22: the E13 guard was removed from the bridge that day, so the `guard` document is no longer read and `domotics_state/tuya` loses its `guard` block once the Pi runs that build; Atlas should stop relying on both); (2) the `domotics_commands` shape the rules hold it to: `{deviceId, commands: [{code, value}], createdAt}` with 1–2 commands, `code` one of `temp_set` / `mode` / `switch`, `createdAt` the server time; (3) the callables `legrandGetHome`, `legrandGetStatus`, `legrandSetState` (from Atlas, `modules` is 1–30 entries of `{id, bridge?, on?, target_position?, brightness?}`), `domoticsWarmBy` and `domoticsEnergyBill` (`{from, to}` → the result of `buildEnergyBillReport` in `firebase/noisysource/functions/src/domotics/energyBillReport.ts`). **Changing any of these, in the bridge, the app, the rules or the functions, means telling Atlas** (nothing in this repo's tests or CI will notice). Not for Atlas: `domotics_admin` and the vendor secrets.
