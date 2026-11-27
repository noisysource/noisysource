# Deploying the bridge to the Raspberry Pi

Do this **before leaving the house** — everything else about remote access
depends on the bridge running on the LAN while you are away.

Lights and blinds are unaffected either way; they go through the Netatmo cloud
and work from anywhere.

## The hardware, as measured

A **Raspberry Pi 1 Model B Rev 2** at `192.168.1.125`, `armv6l`, Raspbian 13.
It reports `arm=192M gpu=64M`, so it is a **256MB** board — about 173MB visible
to Linux with roughly 60MB used at idle. That number drives several choices
below. `vcgencmd get_throttled` returns `0x0` powered from the Fibergateway's
USB port, so that supply is adequate; if it ever returns non-zero, undervoltage
is causing the brownouts and it needs its own PSU.

## 1. The bridge's Firestore credentials

On the Mac, once:

```bash
./deploy/create-bridge-user.sh noisysource-prod
```

This creates a Firebase Auth account for the bridge in that project and writes
`deploy/bridge.env` (0600, gitignored) with the project, its API key, the address
and a generated password. `bridge.env` decides which project the Pi publishes to.
A `bridge.env` for another project is kept as `deploy/bridge.env.<project>`.

The house's project is `noisysource-prod` once the cutover is done
(`infra/HANDOFF-repo-restructure.md`, step 10; it was `kidclub-dev` until 2026-11-16).

**Not a service account.** The org policy
`iam.disableServiceAccountKeyCreation` refuses to mint the key, and the role
that path needed — `roles/datastore.user` — would have given a Pi in the hall
cupboard read/write over every collection in the project, the finances bank data
included. As an ordinary signed-in user the bridge is governed by
`firestore.rules`, which grant it its device list, the state document and the
command queue, and nothing else. There are emulator assertions covering exactly
that.

The rules are deployed by CI (`firebase/noisysource/firestore.rules` for the
`noisysource-*` projects).

### Atlas's account (not the bridge's)

Atlas, Renato's assistant, signs in to the same project with an account of its
own, made the same way:

```bash
./deploy/create-agent-user.sh noisysource-prod
```

It asks for a password twice (at least 16 characters), creates or updates
`atlas@kidclub.pt` as a verified user, and writes nothing to disk. What Atlas
may do is in the rules (`isAtlas`) and the callables (`requireOwnerOrAgent`);
it has nothing to do with the Pi.

## 2. Node on the Pi

`uname -m` reports `armv6l`, which neither NodeSource nor nodejs.org publish
for. The unofficial builds do.

Download on the **Mac** and copy it over — fetching directly from the Pi failed
repeatedly with `curl: (56) Connection reset by peer`, and a 26MB download over
that link is not worth fighting:

```bash
VER=v22.23.2
curl -fsSL --retry 5 --retry-all-errors -O \
  https://unofficial-builds.nodejs.org/download/release/$VER/node-$VER-linux-armv6l.tar.xz
scp node-$VER-linux-armv6l.tar.xz pi@192.168.1.125:/tmp/
ssh pi@192.168.1.125 "sudo tar -xJf /tmp/node-$VER-linux-armv6l.tar.xz \
  -C /usr/local --strip-components=1 && node --version"
```

Unpacking takes several minutes at 700MHz — it has not hung. Note this lands in
`/usr/local/bin/node`, which is what the systemd unit points at.

## 3. Copy the bridge across

From `apps/noisysource/domotics-bridge` on the Mac:

```bash
pnpm build                      # produces lib/
# No trailing slashes on lib and deploy — with them, rsync copies the *contents*
# of each into the target and flattens both, leaving index.js at the top level
# where the systemd unit's `lib/index.js` cannot find it.
rsync -a --exclude 'bridge.env*' package.json lib deploy pi@192.168.1.125:~/domotics-bridge/
scp deploy/bridge.env pi@192.168.1.125:~/domotics-bridge/bridge.env
```

Then on the Pi:

```bash
cd ~/domotics-bridge && npm install --omit=dev
chmod 600 bridge.env
```

`tuyapi` is now the only runtime dependency — `firebase-admin` was dropped along
with the service account, which removed gRPC and roughly two thirds of the
install. On this board that matters.

### Updating an existing install

`pnpm build`, keep a backup of `lib`, rsync as above (it leaves `bridge.env`
and the state files alone), restart, then check 7/7 and the ARP pins (see
`../../domotics/STATUS.md`):

```bash
ssh pi@192.168.1.125 'cd ~/domotics-bridge && cp -a lib lib.bak-$(date +%Y%m%d)'
rsync -a --exclude 'bridge.env*' package.json lib deploy pi@192.168.1.125:~/domotics-bridge/
ssh pi@192.168.1.125 'sudo systemctl restart domotics-bridge && sleep 90 && journalctl -u domotics-bridge -n 40 --no-pager'
```

State the bridge keeps next to `lib/` (gitignored, safe to delete):
`device-cache.json`, `automation-config.json`, `incidents-state.json`,
`incidents-pending.json`.

**Left over from the E13 guard (removed 2026-11-22):** `guard-config.json` and
`guard-state.json` next to `lib/` are no longer read or written, and can be
deleted. The rsync above has no `--delete`, so `lib/guard.js` and
`lib/preempt.js` (with their `.map` files, if any) stay on the Pi from the
previous build: nothing loads them, so they are harmless, and can be removed too:

```bash
ssh pi@192.168.1.125 'cd ~/domotics-bridge && rm -f guard-config.json guard-state.json lib/guard.js* lib/preempt.js*'
```

## 4. Check it can actually see the devices

**Do not skip this.** The Pi may be on a different band or VLAN from the
thermostats, and it is far easier to find out now than from another country.

```bash
cd ~/domotics-bridge && set -a && . ./bridge.env && set +a && node lib/index.js
```

Expect a sign-in line, `7 devices`, and a poll reporting most of them online.
`Ctrl-C` once happy. Give it a full minute before deciding it has hung; startup
really is that slow, and it is a one-off cost per restart, not per poll.

### If some thermostats are unreachable from the Pi

Expect this, and do not mistake it for a broken device. Every Tuya device is
behind the WiFi repeater, so from the Pi's wired side they all share one
destination MAC — the repeater's, proxy-ARPing on their behalf. It answers for
most of them and persistently refuses for a couple: `192.168.1.122` and
`192.168.1.153` sat in `NUD FAILED` through three rounds of ping over 45
seconds, while a laptop on the WiFi reached all seven at that same moment and
saw the identical MAC for every one.

So it is an ARP problem on the wired side, not a sleeping device and not the
bridge. `deploy/pin-device-arp.sh` installs the known-good MAC for whichever
devices ARP gave up on, and the unit runs it before each start. Check it with:

```bash
ip neigh show dev eth0 | grep -c PERMANENT
journalctl -u domotics-bridge | grep pin-device-arp
```

The real fix is to stop the Pi depending on the repeater at all — either move
the devices onto the main router's WiFi once it is split, or give the Pi a USB
WiFi adapter so it joins the same network the devices are on. Until then this
keeps all seven reachable.

## 5. Install the service

```bash
sudo cp ~/domotics-bridge/deploy/domotics-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now domotics-bridge
systemctl status domotics-bridge
journalctl -u domotics-bridge -f
```

`Restart=always` is not optional. The bridge intentionally exits when every
device fails several polls running — a wedged process that quietly reports the
whole house asleep is worse than one that stops — and that design only works
with something to restart it.

`MemoryMax=140M` is set deliberately. With 173MB of RAM and swap on an SD card,
a leak would thrash the card into failure rather than surface as an error;
better to be killed and restarted.

## 6. Reclaim memory the desktop is holding

The image boots to `graphical.target` with `lightdm` running, on a headless
board. Nothing is attached to the HDMI port:

```bash
sudo systemctl set-default multi-user.target
sudo systemctl stop lightdm
```

Reversible with `sudo systemctl set-default graphical.target`.

## 7. Stop the Mac instance

Two bridges polling the same devices compete for their few connection slots and
make each other worse.

```bash
pkill -f "lib/index.js"
```

## Televisor, Roomba e câmaras (the LG TV, the Roomba, the Tapo cameras)

Optional: without a `domotics_config/media_devices` document the bridge logs
"no TV, Roomba or cameras configured" and runs exactly as before. Everything
here is on the LAN; no vendor cloud, nothing metered. The code is
`src/media/`, the app's screen is Aparelhos (Mais → "Televisor, Roomba e
câmaras" on a phone).

**First, a DHCP reservation for each device** on the MEO router (LAN → Leases
estáticas), as for the Tuya devices: the bridge finds them by IP.

### 1. Gather what each device needs

- **LG TV**: its IP and MAC (router's lease list). On the TV turn on
  *Settings → General → Devices → TV Management → "Turn on via Wi-Fi"* (the
  name varies by year; older sets call it "Mobile TV On"), or the TV can't be
  switched on from the app; it can still be switched off.
- **Roomba**: its BLID and local password. On the house network:
  `node deploy/roomba-credentials.js` lists robots, then
  `node deploy/roomba-credentials.js <ip>` and follow it (hold HOME on the
  docked robot until it plays tones). Some newer robots no longer give the
  password locally; the script says so, and then it comes from the iRobot
  cloud (dorita980's `get-roomba-password-cloud`).
- **Tapo cameras**: in the Tapo app, each camera → Settings → Advanced
  settings → **Camera account**: create a user and password (this is not the
  TP-Link login). The same account serves RTSP (video) and ONVIF (pan/tilt).
  Mark `"ptz": true` on pan/tilt models (C200, C210, C225, C500…).

### 2. Write the list to Firestore

```bash
cd apps/noisysource/domotics-bridge
cp deploy/media-devices.example.json deploy/media-devices.json   # gitignored, holds passwords
# edit it
pnpm build
node deploy/sync-media-devices.js           # checks it, prints it without passwords
node deploy/sync-media-devices.js --write   # writes domotics_config/media_devices
```

Only the bridge can read that document (`firebase/noisysource/firestore.rules`);
the owner can't, from the app or anywhere else. To change a password or add a
device, edit the file, run `--write` again, restart the bridge.

### 3. Deploy the bridge with its two new dependencies

`lgtv2` and `mqtt` (both pure JavaScript, a few MB) join `tuyapi`, so this
update needs an `npm install` on the Pi, not only the usual rsync:

```bash
ssh pi@192.168.1.125 'cd ~/domotics-bridge && cp -a lib lib.bak-$(date +%Y%m%d)'
rsync -a --exclude 'bridge.env*' --exclude 'media-devices.json' package.json lib deploy pi@192.168.1.125:~/domotics-bridge/
ssh pi@192.168.1.125 'cd ~/domotics-bridge && npm install --omit=dev && sudo systemctl restart domotics-bridge'
ssh pi@192.168.1.125 'sleep 90; journalctl -u domotics-bridge -n 40 --no-pager | grep -E "media|devices"'
```

Expect `[media] 1 TV, 1 Roomba, N cameras`. The thermostats must still read
7/7: the media devices have their own loop and never delay them.

**lgtv2 needs Node ≥ 22.12** (it is ESM, loaded with `require`). The Pi has
v22.23.2; don't downgrade it.

### 4. Pair the TV (once)

Switch the TV on, open Aparelhos on the LAN, press **Emparelhar** and accept
the prompt on the TV with the remote within a minute. The bridge keeps the
key in `media-state.json` (0600, next to `lib/`). After a TV factory reset,
press Emparelhar again.

### 5. Cameras: go2rtc for video and snapshots

The bridge doesn't touch video (no room in its 140 MB). go2rtc runs beside it
as its own service: it hands the cameras' streams to the browser without
transcoding and makes the JPEG snapshots (with ffmpeg, for a second or two).

```bash
# On the Mac: the ARMv6 build from https://github.com/AlexxIT/go2rtc/releases (go2rtc_linux_armv6)
scp go2rtc_linux_armv6 pi@192.168.1.125:/tmp/go2rtc
ssh pi@192.168.1.125 'sudo install -m 755 /tmp/go2rtc /usr/local/bin/go2rtc && sudo apt-get install -y ffmpeg'
# On the Pi, after the bridge has started once with the cameras (it caches the list in media-cache.json):
ssh pi@192.168.1.125 'cd ~/domotics-bridge && node deploy/go2rtc-config.js \
  && sudo cp deploy/go2rtc.service /etc/systemd/system/ && sudo systemctl daemon-reload \
  && sudo systemctl enable --now go2rtc'
```

Then tell the bridge where go2rtc is, in the Pi's `bridge.env`, and restart it:

```
GO2RTC_URL=http://127.0.0.1:1984
GO2RTC_LAN_URL=http://192.168.1.125:1984
```

What works where:
- **On the LAN** (the app from a dev server or the computer's address, plain
  `http://`): live view in the card (go2rtc's player, sub-stream), snapshots,
  pan/tilt.
- **Hosted app** (`noisysource-prod-domotics.web.app`), at home or away:
  snapshots on request (the bridge puts a JPEG in `domotics_state/snap_<id>`,
  at most one per camera every 10 s and 200 a day) and pan/tilt. No live view:
  an `https://` page can't load go2rtc's `http://` player, the same mixed-content
  limit as the bridge itself (`../../domotics/CLAUDE.md`, "Visibility & Access").
- **Privacy:** go2rtc's port 1984 has no password by default, so anyone on
  the house Wi-Fi can open the cameras through it (they can reach the cameras'
  RTSP directly anyway). To require one, add `username`/`password` under `api:`
  in `go2rtc.yaml`. Snapshots in Firestore are readable by the owner only:
  not by Atlas.

## Afterwards

- `journalctl -u domotics-bridge -n 50` — recent logs
- `curl http://192.168.1.125:8787/state` — from any machine on the LAN
- `sudo systemctl restart domotics-bridge` — after deploying a new `lib/`
- `free -h` and `systemctl status domotics-bridge` — watch the `Memory:` line

Redeploying is just repeating step 3 and restarting the service.
