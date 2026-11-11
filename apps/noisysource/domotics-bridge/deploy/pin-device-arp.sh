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
# re-derived on every run: an existing pin is kept only while TCP 6668 still
# answers through it, and every other one is cleared first.
#
# Runs as root from the unit's ExecStartPre. Never fails the service: losing
# two thermostats is much better than losing the bridge.
set -u

IFACE=${ARP_IFACE:-eth0}
CACHE=${DEVICE_CACHE:-/home/pi/domotics-bridge/device-cache.json}
ROUNDS=${ARP_ROUNDS:-3}
# Tuya's local protocol port — a pin only counts if this answers through it.
TUYA_PORT=${TUYA_PORT:-6668}

reaches() { timeout 3 bash -c "</dev/tcp/$1/$TUYA_PORT" 2>/dev/null; }

# Check every permanent entry on the interface, not just ones for IPs in the
# current cache. A device's IP changes on its own DHCP lease renewal,
# with no record here that its old address ever existed; scoping the clear to
# today's cache left yesterday's pin behind it forever. Harmless while that
# address sits idle, but a live landmine the day DHCP hands it to something
# else — that thing would inherit a permanent route to a stranger's MAC.
# Nothing but this script ever sets NUD_PERMANENT here, so checking all of
# them is exactly as safe as checking our own.
#
# A pin that still reaches a Tuya device is kept. Clearing every pin up front
# (the previous behaviour) was right for stale ones and wrong for working ones:
# on 2026-10-17 23:06 and again on 2026-10-22 the repeater answered ARP for at
# most one device right after a restart, so nothing below could re-derive the
# pins, and five working ones were gone until re-pinned by hand. A pin that
# doesn't answer — wrong MAC, device moved, address handed to something else,
# or the repeater down altogether (2026-10-25 07:20) — is cleared as before.
#
# This runs before the cache check on purpose: with no cache (it is deleted
# after a device re-sync) the old order exited first and left every stale pin
# in place, which is how two devices stayed pinned to the wrong MAC through a
# restart on 2026-10-16.
kept=(); cleared=0
while read -r pin_ip pin_mac; do
  [ -n "$pin_ip" ] || continue
  # One retry: these devices refuse a connection now and then (see tuya.ts),
  # and dropping a working pin by mistake is what this check is here to stop.
  if [ -n "$pin_mac" ] && { reaches "$pin_ip" || { sleep 1; reaches "$pin_ip"; }; }; then
    kept+=("$pin_ip")
  elif ip neigh del "$pin_ip" dev "$IFACE" 2>/dev/null; then
    cleared=$((cleared+1))
  fi
done < <(ip neigh show dev "$IFACE" 2>/dev/null | awk '/PERMANENT/ {
  mac = ""; for (i = 1; i < NF; i++) if ($i == "lladdr") { mac = $(i+1); break }
  print $1, mac }')

command -v node >/dev/null || exit 0
if [ ! -r "$CACHE" ]; then
  echo "pin-device-arp: no device cache yet; kept ${#kept[@]} working pin(s) (${kept[*]:-none}), cleared $cleared stale, nothing else to pin"
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
#
# A kept pin's MAC is a candidate too, even alone: TCP 6668 has just answered
# through it, so it does reach a Tuya device, however few devices the
# repeater's ARP happens to answer for this minute.
mapfile -t CANDIDATES < <(
  {
    for ip in "${resolved[@]}"; do mac_of "$ip"; done \
      | sort | uniq -c | awk '$1 >= 2 { print $2 }'
    for ip in "${kept[@]}"; do mac_of "$ip"; done
  } | sort | uniq -c | sort -rn | awk '{ print $2 }'
)

if [ ${#CANDIDATES[@]} -eq 0 ]; then
  echo "pin-device-arp: ${#resolved[@]} resolved, ${#failed[@]} unresolved, no MAC answers for more than one device so no repeater to pin to; kept ${#kept[@]} working pin(s) (${kept[*]:-none}), cleared $cleared stale"
  exit 0
fi

is_candidate() {
  local m
  for m in "${CANDIDATES[@]}"; do [ "$m" = "$1" ] && return 0; done
  return 1
}

is_kept() {
  local k
  for k in "${kept[@]}"; do [ "$k" = "$1" ] && return 0; done
  return 1
}

# Devices that resolved *through the repeater* are pinned to it as well, not
# just the ones that failed. Its proxy-ARP is intermittent, not merely picky:
# on 2026-10-16 .164 resolved fine during this script and was FAILED a few
# minutes later, once the kernel's entry went stale and had to be re-asked.
# Devices answering with their own MAC are left to normal ARP — they resolve
# reliably, and pinning them would break the day one moves. Every pin is
# re-checked on each start, so a move is still corrected by a restart. Kept
# pins already are what this would set, so they are only reported.
held=()
for ip in "${resolved[@]}"; do
  is_kept "$ip" && continue
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

echo "pin-device-arp: via ${CANDIDATES[*]} — kept ${#kept[@]} working pin(s) (${kept[*]:-none}), held ${#held[@]} that resolved (${held[*]:-none}), pinned ${#pinned[@]} that didn't (${pinned[*]:-none}), unreachable ${#unreachable[@]} (${unreachable[*]:-none}); cleared $cleared stale"
exit 0
