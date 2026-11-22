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

> **2026-11-22: the E13 guard was removed from the bridge** (Renato: the pump was fixed; the guard had been off since 28/10). From then on the slots in `domotics_climate` have no `guard` field and no switch in `domotics_incidents` has source `guard`; the days and incidents before keep them, as described below.

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

## Results (analysis 2026-11-02)

Data: `climate-export.mjs 2026-10-28 2026-11-02`. The experiment settings stayed in until 2/11, so 1–2/11 is included (another evening run by hand and the first full night off). Room means are over Hall, Quarto, Master and Diniz, the four that answered throughout. Hall dropped out at ~03:00 on 2/11, so it's 3 rooms from then. Sala (out from 29/10) and Kids Bathroom (from 30/10) are left out everywhere. 31/10 07:30–09:45 (timer, setpoint 10, no compressor) is left out of the warm-ups.

**0. The thermostats.** Every valve opens and closes at target − 0.4 to −0.6 (mostly −0.5), in all five rooms with data. So a room sits at target − 0.5: 24 gives 23.5, 25 gives 24.5. On the evening of 29/10 (targets 24), the rooms at 23.6–23.7 were inside that band. The valves were open 9–17 % of the time, so the floor was barely fed: that's the jackets evening.

**1. Cooling, pump off** (4-room mean; τ = (room − outdoor) / rate):

| Stretch | °C/h | Outdoor | τ |
|---|---|---|---|
| Night, first ~6 h after a 4–5 h run (31/10, 1/11, 1–2/11) | −0.09 to −0.12 | 8.6–9.8 | 135–170 h |
| Night, 6–12 h after the pump stopped (2/11 03–09, 3 rooms) | −0.21 | 8.2 | 70 h |
| Evening after a sunny day (29, 30, 31/10) | −0.15 to −0.27 | 16–19 | 18–46 h |
| First 1.3 h after a hard run stops (30/10 08:42) | −0.44 | 15 | — |
| Day with sun (29, 31/10, 1/11) | +0.07 to +0.24 | 19–21 | — |
| Day, partly cloudy afternoon (30/10) | +0.02 | 20 | — |

- No single τ fits. What sets the rate is how recently the slab was charged, not room − outdoor. A charged slab feeds the air for ~6 h (~0.1 °C/h); after that, or when only the sun warmed the air, it's ~0.2 °C/h.
- With the circulator stopped, the water readings are the outdoor unit's, not the slab's. They fall to ~25 °C within 1–2 h, then towards outdoor. With the circulator on and the compressor off (31/10 07:30), out = in = 27 °C was the slab after 6.5 h off.

**2. Warm-ups** (cold starts, water 14–23 °C; compressor 60–70 Hz from the first slot):

| Start | Setpoint | Outdoor | Dip | Back at start | Rise after the dip | House kWh |
|---|---|---|---|---|---|---|
| 30/10 20:10 | 44 | 10–12 | −0.09 at +35 min | +125 min | 0.18 °C/h | 16.6 in 4.7 h |
| 31/10 21:23 | 43 | 8–9 | −0.07 at +52 min | +112 min | 0.25 °C/h | 11.9 in 3.8 h |
| 1/11 07:30 (timer) | 40 | 6.5–8.5 | −0.10 at +45 min | not by +80 min | — | 4.5 in 1.4 h |
| 1/11 16:41 | 40 | 21 → 10 | −0.22 at +64 min (with the after-sun drop) | +154 min | 0.15 °C/h | 13.0 in 4.5 h |

- 29/10 18:54 isn't a warm-up (valves mostly shut, see 0). On 30/10 01:02 the targets were raised with the pump already warm: no dip, then 0.17 °C/h for 7.7 h.
- The first water through the floor after a stop is the cold water left in the outdoor unit. So the rooms dip for 35–65 min and are back where they started ~2 h after the start. The floor gets ≥ 34 °C water within ~15 min.
- The learner (`automation.model`: floor 59 min, 0.17 °C/h, 12–13 samples) matches the rise; "back at start" is nearer 2 h than 1.
- At a 40 °C setpoint the compressor settled at 55–60 Hz; at 43–44 it ran 70 Hz flat out. These runs can't tell them apart per kWh (the 1/11 evening also fought the after-sun drop).
- House draw with the compressor at ≥ 65 Hz is 3.1 kW (night slots, n 32), so the pump is ~2.8 kW over the baseline. Circulating with the compressor idle: 0.47 kW.

**3. Holding.**
- Targets 24, rooms at 23.65 (29/10 19:00–01:00): 1.45–1.7 kWh/h, compressor duty ~50 %, valves open 9–17 %.
- Targets 25–26, rooms ~25 (30/10 05:30–08:30): 2.0 kWh/h, duty 92 %.
- Rising, setpoint 40 (1/11 19–21): 2.6 kWh/h, duty 100 %.

**4. Interventions** (4-room mean):
- **On, cold:** 29/10 18:54 at 23.6 (5 rooms); 30/10 20:10 at 23.8; 31/10 21:23 at 23.3. The 1/11 16:41 on, at 24.1 with the sun still up, reads more like starting the evening early.
- **Off, warm enough:** 31/10 00:53 at 24.5; 1/11 01:11 at 24.0; 1/11 21:09 at 24.4; 30/10 08:42 at 25.0. The morning offs (08:51–10:58, at 23.1–23.8) mean leaving or sun, not comfort.
- **Targets:** 30/10 01:02, four rooms 24 → 25/26 at 23.7 (warmer).
- **Timer:** 31/10 07:30 (setpoint 44 → 10) and 1/11 07:30 (43 → 40). It didn't fire on 2/11.
- So cold is ≤ 23.8 and warm enough is 24.0–24.5: rooms at ~24.5, which is a target of 25.

**5. E13: none** from 28/10 11:20 to 2/11 10:00, guard off. Five cold starts from 14–23 °C water (29/10 18:54, 30/10 20:10, 31/10 21:23, 1/11 07:30 and 16:41), all at 60–70 Hz from the first minutes. Before the visit, cold starts at a flat 50 Hz tripped at 9–14 min. That's consistent with the technicians lifting a frequency limit, but it's a guess. It's also 5 days, not the week the cost plan asked for.

**6. Energy and €** (grid at €0.117 vazio / €0.202 fora):

| Day | House kWh | PV | Grid | € |
|---|---|---|---|---|
| 28/10 (pump on all day, thermostats 26 by hand) | 39.8 | 18.0 | 22.3 | 3.65 |
| 29/10 | 30.4 | 29.8 | 10.5 | 1.64 |
| 30/10 | 42.3 | 24.5 | 13.3 | 1.82 |
| 31/10 (night off, setpoint-10 morning) | 23.6 | 26.8 | 5.3 | 0.69 |
| 1/11 (both runs on the battery; cold by the morning of 2/11) | 31.1 | 25.8 | 1.1 | 0.21 |

- **Battery:** ≈ 29–30 kWh per 100 %; charge and discharge both capped at 3 kW. On a sunny day it charges at the cap from ~10:00 to 15:30, is at 76–84 % by 16:00, and stops discharging at ~17–18 %. That leaves ~18 kWh for the evening, ~6 h of pump.
- **The panels are throttled on sunny days.** In 65 midday slots with the battery charging at its 3 kW cap and the pump off, PV = house + charge exactly (export ~0). With the pump on (29/10 10:00), PV reached 5.9 kW. So ≥ 2.5 kW is thrown away at midday on sunny days. How much more is unknown: the inverter doesn't report it.

**Found in the code on the way (not changed):**
- `spareSun()` can't see the throttled sun. It reads PV − house, which under throttling is the battery's charge (≤ 3 kW, under `pumpW` 3.3 kW) and ~0 once the battery is full. So the solar rule would never start the pump on this inverter, at any `socOn`.
- **Recovery can't end with these thermostats.** It ends at ≤ 0.2 °C short, but they close the valves at 0.5 short. Once on, it keeps the pump on with every valve shut until the window ends. With the water curve off, that's all it does, so the schedule switches recovery off. Fix it before the water curve goes back on (e.g. measure the shortfall against target − 0.5).
- The warm-up's "need" is measured against `comfort`, but the rooms sit at comfort − 0.5. So the need is always ≥ 0.5, and the warm-up always runs to `warmupMaxMin`: the cap is the real start time.

## Known limits

- Thermostats are read every ~5 min when the app is closed, so a room's temperature can be up to 5 min old in a slot.
- A manual hold is forgotten if the bridge restarts. The automation then goes back to its plan.
- `domotics_climate` writes fail until the rules deploy reaches dev (the PR's Deploy to Dev). Until then the bridge keeps the data on the Pi (`climate-state.json`, two weeks) and retries with backoff, so nothing is lost.
- The app shows the windows read-only (Definições). They can't be edited there yet.
