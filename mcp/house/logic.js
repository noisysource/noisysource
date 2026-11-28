// The pure half of the house MCP: reading what the house reports, and building
// the commands Atlas may send. No Firebase here, so it can be tested alone
// (logic.test.js). The shapes come from:
//   - domotics_state/tuya: the Pi bridge (apps/noisysource/domotics-bridge),
//     the same {code, value} statuses the app decodes in src/data/tuyaData.ts
//   - legrandGetHome / legrandGetStatus: Netatmo's homesdata / homestatus
//   - domotics_commands: the shape the rules hold Atlas to (isAtlasCommand in
//     firebase/noisysource/firestore.rules): 1–2 commands, code temp_set | mode | switch

/** Relayed state older than this is the bridge not publishing: the house is offline to us. */
export const STALE_MS = 15 * 60_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const tenths = (v) => (num(v) === undefined ? undefined : v / 10);
const statusMap = (d) => new Map((Array.isArray(d?.status) ? d.status : []).map((s) => [s.code, s.value]));
const millis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : num(t));
const iso = (ms) => (ms === undefined ? undefined : new Date(ms).toISOString());

/** Thermostats, the heat pump, the inverter and the heating automation, from domotics_state/tuya. */
export function decodeHouseState(doc, now = Date.now()) {
  if (!doc) return { available: false, reason: 'The bridge has never published state.' };
  const updatedAt = millis(doc.updatedAt);
  const ageMin = updatedAt === undefined ? undefined : Math.round((now - updatedAt) / 60_000);
  const thermostats = [];
  let heatPump;
  for (const d of Array.isArray(doc.devices) ? doc.devices : []) {
    const s = statusMap(d);
    if (d.category === 'wk') {
      thermostats.push({
        deviceId: d.id,
        room: d.name,
        online: d.online === true,
        currentC: tenths(s.get('temp_current')),
        targetC: tenths(s.get('temp_set')),
        mode: s.get('mode') === 'auto' ? 'auto' : 'manual',
        // valve_state is the honest "heating now"; target above current only means it intends to.
        valveOpen: s.get('valve_state') === 'open',
        humidity: num(s.get('humidity')),
        battery: num(s.get('battery_percentage')),
        lastSeen: iso(num(d.lastSeen)),
      });
    } else if (d.category === 'znrb') {
      // The pump's Tuya codes are reused generic names: temp_current is compressor Hz, temp_top is outdoor.
      heatPump = {
        deviceId: d.id,
        name: d.name,
        online: d.online === true,
        on: s.get('switch') === true,
        mode: typeof s.get('mode') === 'string' ? s.get('mode') : undefined,
        compressorHz: num(s.get('temp_current')),
        outdoorC: tenths(s.get('temp_top')),
        waterInC: tenths(s.get('coiler_temp')),
        waterOutC: tenths(s.get('venting_temp')),
        heatingSetpointC: num(s.get('p02_heating')),
        reportsFaults: s.has('fault') || s.has('fault1') || [...s.keys()].some((k) => /fault/i.test(k)),
      };
    }
  }
  const inv = doc.inverter;
  const inverter = inv && inv.online
    ? {
        solarW: num(inv.pvPowerW),
        // Positive charging or discharging depends on the inverter's convention; reported as it comes.
        batteryW: num(inv.batteryPowerW),
        batteryPercent: num(inv.soc),
        gridW: num(inv.gridPowerW),
        houseConsumptionW: num(inv.consumptionW),
        readAt: iso(num(inv.readAt)),
      }
    : { online: false };
  const a = doc.automation;
  const automation = a
    ? {
        state: a.state,
        doing: a.doing,
        reasons: Array.isArray(a.reasons) ? a.reasons.slice(0, 8) : undefined,
        pausedUntil: iso(num(a.pausedUntil) ?? undefined),
        meanRoomC: num(a.meanRoom),
        roomTargetC: num(a.roomTarget),
        outdoorC: num(a.outdoor),
        warmBy: a.warmBy ?? undefined,
      }
    : undefined;
  return {
    available: true,
    updatedAt: iso(updatedAt),
    ageMinutes: ageMin,
    stale: updatedAt === undefined || now - updatedAt > STALE_MS,
    thermostats,
    heatPump,
    inverter,
    automation,
  };
}

/**
 * Lights and blinds, from Netatmo's homesdata (names, rooms) and homestatus
 * (state, and the gateway each module sits behind, which setstate needs).
 * A module with a position is a blind; one with on/off is a light.
 */
export function decodeLegrand(home, status) {
  const h = home?.body?.homes?.[0] ?? home?.homes?.[0] ?? {};
  const rooms = new Map((h.rooms ?? []).map((r) => [r.id, r.name]));
  const meta = new Map((h.modules ?? []).map((m) => [m.id, m]));
  const live = status?.body?.home?.modules ?? status?.home?.modules ?? [];
  const lights = [];
  const blinds = [];
  for (const s of live) {
    const m = meta.get(s.id) ?? {};
    const base = {
      id: s.id,
      name: m.name ?? s.id,
      room: rooms.get(m.room_id) ?? m.room_id ?? null,
      bridge: s.bridge ?? m.bridge,
      reachable: s.reachable !== false,
    };
    if (num(s.current_position) !== undefined || num(s.target_position) !== undefined) {
      blinds.push({ ...base, position: num(s.current_position) ?? num(s.target_position) });
    } else if (typeof s.on === 'boolean') {
      lights.push({ ...base, on: s.on, ...(num(s.brightness) !== undefined ? { brightness: s.brightness } : {}) });
    }
  }
  const byRoom = (a, b) => String(a.room).localeCompare(String(b.room)) || String(a.name).localeCompare(String(b.name));
  return { lights: lights.sort(byRoom), blinds: blinds.sort(byRoom) };
}

const isPercent = (v) => Number.isInteger(v) && v >= 0 && v <= 100;

/**
 * Modules for legrandSetState, each with its gateway. Lights take on and/or
 * brightness; blinds a position. Refuses unknown ids and anything else, the
 * same rules the callable applies to Atlas (legrandModules.ts).
 */
export function legrandModules(changes, known) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 30) {
    throw new Error('Give 1 to 30 changes.');
  }
  const byId = new Map([...known.lights, ...known.blinds].map((m) => [m.id, m]));
  return changes.map((c, i) => {
    const m = byId.get(c?.id);
    if (!m) throw new Error(`changes[${i}]: unknown module ${c?.id}. Use house_lights_and_blinds for the ids.`);
    const out = { id: m.id, ...(m.bridge ? { bridge: m.bridge } : {}) };
    const isBlind = known.blinds.includes(m);
    if (isBlind) {
      if (!isPercent(c.position)) throw new Error(`changes[${i}]: ${m.name} is a blind; give position 0–100.`);
      out.target_position = c.position;
    } else {
      if (c.on === undefined && c.brightness === undefined) throw new Error(`changes[${i}]: give on and/or brightness for ${m.name}.`);
      if (c.on !== undefined) {
        if (typeof c.on !== 'boolean') throw new Error(`changes[${i}]: on must be true or false.`);
        out.on = c.on;
      }
      if (c.brightness !== undefined) {
        if (!isPercent(c.brightness)) throw new Error(`changes[${i}]: brightness must be 0–100.`);
        out.brightness = c.brightness;
      }
    }
    return out;
  });
}

/** A thermostat's target (°C) and/or mode, as the bridge takes them (tenths of a degree). */
export function thermostatCommands({ targetC, mode }) {
  const commands = [];
  if (targetC !== undefined) {
    if (typeof targetC !== 'number' || !Number.isFinite(targetC)) throw new Error('targetC must be a number.');
    if (targetC < 10 || targetC > 28) throw new Error('targetC must be between 10 and 28 °C.');
    commands.push({ code: 'temp_set', value: Math.round(targetC * 2) * 5 }); // half degrees, in tenths
  }
  if (mode !== undefined) {
    if (mode !== 'auto' && mode !== 'manual') throw new Error('mode must be "auto" or "manual".');
    commands.push({ code: 'mode', value: mode });
  }
  if (commands.length === 0) throw new Error('Give targetC and/or mode.');
  return commands;
}

/**
 * One day's history, made small: kWh per hour (pv, load, imp = bought, exp =
 * sold, chg/dis = battery), and the climate at the start of each hour with
 * thermostat ids replaced by room names (`names`: id → room).
 */
export function compactDay(climate, energy, names = {}) {
  const slots = (doc) => Object.entries(doc ?? {}).filter(([k]) => /^q\d\d$/.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const hours = {};
  for (const [k, v] of slots(energy)) {
    const h = String(Math.floor(Number(k.slice(1)) / 4)).padStart(2, '0');
    hours[h] ??= {};
    for (const [field, val] of Object.entries(v ?? {})) {
      if (typeof val === 'number') hours[h][`${field}Kwh`] = Math.round(((hours[h][`${field}Kwh`] ?? 0) + val) * 1000) / 1000;
    }
  }
  const climateHours = {};
  for (const [k, v] of slots(climate)) {
    const h = String(Math.floor(Number(k.slice(1)) / 4)).padStart(2, '0');
    if (climateHours[h]) continue; // the first slot of each hour: enough for a picture of the day
    const z = v?.z && typeof v.z === 'object'
      ? Object.fromEntries(Object.entries(v.z).map(([id, r]) => [names[id] ?? id, r]))
      : undefined;
    climateHours[h] = z ? { ...v, z } : v;
  }
  return { energyByHour: hours, climateByHour: climateHours, interventions: Object.fromEntries(Object.entries(climate ?? {}).filter(([k]) => k.startsWith('x_'))) };
}

/** YYYY-MM-DD, or today's date in Lisbon. */
export function dayId(date, now = Date.now()) {
  if (date === undefined) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(now);
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD.');
  return date;
}
