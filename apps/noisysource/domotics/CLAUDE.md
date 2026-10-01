# App: Domotics

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/domotics/`.

## Purpose
Home automation for Renato's house: lights, blinds, and climate control, plus a live dashboard. Two separate device ecosystems, both behind cloud APIs with a local bridge in front for speed:
- **Legrand** (lights, blinds) — via the **Netatmo API** (`functions/src/domotics/legrand.ts`)
- **Tuya/SmartLife** (thermostats, heat pump) — via the **Tuya Cloud API**, EU data centre (`functions/src/domotics/tuya.ts`)

There is no Shelly integration and no amps/watts/kWh energy monitoring — despite earlier planning docs, those were never built.

## Visibility & Access
- **Not behind GCP IAP** — no IAP setup exists for this app (unlike Finances/Tasks).
- On the house LAN, the app talks straight to the local bridge (see below) and requires no sign-in — the whole point is being able to control your own house during an internet outage.
- Off the LAN (hosted build), the app requires **Firebase Auth (Google sign-in)** — `requiresSignIn()` in `src/lib/auth.ts` gates the UI, but the real enforcement is `firestore.rules`, since `domotics_commands`/`domotics_state` are reachable from the public internet once the relay is in play.

## Status
🔨 Working, in active use — not scaffolding. Known rough edges (2026-08-09, verify before trusting): blind open/closed state is inverted in the UI, device status has no polling so it drifts from physical switches, dimming is stubbed, blind "stop" sends a position instead of a real stop.

---

## Architecture: local bridge + cloud relay
A Raspberry Pi on the house LAN (`192.168.1.125`) runs a bridge service that talks to the devices directly and answers plain HTTP (`src/lib/bridge.ts`):
- **On the LAN**: the app calls the bridge directly (`VITE_BRIDGE_URL`) — a LAN round trip, no cloud involved, works even if the internet is down.
- **Off the LAN**: the bridge is behind NAT and unreachable, and a browser blocks `http://` calls to a private address from an `https://` page as mixed content anyway. The app falls back to a Firestore relay: the bridge publishes state to `domotics_state/tuya`, and commands are queued to `domotics_commands` for the bridge to pick up. Relayed state older than 15 minutes is treated as offline, not stale-but-valid.
- The Pi authenticates to Firestore as a **dedicated Firebase Auth user over REST** (`domotics-bridge@kidclub.pt`), never a service-account key — blocked at the org level (`constraints/iam.disableServiceAccountKeyCreation`) and deliberately not exempted, so this isn't a "TODO fix later." If the bridge needs a new Firestore path, widen that UID's grant in `firestore.rules`, don't reach for IAM.

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite, TypeScript, Tailwind |
| Backend | Firebase Cloud Functions (shared `/functions`), local bridge on the Pi |
| Database | Firestore (`(default)` database, `domotics_*` collections) |
| Realtime | Poll-based today; no WebSocket yet (root CLAUDE.md's Phase 2 WebSocket plan hasn't started) |
| Auth | Firebase Auth (Google), gated by `firestore.rules` — no IAP |
| Hosting | Firebase Hosting, **dev only** (`kidclub-dev-domotics`) — no prod hosting target exists yet |

## Firestore Collections
Prefixed `domotics_`:
- `domotics_config/netatmo`, `domotics_config/tuya` — OAuth credentials for each cloud API (sensitive — see Notes)
- `domotics_state/tuya` — last known device/inverter state, published by the bridge
- `domotics_commands` — command queue the bridge drains when off-LAN

---

## Local Dev
```bash
pnpm dev:domotics        # runs against kidclub-dev, http://localhost:5173
pnpm dev:domotics:prod   # dev server against prod Firebase — see root CLAUDE.md, not a default debugging step
```

## Deploy
Dev only for now (see Status/Hosting above):
```bash
pnpm --filter domotics build:staging
firebase deploy --only hosting:domotics --project=kidclub-dev
```
There is no prod deploy target yet — don't invent one without checking with Renato first.

---

## Cost notes
Both Netatmo and Tuya are metered cloud APIs — this is exactly the class of bug the root CLAUDE.md's "repeated/looping call to a metered API" warning is about. Tuya access tokens are cached in module scope (~2h TTL) specifically to avoid a token round-trip per call; don't remove that caching without replacing it with something equivalent.

---

## Notes
- `domotics_config/netatmo` (OAuth client id/secret/refresh token) was **world-readable from 2026-08-05 to 2026-08-09** — confirm it's been rotated in the Netatmo console before treating those credentials as trustworthy; check `firestore.rules` covers `domotics_config` correctly before touching it.
- The Pi is a 256MB Raspberry Pi 1 Model B Rev 2, MAC `b8:27:eb:bd:be:8c`, key-based SSH as `pi`. Every Tuya device sits behind a WiFi repeater and shares its MAC from the Pi's wired side — `deploy/pin-device-arp.sh` works around the repeater's proxy-ARP refusing some IPs. Remove that workaround if the MEO router's WiFi is ever split and devices move off the repeater.
- Previous energy monitoring work exists in a separate repo — review before building energy features, if that's ever picked back up.

---

## Session start/end

Read `STATUS.md` (same folder) before starting work — it holds what's in progress, what's next, and anything open that needs Renato's decision. Update it before ending a session, even mid-task: current state, next concrete step, open questions, and anything risky left in flight. This is how Renato resumes cold after a context switch, so write it for someone with zero memory of this session, not as a changelog entry.

**Note (2026-09-21):** this file was substantially out of date until now — it described a from-scratch Shelly build that was never built, while the real Legrand/Tuya integration shipped without the doc being updated. If something here looks off again, check the code before planning from it, and fix the doc rather than let it drift a second time.
