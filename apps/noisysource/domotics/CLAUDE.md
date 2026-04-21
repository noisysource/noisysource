# App: Domotics

> **Context**: See root `../../../CLAUDE.md` for group architecture. Backend logic lives in `../../../functions/src/domotics/`.

## Purpose
Home and building automation management. Controls and monitors smart devices (Shelly and others), circuits, energy consumption, and environmental systems.

## Visibility & Access
- **Private** — not internet-facing
- Protected by **GCP Identity-Aware Proxy (IAP)**
- No Firebase Auth needed (IAP handles identity)

## Status
🆕 To be built from scratch

---

## Stack
| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Backend | Firebase Cloud Functions (shared `/functions`) |
| Database | Firestore |
| Realtime | Firestore realtime listeners (WebSockets TBD — see notes) |
| Auth | GCP IAP |
| Hosting | Firebase Hosting (dev environment only) |

---

## Key Features (planned)
- Circuit-level device control (AC, heat pumps, blinds, lights)
- Energy monitoring — amps, watts, kWh per circuit
- Shelly device integration
- Live data dashboard
- Scheduling and automation rules
- Multi-room, multi-system support

---

## Device Model
- Each Shelly channel = one logical device in the system
- Devices grouped by room and circuit
- State managed in Firestore, changes triggered via Cloud Functions

---

## Firestore Collections
> To be defined during build. Prefix all collections with `domotics_`.

---

## ⚠️ WebSocket Note
Real-time live data (amps, watts, kWh streaming) will eventually require persistent WebSocket connections. Current plan:
- **Phase 1**: Use Firestore realtime listeners — sufficient for initial build
- **Phase 2**: Evaluate Cloud Run for a dedicated WebSocket service when live streaming becomes a requirement
- Do not over-engineer for Phase 2 until it is actually needed

---

## Notes
- IAP setup reference: `../../../infra/gcp/`
- Previous energy monitoring work exists in a separate repo — review before building to extract useful patterns
