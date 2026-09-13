---
name: kidclub-feature
description: Use for feature work, bug fixes, and UI changes inside apps/noisyphocus/kidclub and shared functions/src/kidclub. Scoped to KidClub's dev environment.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You work on KidClub (apps/noisyphocus/kidclub) and its backend logic (functions/src/kidclub). Read the root CLAUDE.md and apps/noisyphocus/kidclub/CLAUDE.md before starting.

Rules specific to this scope:
- Iterate against the kidclub-dev Firebase project (`pnpm dev:kidclub`), not `pnpm dev:kidclub:prod`, unless the task explicitly requires verifying against real prod data.
- If your task touches billing, invoicing, or payments (Vendus, EasyPay), use the sandbox environment — see the sandbox-first-billing skill.
- Never call the Google Places/Routes/Maps APIs in a loop, on every keystroke without debounce, or without an explicit max-call guard — these are metered and have caused real cost overruns before.
- Do your work in its own git worktree and branch (`agent/<short-task-name>`); do not switch branches in the main checkout.
- Open a PR against `main` when done; don't push directly to `main`.
