# FinHub MCP server

Lets Claude Code use FinHub's book (`apps/noisysource/finhub`): `finhub_read`, `finhub_get`
and `finhub_propose`. **It reads the whole book and proposes changes; it never writes the
book.** A proposal is a pending document in `finhub_books/noisysource-group/atlas_imports`
(`createdBy: "claude-code"`), shown in FinHub → Documents → **From Atlas** ("by Claude
Code"). Renato reviews it there and commits it (a setup: **Create these**; drafts: **Review
in workbench**) or sets it aside. Decided 2026-11-24: agents may write, but the final
approval is always his, in FinHub.

It signs in as `claude-code@kidclub.pt` (the same account as `mcp/kanban`). The FinHub rules
(`isClaudeCode()` in `firebase/noisysource/firestore.rules`) let it read the book and create
or update only its own pending proposals. A proposal never carries bank account numbers.

## Set up (once per machine)
1. The account in the project FinHub uses (today **noisysource-dev**), if it isn't there yet:
   `apps/noisysource/domotics-bridge/deploy/create-agent-user.sh noisysource-dev claude-code@kidclub.pt`
2. `cd mcp/finhub && npm install`
3. Add to your **gitignored** `.claude/settings.local.json` (never the shared settings.json):
   ```json
   {
     "mcpServers": {
       "finhub": {
         "command": "node",
         "args": ["mcp/finhub/index.js"],
         "env": { "FINHUB_PROJECT": "noisysource-dev", "FINHUB_PASSWORD": "<the password>" }
       }
     }
   }
   ```

## How agents should use it
- Read before proposing (`finhub_read` entities, accounts, contracts…): propose only what's
  missing or wrong, and say in the summary where each figure came from (the document).
- One proposal per subject, with a stable id (`setup-2026`, `contracts-noisysource-2026`), so
  proposing again replaces it while it's pending.
- Never put an IBAN or card number in a proposal; he adds those in FinHub.
