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
./deploy/create-bridge-user.sh
```

This creates a Firebase Auth account for the bridge and writes
`deploy/bridge.env` (0600, gitignored) with the API key, address and a generated
password.

**Not a service account.** The org policy
`iam.disableServiceAccountKeyCreation` refuses to mint the key, and the role
that path needed — `roles/datastore.user` — would have given a Pi in the hall
cupboard read/write over every collection in the project, the finances bank data
included. As an ordinary signed-in user the bridge is governed by
`firestore.rules`, which grant it its device list, the state document and the
command queue, and nothing else. There are emulator assertions covering exactly
that.

Deploy the rules before the bridge can use them:

```bash
npx firebase-tools deploy --only firestore:rules --project kidclub-dev
```

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
rsync -a --exclude bridge.env package.json lib deploy pi@192.168.1.125:~/domotics-bridge/
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

## Afterwards

- `journalctl -u domotics-bridge -n 50` — recent logs
- `curl http://192.168.1.125:8787/state` — from any machine on the LAN
- `sudo systemctl restart domotics-bridge` — after deploying a new `lib/`
- `free -h` and `systemctl status domotics-bridge` — watch the `Memory:` line

Redeploying is just repeating step 3 and restarting the service.
