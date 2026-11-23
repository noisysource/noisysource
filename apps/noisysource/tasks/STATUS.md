# Tasks (kanban) — status

_Last updated: 2026-11-23, branch `agent/tasks-kanban` (PR #168)._

## Done (in this branch, not merged)
- Kanban app: All systems roadmap + one board per app, drag and drop between columns,
  card details (description, priority, assignee, labels, links, roadmap flag, move to another
  board), activity log with comments, filters (text, assignee, app chips on the roadmap),
  new boards from the sidebar, delete (owner only).
- Agent API: callables `kanbanList`, `kanbanGet`, `kanbanCreate`, `kanbanUpdate`,
  `kanbanComment` for Renato, Atlas and Claude Code (`requireKanbanCaller`). No delete.
- `mcp/kanban`: the MCP server Claude Code uses (signs in as `claude-code@kidclub.pt`).
- Testing step (2026-11-23): `testing` status between Review and Done, a test plan on each card,
  the linked PRs on the card (state, conflicts, check runs), checkout commands for the PR branch,
  and Merge from the card (owner only, blocked while checks fail or run; moves the card to Done).
  GitHub token set in the app (sidebar → GitHub). Agents can read PRs (`kanban_prs`), never merge.
- Deploy wiring: hosting target `tasks`, sites `noisysource-{dev,prod}-tasks` (Terraform
  tfvars), both NoisySource workflows, `deploy-parts.mjs`.

## Before it works end to end (Renato)
1. ~~Run the rules test~~: done 2026-11-23, `pnpm test:rules:tasks` passes on the branch with `staging` (#160) merged in, and so does `pnpm test:rules:domotics`.
2. **Authorize the new domains** in Firebase Auth (Console → Authentication → Settings →
   Authorized domains): `noisysource-dev-board.web.app` (the dev site's third name: `noisysource-dev-tasks` and `noisysource-dev-kanban` were each deleted on 2026-11-23 by a Terraform run that didn't know them, the second by #160's merge into `staging`, and Firebase never gives a deleted name back) and `noisysource-prod-tasks.web.app`.
   Without it Google sign-in answers `auth/unauthorized-domain`.
3. **Create Claude Code's account** in each project you want it on (prod for the real boards):
   `apps/noisysource/domotics-bridge/deploy/create-agent-user.sh noisysource-prod claude-code@kidclub.pt`
   then add the `kanban` MCP entry to your gitignored `.claude/settings.local.json` (see
   `mcp/kanban/README.md`).
4. **GitHub token**: in the app, sidebar → GitHub. Fine-grained, `noisysource` repos only:
   Pull requests and Contents read/write, Checks read.
5. **Atlas**: give it tools for the five callables (it already signs in to noisysource-prod
   as `atlas@kidclub.pt`). Contract in the root CLAUDE.md.

## Next step
The dev Functions deploy for #168 fails because PR #160 (website) put `atlasGate` on
`noisysource-dev` and this branch doesn't have it. Merge #160 first, then merge `staging` into
this branch and push; the preview then deploys. Expect conflicts in the shared NoisySource files
(rules, functions index, firebase.json, .firebaserc, tfvars, workflows, deploy-parts).
Then merge into `staging` after the dev preview looks right (that is the prod release).

## Open questions
- Should Atlas/Claude Code be allowed to move a card to `done`, or stop at `review` for
  Renato's OK? Today they can do either.
