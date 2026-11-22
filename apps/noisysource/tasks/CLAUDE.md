# App: Tasks (the kanban)

> **Context**: see the root `../../../CLAUDE.md`. Read `STATUS.md` in this folder first.

## Purpose
The development kanban for every Noisy Source app, shared by Renato and the agents:
one board per app (KidClub, FinHub, Domotics, Atlas, noisysource.com, Tasks itself, and
any added in the app) plus **All systems**, the roadmap. The roadmap shows the cards on the
`systems` board (cross-app work) and every app card marked `roadmap: true`.

## Who reaches it, and how
| Who | How | Can |
|---|---|---|
| Renato | this app, Google sign-in as `admin@noisysource.com` | everything, straight to Firestore (rules) |
| Atlas | callables `kanbanList/Get/Create/Update/Comment`, signed in as `atlas@kidclub.pt` | read, create, edit, move, comment; no delete |
| Claude Code | `mcp/kanban` (tools `kanban_*`), signed in as `claude-code@kidclub.pt` | same as Atlas |

The agents never read or write `tasks_*` directly: the rules give those collections to the
owner alone, and the callables check every field.

## Code
- Logic (statuses, priorities, assignees, validation, ordering): `packages/shared/lib/kanban.ts`,
  mirrored to `firebase/noisysource/functions/src/tasks/kanban.ts` (a test fails when they differ).
- Callables: `firebase/noisysource/functions/src/tasks/callables.ts`.
- Rules: `firebase/noisysource/firestore.rules` (Tasks block); test `scripts/rules-tests/tasks-kanban.rules-test.cjs`
  (`pnpm test:rules:tasks`, needs Java).
- App: `src/lib/data.ts` (Firestore, live), `src/components/BoardView.tsx` (columns, drag and drop),
  `src/components/CardDialog.tsx` (details, activity, comments).

## Firestore (noisysource-dev / noisysource-prod)
- `tasks_boards/{boardId}`: `{name, color, order, path?}`. The defaults (`DEFAULT_BOARDS`) are
  created the first time the app or a callable finds none.
- `tasks_cards/{cardId}`: `{boardId, title, description, status, priority, labels[], assignee,
  roadmap, links[{label,url}], order, createdBy, updatedBy, createdAt, updatedAt}`.
  `status`: backlog, todo, in_progress, review, done. `assignee`: renato, marisa, atlas,
  claude-code or null. `createdBy/updatedBy`: renato, atlas, claude-code.
- `tasks_cards/{cardId}/activity/{id}`: `{at, by, kind: created|updated|comment, text}`.

## Deploy
NoisySource unit, like Domotics: a PR into `staging` previews on `noisysource-dev-tasks.web.app`;
**merging into `staging` releases to `noisysource-prod-tasks.web.app`**. `pnpm --filter tasks dev`
runs it locally on port 5176 against `noisysource-dev` (localhost is an authorized domain).

## Conventions
- Keep it a kanban: no sprints, estimates or time tracking unless Renato asks.
- Changing a card's shape, a status, an assignee or a callable means updating the mirror,
  `mcp/kanban/index.js` (its enums) and telling Atlas (root CLAUDE.md, Cross-App Data Contracts).
