#!/bin/bash
#
# Works around the WiFi repeater's flaky proxy-ARP.
#
# Every Tuya device sits behind the repeater, so from the wired side they all
# share one destination MAC — the repeater's. It answers ARP for most of them
# but persistently refuses for a couple, which land in NUD FAILED and stay
# there: three rounds of ping over 45 seconds never recovered 192.168.1.122 or
# 192.168.1.153, while a laptop on the WiFi side reached all seven at the same
# moment and saw the identical MAC for every one of them.
#
# Since the right answer is already known — whatever MAC the *reachable*
# devices resolve to — the fix is to install it for the ones ARP gave up on.
# The MAC is discovered rather than hardcoded, so replacing the repeater does
# not silently blackhole the house.
#
# Runs as root from the unit's ExecStartPre. Never fails the service: losing
# two thermostats is much better than losing the bridge.
set -u

IFACE=${ARP_IFACE:-eth0}
CACHE=${DEVICE_CACHE:-/home/pi/domotics-bridge/device-cache.json}

command -v node >/dev/null || exit 0
[ -r "$CACHE" ] || exit 0

mapfile -t IPS < <(node -e '
  try {
    const list = require(process.argv[1]);
    for (const d of list) if (d.ip) console.log(d.ip);
  } catch { }
' "$CACHE")
[ ${#IPS[@]} -gt 0 ] || exit 0

# Prompt resolution for everything first; some will answer, some will not.
for ip in "${IPS[@]}"; do
  ping -c 1 -W 1 "$ip" >/dev/null 2>&1 &
done
wait

# Whatever the reachable devices resolved to is the repeater. Take the most
# common answer rather than the first, so one stale entry cannot mislead us.
#
# Only the device IPs get a vote. Counting across the whole ARP table elected
# the laptop's MAC when just one device had resolved, which would have pinned
# every thermostat at a machine that is not the repeater and broken all seven
# rather than the two that were already broken.
#
# The MAC is found by locating the `lladdr` keyword rather than by column
# number: `ip neigh show dev eth0` drops the "dev eth0" pair from its output
# while a bare `ip neigh` keeps it, so fixed offsets silently match nothing.
MAC=$(
  for ip in "${IPS[@]}"; do
    ip neigh show "$ip" dev "$IFACE" 2>/dev/null \
      | awk '$NF != "FAILED" {
          for (i = 1; i < NF; i++) if ($i == "lladdr") { print $(i+1); break }
        }'
  done | sort | uniq -c | sort -rn | head -1 | awk '{print $2}'
)

if [ -z "${MAC:-}" ]; then
  echo "pin-device-arp: no MAC resolved on $IFACE; leaving ARP alone"
  exit 0
fi

# Every device is pinned, not just the ones currently broken. They all sit
# behind the same repeater and therefore share one MAC — confirmed from both
# this host and a laptop on the WiFi side — so there is nothing to be selective
# about. Being selective also raced the kernel: entries mid-resolution read as
# INCOMPLETE rather than FAILED, so a check for FAILED pinned nothing at all.
pinned=0
for ip in "${IPS[@]}"; do
  ip neigh replace "$ip" lladdr "$MAC" dev "$IFACE" nud permanent 2>/dev/null && pinned=$((pinned+1))
done

echo "pin-device-arp: $pinned of ${#IPS[@]} devices pinned to $MAC on $IFACE"

# NOTE: these entries are permanent, so the kernel will never re-learn them.
# When the router's WiFi is finally split and the devices move off the
# repeater, drop the ExecStartPre from the unit — otherwise the house keeps
# being addressed at a repeater it no longer lives behind.
exit 0
