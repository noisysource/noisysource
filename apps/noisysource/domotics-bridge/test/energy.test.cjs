// Energy recorder (src/energy.ts) and its store (src/energy-store.ts), against
// simulated inverter readings — no house attached. Run: pnpm --filter domotics-bridge test.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  createEnergyRecorder, flowsOf, lisbonDate, lisbonOffsetMs, dayStart, slotsInDay, slotOf, slotField, SLOT_MS,
} = require('../lib/energy.js');
const { createEnergyStore, MAX_WRITES_PER_DAY } = require('../lib/energy-store.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// --- Lisbon calendar ------------------------------------------------------------
{
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2029, 0, 1); t += HOUR) {
    assert.equal(lisbonDate(t), fmt.format(t), `date at ${new Date(t).toISOString()}`);
  }
  assert.equal(lisbonOffsetMs(Date.UTC(2026, 6, 1)), HOUR);
  assert.equal(lisbonOffsetMs(Date.UTC(2026, 11, 1)), 0);
  // 25/10/2026: 25 hours, 100 slots; 28/03/2027: 23 hours, 92.
  assert.equal(slotsInDay('2026-10-25'), 100);
  assert.equal(slotsInDay('2026-10-24'), 96);
  assert.equal(slotsInDay('2027-03-28'), 92);
  assert.equal(new Date(dayStart('2026-10-25')).toISOString(), '2026-10-24T23:00:00.000Z');
  // 01:30 happens twice on 25/10: summer time (00:30Z) is q06, winter time (01:30Z) is q10.
  assert.deepEqual([slotOf(Date.UTC(2026, 9, 25, 0, 30)).index, slotOf(Date.UTC(2026, 9, 25, 1, 30)).index], [6, 10]);
  assert.equal(slotOf(Date.UTC(2026, 9, 25, 23, 59)).index, 99);
  assert.deepEqual(slotOf(Date.UTC(2026, 9, 26, 0, 0)), { date: '2026-10-26', index: 0, start: Date.UTC(2026, 9, 26) });
  assert.equal(slotField(7), 'q07');
}

// --- Flows -----------------------------------------------------------------------
{
  const cases = [
    { pvW: 3000, batteryW: 1500, gridW: 500 },    // sunny: house, battery and export
    { pvW: 150, batteryW: -3000, gridW: -1500 },  // evening: battery and grid (seen 25/10 17:47)
    { pvW: 0, batteryW: 2000, gridW: -2500 },     // charging from the grid at night
    { pvW: 800, batteryW: -200, gridW: 0 },
    { pvW: 0, batteryW: 0, gridW: 20 },           // noise: load would be −20
  ];
  for (const c of cases) {
    const f = flowsOf({ t: 0, ...c });
    // The balance holds by construction (load is derived), except where noise is clamped.
    if (c.pvW - c.batteryW - c.gridW >= 0) near(f.pv + f.dis + f.imp, f.load + f.chg + f.exp, 1e-9, 'balance');
    assert.ok(f.pvLoad + f.batLoad <= f.load + 1e-9, 'sources never exceed the load');
    assert.ok(f.gridBat <= f.chg && f.gridBat <= f.imp, 'grid → battery bounded');
  }
  const sunny = flowsOf({ t: 0, pvW: 3000, batteryW: 1500, gridW: 500 });
  assert.deepEqual(sunny, { pv: 3000, load: 1000, imp: 0, exp: 500, chg: 1500, dis: 0, pvLoad: 1000, batLoad: 0, gridBat: 0 });
  const evening = flowsOf({ t: 0, pvW: 150, batteryW: -3000, gridW: -1500 });
  assert.equal(evening.load, 4650);
  assert.equal(evening.pvLoad, 150);
  assert.equal(evening.batLoad, 3000);
  const night = flowsOf({ t: 0, pvW: 0, batteryW: 2000, gridW: -2500 });
  assert.equal(night.gridBat, 2000);
  assert.equal(night.load, 500);
}

// --- Recorder ----------------------------------------------------------------------
const T0 = Date.UTC(2026, 10, 10, 10, 0); // 10/11 10:00 Lisbon (winter), slot q40
const evening = (t, over = {}) => ({ t, pvW: 0, batteryW: -1000, gridW: -500, soc: 60, ...over });

{
  // An hour of steady readings every 30 s: 1.5 kW house = 375 Wh a slot.
  const rec = createEnergyRecorder();
  for (let t = T0; t <= T0 + HOUR; t += 30_000) rec.observe(evening(t), t + 5);
  const writes = rec.pendingWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, '2026-11-10');
  const f = writes[0].fields;
  assert.deepEqual(Object.keys(f).filter(k => k.startsWith('q')).sort(), ['q40', 'q41', 'q42', 'q43']);
  assert.deepEqual(f.q41, { pv: 0, load: 375, imp: 125, exp: 0, chg: 0, dis: 250, pvLoad: 0, batLoad: 250, gridBat: 0, sec: 900, soc: 60 });
  assert.equal(f.slots, 96);
  assert.equal(f.date, '2026-11-10');
  assert.equal(f.start.toISOString(), '2026-11-10T00:00:00.000Z');
  // The slot in progress (q44) isn't written until it ends.
  assert.equal(rec.snapshot().open.index, 44);
  // A write that lands clears exactly what it carried.
  rec.written(writes[0].id, writes[0].fields);
  assert.equal(rec.pendingCount(), 0);
}
{
  // The inverter's own AC figures are integrated alongside, when both readings have them.
  const rec = createEnergyRecorder();
  for (let t = T0; t <= T0 + 16 * MIN; t += 30_000) rec.observe(evening(t, { acLoadW: 1360, invOutW: 1350 }), t);
  const q40 = rec.pendingWrites()[0].fields.q40;
  assert.equal(q40.acLoad, 340);
  assert.equal(q40.invOut, 338);
  assert.equal(q40.load, 375, 'the derived load is unchanged');
  const plain = createEnergyRecorder();
  for (let t = T0; t <= T0 + 16 * MIN; t += 30_000) plain.observe(evening(t), t);
  assert.equal('acLoad' in plain.pendingWrites()[0].fields.q40, false);
}
{
  // A 10-minute silence is a gap: not integrated across, and the slot says so.
  const rec = createEnergyRecorder();
  for (let t = T0; t <= T0 + 2 * MIN; t += 30_000) rec.observe(evening(t), t);
  for (let t = T0 + 12 * MIN; t <= T0 + 16 * MIN; t += 30_000) rec.observe(evening(t), t);
  const q40 = rec.pendingWrites()[0].fields.q40;
  assert.equal(q40.sec, 5 * 60, '2 min before + 3 min after the gap');
  near(q40.load, 1500 * 5 / 60, 1, 'only the covered minutes');
}
{
  // An inverter that stops answering still lets the slot close (and be written) on time.
  const rec = createEnergyRecorder();
  for (let t = T0; t <= T0 + 5 * MIN; t += 30_000) rec.observe(evening(t), t);
  rec.observe(undefined, T0 + 14 * MIN);
  assert.equal(rec.pendingCount(), 0);
  rec.observe(undefined, T0 + 15 * MIN);
  assert.equal(rec.pendingWrites()[0].fields.q40.sec, 300);
}
{
  // A reading a hair before the boundary, processed after it: the closed slot is never reopened.
  const rec = createEnergyRecorder();
  for (let t = T0; t < T0 + 15 * MIN; t += 30_000) rec.observe(evening(t), t);
  rec.observe(evening(T0 + 15 * MIN - 1), T0 + 15 * MIN + 2);
  const first = rec.pendingWrites()[0].fields.q40;
  rec.observe(evening(T0 + 15 * MIN + 29_000), T0 + 15 * MIN + 29_000);
  assert.equal(rec.pendingWrites()[0].fields.q40, first, 'q40 untouched');
  assert.equal(first.sec, 900);
  near(rec.snapshot().open.slot.sec, 29, 0.01, 'q41 starts at the boundary');
}
{
  // Midnight: the last slot goes to the old day's document, the next to the new day's.
  const rec = createEnergyRecorder();
  const mid = Date.UTC(2026, 10, 11);
  for (let t = mid - 20 * MIN; t <= mid + 20 * MIN; t += 30_000) rec.observe(evening(t), t);
  const ids = rec.pendingWrites().map(w => [w.id, Object.keys(w.fields).filter(k => k.startsWith('q')).sort()]);
  assert.deepEqual(ids, [['2026-11-10', ['q94', 'q95']], ['2026-11-11', ['q00']]]);
}
{
  // 25/10/2026: the repeated hour is its own slots, and the day ends at q99.
  const rec = createEnergyRecorder();
  const from = Date.UTC(2026, 9, 25, 0, 0); // 01:00 summer time
  for (let t = from; t <= from + 2 * HOUR; t += 30_000) rec.observe(evening(t), t);
  const keys = Object.keys(rec.pendingWrites()[0].fields).filter(k => k.startsWith('q')).sort();
  assert.deepEqual(keys, ['q04', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q11']);
  assert.equal(rec.pendingWrites()[0].fields.slots, 100);
}
{
  // A restart in the middle of a slot carries on from the saved state (JSON on disk).
  const rec = createEnergyRecorder();
  for (let t = T0; t <= T0 + 6 * MIN; t += 30_000) rec.observe(evening(t), t);
  const saved = JSON.parse(JSON.stringify(rec.snapshot()));
  const again = createEnergyRecorder(saved);
  for (let t = T0 + 7 * MIN; t <= T0 + 16 * MIN; t += 30_000) again.observe(evening(t), t);
  assert.equal(again.pendingWrites()[0].fields.q40.sec, 900, 'the 1-min restart is bridged');
  near(again.pendingWrites()[0].fields.q40.load, 375, 1, 'and the slot is whole');
}
{
  // The clock stepping back (NTP after boot) is ignored; a big jump back starts afresh.
  const rec = createEnergyRecorder();
  for (let t = T0; t <= T0 + 16 * MIN; t += 30_000) rec.observe(evening(t), t);
  const q40 = rec.pendingWrites()[0].fields.q40;
  rec.observe(evening(T0 + 5 * MIN), T0 + 5 * MIN);
  assert.equal(rec.pendingWrites()[0].fields.q40, q40);
  assert.equal(rec.snapshot().last.t, T0 + 16 * MIN);
  const warn = console.warn;
  console.warn = () => {};
  rec.observe(evening(T0 - 3 * 24 * HOUR), T0 - 3 * 24 * HOUR);
  console.warn = warn;
  assert.equal(rec.snapshot().closedUntil, 0);
  assert.equal(rec.snapshot().last.t, T0 - 3 * 24 * HOUR);
}
{
  // A slot that closes while the previous write is in flight stays queued.
  const rec = createEnergyRecorder();
  for (let t = T0; t <= T0 + 16 * MIN; t += 30_000) rec.observe(evening(t), t);
  const inFlight = rec.pendingWrites()[0];
  for (let t = T0 + 16.5 * MIN; t <= T0 + 31 * MIN; t += 30_000) rec.observe(evening(t), t);
  rec.written(inFlight.id, inFlight.fields);
  assert.deepEqual(Object.keys(rec.pendingWrites()[0].fields).filter(k => k.startsWith('q')), ['q41']);
}

// --- Store: writes, backoff, cap, state on disk ------------------------------------------
async function storeTests() {
  const dir = mkdtempSync(join(tmpdir(), 'energy-'));
  let now = T0;
  const inv = (over = {}) => ({ online: true, pvPowerW: 0, gridPowerW: -500, batteryPowerW: -1000, soc: 60, readAt: now, ...over });
  {
    const calls = [];
    const db = { setDoc: async (path, data) => { calls.push({ path, data }); } };
    const path = join(dir, 'a.json');
    const store = createEnergyStore(db, path, { clock: () => now });
    for (; now <= T0 + 31 * MIN; now += 30_000) await store.observe(inv());
    assert.deepEqual(calls.map(c => c.path), ['domotics_energy/2026-11-10', 'domotics_energy/2026-11-10'], 'one write per closed slot');
    assert.deepEqual(Object.keys(calls[0].data).sort(), ['date', 'q40', 'slots', 'source', 'start', 'updatedAt', 'v']);
    assert.ok(Object.keys(calls[1].data).includes('q41') && !Object.keys(calls[1].data).includes('q40'), 'only the new slot');
    assert.ok(existsSync(path), 'state saved');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).open.index, 42);
    // Offline inverter: no reading, no write, no crash.
    await store.observe({ online: false, readAt: now });
  }
  {
    // Failures back off (30 s, 60 s, ...) instead of retrying every poll.
    let calls = 0;
    const db = { setDoc: async () => { calls++; throw new Error('403'); } };
    now = T0;
    const store = createEnergyStore(db, join(dir, 'b.json'), { clock: () => now });
    const warn = console.warn;
    console.warn = () => {};
    for (; now <= T0 + 15 * MIN + 20_000; now += 10_000) await store.observe(inv());
    assert.equal(calls, 1, 'first failure, then a 30 s wait');
    for (const t = now; now <= t + 3 * MIN; now += 10_000) await store.observe(inv());
    console.warn = warn;
    assert.ok(calls >= 2 && calls <= 4, `a few retries in 3 min, not one per poll (${calls})`);
  }
  {
    // The counter candidates are logged on the Pi once per closed slot, beside what was integrated.
    now = T0;
    const log = join(dir, 'registers.jsonl');
    const store = createEnergyStore(undefined, join(dir, 'e.json'), {
      clock: () => now, counterLog: log, counters: () => ({ t: now, values: { 30: 10602, 52: 21622 } }),
    });
    for (; now <= T0 + 31 * MIN; now += 30_000) await store.observe(inv());
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => l.slot), ['2026-11-10/q40', '2026-11-10/q41']);
    assert.equal(lines[0].wh.load, 375);
    assert.deepEqual(lines[0].reg, { 30: 10602, 52: 21622 });
  }
  {
    // A whole day of normal use is well inside the cap: one write per slot.
    let calls = 0;
    const db = { setDoc: async () => { calls++; } };
    now = Date.UTC(2026, 10, 11);
    const store = createEnergyStore(db, join(dir, 'c.json'), { clock: () => now });
    for (const end = now + 24 * HOUR; now <= end; now += 30_000) await store.observe(inv());
    assert.equal(calls, 96);
    assert.ok(calls < MAX_WRITES_PER_DAY / 2);
  }
  {
    // The cap holds whatever happens: with 3 a day, the 4th slot waits for the next UTC day.
    let calls = 0;
    const db = { setDoc: async () => { calls++; } };
    now = Date.UTC(2026, 10, 11, 22, 0);
    const store = createEnergyStore(db, join(dir, 'd.json'), { clock: () => now, maxWritesPerDay: 3 });
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    for (const end = now + 75 * MIN; now <= end; now += 30_000) await store.observe(inv());
    assert.equal(calls, 3, 'capped');
    for (const end = Date.UTC(2026, 10, 12, 0, 31); now <= end; now += 30_000) await store.observe(inv());
    console.warn = warn;
    assert.ok(warned >= 1 && warned <= 4, `said so, without flooding the log (${warned})`);
    assert.ok(calls >= 4, 'resumes the next day, with the backlog in one write per document');
  }
}

storeTests().then(() => console.log('all energy scenarios pass'), err => { console.error(err); process.exit(1); });
