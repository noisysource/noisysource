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
| `GCLOUD_PROJECT` | `kidclub-dev` | project holding the device config |

## API

- `GET /state` → `{ devices: [{ id, name, category, online, status: [{code, value}] }], updatedAt }`
- `POST /command` → `{ deviceId, commands: [{ code, value }] }`, answers with freshly read state

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
- Datapoint numbers in `dpmap.ts` were derived by reading cloud status and local
  dps back-to-back and matching on value — not from documentation. A few heat
  pump datapoints are still unmapped because they all read zero at sampling time
  and couldn't be told apart.

## Moving to the Raspberry Pi

Not done yet. When it happens: install Node, copy a service account key (ADC
won't exist there), run under `systemd`, and **stop the instance on the Mac** —
two bridges polling the same devices compete for connection slots.
