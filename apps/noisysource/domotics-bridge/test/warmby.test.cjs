// Warm-by planning and the warm-up learner, against simulated readings and the
// real 20-s log in deploy/ — no house attached. Run: pnpm --filter domotics-bridge test.
const assert = require('node:assert/strict');
const { createWarmupLearner, planWarmBy, leadMinutes, parseWarmBy, parseModel, DEFAULT_MODEL } = require('../lib/warmby.js');
const { DEFAULT_LOGS, readLog } = require('../deploy/backfill-incidents.cjs');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 26, 20, 0);

// --- Request and model parsing -------------------------------------------------
assert.equal(parseWarmBy(null), null);
assert.equal(parseWarmBy({ at: 'tomorrow' }), null);
assert.deepEqual(parseWarmBy({ at: new Date(T0), target: 24.5, source: 'chat' }), { at: T0, target: 24.5, setAt: null, source: 'chat' });
assert.deepEqual(parseWarmBy({ at: T0, target: null }), { at: T0, target: null, setAt: null, source: null }, 'the disk cache holds numbers');
assert.deepEqual(parseModel({ floorMin: 1000, roomRatePerH: -1 }), { ...DEFAULT_MODEL, floorMin: 180, roomRatePerH: 0.1 });

// --- Lead time ----------------------------------------------------------------
assert.equal(leadMinutes(0, 90, DEFAULT_MODEL), 0, 'already warm: nothing to do');
assert.equal(leadMinutes(1, 90, DEFAULT_MODEL), 90 + 200 + 30);
assert.equal(leadMinutes(1, 0, DEFAULT_MODEL), 230, 'floor already warm');
assert.equal(leadMinutes(10, 90, DEFAULT_MODEL), 18 * 60, 'capped');

// --- Plan ---------------------------------------------------------------------
{
  const request = { at: T0 + 10 * 60 * MIN, target: 24, setAt: null, source: 'app' };
  const base = { request, target: 24, floorWarmInMin: 90, model: DEFAULT_MODEL, started: false, outcome: null };
  let s = planWarmBy({ ...base, now: T0, current: 23 });
  assert.equal(s.phase, 'waiting');
  assert.equal(s.startAt, request.at - 320 * MIN);
  assert.equal(s.late, false);
  // Started, then the sun warms the rooms a little: it doesn't go back to waiting.
  s = planWarmBy({ ...base, now: request.at - 300 * MIN, current: 23.4, started: true });
  assert.equal(s.phase, 'heating');
  // Without room readings: plan for 1° by precaution.
  s = planWarmBy({ ...base, now: T0 });
  assert.equal(s.leadMin, 320);
  assert.match(s.note, /Sem leituras/);
}

// --- Learning the floor and the rooms --------------------------------------------
{
  const L = createWarmupLearner();
  const zs = (c) => [{ id: 'a', current: c, target: 24 }, { id: 'b', current: c, target: 24 }];
  // Off for an hour, then a start: the return water climbs 2°/10 min for an hour, then levels off.
  let t = T0;
  for (; t < T0 + 60 * MIN; t += MIN) L.observe({ t, running: false, waterIn: 20, zones: zs(22), available: true });
  assert.equal(L.floorWarmIn(t), 90, 'cold');
  const start = t;
  for (; t < start + 120 * MIN; t += MIN) {
    const el = (t - start) / MIN;
    // Rooms at target meanwhile, so no room measurement starts yet.
    L.observe({ t, running: true, waterIn: 20 + Math.min(12, el / 5), zones: zs(24), available: true });
  }
  const m = L.model();
  assert.equal(m.floorSamples, 1);
  // Levelled at ~60 min, seen once the half hour after it shows no rise (~92 min): 90 → ~90.
  assert.ok(m.floorMin >= 85 && m.floorMin <= 95, `floor ${m.floorMin}`);
  // Floor warm now; the rooms, 2° short, rise 0.8° in two hours: 0.4 °C/h → model 0.3 → 0.33.
  const w0 = t;
  for (; t <= w0 + 120 * MIN; t += MIN) {
    L.observe({ t, running: true, waterIn: 32, zones: zs(22 + 0.8 * (t - w0) / (120 * MIN)), available: true });
  }
  assert.equal(L.model().roomSamples, 1);
  assert.equal(L.model().roomRatePerH, 0.33);
  // Switched off by hand meanwhile: that stretch says nothing about the house warming.
  const before = L.model().roomSamples;
  for (let k = 0; k < 130; k++, t += MIN) L.observe({ t, running: false, zones: zs(22.8), available: false });
  assert.equal(L.model().roomSamples, before);
}

// --- On the real log: what the floor detector learns from 22–24/10 ----------------
{
  const L = createWarmupLearner();
  const samples = DEFAULT_LOGS.flatMap(spec => {
    const [path, date] = spec.split('@');
    return readLog(path, date).samples;
  }).sort((a, b) => a.t - b.t);
  const learned = [];
  for (const s of samples) {
    const n = L.model().floorSamples;
    L.observe({ t: s.t, running: s.on && s.hz > 0 && s.faults.length === 0, waterIn: s.inn, zones: [], available: true });
    if (L.model().floorSamples > n) learned.push(L.model().floorMin);
  }
  // Six starts after a long stop that levelled off: after 36–63 min with the
  // water at 34–35 °C (21/10 22:13, 22/10 08:00, 22/10 19:12), 73–121 min at the
  // technicians' 44 °C (23/10 20:33, 24/10 04:21, 24/10 17:57). The model ends
  // near the 90-min default.
  assert.equal(learned.length, 6, `learned ${learned}`);
  assert.ok(L.model().floorMin >= 80 && L.model().floorMin <= 110, `floor ${L.model().floorMin}`);
  console.log(`  floor on the logs: ${learned.join(' → ')} min`);
}

console.log('all warm-by scenarios pass');
