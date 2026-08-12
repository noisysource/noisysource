# Deploying the bridge to the Raspberry Pi

Do this **before leaving the house** — everything else about remote access
depends on the bridge running on the LAN while you are away.

Roughly 30–45 minutes. Lights and blinds are unaffected either way; they go
through the Netatmo cloud and work from anywhere.

## 1. A service account, not your login

On the Mac. The Pi cannot use `gcloud auth application-default login` — it is
interactive, and those credentials expire (which already took the bridge down
once mid-session).

```bash
gcloud iam service-accounts create domotics-bridge \
  --display-name="Domotics bridge (Pi)" --project=kidclub-dev

gcloud projects add-iam-policy-binding kidclub-dev \
  --member="serviceAccount:domotics-bridge@kidclub-dev.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

gcloud iam service-accounts keys create ~/domotics-sa.json \
  --iam-account=domotics-bridge@kidclub-dev.iam.gserviceaccount.com
```

`roles/datastore.user` is read/write on Firestore. It is broader than this
service strictly needs — narrow it to the specific collections later if you
care, but do not block the trip on it.

**That JSON file is a credential.** It is gitignored here; keep it off shared
storage and out of chat.

## 2. Node on the Pi

Pi 3 needs the ARM build. Check `uname -m` — `armv7l` is 32-bit, `aarch64` is
64-bit — and install Node 20 or newer:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # expect v20.x or later
```

## 3. Copy the bridge across

From the Mac, in `apps/noisysource/domotics-bridge`:

```bash
pnpm build                      # produces lib/
rsync -av --exclude node_modules --exclude .git \
  package.json lib/ deploy/ pi@raspberrypi.local:~/domotics-bridge/
scp ~/domotics-sa.json pi@raspberrypi.local:~/domotics-bridge/service-account.json
```

Then on the Pi:

```bash
cd ~/domotics-bridge && npm install --omit=dev
chmod 600 service-account.json
```

## 4. Check it can actually see the devices

**Do not skip this.** The Pi may be on a different band or VLAN from the
thermostats, and it is far easier to find out now than from another country.

```bash
node lib/index.js
```

Expect `7 devices` and a poll reporting most of them online. `Ctrl-C` once
happy.

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

## 6. Stop the Mac instance

Two bridges polling the same devices compete for their few connection slots and
make each other worse.

```bash
pkill -f "lib/index.js"
```

## Afterwards

- `journalctl -u domotics-bridge -n 50` — recent logs
- `curl http://raspberrypi.local:8787/state` — from any machine on the LAN
- `sudo systemctl restart domotics-bridge` — after deploying a new `lib/`

Redeploying is just repeating step 3 and restarting the service.
