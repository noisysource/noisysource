import type { Device } from '@shared/models/Device';
import type { EnergyReading } from './energy';
import type { AutomationStatus } from './automation';
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

/** A sunny afternoon: panels producing, battery charging, a little exported. */
export function demoEnergy(): EnergyReading {
  return {
    online: true,
    pvPowerW: 3720,
    consumptionW: 719,
    batteryPowerW: 2850,
    gridPowerW: 150,
    soc: 86,
    readAt: Date.now(),
  };
}

/** The automation in simulation, mid-afternoon with a solar surplus. */
export function demoAutomation(): AutomationStatus {
  const now = Date.now();
  return {
    enabled: true,
    dryRun: true,
    state: 'dry-run',
    period: 'day',
    periodLabel: 'dia',
    boost: true,
    roomTarget: 24.5,
    outdoor: 14.5,
    flowTarget: 30,
    flowCorrection: 0,
    zones: [
      { id: 'a', name: 'Sala therm', note: 'definiria 24.5°C' },
      { id: 'b', name: 'Master bedroom', note: 'no alvo' },
    ],
    reasons: [
      'Período: dia — alvo das divisões 24.5°C (inclui bónus solar).',
      'Há excedente solar: a guardar calor no pavimento.',
      'Água a 30°C: exterior 14.5°C (sensor da bomba).',
    ],
    actions: [
      { at: now - 4 * 60_000, device: 'Sala therm', what: 'alvo 24°C → 24.5°C', sent: false },
      { at: now - 9 * 60_000, device: 'Bomba de calor', what: 'água 42°C → 30°C', sent: false },
    ],
    evaluatedAt: now,
  };
}

