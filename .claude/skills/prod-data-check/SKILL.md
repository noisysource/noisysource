---
name: prod-data-check
description: Use when a task needs to read real production data (Firestore, billing systems) to verify or investigate something — "is this live/correct in prod", checking real records — as opposed to making a prod change.
---

# Prod data-check checklist

No agent or session gets standing prod access by default — the `firestore-prod` MCP entry is deliberately not in the shared `.claude/settings.json`. This is for the "Looking" container of the Everyday Workflow (root CLAUDE.md): read-only prod investigation, granted for one session and removed after. It is not for making changes — that's a "Building" task with its own worktree/branch and, for anything prod-writing, explicit human confirmation.

1. **Confirm read-only is actually enough** for the task before requesting any prod access — most "let's check prod" tasks are reads.
2. **Grant access narrowly, in your own gitignored `.claude/settings.local.json`**, not the shared `.claude/settings.json` — this keeps it out of the repo and scoped to this machine/session only.
3. **Prefer the lowest-privilege path available.** For Firestore, a `gcloud`-issued access token against the Firestore REST API (no prod service-account key on the machine, matching org policy) has already been used successfully for this kind of check — reuse that pattern rather than provisioning new prod credentials.
4. **Do the check, get the answer.** Avoid looping/retrying against prod — one deliberate read is the goal, not a polling script.
5. **Remove the access when done, same session.** Don't leave prod access sitting in `settings.local.json` after the task that needed it is finished — that's exactly the kind of standing access the no-default-prod-access rule exists to prevent.
6. **If the check turns up a bug or something worth building**, don't start editing here — hand it off per the Everyday Workflow: a scoped agent for a quick fix, or a noted next step in `STATUS.md` for something bigger.
