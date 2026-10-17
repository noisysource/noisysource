# STATUS — Domotics

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-17

## Currently working on
PR #95 (`agent/domotics-pi-ip-fix` → `staging`): climate panel UI + ARP fix + this STATUS. Code is done and verified locally against the real house; **the hosted app is not deployed yet** — blocked only on `firebase login --reauth` (the Firebase CLI's own login expired; gcloud is fine).

## Last completed
**2026-10-17 — UI you can actually read the house from** (`src/components/ClimatePanel.tsx`, `PlanScreen.tsx`, `App.tsx`):
- Side panel (thermometer button in the header; open by default on wide screens, overlays the plan on narrow ones): heat pump card with state ("A trabalhar · 50 Hz" / "Em espera" / "Desligada"), "Sem avarias" or each fault with its PT meaning, mode, outdoor, water in/out vs setpoint, DHW vs setpoint, and on/off with a two-tap confirm for "off". Below it every thermostat: current temp, room, humidity, heating flame, low battery, and −/+ for the target (taps settle for 0.7s, then one command for the final value).
- Header health chips, always visible: "Clima · 7/7" (green; amber if a device is down or the bridge reading is >90s old) and "Luzes e estores" / **"Luzes: entrar"** (amber, clickable). The old red "Gateway offline" on the LAN was just the Legrand callable refusing a signed-out caller, not a fault; Legrand now also reloads after sign-in.
- Red fault banner across the top whenever the heat pump reports a fault (verified with a simulated E13 in the browser — no command sent).
- A missed first bridge poll retries every 4s (twice) before showing "Clima offline", instead of sitting on "Bridge offline" for 30s.

**2026-10-17 — `pin-device-arp.sh` fixed and verified on the Pi** (deployed there by `scp`): only a MAC that answers for 2+ devices counts as the repeater; every device resolving through it is pinned (its proxy-ARP is intermittent — .164 resolved during the script and was FAILED minutes later); unresolved devices keep a pin only if TCP 6668 answers through it; stale pins are cleared even without a device cache. A full `systemctl restart` went straight to 7/7. `sync-tuya-keys.js` now prints the right post-sync step (restart, wait, re-run the pin script).

**2026-10-16 — Pi bridge back to 7/7 devices online, running the heat pump fault mapping.**
- Symptom: since ~2026-10-04/14 only Sala and Master bedroom were online; the other five had failed ~2,900 polls in a row.
- Cause 1 — **DHCP reshuffled the Tuya devices' IPs** and `domotics_config/tuya_devices` still held the old ones. The heat pump had landed on Quarto thermostat's old IP, so the bridge was dialling the wrong device with the wrong key. Fixed by running `deploy/sync-tuya-keys.js --write` (keys unchanged; only IPs and two SmartLife renames). Current IPs: Quarto .158, Kids Bathroom .126, Hall quartos .164, Quarto Diniz .129, heat pump ("Bomba piso radiante Eiras") .157, Sala .155, Master bedroom .206.
- Cause 2 — **`deploy/pin-device-arp.sh` pinned five devices to the wrong MAC.** There are three MACs in front of the devices: the WiFi repeater `d6:35:38:f6:ea:21` (answers for .126 .129 .157 .158 .164), and Sala's own `f8:17:2d:9f:83:ad` and Master bedroom's own `f8:17:2d:9f:86:4d` (those two are on the main router's WiFi). The script's majority vote elected Master bedroom's own MAC and pinned the repeater devices to it. Fixed by hand first, then properly in the script (2026-10-17, above).
- Bridge `lib/` redeployed from `staging` (only `dpmap.js` differed). Backups on the Pi: `~/domotics-bridge/lib.bak-20261016`, `package.json.bak-20261016`, `device-cache.json.bak-20261016` — delete once happy.
- Verified: `[state] 7/7 online`; heat pump state includes all six fault bitmaps (all 0), compressor Hz, outdoor, water in/out, DHW and setpoints.
- The E13 high-pressure fault from 2026-10-02 was fixed physically (Renato, 2026-10-16).

2026-10-02 — Heat pump fault codes + corrected heat pump readings (PR #73, merged to `staging`). The unit is a **Zantia Vancouver 13 (single-phase, R32)**, manual "Vancouver 13DC-32": https://zantia.com/storage/products/vzau85qrqt.pdf. Datapoint table in `domotics-bridge/README.md` → "Heat pump"; fault bitmaps decoded in `src/data/heatpumpFaults.ts`; active faults show as a red badge on the plan tile and at the top of the heat pump popover.

## Next step
1. **Deploy the hosted app**: `npx firebase-tools@13 login --reauth`, then from the worktree `pnpm --filter domotics build:staging && npx firebase-tools@13 deploy --only hosting:domotics --project=kidclub-dev`. https://kidclub-dev-domotics.web.app is still the old build (no panel, no fault badge). At home, `pnpm dev:domotics` (http://localhost:5175) already has everything and needs no sign-in for climate.
2. **Stop the IPs moving**: reserve fixed DHCP leases on the MEO router for the 7 Tuya devices (IPs above). The bridge now survives restarts, but not a lease reshuffle — that still needs `sync-tuya-keys.js --write`.
3. Review/merge PR #95 into `staging`, then promote `staging` → `main` as usual.

## Open questions for Renato
- Not mapped into the app yet (available in the bridge state if wanted): C00 coil, C01 discharge and C03 suction temperatures (Tuya codes `power_consumption`, `compressor_strength`, `temp_bottom`). Discharge temp helps diagnose high-pressure faults.
- No commands beyond on/off for the heat pump (mode/setpoints are read-only in the app). Say if setpoint control is wanted.
- A fault only shows while the app is open. If you want to be told when one appears (push/email), that's a new feature — say so.

## Anything risky in flight
- The Pi runs `pin-device-arp.sh` and bridge `lib/` from this branch / `staging`, ahead of `main`. Harmless (the bridge isn't part of the prod pipeline) but worth knowing. If devices ever drop to 2–3/7 again: `ip neigh show dev eth0` on the Pi — the repeater devices must point at `d6:35:38:f6:ea:21`.
- The heat pump on/off and thermostat −/+ in the new panel send **real commands** to the devices (same bridge path as the existing plan popovers). Not exercised against hardware in this session — only with the command intercepted in the browser.
- No new external/metered API calls. `sync-tuya-keys.js` made two Tuya cloud calls (token + device list).
