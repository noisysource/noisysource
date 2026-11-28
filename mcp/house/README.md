# house MCP server

The house (`apps/noisysource/domotics`) for **Atlas**: heating, lights, blinds, solar and
energy, with the house guide built in. One of the per-domain MCP servers on Atlas's roadmap
(house, FinHub, KidClub…): Atlas loads it when a question is about the house.

It signs in as **`atlas@kidclub.pt`** and uses only what that account may already use, so
the rules (`isAtlas()` in `firebase/noisysource/firestore.rules`) and the callables
(`requireOwnerOrAgent`) still decide everything. Nothing here widens Atlas's rights.

## Tools
| Tool | | What |
|---|---|---|
| `house_guide` | read | The guide (`GUIDE.md`): how the house works and what Atlas may do there |
| `house_status` | read | Rooms (temperature, target, valve), heat pump, solar/battery/grid, the automation's doing and reasons; says if stale |
| `house_lights_and_blinds` | read | Every light and blind by room, live from Netatmo, with ids |
| `house_energy_bill` | read | kWh, cost and savings for a range of days (`domoticsEnergyBill`) |
| `house_day` | read | One day's history: kWh per hour, rooms and pump per hour, interventions |
| `house_media_status` | read | TV, Roomba, cameras: status only |
| `house_set_lights_blinds` | **change** | Lights on/off, brightness, blind positions (`legrandSetState`, gateway ids added) |
| `house_set_thermostat` | **change** | A room's target (10–28 °C) and/or mode, through the bridge's command queue |
| `house_set_heat_pump` | **change** | Pump on/off, through the queue |
| `house_warm_by` | **change** | "Warm by HH:MM" (`domoticsWarmBy`) |
| `house_pause_automation` | **change** | Pause/resume the heating automation (`domotics_config/automation.pauseUntil`, like the app's "Pausar") |

Change tools carry `readOnlyHint: false`, so Atlas asks Renato before calling them. Heating
commands refuse to send when the house state is stale (the bridge wouldn't pick them up),
and wait up to ~25 s to report whether the bridge took them.

The guide is also the server's `instructions` and the resource `house://guide`;
`house://status` is the live state.

**Not here, on purpose:** commands to the TV, Roomba and cameras, and the Teslas. The rules
and functions keep those to the owner. Opening them to Atlas is a decision for Renato, then a
rules/callable change in the same PR as the tool.

## Set up (once per machine)
1. Atlas's account exists in `noisysource-prod` (made with
   `apps/noisysource/domotics-bridge/deploy/create-agent-user.sh noisysource-prod`).
2. `cd mcp/house && npm install`
3. Point the MCP client at it, with the password from your own secrets (never git):
   ```json
   {
     "mcpServers": {
       "house": {
         "command": "node",
         "args": ["<repo>/mcp/house/index.js"],
         "env": { "HOUSE_PROJECT": "noisysource-prod", "HOUSE_PASSWORD": "<atlas password>" }
       }
     }
   }
   ```
   `HOUSE_PROJECT=noisysource-dev` gives the dev project (an empty house, for trying it).

## Changing it
It reads the shapes of `domotics_state/tuya`, `domotics_state/media`, `domotics_energy`,
`domotics_climate` and Netatmo's homesdata/homestatus, and writes the commands the rules hold
Atlas to. **Change those in the app, bridge or rules, and change this server (and
`GUIDE.md`) in the same PR.** Tests: `npm test` (the pure half, `logic.js`).
