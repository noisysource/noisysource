# FinHub (Strata) — apps/noisysource/finhub

> Context: root `../../../CLAUDE.md`. Read `STATUS.md` here first.

FinHub's only UI (Strata Treasury, from AI Studio). Real financial data: no sample data in
real accounts, no prod writes without Renato's OK.

- Run: `pnpm dev:finhub` (noisysource-dev). Build: `pnpm --filter finhub build:nsdev`.
- Backend: the `finhubApi` callable (`firebase/noisysource/functions/src/finhub/`), reached via
  `src/lib/api.ts`. Add a route there, not a new callable per screen.
- Every Gemini call goes through `generateContentWithFallback` in `routes.ts`, which counts it
  (`usage.ts`). Never call Gemini around it.
- Firestore root is `finhub_users/{uid}`; rules in `firebase/noisysource/firestore.rules`.
- Strata's own tsconfig (not strict): keep new code typed anyway.
