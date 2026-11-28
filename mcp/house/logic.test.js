// node --test mcp/house/logic.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDay, dayId, decodeHouseState, decodeLegrand, legrandModules, thermostatCommands } from './logic.js';

const NOW = Date.parse('2026-11-28T10:00:00Z');
const ts = (ms) => ({ toMillis: () => ms });

test('house state: thermostats, pump, inverter and automation, in °C', () => {
  const s = decodeHouseState({
    updatedAt: ts(NOW - 60_000),
    devices: [
      { id: 't1', name: 'Sala', category: 'wk', online: true, status: [
        { code: 'temp_current', value: 205 }, { code: 'temp_set', value: 240 }, { code: 'mode', value: 'manual' },
        { code: 'valve_state', value: 'open' }, { code: 'battery_percentage', value: 80 }] },
      { id: 'hp', name: 'Bomba de calor', category: 'znrb', online: true, status: [
        { code: 'switch', value: true }, { code: 'temp_current', value: 39 }, { code: 'temp_top', value: 95 }, { code: 'p02_heating', value: 44 }] },
    ],
    inverter: { online: true, pvPowerW: 2100, soc: 64, gridPowerW: -300, consumptionW: 900, readAt: NOW - 30_000 },
    automation: { state: 'running', doing: 'Bomba ligada', meanRoom: 21.4, pausedUntil: null },
  }, NOW);
  assert.equal(s.stale, false);
  assert.equal(s.ageMinutes, 1);
  assert.deepEqual(s.thermostats[0], {
    deviceId: 't1', room: 'Sala', online: true, currentC: 20.5, targetC: 24, mode: 'manual', valveOpen: true,
    humidity: undefined, battery: 80, lastSeen: undefined,
  });
  assert.equal(s.heatPump.on, true);
  assert.equal(s.heatPump.outdoorC, 9.5);
  assert.equal(s.heatPump.heatingSetpointC, 44);
  assert.equal(s.inverter.batteryPercent, 64);
  assert.equal(s.automation.doing, 'Bomba ligada');
});

test('house state: old or missing state says so', () => {
  assert.equal(decodeHouseState({ updatedAt: ts(NOW - 20 * 60_000), devices: [] }, NOW).stale, true);
  assert.equal(decodeHouseState(undefined, NOW).available, false);
  assert.deepEqual(decodeHouseState({ updatedAt: ts(NOW), inverter: null }, NOW).inverter, { online: false });
});

const HOME = { body: { homes: [{
  rooms: [{ id: 'r1', name: 'Sala' }, { id: 'r2', name: 'Cozinha' }],
  modules: [
    { id: 'L1', name: 'Luz Sala 1', room_id: 'r1', type: 'NLF' },
    { id: 'L2', name: 'Luz Cozinha', room_id: 'r2', type: 'NLFN' },
    { id: 'B1', name: 'Persiana Sala', room_id: 'r1', type: 'NLV' },
    { id: 'G', name: 'Gateway', type: 'NLG' },
  ],
}] } };
const STATUS = { body: { home: { modules: [
  { id: 'L1', on: true, bridge: 'G' },
  { id: 'L2', on: false, brightness: 40, bridge: 'G' },
  { id: 'B1', current_position: 100, target_position: 100, bridge: 'G' },
  { id: 'G', wifi_strength: 50 },
] } } };

test('Legrand: lights and blinds with names, rooms and their gateway', () => {
  const { lights, blinds } = decodeLegrand(HOME, STATUS);
  assert.deepEqual(lights.map((l) => [l.name, l.room, l.on]), [['Luz Cozinha', 'Cozinha', false], ['Luz Sala 1', 'Sala', true]]);
  assert.equal(lights[0].brightness, 40);
  assert.deepEqual(blinds, [{ id: 'B1', name: 'Persiana Sala', room: 'Sala', bridge: 'G', reachable: true, position: 100 }]);
});

test('Legrand changes: gateway added, values checked, unknown ids refused', () => {
  const known = decodeLegrand(HOME, STATUS);
  assert.deepEqual(legrandModules([{ id: 'L1', on: false }, { id: 'B1', position: 30 }, { id: 'L2', brightness: 70 }], known), [
    { id: 'L1', bridge: 'G', on: false },
    { id: 'B1', bridge: 'G', target_position: 30 },
    { id: 'L2', bridge: 'G', brightness: 70 },
  ]);
  assert.throws(() => legrandModules([{ id: 'G', on: true }], known), /unknown module/);
  assert.throws(() => legrandModules([{ id: 'B1', on: true }], known), /blind/);
  assert.throws(() => legrandModules([{ id: 'L1', brightness: 120 }], known), /0–100/);
  assert.throws(() => legrandModules([], known), /1 to 30/);
});

test('thermostat commands: tenths of a degree, half-degree steps, limits', () => {
  assert.deepEqual(thermostatCommands({ targetC: 21.3 }), [{ code: 'temp_set', value: 215 }]);
  assert.deepEqual(thermostatCommands({ targetC: 22, mode: 'manual' }), [{ code: 'temp_set', value: 220 }, { code: 'mode', value: 'manual' }]);
  assert.throws(() => thermostatCommands({ targetC: 35 }), /between 10 and 28/);
  assert.throws(() => thermostatCommands({ mode: 'eco' }), /auto/);
  assert.throws(() => thermostatCommands({}), /Give targetC/);
});

test('a day, made small; dates checked', () => {
  const d = compactDay(
    { q00: { z: { t1: { t: 20 } } }, q01: { z: { t1: { t: 20.1 } } }, q04: { z: { t1: { t: 21 } } }, x_1: { who: 'person' } },
    { q00: { imp: 0.2, pv: 0 }, q01: { imp: 0.3 }, q05: { imp: 0.1 } },
    { t1: 'Sala' },
  );
  assert.deepEqual(d.energyByHour, { '00': { impKwh: 0.5, pvKwh: 0 }, '01': { impKwh: 0.1 } });
  assert.deepEqual(d.climateByHour['00'].z, { Sala: { t: 20 } });
  assert.deepEqual(Object.keys(d.climateByHour), ['00', '01']);
  assert.deepEqual(Object.keys(d.interventions), ['x_1']);
  assert.equal(dayId(undefined, NOW), '2026-11-28');
  assert.throws(() => dayId('28/11/2026'), /YYYY-MM-DD/);
});
