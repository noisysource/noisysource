// Incident recorder and E13 guard, against simulated readings and the real
// logs in deploy/ — no house attached. Run: pnpm --filter domotics-bridge test.
const assert = require('node:assert/strict');
const { createRecorder } = require('../lib/incidents.js');
const { createGuard, INITIAL_GUARD } = require('../lib/guard.js');
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
  rec.noteCommand(false, 'guard', 'no setpoint', T0 + 0.5 * MIN);
  rec.observe(pump, reading(1, { on: false, hz: 0 }));
  rec.observe(pump, reading(2, { on: true }));
  const sw = [...docs.values()].filter(d => d.kind === 'switch');
  assert.deepEqual(sw.map(d => [d.on, d.source, d.reason]), [[false, 'guard', 'no setpoint'], [true, 'outside', null]]);
  assert.equal(sw[0].before.at(-1).on, false, 'ends with the reading that showed the change');

  // A command too old to explain the switch doesn't claim it.
  rec.noteCommand(false, 'app', null, T0 + 2 * MIN);
  rec.observe(pump, reading(10, { on: false, hz: 0 }));
  assert.equal(docs.get('switch-2026-10-22T10-10-00Z-off').source, 'outside');
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

// --- Guard -----------------------------------------------------------------------
const on = { enabled: true };
const off = { enabled: false };
const p = (over = {}) => ({ on: true, hz: 50, sp: 44, out: 40, faults: [], ...over });
{
  const g = createGuard();
  // Running below the setpoint: nothing.
  assert.equal(g.decide(on, { now: T0, pump: p() }).action, undefined);
  // At the setpoint, compressor at its minimum: off for 60 min.
  let d = g.decide(on, { now: T0 + MIN, pump: p({ hz: 44, out: 43 }) });
  assert.equal(d.action.on, false);
  assert.match(d.action.reason, /setpoint/);
  g.commit(d.action.next);
  assert.equal(g.state().mode, 'rest');
  // Resting, pump off: nothing until the hour is up, then on.
  assert.equal(g.decide(on, { now: T0 + 30 * MIN, pump: p({ on: false, hz: 0 }) }).action, undefined);
  d = g.decide(on, { now: T0 + 62 * MIN, pump: p({ on: false, hz: 0 }) });
  assert.equal(d.action.on, true);
  g.commit(d.action.next);
  // Just switched on: the grace period ignores the idle rule.
  assert.equal(g.decide(on, { now: T0 + 63 * MIN, pump: p({ hz: 40, out: 43.5 }) }).action, undefined);
  // A trip: off for 120 min straight away.
  d = g.decide(on, { now: T0 + 70 * MIN, pump: p({ hz: 0, faults: ['E13'] }) });
  assert.equal(d.action.on, false);
  assert.match(d.action.reason, /120 min/);
  g.commit(d.action.next);
  // Someone switches it on during the rest: theirs.
  assert.equal(g.decide(on, { now: T0 + 80 * MIN, pump: p() }).action, undefined);
  assert.equal(g.state().mode, 'watch');
  // ...and it's still faulted right after: a lockout, not another rest.
  assert.equal(g.decide(on, { now: T0 + 81 * MIN, pump: p({ hz: 0, faults: ['E13'] }) }).action, undefined);
  assert.equal(g.state().mode, 'lockout');
  // Reset: back to watching.
  g.decide(on, { now: T0 + 200 * MIN, pump: p({ hz: 0 }) });
  assert.equal(g.state().mode, 'watch');
}
{
  // A pump switched off by a person is left off.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  assert.equal(g.decide(on, { now: T0, pump: p({ on: false, hz: 0, out: 44 }) }).action, undefined);
  // No fresh reading: nothing at all.
  assert.equal(g.decide(on, { now: T0 }).action, undefined);
  // Switched back on by that person: the same grace as after our own switch-on...
  assert.equal(g.decide(on, { now: T0 + MIN, pump: p({ hz: 40, out: 44 }) }).action, undefined);
  // ...then the idle rule, and a failed command is decided again next time (nothing committed).
  assert.equal(g.decide(on, { now: T0 + 6 * MIN, pump: p({ hz: 40, out: 44 }) }).action.on, false);
  assert.equal(g.decide(on, { now: T0 + 7 * MIN, pump: p({ hz: 40, out: 44 }) }).action.on, false);
}
{
  // Switched off in the app while resting: the pump goes back on, once.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'rest', restUntil: T0 + 60 * MIN });
  const d = g.decide(off, { now: T0, pump: p({ on: false, hz: 0 }) });
  assert.equal(d.action.on, true);
  assert.match(d.action.reason, /desligada na app/);
  g.commit(d.action.next);
  assert.equal(g.decide(off, { now: T0 + MIN, pump: p() }).action, undefined);
  assert.equal(g.decide(off, { now: T0 + MIN, pump: p() }).status.mode, 'off');
}
{
  // The heating automation (live) holds a rest past its end while no zone
  // wants heat; it ends as soon as one does, with that reason.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'rest', restUntil: T0 + 60 * MIN, lastAction: { at: T0, what: 'off', reason: 'x' } });
  let d = g.decide(on, { now: T0 + 61 * MIN, pump: p({ on: false, hz: 0 }), holdRest: true });
  assert.equal(d.action, undefined);
  assert.equal(d.status.mode, 'rest');
  assert.match(d.status.note, /nenhuma zona pede calor/);
  d = g.decide(on, { now: T0 + 95 * MIN, pump: p({ on: false, hz: 0 }), holdRest: true });
  assert.equal(d.action, undefined, 'still nothing wants heat');
  d = g.decide(on, { now: T0 + 100 * MIN, pump: p({ on: false, hz: 0 }), holdRest: false });
  assert.equal(d.action.on, true);
  assert.match(d.action.reason, /voltou a pedir calor/);
  // A hold never shortens a rest, and never applies to anything but a rest.
  const g2 = createGuard({ ...INITIAL_GUARD, mode: 'rest', restUntil: T0 + 60 * MIN });
  assert.equal(g2.decide(on, { now: T0 + 30 * MIN, pump: p({ on: false, hz: 0 }), holdRest: false }).action, undefined);
  const g3 = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  g3.decide(on, { now: T0, pump: p() });
  assert.equal(g3.decide(on, { now: T0 + 10 * MIN, pump: p({ hz: 44, out: 43 }), holdRest: true }).action.on, false, 'the idle rule still fires');
}
{
  // On the real logs, the guard would have switched the pump off before every
  // logged trip (the hand-run script's own replay said 4–25 min before).
  const leads = [];
  for (const spec of DEFAULT_LOGS) {
    const { samples } = readLog(spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1));
    let clearAt = 0;
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      if (s.faults.length && !samples[i - 1].faults.length) {
        // Fresh guard from 30 min before (or since the last fault cleared).
        const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
        const from = Math.max(s.t - 30 * MIN, clearAt);
        const fired = samples.filter(x => x.t >= from && x.t < s.t)
          .find(x => g.decide(on, { now: x.t, pump: x }).action?.on === false);
        leads.push(fired ? Math.round((s.t - fired.t) / MIN) : null);
      }
      if (!s.faults.length && samples[i - 1].faults.length) clearAt = s.t;
    }
  }
  assert.equal(leads.length, 7);
  assert.ok(leads.every(m => m !== null && m >= 1), `fires before every trip (minutes ahead: ${leads})`);
  console.log(`  guard on the logs: fires ${leads.join(', ')} min before each trip`);
}

console.log('all incident and guard scenarios pass');
