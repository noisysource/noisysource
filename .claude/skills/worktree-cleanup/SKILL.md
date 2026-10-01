---
name: worktree-cleanup
description: Use when a task's PR has been merged (or abandoned) and its git worktree is still around, or when asked to check for / clean up stale worktrees. Also worth running periodically — a stale worktree has already caused a real credential-exposure incident here.
---

# Worktree cleanup

`.claude/worktrees/` is scratch space, not part of the repo, and a stale one is how real credentials have already ended up copied into a forgotten folder once. This has also already shown up as plain clutter — a real session found several stale worktrees (`claim-studyroom-fix`, `deploy-functions-workflow-fix`, `kidclub-cicd-automation`, plus some pre-convention ones) sitting around unnoticed.

1. **List what's actually there:** `git worktree list` from the main checkout — this is the source of truth, not memory of what you created.
2. **For each worktree, check its branch's PR status** (merged, open, or abandoned/no PR).
3. **Merged →** `git worktree remove .claude/worktrees/<name>` immediately. Don't leave it "for later."
4. **Open PR, not yet merged →** leave it, but note it in the relevant app's `STATUS.md` under "anything risky in flight" if it's been sitting a while, so it doesn't get forgotten.
5. **Abandoned (no PR, task dropped)** → confirm with Renato before removing if there's any chance of uncommitted work worth keeping; otherwise remove it the same way.
6. **A worktree or branch you don't recognize at all** (not something you or a known agent created) — per the root CLAUDE.md's Visibility rule, ask about it before touching it, don't assume it's safe to remove.
