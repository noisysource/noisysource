# Handoff: heating automation (floor heating, solar, bi-horário)

**Status:** designed 2026-10-19 with Renato, not started. Build on its own branch (`agent/domotics-heating-automation`), after or on top of PR #106.

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

1. **Weather-compensated flow temperature** (the biggest saving: ~2–3% less electricity per °C cooler water). Flow setpoint `p02_heating` (Tuya dp 117 — **confirm it is writable** before relying on it):
   `flow = clamp(30 + (15 − outdoor) × 0.8, 28, 38)` → 30 °C at 15 °C outside, 34 °C at 10 °C, 38 °C at 5 °C. Plus a slow correction: if the average room deficit to target is > 0.5 °C for > 2 h, +1 °C (max +3); remove it when rooms are at target. Write at most once per 30 min, only on a change ≥ 1 °C.
2. **Time-of-day room targets** (written to the thermostats' `temp_set`):
   - 05:00–08:00 (end of vazio): **24.5** — pre-heat the slab on cheap power.
   - Daytime: **24.0**, raised to **24.5** while *solar boost* applies: exporting > 800 W, or battery ≥ 95% and PV > house load. Drop the boost after 15 min without surplus.
   - 18:00–22:00 (expensive evening): **23.5** — coast on the stored heat.
   - 22:00–05:00 (vazio): **24.0**.
   All configurable per zone later; one house-wide schedule first. Hard limits 21–25 °C.
3. **Pump follows the zones**: if every zone valve has been closed for ≥ 20 min, switch the pump off; switch it on when any zone opens. Minimum on time 30 min, minimum off time 15 min.
4. **No large setbacks**: never schedule more than 1 °C below comfort — the slab takes hours to recover and recovery is the expensive, low-efficiency part.

## Safety

- **Never act on a faulted pump**: any fault bit set → stop all automation writes to the pump, leave it as it is, surface the fault (the 2026-10-02 / 10-17 E13 high-pressure history is why; lower flow temperatures also lower that risk).
- Every write rate-limited per device (≥ 10 min apart, except the pump on/off minimums above), bounded by the hard limits, and logged with its reason.
- Manual change wins: if a thermostat or the pump is changed by hand (app or device), the automation leaves that device alone until the next scheduled period.
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
