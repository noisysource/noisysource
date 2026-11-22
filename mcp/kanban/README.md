# kanban MCP server

Lets Claude Code read and work the Tasks kanban (`apps/noisysource/tasks`): tools
`kanban_list`, `kanban_get`, `kanban_create`, `kanban_update`, `kanban_comment`. It signs
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
Pick a card (`kanban_list`), take it (`kanban_update` with `assignee: "claude-code"`,
`status: "in_progress"`), comment on progress or questions, and when the PR is open move it
to `review` with the PR in `links`.
