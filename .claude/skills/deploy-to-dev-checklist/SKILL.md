---
name: deploy-to-dev-checklist
description: Use before deploying any app (kidclub, finances, functions) to the dev Firebase project, or when asked to "deploy to dev" / "push to staging".
---

# Deploy to dev checklist

**Prefer the automatic path first**: opening or updating a PR against `staging` now deploys
KidClub (app + Firestore rules/indexes + functions + terraform) and FinHub (hosting) to
`kidclub-dev` automatically — see root CLAUDE.md's "Branch → environment pipeline". Use the manual steps
below only when you need a one-off dev deploy outside that flow (e.g. debugging a CI failure
by reproducing it locally).

Before running any deploy command, confirm all of the following — this checklist exists because a plain `npm run build` embeds the prod Firebase config (both KidClub and FinHub `.env.production` point at `rainbow-prod-2454b`), which breaks auth on dev hosting (login loop / unauthorized domain).

1. Confirm which app you're deploying and use its staging build script, e.g. `pnpm --filter kidclub build:staging` — never a plain `build` for a dev deploy.
2. Confirm the Firebase project alias/flag targets `kidclub-dev`, not `rainbow-prod-2454b` (e.g. `--project=kidclub-dev` or `firebase use kidclub-dev` beforehand).
3. If the change touches billing/invoicing (Vendus, EasyPay), confirm the deployed build's env vars point at the sandbox endpoints, not live.
4. After deploying, do a quick smoke check (login, and the specific flow you changed) against the dev URL before telling the user it's done.
5. Never deploy to `rainbow-prod-2454b` from this checklist — prod deploys happen automatically on merge to `main` via CI, gated by PR review, not by a manual command (see the Agent Workflow section of the root CLAUDE.md).
