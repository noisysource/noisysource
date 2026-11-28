# The house — a guide for Atlas

Renato and Marisa's house in Eiras, Coimbra, run by the Domotics app
(`apps/noisysource/domotics`). Read this once when the house comes up; use the
tools for anything current. Numbers here are the setup as of November 2026,
not live readings.

## How it is wired
- **A Raspberry Pi bridge** on the house network talks to the heating and the
  solar inverter on the LAN, runs the heating automation, and publishes the
  house's state to Firestore every few minutes (more often while someone
  watches). Your tools read that state; your heating commands are queued to it
  and it picks them up within about 10 seconds.
- **If the state is older than 15 minutes, the house is offline to you** (the
  bridge, the Pi or the internet is down). Say so; don't present old readings
  as current, and don't queue commands into a house that isn't listening.
- **Lights and blinds** are Legrand, through Netatmo's cloud: they need the
  internet but not the bridge.

## Heating
- **Underfloor heating** from a **Zantia Vancouver 13 heat pump**, for heating
  only. Hot water (AQS) comes from a separate pump that isn't connected, so the
  pump's hot-water readings mean nothing; ignore them.
- **Thermostats** (Tuya TR01) in: Sala, Master bedroom, Quarto, Kids Bathroom,
  Hall quartos, Quarto Diniz. `valveOpen` is the real "heating now"; a target
  above the room temperature only means it wants heat.
- **The automation** (on the bridge) switches the pump by a plan: warm hours
  17:00–23:00 and 06:00–08:00 at 24 °C; by day only on spare sun (battery at 40%
  or more) or if rooms drop below 21 °C. Its `doing` and `reasons` say what it's
  doing and why: quote them rather than guessing. It can be paused
  (`house_pause_automation`), and asked to have the house warm by a time
  (`house_warm_by`).
- **Known issue since 19/11/2026:** the pump's module reports only part of its
  data (no mode, setpoints or faults). Missing faults are *not* "no faults":
  say the pump isn't reporting faults.
- Switching the pump yourself fights the automation; prefer pausing it, or a
  warm-by request, unless Renato asks for the pump directly.

## Energy
- **Solar:** a RENAC inverter with a battery, 14 panels (about 7 kWp; the panel
  rating isn't confirmed). Supply from the grid: **6.9 kVA, single phase**
  (about 30 A); the main breaker trips above that.
- The inverter is the only meter: it measures the whole house, not single
  appliances. `houseConsumptionW` is derived (solar − battery − grid).
- **Bills:** `house_energy_bill` gives kWh, cost and savings for a range of days,
  from the 15-minute history and the tariff set in the app.

## What you can and can't do here
- **Read:** the house's state (rooms, pump, inverter, automation), lights and
  blinds, the energy bill, a day's history, the TV/Roomba/camera status.
- **Change, after Renato's OK in Atlas:** lights (on/off, brightness 0–100 on
  dimmers), blinds (position 0–100: 100 open, 0 closed, as Netatmo reports it),
  a thermostat's target (10–28 °C, half degrees) or mode, the heat pump on/off,
  a warm-by request, pausing the automation.
- **Not yours:** the TV, Roomba and cameras (status only, no commands), the
  Teslas (owner only, in the app's Carros page), the bridge's administration,
  and every vendor credential.

## Manners
- Before a change, say exactly what will change ("Sala blinds to 30%, Luz
  Cozinha off"), and do the smallest thing that does the job.
- After a heating command, the house confirms within ~10 s: check the state
  again before saying it's done.
- Write numbers the way the app shows them: °C with one decimal, %, kWh, €.
