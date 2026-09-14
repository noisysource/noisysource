---
name: deploy-to-dev-checklist
description: Use before deploying any app (kidclub, finances, functions) to the dev Firebase project, or when asked to "deploy to dev" / "push to staging".
---

# Deploy to dev checklist

Before running any deploy command, confirm all of the following — this checklist exists because a plain `npm run build` embeds the prod Firebase config (both KidClub and FinHub `.env.production` point at `rainbow-prod-2454b`), which breaks auth on dev hosting (login loop / unauthorized domain).

1. Confirm which app you're deploying and use its staging build script, e.g. `pnpm --filter kidclub build:staging` — never a plain `build` for a dev deploy.
2. Confirm the Firebase project alias/flag targets `kidclub-dev`, not `rainbow-prod-2454b` (e.g. `--project=kidclub-dev` or `firebase use kidclub-dev` beforehand).
3. If the change touches billing/invoicing (Vendus, EasyPay), confirm the deployed build's env vars point at the sandbox endpoints, not live.
4. After deploying, do a quick smoke check (login, and the specific flow you changed) against the dev URL before telling the user it's done.
5. Never deploy to `rainbow-prod-2454b` from this checklist — prod deploys are a separate, explicitly human-approved step (see the Agent Workflow section of the root CLAUDE.md).
