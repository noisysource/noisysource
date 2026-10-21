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
# Devices reached through the repeater are pinned to it; devices that answer
# with their own MAC (on the main router's WiFi) are left alone. An earlier
# version pinned every device unconditionally, which was wrong the moment one
# moved onto the main router: its real MAC is then its own, and pointing it at
# the repeater sends its traffic into a hole. So which side a device is on is
# re-derived from scratch on every run, and stale pins are cleared first.
#
# Runs as root from the unit's ExecStartPre. Never fails the service: losing
# two thermostats is much better than losing the bridge.
set -u

IFACE=${ARP_IFACE:-eth0}
CACHE=${DEVICE_CACHE:-/home/pi/domotics-bridge/device-cache.json}
ROUNDS=${ARP_ROUNDS:-3}
# Tuya's local protocol port — a pin only counts if this answers through it.
TUYA_PORT=${TUYA_PORT:-6668}

# Start clean — every permanent entry on the interface, not just ones for IPs
# in the current cache. A device's IP changes on its own DHCP lease renewal,
# with no record here that its old address ever existed; scoping the clear to
# today's cache left yesterday's pin behind it forever. Harmless while that
# address sits idle, but a live landmine the day DHCP hands it to something
# else — that thing would inherit a permanent route to a stranger's MAC.
# Nothing but this script ever sets NUD_PERMANENT here, so clearing all of
# them is exactly as safe as clearing our own.
#
# This runs before the cache check on purpose: with no cache (it is deleted
# after a device re-sync) the old order exited first and left every stale pin
# in place, which is how two devices stayed pinned to the wrong MAC through a
# restart on 2026-10-16.
cleared=0
while read -r stale_ip; do
  [ -n "$stale_ip" ] && ip neigh del "$stale_ip" dev "$IFACE" 2>/dev/null && cleared=$((cleared+1))
done < <(ip neigh show dev "$IFACE" 2>/dev/null | awk '/PERMANENT/{print $1}')

command -v node >/dev/null || exit 0
if [ ! -r "$CACHE" ]; then
  echo "pin-device-arp: no device cache yet; cleared $cleared stale pin(s), nothing to pin"
  exit 0
fi

mapfile -t IPS < <(node -e '
  try {
    const list = require(process.argv[1]);
    for (const d of list) if (d.ip) console.log(d.ip);
  } catch { }
' "$CACHE")
[ ${#IPS[@]} -gt 0 ] || exit 0

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

mac_of() {
  ip neigh show "$1" dev "$IFACE" 2>/dev/null \
    | awk '{ for (i = 1; i < NF; i++) if ($i == "lladdr") { print $(i+1); break } }'
}

# Candidate MACs are the ones answering for MORE THAN ONE resolved device.
# A repeater proxy-ARPs for everything behind it, so it answers for several;
# a device that joined the main router directly answers only for itself.
# The previous version took the single most common MAC, and with few devices
# resolved that could be one device's own address — on 2026-10-16 it elected
# Master bedroom's MAC (f8:17:2d:9f:86:4d) and pinned every repeater device to
# it, while the repeater was d6:35:38:f6:ea:21. Counting the whole ARP table
# instead once elected the gateway; only resolved devices get a vote.
mapfile -t CANDIDATES < <(
  for ip in "${resolved[@]}"; do mac_of "$ip"; done \
    | sort | uniq -c | sort -rn | awk '$1 >= 2 { print $2 }'
)

if [ ${#CANDIDATES[@]} -eq 0 ]; then
  echo "pin-device-arp: ${#resolved[@]} resolved, ${#failed[@]} unresolved, no MAC answers for more than one device so no repeater to pin to; cleared $cleared stale"
  exit 0
fi

is_candidate() {
  local m
  for m in "${CANDIDATES[@]}"; do [ "$m" = "$1" ] && return 0; done
  return 1
}

reaches() { timeout 3 bash -c "</dev/tcp/$1/$TUYA_PORT" 2>/dev/null; }

# Devices that resolved *through the repeater* are pinned to it as well, not
# just the ones that failed. Its proxy-ARP is intermittent, not merely picky:
# on 2026-10-16 .164 resolved fine during this script and was FAILED a few
# minutes later, once the kernel's entry went stale and had to be re-asked.
# Devices answering with their own MAC are left to normal ARP — they resolve
# reliably, and pinning them would break the day one moves. Every pin here is
# re-derived from scratch on each start, so a move is corrected by a restart.
held=()
for ip in "${resolved[@]}"; do
  mac=$(mac_of "$ip")
  if is_candidate "$mac" && ip neigh replace "$ip" lladdr "$mac" dev "$IFACE" nud permanent 2>/dev/null; then
    held+=("$ip")
  fi
done

# Unresolved devices try each candidate, and a pin is only kept if the device
# answers through it. More than one bridging device has been seen here (three
# MACs for seven devices), and a wrong permanent pin is worse than none: it
# silences the kernel's own retries and makes the device fail quietly.
pinned=(); unreachable=()
for ip in "${failed[@]}"; do
  ok=""
  for mac in "${CANDIDATES[@]}"; do
    ip neigh replace "$ip" lladdr "$mac" dev "$IFACE" nud permanent 2>/dev/null || continue
    if reaches "$ip"; then ok=$mac; break; fi
  done
  if [ -n "$ok" ]; then
    pinned+=("$ip")
  else
    ip neigh del "$ip" dev "$IFACE" 2>/dev/null
    unreachable+=("$ip")
  fi
done

echo "pin-device-arp: via ${CANDIDATES[*]} — held ${#held[@]} that resolved (${held[*]:-none}), pinned ${#pinned[@]} that didn't (${pinned[*]:-none}), unreachable ${#unreachable[@]} (${unreachable[*]:-none}); cleared $cleared stale"
exit 0
