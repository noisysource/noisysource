# Handoff: the comfort experiment (29–31/10/2026) and its analysis

**Built 2026-10-28** (`agent/domotics-comfort-log`, stacked on #123). **Analysis due ~2026-10-31**, in a fresh session. This file is everything that session needs.

## Why (Renato, 2026-10-28)

> "During the day we don't need the house warm, and most of the night we don't either. So as long as we keep 19:00–23:00 and 06:00–10:00 around 23 °C, we can use the intervals to see how long the floor and the water hold temperature, and how long it takes to reach the desired temperature, both night and day. Also record when the pump is switched on or off as a manual intervention, and a need to change the temperature. If I put it on, by that time I was starting to feel the house cold and needed an increase. If I switch it off, the temperature is good enough. We gather data and analyse in 2 days."

It's the first step of the cost plan in `HANDOFF-heating-automation.md` ("Cost plan"). That plan can't be sized without knowing how fast the slab coasts: whether the heating can move to vazio (22–08) and to the sun, and how much.

Comfort in his words: "after 19 I would like it to always be around 22–24." It's not a hard 19:00 target.

## The experiment

`domotics_config/automation`, written 2026-10-28 (dry-run until Renato taps **Ligar** in the app):

| Setting | Value | Why |
|---|---|---|
| `windows` | 19:00–23:00, 06:00–10:00 | the warm windows; outside them the day rules hold, the night included |
| `comfort` | 24 (was 23 until 29/10 20:46) | the room target in the windows; the thermostats get it when live. Raised because people wore jackets at 23.6° (29/10) |
| `dayMin` | 19 | a safety floor outside the windows (the rooms' mean) |
| `warmupMaxMin` | 180 | the warm-up starts at most 3 h before a window. The learned model (0.15 °C/h, floor 68 min) would otherwise start ~6 h early and leave no coasting to measure. |
| `solar.enabled` | false | daytime heating on the sun would break the day coast. Back on after the analysis, with `socOn` ≈ 40 (Renato OK'd this; the bound is now 20–100). |
| `flow.enabled` | false | the water setpoint is left as the pump has it (44 °C). The technicians are diagnosing E13, and ≤ 35 °C water is the trip zone. |
| `rest.enabled` | false | no rest at the setpoint. The technicians want to see the trip happen (Renato, 28/10). |

**The E13 guard is off** (`domotics_config/guard.enabled = false`, since 28/10 11:19, for the technicians). An E13 lockout means no heat until someone resets it at the panel or breaker. The automation never touches a faulted pump.

**A person's on/off is respected** (new 28/10, `automation.ts`). It holds until the plan next moves between heating (a window or its warm-up) and not. Example: switched on at 14:00 because the house is cold, it stays on until the warm-up or window takes over; switched off at 20:00 as warm enough, it stays off until 23:00. The controller's own 23:54 UTC timer off isn't a person and is ignored, as before. It now falls outside both windows anyway. This hold is not kept across a bridge restart.

To stop it: **Pausar** in the app (2 h / until 19:00 / until 09:00). To end the experiment: tap **Simular** (dry-run), or ask an agent to restore the single 19:00–09:00 window (delete `windows`, put `warm` back).

## What is recorded

**`domotics_climate/{yyyy-mm-dd}`** (new; owner read, bridge write, `firestore.rules`) is written by `domotics-bridge/src/climate.ts` from the bridge's normal polls. That's LAN only: no cloud reads, no metered API, ~24 writes a day like the energy history.

- **`q00`…`q95`**: one field per 15-min slot, the same slots as `domotics_energy`.
  - `n`: readings in the slot (one a poll, ~30 s; the thermostats are read every ~5 min and carried between).
  - `z.{thermostatId}`: `t` (temperature at the slot's last reading), `lo`, `hi`, `s` (target), `v` (share of readings with the valve open).
  - `pn`: pump readings. `on` / `run`: shares switched on and with the compressor running. `hz` / `hzMax`: mean and top Hz while it ran.
  - `out`, `inn`: water out and back in at the last reading. `outMax`. `sp`: the setpoint. `ext`: the pump's outdoor sensor. `fault`.
  - `soc`.
  - `plan`: the automation's mode (`warm`, `warmup`, `day`, or `off`, with ` (sim)` in dry-run). `want`: its on/off. `guard`: the guard's mode.
- **`x_HHMMSS_pump`, `x_HHMMSS_{thermostatId}`**: a person's intervention, in Lisbon time.
  - `kind`: `pump` or `target`.
  - `by`: `app`, `outside` (panel, SmartLife, at the thermostat, the technicians) or `timer` (the 23:54 UTC controller timer).
  - `meaning`: `cold` (pump on), `warm-enough` (pump off), `warmer` / `cooler` (target), `none` (the timer).
  - A pump on by a person means cold. Renato, 28/10: "if I switch it on during the night then it's because it's cold." It also carries `offBy` and `offMin` (the last off before it: `timer`, `automation`, `guard`, `app`, `outside`).
  - `from` / `to`: for a target change.
  - `rooms` (thermostatId → °C at that moment), `mean`, `ext`, `plan`, `pumpOn`.
  - The automation's and the guard's own switches and target changes aren't interventions. The switches are in `domotics_incidents`.
- `zones`: thermostatId → name.

**Elsewhere:** kWh per slot is in `domotics_energy`. Every pump switch with its source, every fault with 30 min of 30-s readings, and the guard's actions are in `domotics_incidents`.

**Export it all:** `node apps/noisysource/domotics-bridge/deploy/climate-export.mjs 2026-10-29 2026-10-31 > climate.json`. It uses your gcloud login, is read-only, and joins the climate and energy slots and lists interventions and incidents.

## What actually happened (28–31/10)

**The automation never went live.** Renato didn't tap Ligar, so the plan stayed `(sim)` throughout. Every switch and target change was by hand, which makes the run a manual experiment, logged. The night-by-night account, a table of energy and € per period, and the first conclusions are in `STATUS.md` (🧪 section, "Night 28→29/10" through "Night 30→31/10"). Read that before the export.

Things the export alone won't tell you:
- **31/10 07:30 is a timer Renato set in an app, not "cold".** The same timer also set the water setpoint (`p02_heating`) from 44 to 10, so the compressor never ran from 07:30 until Renato put it back (43) before 09:45. Leave that stretch out of any warm-up figure.
- **18:54 on 29/10 is a real "cold" (jackets at 23.6°).** The 01:02 target changes on 30/10 were done outside our app, and they're real "warmer" signals.
- **Missing rooms:** Sala is gone from 09:37 on 29/10 (offline from ~03:15), and Kids Bathroom from 07:21 on 30/10. Both fail with `read ECONNRESET`. So the means are over 5 rooms, then 4. Compare like with like, and don't read a mean's jump as heat when a room drops out.
- **The water temperatures with the pump off are the outdoor unit's,** falling towards outdoor (13–16 °C on the night of 30–31/10). Once the circulator runs with the compressor idle (31/10 07:30–09:40), out = in is the slab's temperature, about 27 °C after 6.5 h off.
- **No E13 from 28/10 to 31/10.** Cold starts from 20 °C water on 29/10 18:54 and 30/10 20:10 were both clean.

## The analysis (the session ~31/10)

1. **Cooling (pump off, outside the windows):**
   - Per stretch, °C/h for each room and the mean, against (room − outdoor). Fit a time constant, τ = (T − Text) / (−dT/dt).
   - Compare day (10–16) with night (23–03).
   - Note whether the water temperatures mean anything with the circulator stopped. They probably don't.
2. **Warm-up:**
   - Per warm-up: minutes from compressor start to the first rise in the rooms (the floor lag), then °C/h to 23.
   - Did it get there by 19:00 or 06:00? kWh per warm-up (energy slots with `run` > 0).
   - Day against night: outdoor temperature, COP proxy.
   - Compare with the learner's model in the bridge state (`automation.model`).
3. **Holding in the window:** kWh per hour to hold 23, compressor duty (`run`) and Hz.
4. **Interventions:** room temperatures at each manual on (the "cold" threshold) and off (the "warm enough" level). Target changes, by room.
5. **E13:** trips or lockouts during the experiment, and at which starts (cold water ≤ 35 °C, Hz ≤ 50, the 9–14 min signature). The technicians changed something on 28/10 that we can't see.
6. **Then the cost plan** (`HANDOFF-heating-automation.md`, "Cost plan"):
   - What can move to vazio 22–08 and the sun, and what it costs per day against 28/10 (~€3.60).
   - The battery threshold for solar heating.
   - Whether 19:00–23:00 at 22–24 °C holds with the pump off from 16:00.
   - Propose a schedule to Renato.

## Known limits

- Thermostats are read every ~5 min when the app is closed, so a room's temperature can be up to 5 min old in a slot.
- A manual hold is forgotten if the bridge restarts. The automation then goes back to its plan.
- `domotics_climate` writes fail until the rules deploy reaches dev (the PR's Deploy to Dev). Until then the bridge keeps the data on the Pi (`climate-state.json`, two weeks) and retries with backoff, so nothing is lost.
- The app shows the windows read-only (Definições). They can't be edited there yet.
