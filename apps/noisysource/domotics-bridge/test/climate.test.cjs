// The climate history (climate.ts): 15-min slots of room and pump temperatures,
// and people's interventions with the rooms at that moment. No house attached.
const assert = require('node:assert/strict');
const { createClimateRecorder, isControllerTimer } = require('../lib/climate.js');

const MIN = 60_000;
/** November: Lisbon is on UTC. */
const L = (h, m = 0, s = 0, d = 10) => Date.UTC(2026, 10, d, h, m, s);
const zone = (id, current, target, valveOpen = false, online = true) => ({ id, name: `Sala ${id}`, online, current, target, valveOpen });
const pump = (on, hz = 0, extra = {}) => ({ online: true, on, fault: false, hz, waterOut: 40, waterIn: 36, flowSetpoint: 44, outdoor: 12, ...extra });

// --- Slots ------------------------------------------------------------------
{
  const rec = createClimateRecorder();
  // 10:00–10:15: 30 readings; the pump runs for the second half.
  for (let i = 0; i < 30; i++) {
    const t = L(10, 0, 30 * i);
    rec.observe({
      t, soc: 41.6, plan: 'day (sim)', wantOn: false, guard: 'off',
      zones: [zone('a', 22 + i * 0.01, 23, i >= 15), zone('b', 21, 23, false, i % 2 === 0)],
      pump: pump(i >= 15, i >= 15 ? 50 + i : 0, { waterOut: 30 + i }),
    });
  }
  assert.equal(rec.pendingCount(), 0, 'the slot is still open');
  rec.observe({ t: L(10, 15), zones: [], pump: pump(false) });
  const [doc] = rec.pendingWrites();
  assert.equal(doc.id, '2026-11-10');
  const q = doc.fields.q40;
  assert.equal(q.n, 30);
  assert.equal(q.pn, 30);
  assert.equal(q.on, 0.5);
  assert.equal(q.run, 0.5);
  assert.equal(q.hzMax, 79);
  assert.equal(q.hz, 72, 'mean Hz while running (65…79)');
  assert.equal(q.out, 59);
  assert.equal(q.outMax, 59);
  assert.equal(q.sp, 44);
  assert.equal(q.ext, 12);
  assert.equal(q.soc, 42);
  assert.equal(q.plan, 'day (sim)');
  assert.equal(q.want, false);
  assert.equal(q.guard, 'off');
  assert.equal(q.fault, undefined);
  assert.deepEqual(q.z.a, { t: 22.29, lo: 22, hi: 22.29, s: 23, v: 0.5 });
  assert.equal(q.z.b.v, 0, 'offline readings are left out');
  assert.equal(doc.fields.zones.a, 'Sala a');
  assert.equal(doc.fields.slots, 96);
  // Written: only those fields go.
  rec.written(doc.id, doc.fields);
  assert.equal(rec.pendingCount(), 0);
}

// --- The controller's timer ---------------------------------------------------
assert.equal(isControllerTimer(Date.UTC(2026, 9, 27, 23, 54, 32)), true);
assert.equal(isControllerTimer(Date.UTC(2026, 9, 27, 23, 50, 0)), false);
assert.equal(isControllerTimer(Date.UTC(2026, 9, 28, 0, 9, 0)), false);

// --- Interventions --------------------------------------------------------------
{
  const rec = createClimateRecorder();
  const zones = (ta = 23, tb = 23) => [zone('a', 21.4, ta), zone('b', 21.8, tb)];
  rec.observe({ t: L(14, 0), zones: zones(), pump: pump(false), plan: 'day' });
  // Switched on at the panel: the house felt cold.
  let ev = rec.observe({ t: L(14, 0, 30), zones: zones(), pump: pump(true), plan: 'day', switchedBy: 'outside' });
  assert.equal(ev.length, 1);
  assert.deepEqual({ kind: ev[0].kind, by: ev[0].by, meaning: ev[0].meaning, on: ev[0].on, mean: ev[0].mean, time: ev[0].time },
    { kind: 'pump', by: 'outside', meaning: 'cold', on: true, mean: 21.6, time: '14:00:30' });
  assert.deepEqual(ev[0].rooms, { a: 21.4, b: 21.8 });
  // Off from the app: warm enough.
  ev = rec.observe({ t: L(20, 0), zones: zones(), pump: pump(false), switchedBy: 'app' });
  assert.equal(ev[0].meaning, 'warm-enough');
  assert.equal(ev[0].by, 'app');
  // The automation's or the guard's own switches are not interventions.
  assert.equal(rec.observe({ t: L(20, 30), zones: zones(), pump: pump(true), switchedBy: 'automation' }).length, 0);
  assert.equal(rec.observe({ t: L(21, 0), zones: zones(), pump: pump(false), switchedBy: 'guard' }).length, 0);
  // 23:54 UTC off from outside: the controller's timer.
  ev = rec.observe({ t: L(23, 54, 32), zones: zones(), pump: pump(false), switchedBy: 'outside' });
  assert.equal(ev[0].by, 'timer');
  assert.equal(ev[0].meaning, 'none');

  // Switched on by hand after the timer's off: cold, with what came before it.
  ev = rec.observe({ t: L(23, 58, 40), zones: zones(), pump: pump(true), switchedBy: 'outside' });
  assert.deepEqual({ meaning: ev[0].meaning, offBy: ev[0].offBy, offMin: ev[0].offMin }, { meaning: 'cold', offBy: 'timer', offMin: 4 });
  rec.observe({ t: L(23, 58, 50), zones: zones(), pump: pump(false), switchedBy: 'automation' });
  ev = rec.observe({ t: L(23, 58, 55), zones: zones(), pump: pump(true), switchedBy: 'app' });
  assert.deepEqual({ meaning: ev[0].meaning, offBy: ev[0].offBy, offMin: ev[0].offMin }, { meaning: 'cold', offBy: 'automation', offMin: 0 });
  rec.observe({ t: L(23, 59, 0), zones: zones(), pump: pump(false), switchedBy: 'app' });
  assert.equal(rec.observe({ t: L(23, 59, 5), zones: zones(), pump: pump(true), switchedBy: 'outside' })[0].offBy, 'app');

  // Targets: the automation's own change is not an intervention…
  rec.noteTarget('a', 24, 'automation', L(23, 58));
  assert.equal(rec.observe({ t: L(23, 59), zones: zones(24, 23), pump: pump(false) }).length, 0);
  // …one from the app is, and so is one at the thermostat (no command).
  rec.noteTarget('b', 24.5, 'app', L(23, 59, 30));
  ev = rec.observe({ t: L(23, 59, 40), zones: zones(24, 24.5), pump: pump(false) });
  assert.equal(ev.length, 1);
  assert.deepEqual({ by: ev[0].by, meaning: ev[0].meaning, zone: ev[0].zone, from: ev[0].from, to: ev[0].to }, { by: 'app', meaning: 'warmer', zone: 'b', from: 23, to: 24.5 });
  ev = rec.observe({ t: L(23, 59, 50), zones: zones(22, 24.5), pump: pump(false) });
  assert.deepEqual({ by: ev[0].by, meaning: ev[0].meaning, zone: ev[0].zone }, { by: 'outside', meaning: 'cooler', zone: 'a' });
  // A command older than 15 min doesn't claim a change.
  rec.noteTarget('a', 23, 'automation', L(23, 0));
  ev = rec.observe({ t: L(23, 59, 55), zones: zones(23, 24.5), pump: pump(false) });
  assert.equal(ev[0].by, 'outside');

  // Each event is its own field, plain-identifier named (the REST update mask).
  const fields = rec.pendingWrites().find(d => d.id === '2026-11-10').fields;
  const xs = Object.keys(fields).filter(k => k.startsWith('x_')).sort();
  assert.deepEqual(xs, ['x_140030_pump', 'x_200000_pump', 'x_235432_pump', 'x_235840_pump', 'x_235855_pump', 'x_235900_pump', 'x_235905_pump', 'x_235940_b', 'x_235950_a', 'x_235955_a']);
  for (const k of Object.keys(fields)) assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*$/);
  // The snapshot round-trips through JSON (the state file).
  const again = createClimateRecorder(JSON.parse(JSON.stringify(rec.snapshot())));
  assert.equal(again.pendingCount(), rec.pendingCount());
}

console.log('climate: ok');
