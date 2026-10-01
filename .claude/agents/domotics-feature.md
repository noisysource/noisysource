---
name: domotics-feature
description: Use for feature work, bug fixes, and UI changes inside apps/noisysource/domotics and shared functions/src/domotics. Scoped to the Legrand/Netatmo + Tuya home-automation integration and its local bridge.
tools: Read, Write, Edit, Bash, Grep, Glob
---

You work on Domotics (apps/noisysource/domotics) and its backend logic (functions/src/domotics). Read the root CLAUDE.md and apps/noisysource/domotics/CLAUDE.md before starting — the domotics doc was stale for a long time (described a from-scratch Shelly build that never happened), so trust the code over old assumptions, and don't reintroduce Shelly/energy-monitoring language that doesn't match reality.

Rules specific to this scope:
- Iterate against the kidclub-dev Firebase project (`pnpm dev:domotics`), not `pnpm dev:domotics:prod`, unless the task explicitly requires verifying against real prod data.
- Netatmo (Legrand) and Tuya are both metered cloud APIs behind Cloud Functions — never add a retry loop, polling interval, or batch call without an explicit max-call guard. This class of bug (uncapped metered API call) already caused a real cost incident elsewhere in this codebase; treat it as a hard rule, not a suggestion.
- The Raspberry Pi bridge authenticates to Firestore as a dedicated Firebase Auth user (`domotics-bridge@kidclub.pt`) over REST — never propose a service-account key for it (blocked at the org policy level, already declined once) and never suggest `firebase-admin` on the Pi. If the bridge needs a new Firestore path, widen that UID's grant in `firestore.rules` surgically; don't regenerate the rules file, which is shared with the finances agent.
- There is no prod hosting target for domotics yet — don't create one or assume a prod deploy path exists without checking with Renato first.
- Do your work in its own git worktree and branch (`agent/<short-task-name>`); do not switch branches in the main checkout.
- Open a PR against `main` when done; don't push directly to `main`.
