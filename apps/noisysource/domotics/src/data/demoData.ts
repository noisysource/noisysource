import type { Device } from '@shared/models/Device';
import type { EnergyReading } from './energy';
import type { AutomationStatus } from './automation';
import { addDays, lisbonDate } from '@shared/lib/energyBill';
import { hhmm, lisbonAt } from './heatingTimeline';
import { buildDevices, deviceMeta, rooms } from './legrandData';

/**
 * Demo mode for working on the UI away from the house: `?demo` on the dev
 * server. The real device list and room ids with made-up readings, and every
 * command applied on screen only — nothing is sent to Legrand, the bridge or
 * the relay.
 *
 * Development builds only: `import.meta.env.DEV` is false in a production
 * build, so this whole path is compiled out and `?demo` on the hosted app does
 * nothing.
 */
export const DEMO =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo');

/** Lights and blinds in a believable evening state, including some dimmed. */
export function demoLegrand(): Device[] {
  const modules = deviceMeta.map((m, i) =>
    m.type === 'light'
      ? { id: m.id, on: i % 3 === 0, brightness: i % 2 === 0 ? 40 : 100 }
      : { id: m.id, current_position: [0, 100, 40][i % 3] },
  );
  return buildDevices(modules).map(d => ({ ...d, online: true }));
}

/** One thermostat per room that has climate in the real house, plus the heat pump. */
export function demoClimate(): Device[] {
  const climateRooms = rooms.filter(r => !/Cozinha|Jantar/.test(r.name));
  const thermostats: Device[] = climateRooms.map((r, i) => ({
    id: `demo-thermo-${r.id}`,
    roomId: r.id,
    name: `${r.name} therm`,
    type: 'thermostat',
    vendor: 'tuya',
    online: true,
    state: {
      current: 19.5 + ((i * 1.3) % 5),
      target: 21,
      mode: 'manual',
      heating: i % 3 === 0,
      humidity: 45 + ((i * 7) % 20),
      battery: 80,
    },
  }));
  const pump: Device = {
    id: 'demo-heatpump',
    roomId: rooms[0].id,
    name: 'Bomba de calor (demo)',
    type: 'heatpump',
    vendor: 'tuya',
    online: true,
    state: {
      on: true, mode: 'Heating', compressorHz: 42, outdoor: 14.5, waterIn: 30, waterOut: 34,
      dhwTank: 44, heatingSetpoint: 35, dhwSetpoint: 45, faults: [],
    },
  };
  return [...thermostats, pump];
}

/** A sunny afternoon with the battery full: the spare solar goes to the grid, unpaid (shows the surplus hint). */
export function demoEnergy(): EnergyReading {
  return {
    online: true,
    pvPowerW: 3720,
    consumptionW: 719,
    batteryPowerW: 40,
    gridPowerW: 2961,
    soc: 99,
    readAt: Date.now(),
  };
}

/** The automation in simulation, on today's real windows, with the rooms too far short for the warm-up to catch up. */
export function demoAutomation(): AutomationStatus {
  const now = Date.now();
  const today = lisbonDate(now);
  const tomorrow = addDays(today, 1);
  // The next of the two windows; demo mode doesn't go as far as being inside one.
  const nextStart = [lisbonAt(today, '06:00'), lisbonAt(today, '17:00'), lisbonAt(tomorrow, '06:00')].find(t => t > now)!;
  const morning = hhmm(nextStart) === '06:00';
  return {
    enabled: true,
    dryRun: true,
    state: 'dry-run',
    pausedUntil: null,
    settings: {
      warmFrom: '17:00', warmTo: '23:00', comfort: 25, dayMin: 21, socOn: 40,
      windows: [{ from: '17:00', to: '23:00' }, { from: '06:00', to: '08:00' }],
      solar: { enabled: true, boost: 1 },
    },
    mode: 'day',
    wantOn: true,
    doing: 'Ligaria a bomba — com o sol: bateria 93 %, 3,1 kW de sol a sobrar.',
    plan: 'Aquece a partir das 17:20 para estar quente às 19:00 (faltam 0,4°: chão ~90 min + divisões a 0,30°/h + 30 min de margem); de dia só com sol e bateria ≥ 90 %, ou se a casa descer dos 21°.',
    warm: {
      from: morning ? '06:00' : '17:00', to: morning ? '08:00' : '23:00', inWindow: false, nextStart,
      end: nextStart + (morning ? 2 : 6) * 3_600_000, warmupAt: nextStart - 30 * 60_000, warmupStarted: false,
      leadMin: 30, capped: true, need: 2.6, expectedAt: nextStart + 17 * 3_600_000,
    },
    solar: { on: true, soc: 93, spareW: 3100, note: 'bateria 93 %, 3,1 kW de sol a sobrar' },
    dayMinActive: false,
    meanRoom: 23.6,
    roomTarget: 24,
    outdoor: 14.5,
    flowTarget: 30,
    flowCorrection: 0,
    zones: [
      { id: 'a', name: 'Sala therm', note: 'definiria 24°C' },
      { id: 'b', name: 'Master bedroom', note: 'no alvo' },
    ],
    reasons: [
      'Dia: bomba ligada — com o sol: bateria 93 %, 3,1 kW de sol a sobrar.',
      'Água a 30°C: exterior 14.5°C (sensor da bomba).',
      'Ligaria a bomba — com o sol: bateria 93 %, 3,1 kW de sol a sobrar.',
    ],
    actions: [
      { at: now - 4 * 60_000, device: 'Bomba de calor', what: 'ligar (com o sol: bateria 93 %, 3,1 kW de sol a sobrar)', sent: false },
      { at: now - 9 * 60_000, device: 'Bomba de calor', what: 'água 42°C → 41°C (desce 1° de cada vez até 30°C)', sent: false },
    ],
    warmBy: {
      at: now + 9 * 3600_000,
      target: 24,
      setAt: now - 3600_000,
      source: 'app',
      phase: 'waiting',
      startAt: now + 4 * 3600_000,
      leadMin: 300,
      current: 23.2,
      expectedAt: now + 8.5 * 3600_000,
      late: false,
      outcome: null,
      note: 'Começa a aquecer mais tarde (faltam 0,8° · chão ~90 min + divisões a 0,30°/h + 30 min de margem).',
    },
    model: { floorMin: 90, roomRatePerH: 0.15, floorSamples: 2, roomSamples: 0 },
    evaluatedAt: now,
  };
}

