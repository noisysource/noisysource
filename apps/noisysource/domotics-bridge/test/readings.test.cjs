// The pump answering with only some of its datapoints, as its Tuya module has
// since 19/11/2026: on/off, compressor Hz and the temperatures (dps 1, 16, 18,
// 20–25), with no mode, no setpoints and no fault bitmaps. From the raw dps to
// what the automation and the recorder do with them — no house
// attached. Run: pnpm --filter domotics-bridge test (builds first).
const assert = require('node:assert/strict');
const { dpsToStatus } = require('../lib/dpmap.js');
const { readHeating, readPumpSample } = require('../lib/readings.js');
const { createAutomation, parseConfig } = require('../lib/automation.js');
const { createRecorder } = require('../lib/incidents.js');

const MIN = 60_000;
/** What a full `get({schema: true})` brought on 20/11 (39 Hz, water 35 → 37.5 °C). */
const PARTIAL = { 1: true, 16: 39, 18: 65, 20: 720, 21: 95, 22: 40, 23: 350, 24: 375, 25: 180 };
/** The same pump reporting everything, as before. */
const FULL = { ...PARTIAL, 2: 'Heating', 15: 0, 109: 0, 117: 44, 118: 25, 119: 45, 120: 0, 121: 0, 122: 0, 123: 0 };
const pumpDevice = (dps, online = true) => ({ id: 'hp', name: 'Bomba de calor', category: 'znrb', online, status: dpsToStatus('znrb', dps) });
const zoneDevice = (i, { open = true, current = 240, target = 240 } = {}) => ({
  id: `z${i}`, name: `z${i}`, category: 'wk', online: true,
  status: dpsToStatus('wk', { 2: 'manual', 16: target, 24: current, 36: open ? 'open' : 'close' }),
});
const house = (dps, zone = {}) => [zoneDevice(1, zone), zoneDevice(2, zone), pumpDevice(dps)];
/** Instants in UTC; Lisbon is UTC+0 in November, so these are also the house's clock. */
const at = (h, m, d = 20) => new Date(Date.UTC(2026, 10, d, h, m));

const sent = [];
const send = async (id, cmds) => { sent.push(`${id}:${cmds.map(c => `${c.code}=${c.value}`).join(',')}`); };
const reset = () => { sent.length = 0; };
/** Warm 17:00–23:00 and 06:00–08:00, as on the Pi on 20/11; live. */
const cfg = parseConfig({ enabled: true, dryRun: false, comfort: 24, windows: [{ from: '17:00', to: '23:00' }, { from: '06:00', to: '08:00' }] });
const blind = s => s.reasons.filter(r => /não está a reportar/.test(r));

(async () => {
  // --- Reading ---------------------------------------------------------------
  {
    // Found by its category, with what it does report; what it doesn't stays unknown.
    const { zones, pump } = readHeating(house(PARTIAL));
    assert.equal(zones.length, 2);
    assert.ok(pump, 'the pump is found without p02_heating');
    assert.deepEqual(pump, {
      id: 'hp', online: true, on: true, fault: false, faultsUnknown: true,
      outdoor: 9.5, flowSetpoint: undefined, hz: 39, waterOut: 37.5, waterIn: 35,
    });
    // Reporting everything: nothing unknown.
    const full = readHeating(house(FULL)).pump;
    assert.equal(full.faultsUnknown, false);
    assert.equal(full.flowSetpoint, 44);
    assert.equal(full.fault, false);
    // A fault it does report is still a fault, whatever else is missing.
    const e13 = readHeating(house({ ...PARTIAL, 15: 4096 })).pump;
    assert.equal(e13.fault, true);
    assert.equal(e13.faultsUnknown, true, 'the other bitmaps are still missing');
    // One bitmap missing is enough: a fault there wouldn't show.
    const { 109: _dp109, ...no109 } = FULL;
    assert.equal(readHeating(house(no109)).pump.faultsUnknown, true);
    // Never reached (no status at all): that is "sem ligação", not missing datapoints.
    const never = readHeating([{ id: 'hp', name: 'Bomba', category: 'znrb', online: false, status: [] }]).pump;
    assert.equal(never.online, false);
    assert.equal(never.faultsUnknown, false);
    // A thermostat is never taken for the pump, nor the pump for a thermostat.
    assert.equal(readHeating([zoneDevice(1)]).pump, undefined);

    // The recorder's sample.
    const { sample, dps } = readPumpSample(pumpDevice(PARTIAL), house(PARTIAL, { open: false }), 1000);
    assert.equal(sample.faultsUnknown, true);
    assert.deepEqual(sample.faults, []);
    assert.equal(sample.sp, undefined);
    assert.deepEqual([sample.on, sample.hz, sample.out, sample.inn, sample.dis, sample.outdoor, sample.coil, sample.suct], [true, 39, 37.5, 35, 72, 9.5, 6.5, 4]);
    assert.deepEqual([sample.valves, sample.zones], [0, 2]);
    assert.deepEqual(Object.keys(dps).sort(), ['coiler_temp', 'compressor_strength', 'effluent_temp', 'power_consumption', 'switch', 'temp_bottom', 'temp_current', 'temp_top', 'venting_temp']);
    assert.ok(!('faultsUnknown' in readPumpSample(pumpDevice(FULL), house(FULL), 1000).sample), 'absent when everything is reported');
  }

  // --- Automation ------------------------------------------------------------
  {
    // Outside the warm window (23:30, day rules, no sun): the pump, found on, is switched off.
    const tick = createAutomation(send);
    const { zones, pump } = readHeating(house(PARTIAL));
    let s = await tick(cfg, { now: at(23, 30), zones, pump });
    assert.equal(s.pumpHold, undefined, 'not "bomba não encontrada"');
    assert.equal(s.wantOn, false);
    // Seen on from now: the minimum on time first.
    s = await tick(cfg, { now: at(23, 30 + cfg.pumpFollowsZones.minOnMin + 1), zones, pump });
    assert.deepEqual(sent, ['hp:switch=false'], 'switched off, and nothing else sent to the pump');
    assert.equal(s.pumpHold, undefined);
    // One plain line, in the reasons and on its own.
    assert.equal(blind(s).length, 1);
    assert.match(blind(s)[0], /não está a reportar avarias nem a temperatura da água pedida/);
    assert.match(blind(s)[0], /bloqueio \(E13\) não se vê/);
    assert.match(blind(s)[0], /Liga e desliga pelo plano/);
    assert.equal(s.pumpBlind, blind(s)[0]);
    assert.ok(!s.reasons.some(r => /avaria — a automação não lhe mexe/.test(r)), 'no fault is made up');
    reset();
  }
  {
    // In the warm window with a zone asking for heat: the pump, found off, is switched on.
    const tick = createAutomation(send);
    const off = { ...PARTIAL, 1: false, 16: 0 };
    const { zones, pump } = readHeating(house(off, { current: 225 }));
    assert.equal(pump.on, false);
    let s = await tick(cfg, { now: at(18, 0), zones, pump });
    assert.equal(s.wantOn, true);
    s = await tick(cfg, { now: at(18, cfg.pumpFollowsZones.minOffMin + 1), zones, pump });
    assert.deepEqual(sent, ['hp:switch=true']);
    assert.equal(s.pumpHold, undefined);
    assert.equal(blind(s).length, 1);
    // Rooms 1.5° short would mean "water at the top of the range": not sent
    // blind, with no setpoint to compare against, and not shown as a target.
    assert.equal(s.recovery, true);
    assert.ok(!sent.some(x => /p02_heating/.test(x)));
    assert.equal(s.flowTarget, undefined);
    // …for as long as it lasts (the water was otherwise due every 15 min).
    for (const m of [30, 50, 70, 90]) s = await tick(cfg, { now: at(18, m), zones, pump: { ...pump, on: true, hz: 60 } });
    assert.deepEqual(sent, ['hp:switch=true'], 'still only the switch-on');
    reset();
  }
  {
    // Running in the warm window with zones open: left on, and the line is there.
    const tick = createAutomation(send);
    const { zones, pump } = readHeating(house(PARTIAL));
    const s = await tick(cfg, { now: at(19, 0), zones, pump });
    assert.deepEqual(sent, []);
    assert.match(s.doing, /^Bomba ligada — horário quente/);
    assert.equal(blind(s).length, 1);
  }
  {
    // Reporting everything: no such line, and the water is managed as ever.
    const tick = createAutomation(send, { flow: { value: 44, at: 0 } });
    const { zones, pump } = readHeating(house(FULL));
    const s = await tick(cfg, { now: at(19, 0), zones, pump });
    assert.equal(blind(s).length, 0);
    assert.equal(s.pumpBlind, undefined);
    assert.ok(s.flowTarget !== undefined);
    assert.ok(sent.every(x => /^hp:p02_heating=/.test(x)), 'only the water setpoint, if anything');
    reset();
  }
  {
    // Only the faults missing (setpoint reported): the line says just that, and the water is still managed.
    const { 15: _f, 109: _a, 120: _b, 121: _c, 122: _d, 123: _e, ...noFaults } = FULL;
    const { zones, pump } = readHeating(house(noFaults));
    const s = await createAutomation(send, { flow: { value: 44, at: 0 } })(cfg, { now: at(19, 0), zones, pump });
    assert.equal(blind(s).length, 1);
    assert.match(blind(s)[0], /não está a reportar avarias —/);
    assert.ok(!/temperatura da água/.test(blind(s)[0]));
    assert.ok(s.flowTarget !== undefined);
    reset();
  }
  {
    // A fault it does report still holds the pump; unreachable is still "sem ligação", without the line.
    let { zones, pump } = readHeating(house({ ...PARTIAL, 15: 4096 }));
    let s = await createAutomation(send)(cfg, { now: at(23, 30), zones, pump });
    assert.match(s.pumpHold, /avaria/);
    ({ zones, pump } = readHeating([zoneDevice(1), zoneDevice(2), pumpDevice(PARTIAL, false)]));
    s = await createAutomation(send)(cfg, { now: at(23, 30), zones, pump });
    assert.match(s.pumpHold, /sem ligação/);
    assert.equal(blind(s).length, 0);
    assert.deepEqual(sent, []);
  }

  // --- Incident recorder -------------------------------------------------------
  {
    const T0 = Date.UTC(2026, 10, 19, 8, 0);
    const docs = new Map();
    const rec = createRecorder((id, doc) => { docs.set(id, structuredClone(doc)); }, { origin: 'bridge' });
    const dev = { id: 'hp', name: 'Bomba' };
    const reading = (min, over = {}) => ({ t: T0 + min * MIN, on: true, hz: 50, sp: 44, out: 40, faults: [], ...over });
    for (let m = 0; m < 5; m++) rec.observe(dev, reading(m));
    rec.observe(dev, reading(5, { hz: 0, faults: ['E13'] }));
    // The module restarts and stops reporting its bitmaps: not "cleared by itself".
    rec.observe(dev, reading(6, { hz: 0, sp: undefined, faultsUnknown: true }));
    const d = [...docs.values()].find(x => x.kind === 'fault');
    assert.equal(d.status, 'unknown');
    assert.equal(d.endedHow, 'unknown');
    assert.equal(d.endedAt, null);
    assert.match(d.note, /deixou de reportar avarias/);
    assert.equal(rec.snapshot().open, null);
    // Nothing is opened, and nothing made up, while the bitmaps stay missing.
    const before = docs.size;
    for (let m = 7; m < 20; m++) rec.observe(dev, reading(m, { sp: undefined, faultsUnknown: true }));
    assert.equal(docs.size, before);
    // On/off is still recorded.
    rec.observe(dev, reading(20, { on: false, hz: 0, sp: undefined, faultsUnknown: true }));
    assert.equal([...docs.values()].filter(x => x.kind === 'switch').length, 1);
  }

  console.log('readings.test.cjs: ok');
})().catch(err => { console.error(err); process.exit(1); });
