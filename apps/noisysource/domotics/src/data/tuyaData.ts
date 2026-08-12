import type { Device } from '@shared/models/Device';

/**
 * Maps the Tuya (SmartLife) device list onto our Device model.
 *
 * Unlike Legrand, nothing here is hardcoded — Tuya returns names, ids and
 * capabilities, so adding a thermostat in SmartLife is enough for it to appear
 * in the app. New devices arrive with no room and surface in the sidebar's
 * "Sem divisão" group until dragged onto the plan.
 *
 * Tuya categories seen on this account:
 *   wk   — TR01-WF radiator thermostat
 *   znrb — MTATWHP-5C heat pump
 */

export interface TuyaDevice {
  id: string;
  name: string;
  category: string;
  online: boolean;
  status: Array<{ code: string; value: unknown }>;
}

/** Tuya reports temperatures in tenths of a degree. */
const TENTHS = 10;

function statusMap(status: TuyaDevice['status']) {
  return new Map(status.map(s => [s.code, s.value]));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function degrees(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : n / TENTHS;
}

export function buildTuyaDevices(raw: TuyaDevice[]): Device[] {
  const out: Device[] = [];

  for (const d of raw) {
    const s = statusMap(d.status ?? []);
    const base = {
      id: d.id,
      name: d.name,
      roomId: '',            // unplaced until dragged onto the plan
      vendor: 'tuya' as const,
      online: d.online,
    };

    if (d.category === 'wk') {
      out.push({
        ...base,
        type: 'thermostat',
        state: {
          // NaN, not 0: a device we have never reached has no temperature, and
          // 0 °C would render as a plausible-looking lie.
          current: degrees(s.get('temp_current')) ?? NaN,
          target: degrees(s.get('temp_set')) ?? NaN,
          mode: s.get('mode') === 'auto' ? 'auto' : 'manual',
          // `valve_state` is the honest "is it heating right now" signal —
          // target above current only means it intends to.
          heating: s.get('valve_state') === 'open',
          humidity: num(s.get('humidity')),
          battery: num(s.get('battery_percentage')),
        },
      });
      continue;
    }

    if (d.category === 'znrb') {
      out.push({
        ...base,
        type: 'heatpump',
        state: {
          on: s.get('switch') === true,
          tankTop: degrees(s.get('temp_top')),
          tankBottom: degrees(s.get('temp_bottom')),
          power: num(s.get('power_consumption')),
        },
      });
      continue;
    }

    // Unknown category: skipped rather than guessed at. Add a branch here when
    // a new kind of device shows up in SmartLife.
  }

  return out;
}

/** Degrees -> the tenths Tuya expects on the wire. */
export function toTuyaTemp(degrees: number) {
  return Math.round(degrees * TENTHS);
}
