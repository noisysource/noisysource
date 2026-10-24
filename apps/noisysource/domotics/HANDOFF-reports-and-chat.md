# Handoff — Reports page and app chat (domotics)

Requested by Renato on 2026-10-24, at the end of the heat-pump E13 session. Not started. Two separate features, so build them as two branches/PRs off `staging`, reports first: the chat gets more useful once incidents exist to ask about.

Read `STATUS.md` first, especially the 2026-10-21 → 10-24 entries on the E13 trips and the guard.

---

## 1. Reports page ("Relatórios")

### What Renato asked for
"The current report within a page that could have reports on multiple errors that could happen with their respective values displayed. A dedicated page maybe."

### What exists today
- **The report:** `domotics-bridge/deploy/relatorio-e13-2026-10-23.html` (pt-PT, written for the installer). It was also published as a private claude.ai artifact (https://claude.ai/artifact/QsXkKeYuJnwvwebsJxtyYX), which Renato may have shared with the technicians.
- **The data behind it:**
  - `domotics-bridge/deploy/e13-test-2026-10-21.jsonl` and `e13-night-2026-10-21.jsonl`: one line per minute, `valves_open` count.
  - `domotics-bridge/deploy/e13-2026-10-22-to-24.jsonl.gz`: one line per ~20 s, from 22/10 07:56 to 24/10 20:09. Rows carry only a time and no date; dates follow from the line order. The logger on the Pi keeps writing to `~/e13-watch/e13-2026-10-22.jsonl` until 25/10 09:00, so copy the final file from there.
- **The guard's decisions:** `~/e13-watch/guard.log` on the Pi.
- **Fault decoding:** the pump's `fault` dp (15) is a bitmap; 4096 = bit 12 = E13 (high-pressure protection, per the manual). dps 109 and 120–123 are further bitmaps, all 0 so far. The bridge exposes them as `fault`, `bcu_com_state`, `electronic_system`, `ithium_battery_system`, `power_system`, `smart_system` (see `domotics-bridge/src/dpmap.ts`). The thermostats also report faults.

### Proposed design
- **Incidents captured by the bridge, not by a separate logger.**
  - The bridge already reads the pump every 30 s. Keep a rolling in-memory buffer of the last ~30 min of pump readings (about 60 rows; fine on the 256 MB Pi).
  - When any fault bit goes from 0 to set, write `domotics_incidents/{id}`:
    - device, decoded code(s), start time;
    - the buffered readings before the trip;
    - the readings for ~5 min after;
    - how it ended: cleared by itself (and when), locked out, or reset (breaker, panel, technicians).
  - Also record pump on/off transitions and their source where it's known (bridge command, guard, outside), since the unexplained switch-offs (00:54 twice, 12:27) are part of the same story.
- **Rules:** owner read, bridge write. Mirror the `domotics_config/automation` pattern in `firestore.rules` and add a rules test next to `scripts/rules-tests/domotics-automation.rules-test.cjs`.
- **Fault catalogue** in shared code: code → bit → pt-PT name → likely causes → what to do (e.g. E13: high pressure; lockout after two trips within ~15 min; reset only at the panel, the breaker or by the technicians, not via Tuya).
- **Page:** a new view next to 3D/2D (`App.tsx` switches views with `useState<View>`; there's no router). It shows:
  - incidents grouped by code;
  - a timeline chart per incident (compressor Hz, discharge, water in/out, setpoint) around the trip;
  - a pattern summary per code: count, time of day, what preceded each trip;
  - a printable pt-PT version for the technicians, replacing the hand-written report. Load the `dataviz` skill before writing the charts.
- **Backfill:** import the logs above as the first incidents, so the page opens with the real E13 history rather than empty.
- **Cost:** a few Firestore writes per incident, plus reads when the page opens. No external API.

### Questions for Renato
- Should the guard move into the bridge?
  - Today it's a Python script started by hand (`domotics-bridge/deploy/e13-guard.py`, copied to `~/e13-watch/guard.py`). It doesn't survive a Pi reboot and ends 2026-10-26 09:00.
  - Inside the bridge, it would survive reboots and its decisions would land in the incidents.
  - Recommended: yes, as part of this feature, with its own setting (on/off) in the app.

---

## 2. Chat scoped to the app

### What Renato asked for
"A chat, so that we can ask questions or actions but scoped to this app."

### Proposed design
- **Backend:** a callable Cloud Function in `functions/src/domotics/chat.ts`, owner-only like `legrand.ts`/`tuya.ts`.
  - It calls the Claude API with the house context: rooms and devices, current state from `domotics_state/tuya`, Legrand status, automation settings and status, recent incidents.
  - Load the `claude-api` skill before writing it, for the model, SDK and tool-use loop.
  - API key in `firebase functions:secrets`, never in code or env files.
- **Questions:** read-only tools to get state, incidents, automation and history. "Why is the house cold?" should be answerable from the same data this session used.
- **Actions:** tools that *propose* a change (thermostat target, light/blind, pump on/off/setpoint). The app shows a confirm button, and only the user's tap sends the command. Commands go through the existing paths (Legrand callable, `domotics_commands` relay / bridge), never directly from the function. The heat pump is the device most at stake here.
- **Cost guards** (root CLAUDE.md, "Cost & Production Safety"). Run the `new-metered-api-checklist` skill before the first call:
  - a hard monthly spend limit on the Anthropic account, set **before** shipping;
  - a per-day message cap and a per-message tool-call cap in code;
  - `max_tokens` set;
  - no automatic retries beyond one with backoff.
- **Language:** answer in the language asked. The app UI and the technician material are in pt-PT.
- **Where in the UI:** a chat button on the house screen, opening a panel over it. It must work on the phone and on the future wall tablet.

### Questions for Renato
1. **Anthropic account:** does NoisySource have one for API use, with a key? The repo has no Anthropic SDK or key yet.
2. **Monthly spend cap:** what figure? It has to be set at the provider before this ships.
3. **Actions:** propose + confirm (recommended), or questions only for the first version?
4. **Who can use it:** Renato only, or also his wife? That depends on the household allowlist (STATUS plan item 3), which isn't built yet.
