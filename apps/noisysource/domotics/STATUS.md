# STATUS — Domotics

> Read this first when you start a session on this app. Update it before you sign off, even mid-task — this is Renato's re-entry point after a context switch, not a changelog.

**Last updated:** 2026-10-17

## Currently working on
**UI refactor: 3D house + an app for a wall tablet and two iPhones** (Renato's request, 2026-10-17). Branch `agent/domotics-3d`, worktree `.claude/worktrees/domotics-3d`. **Stacked on PR #95's branch** (`agent/domotics-pi-ip-fix`), because #95 rewrites the same screens — so merge #95 first; until then a PR from this branch would carry #95's commits too. **Not pushed, no PR yet** (waiting for Renato to try it).

Decisions taken with Renato (2026-10-17): no tablet bought yet (design for a 10–11" landscape screen); both phones are **iPhones**; phones get an **installable web app (PWA)**, not a native/App Store app; the 3D house is **generated from the existing floor plan**, not a scan.

Plan, in order:
1. ✅ **3D house + responsive screen** — done on the branch, see "Last completed".
2. **Phone app (PWA)**: web manifest + icons + service worker, `apple-mobile-web-app-*` meta, and **iOS sign-in**: inside an installed home-screen app `signInWithPopup` is unreliable — switch to `signInWithRedirect` with `authDomain` set to the hosting domain (`kidclub-dev-domotics.web.app`, which serves `/__/auth/handler`) and add it to Firebase Auth's authorized domains. Also make the bridge publish fast while a *remote* client is watching (today only LAN requests count, so away from home climate can be ~5 min old) — e.g. the app writes a heartbeat doc the bridge already reads on its 10s command poll.
3. **Household access for Renato's wife**: needs her Google account email. `firestore.rules` `isDomoticsOwner()` only admits `admin@kidclub.pt` / owner role, and — separately — the Legrand and Tuya callables (`functions/src/domotics/*.ts`, `requireOwner`) accept **any** signed-in user of the project. Replace both with one household allowlist. Rules/functions change → its own branch (infra).
4. **Wall tablet**: serve the built app from the Pi on the LAN so it uses the direct bridge (fast, works without internet); kiosk browser (Fully Kiosk on Android recommended); an idle/ambient screen; a slow, capped Legrand refresh (an always-on screen can't rely on "refresh when reopened" — Netatmo is metered/rate-limited, so keep it ≥60s and stop when the screen is off). The Pi is a 256 MB Pi 1: static files only, no build there.

## Last completed
**2026-10-17 — 3D house view with a tablet/phone layout** (branch `agent/domotics-3d`, 3 commits, not pushed):
- New everyday screen `src/components/HouseScreen.tsx` with `house3d/House3D.tsx` (react-three-fiber). Built from the saved floor plan: walls cut at 1.15 m, lit rooms glow with a pool of light per bulb, blinds drawn on the nearest wall showing how closed they are, heat pump unit with running/fault state, fault badge always visible. "Clima" toggle colours rooms by temperature (legend 16–25°). Tap a room (in 3D or in the panel's room list) → camera flies there, `RoomPanel.tsx` shows its lights (all on/off = one Netatmo call), blinds (open/stop/close/slider, all open/close = one call), thermostats and heat pump (cards reused from `ClimatePanel`).
- Layout: landscape tablet = 3D left + panel right; phone/portrait = 3D on top + panel below; header chips wrap to a second row on a phone; safe-area padding for an iPhone home-screen install. Default camera frames only the rooms with devices (the garage/storage wing made the house tiny on a phone).
- On-demand rendering only (no idle 60fps on an always-on tablet), three.js in its own lazy chunk (main 179 kB gz, 3D 244 kB gz), WebGL failure falls back to "Ver planta 2D".
- The 2D plan stays as the editor/detail view (map button; "3D" button back); choice remembered per device (`localStorage` `domotics.view`). Editing always opens the 2D plan, and returns to 3D after.
- Shared code: device placement now lives in `src/data/placement.ts` (2D and 3D can't disagree); status chips + fault banner in `HealthChips.tsx`.
- Behaviour fixes: a failed Legrand command now **rolls back** the optimistic state (before, a refused command left the light shown on); Legrand state is re-read when the app returns to the foreground (≥60s apart, not a poll).
- Verified in Chrome against the real plan and live bridge (on the LAN), tablet size and a 390×844 phone viewport: room select/fly-to, light chip toggle (signed out, so the callable refused with "Sign-in required" — nothing switched — and the rollback restored "apagada"), Clima mode, 2D↔3D, edit→cancel→3D, no console errors. Not tried on a real iPhone/tablet yet. Thermostat/heat pump/blind controls in the new panel were **not** exercised (they'd send real commands); they're the same components/handlers as the existing ones.
- To try it at home: `cd .claude/worktrees/domotics-3d && pnpm --filter domotics dev -- --host`, then open `http://<mac-LAN-IP>:5175` on the iPhone (LAN origin → no sign-in, direct to the Pi). The worktree's `.env.development`/`.env.staging` are **symlinks** to the main checkout's (gitignored; nothing copied).

**2026-10-17 — UI you can actually read the house from** (`src/components/ClimatePanel.tsx`, `PlanScreen.tsx`, `App.tsx`) — PR #95:
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
1. **Heat pump: E13 is active again (seen 2026-10-17 13:18 UTC)** — see "Anything risky". Physical/installer issue, not software.
2. **Try the 3D UI on the iPhone** (command in "Last completed") and say what to change. Then merge PR #95, rebase `agent/domotics-3d` onto `staging`, and open its PR → `staging`.
3. Phase 2 (PWA + iOS sign-in) — see the plan under "Currently working on".
4. **Sign in on https://kidclub-dev-domotics.web.app and click through** (Google sign-in; away from home it reads via the Firestore relay, so readings can be up to ~5 min old — the bridge only polls fast when a LAN client is watching). At home, `pnpm dev:domotics` (http://localhost:5175) goes straight to the Pi and needs no sign-in for climate. To redeploy: `pnpm --filter domotics build:staging && npx firebase-tools@13 deploy --only hosting:domotics --project=kidclub-dev`.
5. **Stop the IPs moving**: reserve fixed DHCP leases on the MEO router for the 7 Tuya devices (IPs above). The bridge now survives restarts, but not a lease reshuffle — that still needs `sync-tuya-keys.js --write`.
6. Promote `staging` → `main` as usual once #95 (and later this branch) are merged.

## Open questions for Renato
- **Your wife's Google account email** — needed for household access (phase 3). Until then only `admin@kidclub.pt` gets climate/relay away from home.
- **Tablet**: none bought yet. Recommendation: a 10–11" Android tablet (runs Fully Kiosk Browser — screen-on schedule, motion wake, auto-restart). An iPad works too, with fewer wall-panel features.
- The 3D view is from the plan's rectangles and walls only (single storey, no roof/furniture). Say if you want more (e.g. windows/doors in the walls, solar panels on a roof layer, outdoor equipment).
- Not mapped into the app yet (available in the bridge state if wanted): C00 coil, C01 discharge and C03 suction temperatures (Tuya codes `power_consumption`, `compressor_strength`, `temp_bottom`). Discharge temp helps diagnose high-pressure faults.
- No commands beyond on/off for the heat pump (mode/setpoints are read-only in the app). Say if setpoint control is wanted.
- A fault only shows while the app is open. If you want to be told when one appears (push/email), that's a new feature — say so.

## Anything risky in flight
- **Heat pump E13 (high-pressure protection) active again — 2026-10-17 13:18 UTC**, read live from the bridge: `fault` dp = 4096, `switch` = off, compressor 0 Hz, outdoor 24.7 °C, water in 25.5 °C / out 26.3 °C (setpoint 42), DHW setpoint 45. The 2026-10-16 note says E13 was fixed physically, so it has come back (or the "off" is someone switching it off after it tripped). Nothing was commanded from this session.
- Branch `agent/domotics-3d` (local only, not pushed) is stacked on #95's branch. The new 3D panel's light/blind/thermostat/heat-pump controls send **real commands** (same handlers as before); in this session only a light toggle was exercised, signed out, and the callable refused it.
- No new external/metered API calls. Legrand (Netatmo) is now also re-read when the app returns to the foreground — at most once a minute per open app, not a poll.
- The Pi runs `pin-device-arp.sh` and bridge `lib/` from this branch / `staging`, ahead of `main`. Harmless (the bridge isn't part of the prod pipeline) but worth knowing. If devices ever drop to 2–3/7 again: `ip neigh show dev eth0` on the Pi — the repeater devices must point at `d6:35:38:f6:ea:21`.
- The heat pump on/off and thermostat −/+ in the new panel send **real commands** to the devices (same bridge path as the existing plan popovers). Not exercised against hardware in this session — only with the command intercepted in the browser.
- No new external/metered API calls. `sync-tuya-keys.js` made two Tuya cloud calls (token + device list).
