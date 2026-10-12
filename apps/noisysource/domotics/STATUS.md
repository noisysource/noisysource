# STATUS — Domotics

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-02

## Currently working on
Nothing in progress beyond the open PR below (branch `agent/heatpump-faults`, targets `staging`).

## Last completed
Heat pump fault codes + corrected heat pump readings (PR from `agent/heatpump-faults` → `staging`, not merged yet as of writing):
- The heat pump is a **Zantia Vancouver 13 (single-phase, R32)**, Zantia code 2301-0273 (label reads 2301-8273), manual "Vancouver 13DC-32": https://zantia.com/storage/products/vzau85qrqt.pdf. It is **not** an "MTATWHP-5C" — that name was wrong and has been removed from code and docs.
- Bridge `domotics-bridge/src/dpmap.ts` now maps the full set of heat pump datapoints, taken from the device's Tuya cloud thing model (table in `domotics-bridge/README.md` → "Heat pump"). The Tuya `code` names are vendor-reused and misleading (e.g. `temp_top` = outdoor temp, `temp_current` = compressor Hz).
- App: `HeatPumpState` (`packages/shared/models/Device.ts`) replaced the mislabeled `tankTop`/`tankBottom`/`power` with `mode`, `compressorHz`, `outdoor`, `waterIn`, `waterOut`, `dhwTank`, the three setpoints, and `faults: string[]`. Fault bitmaps are decoded in `src/data/heatpumpFaults.ts` (bit tables + PT meanings from manual §5.3.2-8). Active faults show as a red badge on the plan tile and at the top of the heat pump popover.

## Next step
1. Review/merge the PR into `staging` and click through the heat pump popover on the dev deploy.
2. **Redeploy the bridge on the Pi by hand**: `apps/noisysource/domotics-bridge/deploy/README.md` step 3 (`pnpm build` + `rsync` of `lib`), then `sudo systemctl restart domotics-bridge` on the Pi. Until that happens the Pi keeps running the old `dpmap.ts`, which doesn't emit the fault/water/DHW datapoints — so the app will show "—" for the new readings and **no faults at all**, even with the PR merged.
3. Then promote `staging` → `main` as usual.

## Open questions for Renato
- The E13 fault from 2026-10-02 (below) needs a physical/installer look — the app only reports it.
- Not mapped into the app yet (available in the bridge state if wanted): C00 coil, C01 discharge and C03 suction temperatures (Tuya codes `power_consumption`, `compressor_strength`, `temp_bottom`). Discharge temp could help diagnose high-pressure faults; say if you want it in the popover.
- No commands beyond on/off for the heat pump (mode/setpoints are read-only in the app). Say if setpoint control is wanted.

## Anything risky in flight
- PR `agent/heatpump-faults` → `staging` is open (deploys to `kidclub-dev` on open/update; nothing to prod).
- **Bridge needs a manual redeploy on the Pi** for faults to appear at all (see Next step 2). The app change alone is harmless without it — fields just render "—".
- **Live fault seen 2026-10-02 12:09: E13 = high-pressure protection** (dp15 = 4096 → bit 12). Compressor stopped (dp16 = 0 Hz). Manual's causes: too much refrigerant, a restriction in the circuit, or a faulty pressure sensor/switch. At that moment: outdoor 22.3 °C, water in/out 33.0 °C, DHW tank 30.5 °C, heating setpoint 42 °C, DHW setpoint 45 °C.
- No new external/metered API calls were added; the app still reads only bridge/relay state.
