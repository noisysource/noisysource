/**
 * The thermostats and the heat pump, read out of the devices' raw status for
 * the automation, the climate history and the incident recorder.
 * Pure, so it is tested without a house (test/readings.test.cjs).
 *
 * The pump is found by its Tuya category, never by a datapoint it happens to
 * report. Its module can answer with only some of them: since 19/11/2026
 * (probably a power cut that restarted it) a full read brings only dps 1, 16,
 * 18 and 20–25 (on/off, compressor Hz, temperatures), with no mode, no
 * setpoints and no fault bitmaps. Finding the pump by `p02_heating` then left
 * the automation with "bomba não encontrada", and nothing switched the pump.
 *
 * Missing is not zero: a fault bitmap that isn't reported is "not known", not
 * "no fault" (`faultsUnknown`), and a missing setpoint stays undefined.
 */

import type { DeviceState } from './tuya';
import type { PumpReading, ZoneReading } from './automation';
import type { PumpDps, PumpSample } from './incidents';
import { PUMP_FAULT_CODES, decodeFaults, faultsReported } from './faults';

/** The heat pump's Tuya category (see dpmap.ts). */
export const PUMP_CATEGORY = 'znrb';

const tenths = (v: unknown) => (typeof v === 'number' ? v / 10 : undefined);
const whole = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** The thermostats and the pump, as the automation and the climate history read them. */
export function readHeating(devices: DeviceState[]): { zones: ZoneReading[]; pump: PumpReading | undefined } {
  const zones: ZoneReading[] = [];
  let pump: PumpReading | undefined;
  for (const d of devices) {
    const s = new Map(d.status.map(x => [x.code, x.value]));
    if (d.category === PUMP_CATEGORY) {
      pump = {
        id: d.id,
        online: d.online,
        on: s.get('switch') === true,
        fault: PUMP_FAULT_CODES.some(c => Number(s.get(c) ?? 0) !== 0),
        // Only said of a pump that answered something: one never reached is "sem ligação".
        faultsUnknown: d.status.length > 0 && !faultsReported(c => s.has(c)),
        // The pump's own outdoor sensor (`temp_top` — see README, "Heat pump").
        outdoor: tenths(s.get('temp_top')),
        flowSetpoint: whole(s.get('p02_heating')),
        // Same datapoints as the incident samples (readPumpSample).
        hz: whole(s.get('temp_current')),
        waterOut: tenths(s.get('venting_temp')),
        waterIn: tenths(s.get('coiler_temp')),
      };
    } else if (s.has('temp_set')) {
      zones.push({
        id: d.id,
        name: d.name,
        online: d.online,
        current: tenths(s.get('temp_current')),
        target: tenths(s.get('temp_set')),
        mode: typeof s.get('mode') === 'string' ? (s.get('mode') as string) : undefined,
        valveOpen: s.get('valve_state') === 'open',
      });
    }
  }
  return { zones, pump };
}

/** One fresh pump reading for the incident recorder, with every raw datapoint beside it. */
export function readPumpSample(pump: DeviceState, devices: DeviceState[], now: number): { sample: PumpSample; dps: PumpDps } {
  const s = new Map(pump.status.map(x => [x.code, x.value]));
  const zones = devices.filter(d => d.category === 'wk' && d.online);
  const sample: PumpSample = {
    t: now,
    on: s.get('switch') === true,
    hz: whole(s.get('temp_current')) ?? 0,
    sp: whole(s.get('p02_heating')),
    out: tenths(s.get('venting_temp')),
    inn: tenths(s.get('coiler_temp')),
    dis: tenths(s.get('compressor_strength')),
    outdoor: tenths(s.get('temp_top')),
    coil: tenths(s.get('power_consumption')),
    suct: tenths(s.get('temp_bottom')),
    faults: decodeFaults(code => s.get(code)),
    // Only when true: dozens of samples go into each incident document.
    ...(faultsReported(c => s.has(c)) ? {} : { faultsUnknown: true as const }),
    valves: zones.filter(z => z.status.some(x => x.code === 'valve_state' && x.value === 'open')).length,
    zones: zones.length,
  };
  const dps: PumpDps = {};
  for (const { code, value } of pump.status) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') dps[code] = value;
  }
  return { sample, dps };
}
