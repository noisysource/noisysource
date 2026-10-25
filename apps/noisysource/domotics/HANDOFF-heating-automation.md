# Handoff: heating automation (floor heating, solar, bi-horário)

**Status:** built 2026-10-19 (PR #106), in dry-run since the cold morning of 2026-10-20. Reworked 2026-10-25 (`agent/domotics-warm-by`) after that morning and the E13 trips of 21–24/10: recovery, hand-set water, faster correction, rest at the setpoint, and "warm by HH:MM". Renato decides when it goes live. What happened on those days: `STATUS.md`.

## Goal

Keep the house at ~24 °C for less energy and less money. Rooms are underfloor heating on a heavy screed slab, fed by the Zantia Vancouver 13 air-to-water heat pump (floor heating **only** — hot water/AQS is a separate, unintegrated heat pump). Six Tuya TR01 thermostats open and close the zone valves. The house has PV + a RENAC battery, and a **bi-horário** tariff.

## Decisions (Renato, 2026-10-19)

- Tariff: **bi-horário**. Default to the daily cycle (vazio 22:00–08:00); make the hours a setting, since the weekly cycle differs.
- Automation level: **everything, with limits** — the Pi may set the heat pump's flow temperature, switch the pump on/off, and set zone targets, within hard limits, with an off switch in the app.

## Where it runs

In the **bridge on the Pi** (`apps/noisysource/domotics-bridge`): it is always on, already polls every device over the LAN, and already writes to them. No cloud calls, no metered API, works without internet. The app only edits settings and shows what the automation is doing.

- Settings: `domotics_config/automation` (Firestore; bridge reads it — widen the bridge's rule for this one doc only). Fields: `enabled` (default **false**), `dryRun` (default **true**), `comfort` (24), tariff hours, curve parameters, limits.
- State for the app: `domotics_state/automation` — current mode, last decision per device and **why** ("flow 33 °C: outdoor 11 °C", "boost: exporting 1.4 kW", "pump off: all zones satisfied 20 min").

## The rules

1. **Weather-compensated flow temperature** (the biggest saving: ~2–3% less electricity per °C cooler water). Flow setpoint `p02_heating` (Tuya dp 117, writable: proven 2026-10-20):
   `flow = clamp(30 + (15 − outdoor) × 0.8, 28, 45)` → 30 °C at 15 °C outside, 34 °C at 10 °C, 38 °C at 5 °C. Top of the range 45 °C (Renato, 2026-10-25; was 38).
   - **Shortfall** = how far each room is below the target its thermostat has, averaged (a room above target counts as 0, so it can't make up for a cold one).
   - **Correction** (faster since 2026-10-25): shortfall > 0.25 °C for 30 min → +1 °C, up to +4; at target (≤ 0.05) for an hour → −1.
   - **Recovery** (2026-10-25): shortfall > 0.5 °C → water at the top of the range (45) until it is ≤ 0.2. On 20/10 the curve lowered the water overnight to 29–31 °C while the slab was still recovering, and the house woke at 21.7–22.8 °C.
   - **Never lowered while the rooms are below target** (shortfall > 0.2), and then only 1 °C per 30 min. Raised at most every 15 min. Only changes ≥ 1 °C are written.
   - **A setpoint the automation didn't send is someone's** (SmartLife, the panel, the technicians): left alone until the next period, like a zone. So is the one found when the bridge starts, unless it is the last one the automation sent (kept in `automation-state.json`).
2. **Time-of-day room targets** (written to the thermostats' `temp_set`):
   - 05:00–08:00 (end of vazio): **24.5** — pre-heat the slab on cheap power.
   - Daytime: **24.0**, raised to **24.5** while *solar boost* applies: exporting > 800 W, or battery ≥ 95% and PV > house load. Drop the boost after 15 min without surplus.
   - 18:00–22:00 (expensive evening): **23.5** — coast on the stored heat.
   - 22:00–05:00 (vazio): **24.0**.
   All configurable per zone later; one house-wide schedule first. Hard limits 21–25 °C.
3. **Pump follows the zones**: if every zone valve has been closed for ≥ 20 min, switch the pump off; switch it on when any zone opens. Minimum on time 30 min, minimum off time 15 min. Whoever switched it off (the automation, the guard's rest, SmartLife, the panel, the technicians), it comes back on when heat is wanted; the guard's rest and a fault still come first. Needs at least half the thermostats answering: with fewer (only 1–2 answered on 22–25/10), "all closed" means nothing.
3b. **Never idle at the setpoint** (2026-10-25, from the E13 trips): every trip came after the water reached the setpoint, the compressor dropped to its minimum (35–45 Hz), idled 4–25 min and then sped up again; starts from standstill never tripped (11 of 11). So:
   - at the setpoint with the compressor ≤ 45 Hz (water ≥ setpoint − 1.5, 4 min after a switch-on), the pump is switched off and rests 60 min. With the E13 guard on, the guard does it; with it off, the automation does;
   - after a rest it comes back on only when a zone wants heat (or recovery, or a warm-by). With the guard's rests, the automation (live only) asks the guard to carry on resting while nothing wants heat (`holdRest`), and never switches on a pump the guard parked;
   - the water is never raised while the compressor idles at the setpoint: raised then, it speeds up from its minimum, which is the trip. It is raised while the pump is off, so it restarts from standstill.
4. **Warm by HH:MM** (2026-10-25, `src/warmby.ts`): a one-off target set from the app's automation card (or, later, the chat) through the `domoticsWarmBy` callable, stored in `domotics_config/warm_by` (the callable is the only writer; 10 min–24 h ahead; no target = comfort).
   - Start = time − (floor + shortfall ÷ room rate + 30 min margin), with the shortfall measured from the rooms' mean.
   - Floor: once the pump starts, the water leaving it is warm within ~15 min, but the return water (the slab) keeps climbing. From the 20-s logs of 21–24/10: it levelled off 36–63 min after a start with the water at 34–35 °C, and 73–121 min at the technicians' 44 °C. Default 90 min.
   - Rooms: ~0.3 °C/h once the floor is warm (observed; no room history exists to check it against).
   - Both are learned live (`automation-state.json`; the card shows them): every start after a ≥ 30 min stop measures the floor, and every 1–2 h of rooms below target with a warm floor measures their rise.
   - From the start until the time: room targets at least the requested one, water at the top of the range while short. Then the target is held for an hour and the request is done. The card shows the start, the expected arrival (and if late), and how the house was at the time.
   - A pump switched off from outside is switched back on for it, like any other heat request (rule 3).
5. **No large setbacks**: never schedule more than 1 °C below comfort — the slab takes hours to recover and recovery is the expensive, low-efficiency part.

## Safety

- **Never act on a faulted pump**: any fault bit set → stop all automation writes to the pump, leave it as it is, surface the fault (the 2026-10-02 / 10-17 E13 high-pressure history is why; lower flow temperatures also lower that risk).
- Every write rate-limited per device (≥ 10 min apart, except the pump on/off minimums above), bounded by the hard limits, and logged with its reason.
- Manual change wins: if a thermostat or the pump's water setpoint is changed by hand (app or device), the automation leaves it alone until the next scheduled period. **Not the pump's on/off** (Renato, 2026-10-25: the automation is obeyed whoever switched the pump off): an off from outside is switched back on when heat is wanted, after the minimum off time.
- If the bridge loses the devices or Firestore, it does nothing new — it never retries writes in a loop (root CLAUDE.md: looping calls are the main cost risk; here they would also be hardware wear).

## Rollout

1. Build with `dryRun: true`: the bridge computes and **logs** decisions ("would set flow 33 °C") without sending them. Run it for a day; Renato checks the log against how the house felt.
2. Turn on flow-temperature compensation alone for a few days; watch rooms still reach target.
3. Then the schedule + solar boost; then pump-follows-zones.
4. App: in the Clima layer, an "Automação" card — on/off, dry-run, comfort temperature, tariff hours, and the current decision and reason.

## Outside the app (Renato)

- **RENAC battery**: set it (RENAC app, time-of-use / scheduled mode) to **not discharge during vazio**, so cheap night power runs the heating and the battery's solar energy covers the expensive evening and morning. Observed 2026-10-19 20:30: the pump drew ~3 kW all evening from the battery (92% → 90% in 10 min), which would empty it around 02:00–03:00.
- 24 °C is warm for a house; each 1 °C lower saves roughly 6–7% of heating energy, if ever wanted as an extra lever.

## Reference readings (2026-10-19 20:22–20:32, pump just fixed, cold start)

Outdoor 10–11.5 °C · compressor 70→85 Hz · water out 30.5→35.5→34.8 °C, in 26.0→30.5→29.0 °C (plateau: the slab absorbing heat) · rooms 20.8–22.3 °C, targets 24–25, all valves open · house load ~3.6 kW.
