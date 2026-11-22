// Incident recorder, against simulated readings and the real
// logs in deploy/ — no house attached. Run: pnpm --filter domotics-bridge test.
const assert = require('node:assert/strict');
const { createRecorder } = require('../lib/incidents.js');
const { DEFAULT_LOGS, replay, readLog, lisbon } = require('../deploy/backfill-incidents.cjs');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 10, 0);
const pump = { id: 'hp', name: 'Bomba' };
const reading = (min, over = {}) => ({ t: T0 + min * MIN, on: true, hz: 50, sp: 35, out: 33, inn: 31, dis: 50, faults: [], ...over });
const E13 = { hz: 0, faults: ['E13'] };

function recorder(origin = 'bridge') {
  const docs = new Map();
  const writes = [];
  const rec = createRecorder((id, doc) => { docs.set(id, structuredClone(doc)); writes.push(id); }, { origin });
  return { rec, docs, writes };
}

// --- Recorder ---------------------------------------------------------------
{
  // A single trip that clears by itself, then the compressor restarts.
  const { rec, docs } = recorder();
  for (let m = 0; m < 40; m++) rec.observe(pump, reading(m));
  rec.observe(pump, reading(40, E13));
  rec.observe(pump, reading(41, E13));
  rec.observe(pump, reading(42, { hz: 0 }));
  rec.observe(pump, reading(44, { hz: 40 }));
  const [id, d] = [...docs].find(([, x]) => x.kind === 'fault');
  assert.match(id, /^fault-2026-10-22T10-40-00Z-E13$/);
  assert.equal(d.status, 'ended');
  assert.equal(d.endedHow, 'self');
  assert.equal(d.lockout, false);
  assert.equal(d.before.length, 30, '30 min of readings before the trip');
  assert.ok(d.before.every(s => s.t < d.at.getTime()));
  assert.equal(d.endedAt.getTime(), T0 + 42 * MIN);
  assert.equal(d.restartedAt.getTime(), T0 + 44 * MIN);

  // A second trip 15 min later is a lockout, ended by a reset.
  for (let m = 45; m < 57; m++) rec.observe(pump, reading(m));
  rec.observe(pump, reading(57, E13));
  for (let m = 58; m < 120; m += 5) rec.observe(pump, reading(m, E13));
  rec.gap(); // breaker off
  rec.observe(pump, reading(130, { hz: 0 }));
  const second = docs.get('fault-2026-10-22T10-57-00Z-E13');
  assert.equal(second.lockout, true);
  assert.equal(second.minutesSincePrevious, 17);
  assert.equal(second.previousId, id);
  assert.match(second.lockoutWhy, /segundo disparo/);
  assert.equal(second.endedHow, 'reset');
  assert.equal(second.offlineDuring, true);
  assert.ok(second.after.length <= 6, 'after = the first 5 min only');
}
{
  // A fault still on after 10 min is a lockout even without a second trip.
  const { rec, docs } = recorder();
  rec.observe(pump, reading(0));
  for (let m = 1; m <= 12; m++) rec.observe(pump, reading(m, E13));
  const d = [...docs.values()][0];
  assert.equal(d.status, 'active');
  assert.equal(d.lockout, true);
  assert.match(d.lockoutWhy, /10 min/);
}
{
  // Switches: ours are attributed to whoever sent them; anything else is "outside".
  const { rec, docs } = recorder();
  rec.observe(pump, reading(0));
  rec.noteCommand(false, 'automation', 'no setpoint', T0 + 0.5 * MIN);
  rec.observe(pump, reading(1, { on: false, hz: 0 }));
  rec.observe(pump, reading(2, { on: true }));
  const sw = [...docs.values()].filter(d => d.kind === 'switch');
  assert.deepEqual(sw.map(d => [d.on, d.source, d.reason]), [[false, 'automation', 'no setpoint'], [true, 'outside', null]]);
  assert.equal(sw[0].before.at(-1).on, false, 'ends with the reading that showed the change');

  // A command too old to explain the switch doesn't claim it.
  rec.noteCommand(false, 'app', null, T0 + 2 * MIN);
  rec.observe(pump, reading(10, { on: false, hz: 0 }));
  assert.equal(docs.get('switch-2026-10-22T10-10-00Z-off').source, 'outside');
}
{
  // observe() says who caused the switch it saw; the raw datapoints either side go on the record.
  const { rec, docs } = recorder();
  assert.equal(rec.observe(pump, reading(0), { 1: true, mode: 'Heating' }), undefined);
  assert.equal(rec.observe(pump, reading(1), { switch: true, mode: 'Heating', p02_heating: 44 }), undefined, 'no switch, nothing to say');
  assert.equal(rec.observe(pump, reading(2, { on: false }), { switch: false, mode: 'Heating', p02_heating: 44 }), 'outside');
  const d = docs.get('switch-2026-10-22T10-02-00Z-off');
  assert.deepEqual(d.dps, { before: { switch: true, mode: 'Heating', p02_heating: 44 }, at: { switch: false, mode: 'Heating', p02_heating: 44 } });
  // Without datapoints (the backfill), no dps field at all.
  const r2 = recorder('log');
  r2.rec.observe(pump, reading(0));
  r2.rec.observe(pump, reading(1, { on: false }));
  assert.equal('dps' in [...r2.docs.values()][0], false);
}
{
  // Switches during a fault are listed on it; from a log, an unexplained one is "unknown".
  const { rec, docs } = recorder('log');
  rec.observe(pump, reading(0));
  rec.observe(pump, reading(1, E13));
  rec.observe(pump, reading(2, { ...E13, on: false }));
  const f = docs.get('fault-2026-10-22T10-01-00Z-E13');
  assert.deepEqual(f.actions.map(a => [a.what, a.by]), [['off', 'unknown']]);
}
{
  // Survives a restart: the open incident carries on from the snapshot.
  const { rec, docs } = recorder();
  rec.observe(pump, reading(0));
  rec.observe(pump, reading(1, E13));
  const snap = structuredClone(rec.snapshot());
  const again = createRecorder((id, doc) => docs.set(id, structuredClone(doc)), { origin: 'bridge' }, snap);
  again.observe(pump, reading(3, { hz: 0 }));
  assert.equal(docs.get('fault-2026-10-22T10-01-00Z-E13').status, 'ended');
}

// --- Replaying the real logs (deploy/) -----------------------------------------
{
  assert.equal(lisbon('2026-10-22', '12:37:49'), Date.UTC(2026, 9, 22, 11, 37, 49), 'summer time: UTC+1');
  assert.equal(lisbon('2026-10-26', '12:00'), Date.UTC(2026, 9, 26, 12, 0), 'winter time: UTC');
  // 25/10 01:30 happens twice; after the first, the second is meant.
  assert.equal(lisbon('2026-10-25', '01:30', Date.UTC(2026, 9, 25, 0, 50)), Date.UTC(2026, 9, 25, 1, 30));

  const docs = [...replay(DEFAULT_LOGS, pump).values()];
  const faults = docs.filter(d => d.kind === 'fault' && d.origin === 'log');
  const at = d => new Date(d.at).toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit' });
  // The seven logged trips, as the technician report has them.
  assert.deepEqual(faults.map(at), ['11:45', '00:25', '12:37', '12:53', '20:30', '23:11', '23:25']);
  assert.deepEqual(faults.map(d => d.lockout), [false, false, false, true, false, false, true]);
  assert.deepEqual(faults.map(d => d.endedHow), [null, 'self', 'self', 'reset', 'self', 'self', 'reset']);
  const d = faults[3];
  assert.equal(at({ at: d.endedAt }), '19:11', '12:53 lockout reset at 19:11');
  assert.equal(at({ at: faults[6].endedAt }), '20:33', '23:25 lockout cleared by the breaker the next evening');
  const offs = docs.filter(x => x.kind === 'switch' && !x.on && x.source === 'outside').map(at);
  assert.deepEqual(offs, ['00:55', '00:54', '00:54', '12:27']);
}

console.log('all incident scenarios pass');
