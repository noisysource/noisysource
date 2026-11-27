# Domotics bridge

Talks to the Tuya (SmartLife) thermostats and heat pump **over the LAN** and
serves their state on a small local HTTP API. No vendor cloud sits in the path
of a temperature change.

Lights and blinds are *not* here — those are Legrand, which has no local API and
still goes through Netatmo via `functions/src/domotics/legrand.ts`.

## Why this exists

Tuya's Cloud API works, but requires an IoT Core subscription that must be
periodically re-applied for; when it lapses, every call fails. Local control
needs only the device's `local_key`, which the cloud hands out once. After that
the subscription is irrelevant.

Local control is also simply better: it answers in milliseconds instead of a
round trip to a datacentre, and it keeps working when the internet doesn't. One
of the thermostats that Tuya's cloud reports as permanently `online: false`
answers perfectly well on the LAN.

## Running

Requires application-default credentials to read the device list:

```bash
gcloud auth application-default login   # once
pnpm build && pnpm start
```

| env | default | |
|---|---|---|
| `PORT` | `8787` | HTTP listen port |
| `POLL_MS` | `10000` | how often devices are read |
| `GCLOUD_PROJECT` | `noisysource-prod` | project holding the device config. On the Pi it comes from `bridge.env` (`deploy/create-bridge-user.sh <project>` writes it) |

## API

- `GET /state` → `{ devices: [{ id, name, category, online, status: [{code, value}] }], updatedAt }`
- `POST /command` → `{ deviceId, commands: [{ code, value }] }`, answers with freshly read state
- `GET /media` → the TV, Roomba and cameras (`src/media/types.ts`, `MediaState`). Asking is what
  makes the bridge read them: they are polled every 30 s for two minutes after a request, and
  not at all otherwise
- `POST /command` with a `tv:` / `roomba:` / `cam:` id goes to those devices instead and answers
  `{ ok, media }`. Codes: TV `power`, `volume`, `volume_step`, `mute`, `input`, `app`,
  `channel_step`, `media`, `button`, `pair`, `unpair`; Roomba `action` (`start`, `pause`,
  `resume`, `stop`, `dock`, `find`); camera `ptz` (`left`, `right`, `up`, `down`). Anything else
  is refused
- `GET /media/snapshot?id=cam:<id>` → a JPEG, through go2rtc (`deploy/README.md`, "Televisor,
  Roomba e câmaras")

`status` deliberately uses the **same `{code, value}` shape the Tuya Cloud API
returned**, so the app's `tuyaData.ts` is identical whether state came from the
cloud or from here.

## Firestore

Used for exactly one thing: reading `domotics_config/tuya_devices` once at
startup, because local keys are secrets and belong somewhere sealed rather than
in the repo. That document is protected by an allowlist in `firestore.rules` —
clients get 403.

State and commands do **not** go through Firestore. They don't need to while the
app runs on the same network. A relay becomes necessary only for reaching the
house from outside it, or once the app is served over HTTPS (browsers block
`http://` calls from an `https://` page).

## If every device suddenly reads asleep, restart the bridge

Seen after ~2h uptime: every connect returned `EHOSTUNREACH`, while a fresh Node
process on the same machine — and `netcat` — reached the same devices instantly.
Not a socket leak (25 fds open, limit 1M) and not the network. Restarting cured
it at once.

The cause is process-level and unidentified. Rather than sit there reporting a
house full of sleeping thermostats, the bridge now exits after
`TOTAL_FAILURE_LIMIT` (default 5) consecutive polls in which *every* device
failed, so a supervisor can restart it. On the Pi that means systemd with
`Restart=always`. Run under a supervisor, or this turns a wedge into an outage.

## Things learned the hard way

- **tuyapi reports socket failures by emitting `error` on the device object, not
  by rejecting the promise you are awaiting.** A timeout fires asynchronously,
  outside any try/catch around `connect()`, and an EventEmitter with no `error`
  listener is fatal in Node. Without a listener the bridge died on the first slow
  device — it managed seven polls. Every device is now created through
  `openDevice()`, which attaches one. Never construct a `TuyAPI` directly.
- Devices refuse connections intermittently (tuyapi errors 901/905) and the same
  device succeeds moments later. Reads and writes retry 3×; this is normal
  operation, not error handling.
- Polling is **sequential**. Hitting seven devices at once competes for their
  few connection slots and measurably raises the failure rate.
- Always `disconnect()`. A leaked socket holds one of those scarce slots and
  makes the *next* poll fail.
- Thermostat datapoint numbers in `dpmap.ts` were derived by reading cloud
  status and local dps back-to-back and matching on value — not from
  documentation. The heat pump's come from its Tuya cloud thing model (below).

## Heat pump

**Zantia Vancouver 13** (single-phase, R32), Zantia catalogue code 2301-0273
(the unit's own label reads 2301-8273). Manual, "Vancouver 13DC-32":
<https://zantia.com/storage/products/vzau85qrqt.pdf> — fault codes are in
§5.3.2-8. It is *not* an "MTATWHP-5C"; older notes that say so are wrong.

It talks through a Tuya module (category `znrb`, Tuya product "HY
Multifunctional Heat Pump V1.2"). The datapoints below were read from the
device's cloud thing model (`/v2.0/cloud/thing/{id}/model` and
`/shadow/properties`) on 2026-10-02. The Tuya `code` names are generic ones the
vendor reused and mostly **don't mean what they say** — trust the "meaning"
column. `dpmap.ts` keeps the codes verbatim so cloud and LAN state look the
same. ×10 = tenths of a degree.

| dp | Tuya code | real meaning |
|---|---|---|
| 1 | `switch` | on/off |
| 2 | `mode` | Hot (DHW) / Heating / Hot_Heating / Cooling / Hot_Cooling |
| 15 | `fault` | fault bitmap, bit i → E(i+1) (E01–E16) |
| 16 | `temp_current` | compressor frequency, Hz |
| 18 | `power_consumption` | C00 coil temp, °C ×10 |
| 20 | `compressor_strength` | C01 discharge temp, °C ×10 |
| 21 | `temp_top` | outdoor/ambient temp, °C ×10 |
| 22 | `temp_bottom` | C03 suction temp, °C ×10 |
| 23 | `coiler_temp` | water inlet temp, °C ×10 |
| 24 | `venting_temp` | water outlet temp (Tout), °C ×10 |
| 25 | `effluent_temp` | DHW tank temp (TDHW), °C ×10 |
| 109 | `smart_system` | fault bitmap (E17–E32) |
| 117 | `p02_heating` | heating setpoint, °C |
| 118 | `p03_cooling` | cooling setpoint, °C |
| 119 | `p04_dhw` | DHW setpoint, °C |
| 120 | `power_system` | fault bitmap (E36, E40, E44, E45, E59) |
| 121 | `ithium_battery_system` | fault bitmap (E50) |
| 122 | `electronic_system` | fault bitmap (IPM sub-codes E20_x) |
| 123 | `bcu_com_state` | fault bitmap (IPM sub-codes E20_x) |

The bit → E-code tables for the bitmaps, and what each code means, live in the
app: `apps/noisysource/domotics/src/data/heatpumpFaults.ts` (a copy of the bit
tables is in `src/faults.ts`, for the incidents).

**The module doesn't always report all of them.** Since about 19/11/2026
(probably a power cut that restarted it) a full read brings only dps 1, 16, 18
and 20–25: on/off, compressor Hz and the temperatures. No `mode`, no setpoints
(117–119), no fault bitmaps (15, 109, 120–123), and a refresh doesn't bring them
back. So the bridge finds the pump by its category (`znrb`), never by a
datapoint, and treats a missing one as not known rather than 0
(`src/readings.ts`):

- **Faults:** missing bitmaps are "no reading", not "no fault". The automation
  says so in its status (`pumpBlind`, and a line in `reasons`), the app shows "Sem leitura de avarias" instead of "Sem avarias". No fault
  is made up and the pump is still switched by the plan. A fault incident open
  when the bitmaps disappear is closed as "end not known", not as cleared.
- **Water setpoint:** without `p02_heating` the automation sends no water
  setpoint (it would be sent blind every 15 min, over whatever was set by hand),
  and it can't see the compressor idling at the setpoint, so the rest at the
  setpoint doesn't happen.

### Incidents and the E13 guard

> **2026-11-22: the E13 guard and its early warning were removed** (Renato: the
> pump was fixed, the guard had been off since late October). `src/guard.ts`,
> `src/preempt.ts` and their tests are gone; the bridge no longer reads
> `domotics_config/guard`, keeps `guard-config.json` / `guard-state.json`, or
> switches the pump as `guard`, and publishes `guard: null` in
> `domotics_state/tuya`. The automation alone switches the pump (its own rest
> at the setpoint, `rest`, is unchanged; a faulted pump is left alone). The
> "E13 guard" bullet below is kept as the record of what it did: incidents up
> to that date carry `source: 'guard'`, and `domotics_climate` slots a `guard`
> field. The code is in git history (last in PR #164).

- **The pump is read every 30 s even when nobody is watching** (`PUMP_POLL_MS`;
  the thermostats keep the 5-min idle rate). Unwatched, the state is still only
  published every 5 min, unless the pump switches or faults.
- **Incidents** (`src/incidents.ts`) go to `domotics_incidents/{id}` for the app's
  Reports page: a fault with 30 min of readings before it and 5 min after, how it
  ended (`self` / `reset`, lockout = second trip within 20 min or still faulted
  after 10 min), the restart time; and every on/off with who caused it (`app`,
  `automation`, `outside` = not through this bridge; `guard` in records up to 22/11) and, since 26/10, every
  raw datapoint in the reading before and the one that showed it (`dps.before` /
  `dps.at`), so anything else an outside off changes is on record. Writes are queued
  in `incidents-pending.json` and retried with backoff, so a network gap or a
  missing rule loses nothing. Ids are stable (`fault-<UTC start>-<code>`).
- **E13 guard** (removed 2026-11-22, see the note above; was `src/guard.ts`, and before that `deploy/e13-guard.py`): with
  `domotics_config/guard` `{enabled: true}` (app: Relatórios or Clima → "Proteção
  E13"), switches the pump off for 60 min when it idles at the setpoint (≤ 45 Hz,
  water ≥ setpoint − 1.5) and for 120 min straight after a trip; still faulted
  within 3 min of a switch-on = lockout, and it stops acting until the fault
  clears. **Switched off from outside** (not through this bridge: the panel,
  SmartLife, a timer — the nightly 23:54 UTC off since 21/10 comes from the pump
  itself, Tuya `event_from` 1, no cloud timer/scene), it switches the pump back on
  after 5 min (`REON_AFTER_MS`) **only while the heating automation is off or in
  dry-run**: running live, the automation owns on/off and undoes the off itself
  (`automationOwns`, from index.ts). Offs through the app or the automation are
  respected, and so is a pump found off at start-up. Off from outside again within
  60 min of that switch-on, or after 6 switch-ons in 24 h, it leaves the pump off
  until someone switches it on (someone means it; no fighting a timer).
  **Paused** (the automation card's "Pausar", `domotics_config/automation`
  `pauseUntil`), it switches nothing on: no re-on after an outside off (not even
  after the pause), and a rest that ends meanwhile carries on until the pause does;
  the protective offs still happen. Switched off in the app while resting, it
  switches the pump back on (unless paused). State in `guard-state.json`, so a rest
  survives a restart. Log lines: `[guard]`, `[incident]`. With the heating
  automation running live, a rest that is due to end carries on while the
  automation's plan has the pump off (`holdRest`) and ends as soon as it wants heat.
  **E13 early warning** (`src/preempt.ts`, since 2026-10-27; on unless
  `domotics_config/guard` has `preempt: false`, app: "Antecipar o E13"): since 26/10
  every run trips 9–11 min in, far below the setpoint, and each time the discharge
  first sat low (42–46 °C), then jumped ≥ 3 °C between two 30 s readings while the
  coil (C00) dropped, 1–2 min before the trip. So, with the run ≥ 5 min old, a
  discharge rise ≥ 3 °C per 30 s **from ≤ 50 °C with the coil down ≥ 0.8 °C** switches
  the pump off for 5 min (`REST_PREEMPT_MS`); the rest then ends like any other (back
  on; held by the live automation's `holdRest`; not during a pause). A rise alone is
  normal in a healthy run (60–100 °C, 281 such rises in the 21–24/10 logs). Fires on
  all 13 recorded trips with a coil reading, 31–121 s ahead, and never in the logs'
  healthy runs (`test/preempt.test.cjs`, fixtures in `test/fixtures/`). Caps: after 5
  stops in an hour, the next rests 30 min; a trip anyway (also during the 5-min rest)
  gets the 120-min rest; two trips within 6 h with it on switch it off for 24 h
  ("Antecipação desligada até …: dois E13 mesmo assim" in the guard's note).
  Switching it (or the guard) off in the app forgets that. The idle rule comes first
  when both apply. Its status is `guard.preempt` in `domotics_state/tuya`
  (`stopsToday`, `lastStop`, `offUntil`, `note`); the stops are switch incidents
  with source `guard` and a reason like "descarga a subir 44 → 50,5 °C em 30 s aos
  9 min — desligada antes do E13, volta a ligar às 20:43".
- **Heating automation** (`src/automation.ts`, `src/warmby.ts`; design and
  Renato's decisions in `apps/noisysource/domotics/HANDOFF-heating-automation.md`,
  reworked 2026-10-26): a warm floor in the warm window (19:00–09:00 Lisbon), with
  a warm-up that starts early enough from the learned model (at most 6 h before);
  by day the pump is off unless the battery is ≥ 90 % and the sun covers the house
  plus the pump's ~3.3 kW (its own draw is taken out of the house load while it
  runs, so it doesn't switch itself off), or the rooms' mean is below 21 °C. Live,
  it owns on/off whoever switched the pump (minimum on 30 / off 15 min, at most 12
  of its own switch-ons a day); `pauseUntil` stops it. A pump in
  fault is left alone until the fault clears.
  Settings in `domotics_config/automation`, the one-off "warm by HH:MM" in
  `domotics_config/warm_by` (both read every 2 min, cached in
  `automation-config.json` / `warm-by.json`). The warm-up model it learns, the last
  water setpoint it sent, the warm-up in progress and its switch-ons are in
  `automation-state.json`. Its status (`mode`, `doing`, `plan`, `solar`, …) goes
  out with the bridge state. Log lines: `[automation]`.
- **History**: `deploy/backfill-incidents.cjs` replays the hand-run logger's
  files through the same recorder (see its header). Tests: `pnpm test`.

## Energy history (kWh)

For the app's Energia page. The inverter (RENAC N1HL, `src/inverter.ts`, local
Modbus TCP, read-only) is read every poll (~30 s) anyway; `src/energy.ts`
integrates those power readings into **15-minute slots** and
`src/energy-store.ts` writes them to `domotics_energy/{yyyy-mm-dd}` (Lisbon
date), one field per slot: `q00`…`q95` (`q99` on the October clock change, `q91`
in March). Each slot holds Wh for `pv`, `load`, `imp`, `exp`, `chg`, `dis`, plus
which source fed the house (`pvLoad`, `batLoad`) and the battery (`gridBat`),
`sec` = seconds of the slot covered by readings, and `soc` at its end. Also
`acLoad` / `invOut`: registers 50 and 3 integrated, unconfirmed and unused (on
25/10 at night reg 50 was exactly reg 3 + grid import, ~10 % below `load`,
which carries the inverter's losses): recorded so the page can switch to an
AC figure later with its history intact.

- **Integrated, not the inverter's counters.** Its kWh registers aren't
  confirmed yet (below). Two readings more than 3 min apart aren't joined: that
  time is a gap, and `sec` says so. House consumption is derived (pv − battery −
  grid, like the vendor app), so it includes the inverter's own losses.
- **Writes**: closed slots wait on the Pi (in `energy-state.json`) and go out
  together at most once an hour: one PATCH per day document, ~24 a day, each with
  only the waiting slots' fields (so a lost state file can't overwrite a written
  slot). The Energia page is therefore up to an hour behind.
  Failures back off 30 s → 30 min; hard cap 300 writes a UTC day. The bridge never
  reads these documents back. Rules: bridge create/update under date ids only.
- **State**: `energy-state.json` (open slot, last reading, unconfirmed writes),
  saved when a slot closes, every 5 min and on exit. A restart under 3 min is
  bridged; a longer one is a gap.
- **Counter candidates**: `energy-registers.jsonl` gets one line per closed slot
  with the integrated Wh and 14 input registers that count up in 0.1 kWh steps
  (`COUNTER_CANDIDATES` in `inverter.ts`). Compare a few sunny days of it with the
  slots to tell which register is which flow; then the counters can fill gaps.
  Capped at 5 MB. Log lines: `[energy]`.
- Tests: `test/energy.test.cjs` (Lisbon days and the clock changes, the flow
  split, gaps, slot boundaries, restarts, write backoff and cap).

## Moving to the Raspberry Pi

Not done yet. When it happens: install Node, copy a service account key (ADC
won't exist there), run under `systemd`, and **stop the instance on the Mac** —
two bridges polling the same devices compete for connection slots.
