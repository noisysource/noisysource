---
name: deploy-to-prod-checklist
description: Use before deploying any app (kidclub, finances) or functions to the prod Firebase project (rainbow-prod-2454b), or when asked to "deploy to prod" / "push live" / "ship to production".
---

# Deploy to prod checklist

Prod deploys are higher stakes than dev ones and have already gone wrong twice in different ways here — once from using the wrong build script, once from deploying hosting straight from a branch instead of through `main`. Confirm all of the following before running any prod deploy command.

1. **Use the plain build, never `build:staging`.** `pnpm --filter <app> build` (not `build:staging`) for a prod deploy — `build:staging` bakes in the dev Firebase config (`.env.staging` points at `kidclub-dev`), which breaks auth/login on the live site. This already happened once on kidclub.pt.
2. **Deploy through a merged `main`, not a feature branch.** `build-and-deploy-kidclub.yml` auto-deploys hosting on every push to `main`/`staging`. If you deploy hosting manually from an unmerged branch (`firebase deploy --only hosting:<app> --project=rainbow-prod-2454b`), prod and `main` go out of sync — the next ordinary push-to-main deploy will silently revert your change. This already happened once (`agent/impersonation-billing-fix` was live on kidclub.pt while unmerged). Prefer: open the PR, get it merged, let the pipeline deploy it. If a manual/emergency deploy is unavoidable, say so explicitly and merge the same commit into `main` immediately after, before anything else touches that branch.
3. **`deploy-finances.yml` and `deploy-functions.yml` are manual (`workflow_dispatch`) by design** — trigger them deliberately, don't assume a merge auto-deploys those the way kidclub hosting does.
4. **Confirm the Firebase project target is `rainbow-prod-2454b`**, not `kidclub-dev` — check the `--project` flag or `firebase use` state explicitly rather than assuming the last-used project.
5. **If the change touches billing/invoicing (Vendus, EasyPay), confirm you're intentionally leaving sandbox** — per the sandbox-first-billing skill, this should be a deliberate, called-out step, not incidental.
6. **After deploying, do a real smoke check against the live URL** (login, and the specific flow that changed) before telling Renato it's done — not just "the build succeeded."
7. **Update the app's `STATUS.md`** noting the prod deploy under "Anything risky in flight" until it's smoke-tested and (if it went out ahead of `main`) until `main` is caught up.
