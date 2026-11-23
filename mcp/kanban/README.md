# kanban MCP server

Lets Claude Code read and work the Tasks kanban (`apps/noisysource/tasks`): tools
`kanban_list`, `kanban_get`, `kanban_create`, `kanban_update`, `kanban_comment`, `kanban_prs`. It signs
in as `claude-code@kidclub.pt` and calls the kanban callables; that account can do nothing
else in the project, and can't delete cards or boards.

## Set up (once per machine)
1. Create the account (asks for the password, writes it nowhere):
   `apps/noisysource/domotics-bridge/deploy/create-agent-user.sh noisysource-prod claude-code@kidclub.pt`
2. `cd mcp/kanban && npm install`
3. Add to your **gitignored** `.claude/settings.local.json` (never the shared settings.json):
   ```json
   {
     "mcpServers": {
       "kanban": {
         "command": "node",
         "args": ["mcp/kanban/index.js"],
         "env": { "KANBAN_PROJECT": "noisysource-prod", "KANBAN_PASSWORD": "<the password>" }
       }
     }
   }
   ```
   Use `noisysource-dev` to try it against the dev boards first.

## How agents should use it
1. Pick a card (`kanban_list`) and take it: `kanban_update` with `assignee: "claude-code"`,
   `status: "in_progress"`. Comment on progress or questions as you go.
2. Open the PR, add it to the card's `links`, move it to `review`.
3. When `kanban_prs` shows the dev deploy green, write the card's `testPlan` (where to test,
   setup, numbered steps with expected results, what must still work) and move it to
   `testing`, `assignee: "renato"`. The board shows the checkout commands from the PR itself.
4. Renato tests, then merges from the card; the board moves it to `done`. Agents never merge
   through the board (`kanban_prs` is read-only).
