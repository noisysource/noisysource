# Handoff — Reports page and app chat (domotics)

Requested by Renato on 2026-10-24, at the end of the heat-pump E13 session. Not started. Two separate features, so build them as two branches/PRs off `staging`, reports first: the chat gets more useful once incidents exist to ask about.

Read `STATUS.md` first, especially the 2026-10-21 → 10-24 entries on the E13 trips and the guard.

---

## 1. Reports page ("Relatórios")

> **Built 2026-10-25** on `agent/domotics-reports` (branched off `agent/domotics-3d`, since #106 wasn't merged yet). What shipped and what's left: `STATUS.md`. The design below is what was built, with the guard inside the bridge (Renato: yes).

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

### Decided (Renato, 2026-10-24)
- **Actions with a confirm tap.** Nothing reaches a device until he taps.
- **Renato only** (admin@kidclub.pt) for now.
- **What it must handle:**
  - "Have the house warm by HH:MM." This needs the automation's one-off "warm by" target (session C below); until that ships, the chat says it can't do it yet.
  - Battery, PV and consumption questions.
  - Lights and blinds (switch, dim, open/close).
  - The heating state and why.

### Billing
- **A Claude.ai subscription doesn't cover this.** Renato has a monthly Claude subscription, but an app calling the API needs an API account (Claude Console) with its own key and pay-as-you-go credits.
- **Hard cap:** prepaid credits with auto-reload **off** cap the spend at whatever was loaded. That fits the root CLAUDE.md rule (a hard cap at the provider, not just an alert).
- **Estimate** (2026-10 prices; per question ≈ 2 API calls, ~4k cached tokens of system prompt + tools, ~5k uncached, ~1k out; a sporadic chat mostly pays a cache write on its first call):

  | Model | Per question | 3–10 questions/day |
  |---|---|---|
  | Opus 5.5 ($4 / $20 per MTok) | ~$0.05–0.06 | ~$5–18/month |
  | Sonnet 5.5 ($2 / $10) | ~$0.02–0.03 | ~$3–9/month |
  | Haiku 5.5 ($0.10 / $0.50) | well under $0.01 | under $0.50/month |

  Plan for warm-by requests to cost 2–3× a simple question. Measure real usage from `response.usage` once it runs. Cloud Functions stay in the free tier at this volume.

### Still open
1. Renato creates the API account and key, and loads the prepaid credits (auto-reload off). The key goes into `firebase functions:secrets`, set by him.
2. Which model? The claude-api skill defaults to Opus 5.5; Sonnet 5.5 costs about half. Renato's call.

---

## Next sessions — order and prompts

**Before any of them:**
- PR #106 (`agent/domotics-3d`) must be merged into `staging`, so new branches have the 3D app and this file.
- Its dev deploy fails at Functions until PR #110 (`agent/kidclub-events`) is in `staging`, because #110's preview functions are on kidclub-dev.
- **Don't push #106 before #110 merges:** every push redeploys #106's rules (staging + #106, without #110's) and wipes #110's rules on dev.
- So: merge #110 → merge `staging` into #106, push → dev deploy green → Renato tests → merge #106.

**A. Thermostat keys + ARP pin script** (independent; no worktree for the key refresh, its own branch for the script fix):
> Domotics: 4 of the 6 Tuya thermostats (Quarto, Quarto Diniz, Sala, Master bedroom) have rejected the Pi bridge with ECONNRESET since 21–22/10, probably because their local keys changed. Read apps/noisysource/domotics/STATUS.md first. Run domotics-bridge/deploy/sync-tuya-keys.js as a preview, then with --write. Restart the bridge on the Pi (pi@192.168.1.125) and confirm all 7 devices are online; re-pin the repeater ARP entries if the restart clears them (STATUS has the command). Then, in its own worktree and branch off staging, fix pin-device-arp.sh so it keeps a pin while TCP 6668 still answers through it, instead of clearing it. Finally, tell me how to block the thermostats' internet access on the MEO router while keeping the heat pump online. Don't change the heat pump or the E13 guard running on the Pi.

**B. Reports page + incidents + guard inside the bridge** (after #106 merges):
> Build the domotics Reports page described in apps/noisysource/domotics/HANDOFF-reports-and-chat.md, section 1. Read STATUS.md first. Work in a new worktree off staging (branch agent/domotics-reports).
> - The bridge records incidents (fault start/end with the readings before and after) and pump on/off transitions in domotics_incidents.
> - Move the E13 guard (domotics-bridge/deploy/e13-guard.py, now running by hand on the Pi) into the bridge, with an on/off setting in the app.
> - Backfill the E13 history from the logs in domotics-bridge/deploy/.
> - The page groups incidents by code and shows charts of the pump values; there's a printable pt-PT version for the technicians.
> - Add rules and a rules test.
> - Deploy the app to dev (hosting only) and the bridge to the Pi. I test the UI myself.
> - Keep the hand-run guard running until the bridge version is live, then stop it with `touch ~/e13-watch/guard.stop`.

**C. Heating automation fixes + "warm by HH:MM"** (after B merges; both touch bridge `src/index.ts`):
> The domotics heating automation (domotics-bridge/src/automation.ts; design in HANDOFF-heating-automation.md) has been in dry-run since a cold morning on 20/10. Read STATUS.md first, especially "Next step" item 0 and the E13 entries from 21–24/10. Then:
> - Apply the fixes listed there: recovery mode, respect a water setpoint changed by hand, faster correction, comfort 24 °C.
> - Make the automation consistent with the E13 findings: never let the pump idle at the setpoint and then speed up again; use the guard's off-and-rest approach.
> - Add a one-off "warm by HH:MM" target. Compute the start time from the observed warm-up (floor warm in ~1.5–2 h; rooms rise ~0.3 °C/h; refine it from the incidents data). Show it in the automation card and make it settable from the app, through a function the chat can call later.
> - New worktree off staging; dry-run first; I decide when it goes live.

**D. Chat** (after C merges, or before it with warm-by left out; needs the API key and model choice first):
> Build the domotics in-app chat described in apps/noisysource/domotics/HANDOFF-reports-and-chat.md, section 2. Decisions: actions only after I tap to confirm; only me (admin@kidclub.pt); it must handle "have the house warm by HH:MM" (through the automation's warm-by target), battery/PV/consumption questions, lights and blinds, and the heating state. Model: <Opus 5.5 / Sonnet 5.5>. Load the claude-api and new-metered-api-checklist skills before writing any code. The API key is in firebase functions:secrets (I set it). Include a daily message cap and a tool-loop cap in code. Commands go through the existing Legrand/relay paths, never directly. Dev only, new worktree off staging.
