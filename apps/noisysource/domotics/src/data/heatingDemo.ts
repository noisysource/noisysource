import { SLOT_MS, addDays, dayStart, lisbonDate } from '@shared/lib/energyBill';
import { lisbonAt, parseClimateDay, type HeatingRecord } from './heatingTimeline';
import type { Incident, SwitchEvent } from './incidents';

/** `?demo`: every day plays out like the real 2026-11-04, today up to now, with the slots an hour behind as the bridge's are. */

const MIN = 60_000;

const SWITCHES: Array<[string, boolean, SwitchEvent['source'], string?]> = [
  ['05:30', true, 'automation', 'ligar (a aquecer para as 06:00)'],
  ['08:00', false, 'automation', 'desligar (de dia só com sol: bateria 18 % de 40 %, a carregar 0,2 kW de 2,7 kW)'],
  ['11:31', true, 'automation', 'ligar (com o sol: bateria 42 %, a carregar 3,0 kW)'],
  ['11:54', false, 'outside'],
  ['12:27', true, 'outside'],
  ['15:54', false, 'outside'],
  ['16:30', true, 'automation', 'ligar (a aquecer para as 17:00)'],
  ['23:00', false, 'automation', 'desligar (de dia só com sol: bateria 30 % de 40 %, a carregar 0,0 kW de 2,7 kW)'],
];

const switchAt = (date: string, [time, on, source, reason]: typeof SWITCHES[number]): SwitchEvent => ({
  kind: 'switch', id: `demo-${date}-${time}`, deviceName: 'Bomba de calor', at: lisbonAt(date, time), on, source,
  ...(reason ? { reason } : {}), faults: [], before: [], origin: 'bridge',
});

export function demoHeatingRecord(date: string, now: number): HeatingRecord {
  const from = dayStart(date);
  const end = Math.min(now, dayStart(addDays(date, 1)));
  const isToday = date === lisbonDate(now);
  const switches = SWITCHES.map(s => switchAt(date, s));
  const incidents: Incident[] = switches.filter(s => s.at <= end);

  const pumpOn = (t: number) => switches.reduce((on, s) => (s.at <= t ? s.on : on), false);
  const planAt = (t: number) => {
    const m = (h: string) => lisbonAt(date, h);
    if ((t >= m('05:30') && t < m('06:00')) || (t >= m('16:30') && t < m('17:00'))) return 'warmup';
    if ((t >= m('06:00') && t < m('08:00')) || (t >= m('17:00') && t < m('23:00'))) return 'warm';
    return 'day';
  };

  // The bridge writes on the hour: today's latest slots aren't in yet.
  const written = isToday ? Math.floor(end / (60 * MIN)) * 60 * MIN : end;
  const doc: Record<string, unknown> = { zones: { sala: 'Sala', quarto: 'Quarto' } };
  let temp = 23.4;
  for (let i = 0; from + (i + 1) * SLOT_MS <= written; i++) {
    const t = from + i * SLOT_MS;
    let onShare = 0;
    for (let k = 0; k < 15; k++) if (pumpOn(t + k * MIN)) onShare += 1 / 15;
    temp += onShare > 0.5 ? 0.04 : -0.02;
    const onSun = t >= lisbonAt(date, '11:30') && t < lisbonAt(date, '12:00');
    doc[`q${String(i).padStart(2, '0')}`] = {
      n: 30, pn: 30, on: Math.round(onShare * 100) / 100, run: Math.round(onShare * 100) / 100, plan: planAt(t + 14 * 60_000),
      soc: Math.round(30 + 25 * Math.sin((i / 96) * Math.PI)), ext: 12,
      z: {
        sala: { t: Math.round((temp + 0.2) * 10) / 10, s: onSun ? 26 : 25, v: 1 },
        quarto: { t: Math.round((temp - 0.2) * 10) / 10, s: onSun ? 26 : 25, v: 1 },
      },
    };
  }
  const thermostat = lisbonAt(date, '10:15');
  if (thermostat <= written) {
    doc.x_101500_sala = { at: thermostat, kind: 'target', by: 'outside', zone: 'sala', zoneName: 'Sala', from: 25, to: 26, mean: 23.6 };
  }
  if (!isToday && end >= lisbonAt(date, '18:04')) {
    incidents.push({
      kind: 'fault', id: `demo-${date}-fault`, device: 'demo-heatpump', deviceName: 'Bomba de calor', code: 'E13', codes: ['E13'],
      at: lisbonAt(date, '18:00'), status: 'ended', lockout: false, endedAt: lisbonAt(date, '18:04'), endedHow: 'self',
      offlineDuring: false, before: [], after: [], actions: [], origin: 'bridge',
    });
  }
  return {
    climate: parseClimateDay(date, doc),
    incidents,
    before: switchAt(addDays(date, -1), SWITCHES[SWITCHES.length - 1]),
  };
}
