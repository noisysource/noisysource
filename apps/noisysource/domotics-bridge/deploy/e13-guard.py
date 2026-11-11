"""E13 guard for the floor-heating heat pump (temporary, until the technicians fix it).

Every E13 so far (7 trips, 21-22 Oct) came the same way: the water reached the
setpoint, the compressor dropped to its minimum (35-45 Hz) and idled there for
4-11 minutes, then sped up again and tripped within a minute. Starts from
standstill never tripped (11 of 11). So instead of letting it idle at the
setpoint, switch it off there and back on after a rest — the slab holds the heat.

Two trips within ~15 minutes lock the pump out until the breaker is cycled. If a
trip happens anyway, switch off at once so the automatic restart can't trip a
second time, and rest longer before switching back on.

Talks only to the local bridge (LAN), never to Tuya's cloud.
  stop:   touch ~/e13-watch/guard.stop   (switches the pump back on if resting)
  log:    ~/e13-watch/guard.log
"""
import json, os, sys, time, urllib.request
from datetime import datetime

BRIDGE = "http://127.0.0.1:8787"
HOME = os.path.expanduser("~/e13-watch")
LOG = os.path.join(HOME, "guard.log")
STOP = os.path.join(HOME, "guard.stop")
STATUS = os.path.join(HOME, "guard-state.json")

POLL_S = 20
IDLE_HZ = 45            # compressor at/near its minimum
NEAR_SP = 1.5           # water out within this of the setpoint (a dip of 1.5 preceded the 20:30 trip)
CONFIRM_READS = 1       # one reading: the 20:30 trip re-ramped straight after a single idle reading
GRACE_S = 4 * 60        # ignore the idle rule right after we switch on
REST_PREVENTIVE_S = 60 * 60
REST_AFTER_TRIP_S = 120 * 60
STALE_S = 3 * 60
FAULT_CODES = ("fault", "bcu_com_state", "electronic_system", "ithium_battery_system",
               "power_system", "smart_system")

END = datetime.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else None


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def get_state():
    with urllib.request.urlopen(BRIDGE + "/state", timeout=15) as r:
        return json.load(r)


def pump_of(state):
    for d in state["devices"]:
        st = {s["code"]: s["value"] for s in d.get("status", [])}
        if "p02_heating" in st:
            return d, st
    return None, None


def switch(device_id, on):
    body = json.dumps({"deviceId": device_id, "commands": [{"code": "switch", "value": on}]}).encode()
    req = urllib.request.Request(BRIDGE + "/command", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)


def faults(st):
    return {c: st[c] for c in FAULT_CODES if st.get(c)}


def main():
    mode = "watch"          # watch | rest | lockout
    rest_until = 0.0
    switched_on_at = 0.0
    idle_count = 0
    last_read = None
    log(f"guard started (end {END or 'none'})")
    while True:
        now = time.time()
        if END and datetime.now() >= END:
            log("end time reached")
            break
        if os.path.exists(STOP):
            break
        try:
            state = get_state()
            dev, st = pump_of(state)
            if dev is None:
                raise RuntimeError("pump missing from bridge state")
            age = now - state["updatedAt"] / 1000
            read = state["updatedAt"]
            on, hz, sp = st.get("switch"), st.get("temp_current", 0), st.get("p02_heating")
            out = st.get("venting_temp", 0) / 10
            f = faults(st)
            summary = f"on={on} hz={hz} out={out} sp={sp} dis={st.get('compressor_strength', 0) / 10} faults={f or 0}"

            if age > STALE_S or not dev.get("online"):
                log(f"stale/offline reading ({int(age)}s old), doing nothing: {summary}")
            elif mode == "rest":
                if on:
                    log(f"pump switched on by someone during rest — handing back to watch: {summary}")
                    mode, switched_on_at, idle_count = "watch", now, 0
                elif now >= rest_until:
                    log(f"rest over, switching ON: {summary}")
                    switch(dev["id"], True)
                    mode, switched_on_at, idle_count = "watch", now, 0
            elif mode == "lockout":
                if on and not f:
                    log(f"fault cleared (reset done) — back to watch: {summary}")
                    mode, switched_on_at, idle_count = "watch", now, 0
            elif on and f:
                if now - switched_on_at < 3 * 60 and switched_on_at:
                    log(f"still faulted right after switching on — LOCKOUT, needs the breaker/technicians: {summary}")
                    mode = "lockout"
                else:
                    log(f"TRIP seen — switching OFF for {REST_AFTER_TRIP_S // 60} min so it can't trip twice: {summary}")
                    switch(dev["id"], False)
                    mode, rest_until = "rest", now + REST_AFTER_TRIP_S
            elif on and hz and sp is not None:
                idling = hz <= IDLE_HZ and out >= sp - NEAR_SP and now - switched_on_at > GRACE_S
                if read != last_read:
                    idle_count = idle_count + 1 if idling else 0
                if idle_count >= CONFIRM_READS:
                    log(f"at setpoint and idling — switching OFF for {REST_PREVENTIVE_S // 60} min before it re-ramps: {summary}")
                    switch(dev["id"], False)
                    mode, rest_until, idle_count = "rest", now + REST_PREVENTIVE_S, 0
            last_read = read
            with open(STATUS, "w") as fh:
                json.dump({"at": datetime.now().isoformat(timespec="seconds"), "mode": mode,
                           "restUntil": datetime.fromtimestamp(rest_until).isoformat(timespec="seconds") if mode == "rest" else None,
                           "pump": summary}, fh)
        except Exception as e:  # keep going; the next poll retries
            log(f"error: {e}")
        time.sleep(POLL_S)

    # Never leave the house with the pump parked by us.
    if mode == "rest":
        try:
            dev, _ = pump_of(get_state())
            switch(dev["id"], True)
            log("stopping during rest — switched the pump back ON")
        except Exception as e:
            log(f"stopping during rest — could NOT switch the pump back on: {e}")
    log("guard stopped")


if __name__ == "__main__":
    main()
