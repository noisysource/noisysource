# Handoff: heating automation (floor heating, solar, battery)

**Status:** built 2026-10-19 (PR #106), in dry-run since the cold morning of 2026-10-20. Reworked 2026-10-25 (recovery, hand-set water, rest at the setpoint, "warm by HH:MM"). **Reworked again 2026-10-26** (`agent/domotics-solar-heating`, Renato's decisions below): a warm floor 19:00–09:00, by day only on spare sun, the automation owning on/off, and a "Pausar" button. Still dry-run; going live is one tap for Renato. What happened on those days: `STATUS.md`.

## Goal (Renato, 2026-10-26)

> "The reason the guard is on is to avoid E13 again until the tech looks at it. Set an automation to always run independently of who turned it off or on, while keeping the guard to avoid shut down. During the day, knowing how long it takes to heat, how much it spends, and PV and battery state, decide keep it on / turn it on / turn it off. While there's sun we can turn it on to keep the floor heated, but the batteries need to be charged too, so a house a little colder is not a problem. What we really need is a warm floor every day from 19:00 until 09:00."

The house: underfloor heating on a heavy screed slab, fed by the Zantia Vancouver 13 air-to-water heat pump (floor heating **only**; hot water is a separate, unintegrated heat pump). Six Tuya TR01 thermostats open and close the zone valves. PV + a RENAC battery, bi-horário tariff (vazio 22:00–08:00).

## Decisions (Renato, 2026-10-26)

- **Warm window 19:00–09:00** (configurable), room temperature **24 °C**.
- **Evening warm-up**: starts early enough to be warm at 19:00, from the learned warm-up model (`warmby.ts`: floor ~90 min, rooms 0.3 °C/h, + 30 min margin). With the battery ≥ 90 % and sun before then, it may start earlier on solar.
- **Daytime** (09:00 → warm-up): pump **off by default**. Runs only on solar surplus: **battery ≥ 90 %** and the sun covering the house plus the pump (or power actually going out to the grid). Hysteresis and minimum on/off times, no flapping. **Day minimum 21 °C**: below it, heat regardless of sun.
- **The automation owns on/off when live, whoever switched the pump.** An off in the warm window (the controller's nightly 23:54 UTC timer, the panel, SmartLife, a person) is undone; an on outside the plan by day is switched back off. Both respect minimum on/off times and the guard.
- **"Pausar"**: the deliberate way for a person to stop it (2 h / até às 19:00 / até amanhã às 09:00 / Retomar), stored as `pauseUntil` (ms) in `domotics_config/automation`. Paused, neither the automation nor the guard switches the pump on; the guard's protective switch-offs still happen.
- **The E13 guard stays and comes first**: its rests and lockout are never overridden. Its "switch back on 5 min after an outside off" (PR #119) steps aside while the automation runs live, and stays only with the automation off or in dry-run. (At 16:15 on 26/10 that rule nearly overrode Renato's own panel off; the pause plus automation ownership is the fix.)
- **Removed**: the pre-heat period (05–08, +0.5), the evening "poupança" (18–22, −0.5) and the solar boost (+0.5). One room temperature all day.
- **Kept**: the water-setpoint handling (outdoor curve, correction, recovery, hand-set water respected, max 45 °C), the rest at the setpoint, the one-off "quente às HH:MM".

## Decisions made while building (2026-10-26, agent; Renato can overrule)

- **Day minimum uses the rooms' mean**, not any single room: one open window or a cold bathroom shouldn't run a 3.3 kW pump on grid power all day; the slab carries the rooms together. Needs at least half the thermostats answering.
- **Warm-up "need"** = the mean of how far each room is below 24 (a room above 24 counts as 0, so a warm living room can't hide a cold bedroom). Without room readings it plans for 1 °C.
- **Warm-up capped at 6 h before 19:00** (`MAX_WARMUP_LEAD_MIN`): a bad model or broken sensor must not heat on grid power all day. A really cold house is the day minimum's job. On the cap the plan says so and when it expects to be warm.
- **Solar thresholds** (constants in `automation.ts`): start after 10 min of spare sun; carry on down to 85 % battery (90 − 5) and while the sun still covers half the pump; stop after 15 min below that, or when buying more than 500 W from the grid. "Spare sun" = PV − (house load − 3.3 kW while the compressor runs), never below a 200 W house: the pump's own draw is taken out, or switching it on would make the surplus vanish and it would switch itself off. "Power going out to the grid" counts from 500 W (`solar.exportW`).
- **Off because no zone wants heat** (valves all closed) waits for them to be closed 20 min, in the warm window and on solar alike; otherwise the minimum on time (30 min). A pause switches it off at once (a person asked, same as the panel's button).
- **At most 12 of its own switch-ons per rolling 24 h** (`MAX_ONS_PER_DAY`). Something that switches the pump off again and again (a broken controller, a person who should use Pausar) isn't fought past that: compressor starts are finite. The card says so when it happens.
- **Thermostats get 24 °C** when live (one target all day). They are at 26 °C by hand today, so **going live sets them to 24**. A zone or water setpoint changed by hand is respected until the plan next moves between day and warm (was: until the next of the four old periods).
- **No tariff setting**: the warm window is fixed by Renato, and nothing in the new plan depends on vazio. The inverter decides battery vs grid at night (Modbus is read-only).
- **Lisbon time by hand** (`energy.ts`'s offset), not the Pi's time zone: the window, the warm-up and every clock in the texts are Lisbon's across the clock changes.

## Where it runs

In the **bridge on the Pi** (`apps/noisysource/domotics-bridge/src/automation.ts`, wiring in `index.ts`). No cloud calls, no metered API, works without internet. The app only edits settings and shows what it is doing.

- Settings: `domotics_config/automation` (owner read/write, bridge read; read every 2 min, cached in `automation-config.json`). Fields: `enabled` (default false), `dryRun` (default true), `pauseUntil`, `comfort` (24), `warm {from, to}`, `dayMin` (21), `solar {enabled, socOn 90, pumpW 3300, exportW 500}`, `flow`, `recovery`, `rest`, `pumpFollowsZones {enabled, idleMin 20, minOnMin 30, minOffMin 15}`, `limits`. Old `preheat` / `evening` / `solarBoost` are ignored (the app's Guardar deletes them).
- Status for the app, published with the bridge state as `automation`: `mode` (`warm` / `warmup` / `day`), `wantOn`, `doing` (what it does now and why), `plan` (today in plain words), `warm` (next start, warm-up start, lead, need, capped, expected), `solar` (on, battery, spare W), `dayMinActive`, `pausedUntil`, `settings` (the four on top), plus water, zones, reasons, last actions, the learned model.
- Memory across restarts (`automation-state.json`): the learned model, the last water setpoint it sent, the warm-up in progress, its switch-ons in the last 24 h.

## The rules, in order of priority

1. **Fault, lockout, pump offline**: the automation doesn't touch the pump.
2. **E13 guard resting**: never switched on from here. Live, while the plan has the pump off the automation asks the guard to keep resting (`holdRest`); the guard ends its rest when the plan wants heat.
3. **Paused**: the plan is "off". Live, the pump is switched off at once.
4. **Warm window, warm-up, or a "quente às" request**: on when a zone wants heat (any valve open, or recovery/warm-up short of target, or too few thermostats answering to tell); off after all valves have been closed 20 min and it has run 30 min.
5. **Day**: on below the day minimum, or on spare sun with a zone wanting heat; otherwise off (after the minimum on time if someone switched it on).
6. Switching on, whoever switched it off: after the minimum off time (15 min from when it was seen off), at most 12 a day.
7. **Rest at the setpoint** (compressor ≤ 45 Hz, water ≥ setpoint − 1.5): the guard rests it 60 min when on; the automation does when the guard is off.
8. **Water** (`p02_heating`, dp 117): `clamp(30 + (15 − outdoor) × 0.8, 28, 45)` from the pump's own outdoor sensor; +1 °C per 30 min while the rooms are short (up to +4), −1 per hour at target; the top of the range (45) during recovery (rooms > 0.5 °C below their targets) and the warm-up; never lowered while the rooms are short, then 1 °C per 30 min; never raised while the compressor idles at the setpoint; a setpoint the automation didn't send is respected until the plan moves between day and warm.
9. **Zones**: `temp_set` = 24 (or a "quente às" target, if higher), 10 min apart at most; hand-changed zones respected as above; thermostats on their own program left alone.

## Safety

- Every pump switch respects the minimum on/off times; only a pause switches off at once.
- Never acts on a faulted pump; the guard's rests and lockout come first.
- Every write rate-limited and logged with its reason; a failed write counts for the rate limit (no retry loop: looping calls are the codebase's main cost risk, and here hardware wear). 12 switch-ons a day at most.
- If the bridge loses the devices or Firestore, it does nothing new; the settings stay as last cached.

## Rollout

1. ✅ Dry-run on the Pi (from 2026-10-26 evening): the card's "Agora (simulação)" and "Últimas ações" show what it would do. Watch a cloudy and a sunny day if possible.
2. **Renato goes live**: Clima → Automação do aquecimento → **Ligar** (one tap). The thermostats go to 24 °C, and from then on it switches the pump. To stop it: **Pausar**.
3. Watch the first night (the 23:54 off should be undone at ~00:09 by the automation, not the guard), and the first sunny day.

## Outside the app (Renato)

- **RENAC battery**: consider not discharging during vazio, so cheap night power runs the heating and the battery's solar energy covers the expensive evening. (2026-10-19: the pump drew ~3 kW all evening from the battery.)
- **Controller timer table**: clear it (the nightly 23:54 UTC off); see STATUS.

## Reference figures (2026-10-26, bridge + inverter)

- Pump ~3.3 kW while running (house 4.24 kW in pump-on 15-min slots vs 0.96 kW pump-off); night baseline 0.2–0.3 kW.
- Recovery from an 8 h off: 2.6 h and 10.7 kWh (4.0 from the grid, battery empty at 13 %, weak sun). Guard cycles: ~20–40 min running, 60 min rest.
- PV 32.7 kWh to 15:30; battery 13 → 54 %. Other appliances add 2–4 kW spikes at times.
- Inverter signs: grid < 0 import, > 0 export; battery > 0 charging; consumption = whole house, pump included.

## Cost plan (proposal 2026-10-28, not built, waiting for Renato's decisions)

> **Superseded 2026-11-02** by the schedule agreed after the comfort experiment, now in `domotics_config/automation` (dev, dry-run): pump 05:30–08:00 and 16:30–23:00, thermostats 25 (26 while heating on held-back sun, battery ≥ 40 %), water 40 °C fixed, ~€1.50/day sunny. Analysis: `HANDOFF-comfort-experiment.md` → "Results"; the solar rule: `domotics-bridge/src/automation.ts` header and PR #130. The levers below are kept as history.

Asked by Renato: "given the data we have, can we optimize costs and propose a plan?" Based on 26–28/10, the only days with 15-min energy slots, all disturbed by E13. The figures size the levers; they are not a forecast.

**What the data shows**
- The house uses 29–39 kWh a day, and the pump is about two thirds of it or more. PV gives 18–36 kWh. Export is 0.05–0.8 kWh and is paid €0 (`domotics_config/tariff.exportPrice`).
- Grid import is 7–21.5 kWh a day, 55 % of it at fora-vazio prices. Incl. 23 % VAT (above the first 200 kWh a month), vazio is ≈ €0.118 and fora ≈ €0.204. Fora imports cluster at 08–10 and 21–22.
- The battery is ≈ 25 kWh: about 28 kWh charged per 100 % of SOC, and 27 kWh discharged. It never went above 56 %, and on 27 and 28/10 it was at its 15 % floor by the evening.
- On 28/10 the guard was off and the pump ran all day at 44 °C water, with the thermostats at 26 by hand and the rooms at 25–26 °C. Bought energy came to ≈ €3.60 by 22:10.
- The pump has no power reading: `power_consumption` and `compressor_strength` are the coil and discharge temperatures (`dpmap.ts`). Pump power is inferred from the inverter (≈ 3.3 kW while running).
- **No room-temperature history is kept** (only the live state). So how fast the slab coasts with the pump off is unknown, and that is what decides how much heating can move to vazio and sun.

**Findings against the current automation (#120)**
- The solar rule needs a battery ≥ 90 %. It never got above 56 % this season, so the rule would never fire in winter.
- The 19:00–09:00 window heats at fora prices 19–22 and 08–09, when the battery is usually empty, so that heat is bought from the grid at ≈ €0.20.

**Levers, by value**
1. **Rooms at 24 °C** (Renato's own target; the thermostats are at 26 by hand). About 10–15 % less heat. Any time after the visit.
2. **Water following the outdoor temperature** (curve already in `automation.ts`: 44 → ≈ 32 °C at 12 °C outside). About 15–25 % less electricity for the same heat. **Only after the E13 repair:** at ≤ 35 °C water every start sits in the trip pattern.
3. **Timing, with the slab as the store:**
   - Main heating 22–08 at vazio.
   - By day, heat on the sun once the battery holds enough for the evening's non-heating load (≈ 40 % SOC, to be checked) instead of ≥ 90 %. A solar kWh into the slab in warm afternoon air beats one stored and spent at night.
   - Pump off 08–11 and 16–22 unless the rooms fall below a floor (≈ 22 °C, Renato to decide).
   - Moving 28/10's 12.3 kWh of fora import to vazio alone is ≈ €1/day.
4. **Minor:** if the RENAC app allows it, don't let the battery discharge in vazio, so its solar energy covers 08–10 instead (≈ €0.08/kWh, a few kWh on sunny days).
5. **Not worth it:**
   - Charging the battery from the grid at night: ≈ €0.07/kWh before wear, and wear takes most of it.
   - A lower contracted power: the pump's 3.3 kW plus spikes of 2–4 kW need 6.9 kVA.
   - Selling surplus: it's paid €0 and is tiny.

Rough total for a day like 28/10: ≈ €3.60 → ≈ €1.50–2.00. Measure it rather than trust it.

**Order**
1. **Now, repair pending:** record room temperatures, outdoor, water and compressor Hz in the 15-min energy slots. It's read-only, LAN only, with no cloud or metered API call, and gives the coasting rate and kWh per degree outside.
2. **After the repair is confirmed** (≈ a week of cold starts without E13): rooms to 24 °C, the water curve on, and the new timing rules, then the automation live.
3. **Two weeks later:** review against the data and tune the battery threshold and the room floor.

**Open questions for Renato**
- Is 19:00–09:00 comfort fixed, or may the rooms dip to ≈ 22–23 °C between 16 and 22 if the slab coasts?
- Rework the solar rule to "battery enough for tonight" (≈ 40 %) instead of 90 %?
- Build step 1 now, in a fresh session?
- Does the separate hot-water heat pump have a timer? It could run on sun (12–16) or in vazio.
