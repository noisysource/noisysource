# STATUS — Domotics

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-16

## Currently working on
Nothing in progress. The Pi bridge was fixed and redeployed on 2026-10-16 (below); the hosted app has not been redeployed yet.

## Last completed
**2026-10-16 — Pi bridge back to 7/7 devices online, running the heat pump fault mapping.**
- Symptom: since ~2026-10-04/14 only Sala and Master bedroom were online; the other five had failed ~2,900 polls in a row.
- Cause 1 — **DHCP reshuffled the Tuya devices' IPs** and `domotics_config/tuya_devices` still held the old ones. The heat pump had landed on Quarto thermostat's old IP, so the bridge was dialling the wrong device with the wrong key. Fixed by running `deploy/sync-tuya-keys.js --write` (keys unchanged; only IPs and two SmartLife renames). Current IPs: Quarto .158, Kids Bathroom .126, Hall quartos .164, Quarto Diniz .129, heat pump ("Bomba piso radiante Eiras") .157, Sala .155, Master bedroom .206.
- Cause 2 — **`deploy/pin-device-arp.sh` pinned five devices to the wrong MAC.** There are three MACs in front of the devices: the WiFi repeater `d6:35:38:f6:ea:21` (answers for .126 .129 .157 .158 .164), and Sala's own `f8:17:2d:9f:83:ad` and Master bedroom's own `f8:17:2d:9f:86:4d` (those two are on the main router's WiFi). The script's majority vote elected Master bedroom's own MAC and pinned the repeater devices to it. Fixed by hand on the Pi: cleared all permanent pins, pinned .126 and .129 to the repeater MAC (.157/.164 resolved on their own). **Not persistent** — see "Anything risky".
- Bridge `lib/` redeployed from `staging` (only `dpmap.js` differed). Backups on the Pi: `~/domotics-bridge/lib.bak-20261016`, `package.json.bak-20261016`, `device-cache.json.bak-20261016` — delete once happy.
- Verified: `[state] 7/7 online`; heat pump state includes all six fault bitmaps (all 0), compressor Hz, outdoor, water in/out, DHW and setpoints.
- The E13 high-pressure fault from 2026-10-02 was fixed physically (Renato, 2026-10-16).

2026-10-02 — Heat pump fault codes + corrected heat pump readings (PR #73, merged to `staging`). The unit is a **Zantia Vancouver 13 (single-phase, R32)**, manual "Vancouver 13DC-32": https://zantia.com/storage/products/vzau85qrqt.pdf. Datapoint table in `domotics-bridge/README.md` → "Heat pump"; fault bitmaps decoded in `src/data/heatpumpFaults.ts`; active faults show as a red badge on the plan tile and at the top of the heat pump popover.

## Next step
1. **Redeploy the hosted app** — https://kidclub-dev-domotics.web.app is still an old build (no fault badge, old `tankTop` fields). Nothing in CI deploys domotics; it's `pnpm --filter domotics build:staging` then `firebase deploy --only hosting:domotics --project kidclub-dev`. Until then the fault badge only exists with `pnpm dev:domotics` locally.
2. **Stop the IPs moving**: reserve fixed DHCP leases on the MEO router for the 7 Tuya devices (IPs above). Without this the next lease shuffle breaks the bridge the same way.
3. Fix `pin-device-arp.sh` so it can't elect a single device's own MAC — e.g. only accept a MAC that answers for 2+ IPs, or verify each pin with a TCP connect to 6668 and try the next candidate MAC on failure.
4. Promote `staging` → `main` as usual (the heat pump commits are still only on `staging`).

## Open questions for Renato
- Not mapped into the app yet (available in the bridge state if wanted): C00 coil, C01 discharge and C03 suction temperatures (Tuya codes `power_consumption`, `compressor_strength`, `temp_bottom`). Discharge temp helps diagnose high-pressure faults.
- No commands beyond on/off for the heat pump (mode/setpoints are read-only in the app). Say if setpoint control is wanted.
- A fault only shows while the app is open. If you want to be told when one appears (push/email), that's a new feature — say so.

## Anything risky in flight
- **The ARP fix on the Pi is runtime-only.** Any bridge restart or Pi reboot reruns `pin-device-arp.sh`, which may vote wrong again. If devices drop to 2–3/7 after a restart, check `ip neigh show dev eth0` on the Pi: the repeater devices must point at `d6:35:38:f6:ea:21`. Fix with `sudo ip neigh replace <ip> lladdr d6:35:38:f6:ea:21 dev eth0 nud permanent`.
- The Pi runs bridge code from `staging`, ahead of `main`. Harmless (the bridge isn't part of the prod pipeline) but worth knowing.
- No new external/metered API calls. `sync-tuya-keys.js` made two Tuya cloud calls (token + device list).
