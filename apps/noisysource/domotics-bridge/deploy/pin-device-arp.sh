#!/bin/bash
#
# Works around the WiFi repeater's flaky proxy-ARP.
#
# Devices behind the repeater all share one destination MAC from the wired side
# — the repeater's, answering ARP on their behalf. It answers for most of them
# and persistently refuses for a couple, which land in NUD FAILED and stay
# there: three rounds of ping over 45 seconds never recovered two of the
# thermostats, while a laptop on the WiFi side reached all seven at that same
# moment and saw the identical MAC for every one.
#
# Only devices that genuinely fail to resolve are pinned. An earlier version
# pinned all of them unconditionally, which was wrong the moment a device moved
# onto the main router's WiFi: its real MAC is then its own, and pointing it at
# the repeater sends its traffic into a hole. Stale pins are cleared on every
# run for the same reason — a device that has moved must be allowed to resolve
# itself again.
#
# Runs as root from the unit's ExecStartPre. Never fails the service: losing
# two thermostats is much better than losing the bridge.
set -u

IFACE=${ARP_IFACE:-eth0}
CACHE=${DEVICE_CACHE:-/home/pi/domotics-bridge/device-cache.json}
ROUNDS=${ARP_ROUNDS:-3}

command -v node >/dev/null || exit 0
[ -r "$CACHE" ] || exit 0

mapfile -t IPS < <(node -e '
  try {
    const list = require(process.argv[1]);
    for (const d of list) if (d.ip) console.log(d.ip);
  } catch { }
' "$CACHE")
[ ${#IPS[@]} -gt 0 ] || exit 0

# Start clean. Without this a device that has since moved to another access
# point keeps a permanent entry aimed at the repeater and can never recover,
# which is a far more confusing failure than the one this script exists to fix.
cleared=0
for ip in "${IPS[@]}"; do
  if ip neigh show "$ip" dev "$IFACE" 2>/dev/null | grep -qi permanent; then
    ip neigh del "$ip" dev "$IFACE" 2>/dev/null && cleared=$((cleared+1))
  fi
done

# Give ordinary resolution a fair chance before overriding anything. Entries
# mid-resolution read as INCOMPLETE rather than FAILED, so a single pass would
# either mistake healthy devices for broken ones or find nothing at all.
for _ in $(seq "$ROUNDS"); do
  for ip in "${IPS[@]}"; do ping -c 1 -W 1 "$ip" >/dev/null 2>&1 & done
  wait
  sleep 1
done

resolved=(); failed=()
for ip in "${IPS[@]}"; do
  if ip neigh show "$ip" dev "$IFACE" 2>/dev/null | grep -q "lladdr"; then
    resolved+=("$ip")
  else
    failed+=("$ip")
  fi
done

if [ ${#failed[@]} -eq 0 ]; then
  echo "pin-device-arp: all ${#IPS[@]} devices resolved on their own; cleared $cleared stale pin(s)"
  exit 0
fi

# Only the devices that did resolve get a vote on where the unreachable ones
# live. Counting the whole ARP table once elected this machine's own gateway,
# which would have pinned every thermostat at something that is not the
# repeater and broken all of them rather than the two already broken.
MAC=$(
  for ip in "${resolved[@]}"; do
    ip neigh show "$ip" dev "$IFACE" 2>/dev/null \
      | awk '{ for (i = 1; i < NF; i++) if ($i == "lladdr") { print $(i+1); break } }'
  done | sort | uniq -c | sort -rn | head -1 | awk '{print $2}'
)

if [ -z "${MAC:-}" ]; then
  echo "pin-device-arp: nothing resolved on $IFACE, so no MAC to borrow; leaving ARP alone"
  exit 0
fi

pinned=0
for ip in "${failed[@]}"; do
  ip neigh replace "$ip" lladdr "$MAC" dev "$IFACE" nud permanent 2>/dev/null && pinned=$((pinned+1))
done

echo "pin-device-arp: ${#resolved[@]} resolved, pinned $pinned of ${#failed[@]} unresolved to $MAC (cleared $cleared stale)"
exit 0
