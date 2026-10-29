// Several warm windows (from 2026-10-28: 19–23 and 06–10 at 23 °C), the warm-up
// cap, and a person's on/off respected until the plan moves on. No house attached.
const assert = require('node:assert/strict');
const { createAutomation, parseConfig, inWarmWindow, windowTimes, lisbonClock } = require('../lib/automation.js');

const MIN = 60_000;
/** November: Lisbon is on UTC. */
const L = (h, m = 0, d = 10) => Date.UTC(2026, 10, d, h, m);
const WINDOWS = [{ from: '19:00', to: '23:00' }, { from: '06:00', to: '10:00' }];
const exp = parseConfig({
  enabled: true, dryRun: false, comfort: 23, dayMin: 19, warmupMaxMin: 240, windows: WINDOWS,
  solar: { enabled: false }, flow: { enabled: false }, rest: { enabled: false },
});

// --- Parsing --------------------------------------------------------------------
assert.deepEqual(exp.windows, WINDOWS);
assert.deepEqual(exp.warm, WINDOWS[0], 'warm is the first window');
assert.equal(exp.warmupMaxMin, 240);
assert.deepEqual(parseConfig({ warm: { from: '18:00', to: '08:00' } }).windows, [{ from: '18:00', to: '08:00' }], 'one window: from warm');
assert.deepEqual(parseConfig({ windows: [{ from: '19:00', to: '19:00' }] }).windows, [{ from: '19:00', to: '09:00' }], 'a bad list falls back');
assert.deepEqual(parseConfig({ windows: [] }).windows, [{ from: '19:00', to: '09:00' }]);
assert.equal(parseConfig({ solar: { socOn: 40 } }).solar.socOn, 40, '"enough for tonight" can be set');

// --- Which window -----------------------------------------------------------------
for (const [h, m, want] of [[5, 59, false], [6, 0, true], [9, 59, true], [10, 0, false], [15, 0, false], [19, 0, true], [22, 59, true], [23, 0, false], [3, 0, false]]) {
  assert.equal(inWarmWindow(exp, L(h, m)), want, `${h}:${m}`);
}
{
  const at20 = windowTimes(exp, L(20, 0));
  assert.equal(lisbonClock(at20.end), '23:00');
  assert.equal(lisbonClock(at20.nextStart), '06:00');
  const at12 = windowTimes(exp, L(12, 0));
  assert.equal(lisbonClock(at12.nextStart), '19:00');
  assert.equal(at12.nextFrom, '19:00');
  assert.equal(lisbonClock(at12.end), '23:00');
  const at01 = windowTimes(exp, L(1, 0));
  assert.equal(lisbonClock(at01.nextStart), '06:00');
  assert.equal(lisbonClock(at01.end), '10:00');
}

const zones = (current, open) => ['a', 'b', 'c'].map(id => ({ id, name: id, online: true, current, target: 23, mode: 'manual', valveOpen: open }));
const pump = on => ({ id: 'hp', online: true, on, fault: false, outdoor: 12, flowSetpoint: 44, hz: on ? 50 : 0, waterOut: 40, waterIn: 36 });

(async () => {
  // --- The warm-up is capped by warmupMaxMin ----------------------------------------
  {
    const tick = createAutomation(async () => {}, { model: { floorMin: 68, roomRatePerH: 0.15, floorSamples: 5, roomSamples: 5 } });
    const s = await tick(exp, { now: new Date(L(12, 0)), zones: zones(21, true), pump: pump(false) });
    assert.equal(s.mode, 'day');
    assert.equal(s.warm.capped, true);
    assert.equal(s.warm.leadMin, 240);
    assert.equal(lisbonClock(s.warm.warmupAt), '15:00', '4 h before 19:00');
    assert.match(s.plan, /19:00–23:00 e 06:00–10:00/);
    assert.match(s.plan, /no máximo 4 h antes/);
  }

  // --- A person's on, outside the windows: kept until the plan moves on ----------------
  {
    const sent = [];
    const tick = createAutomation(async (_id, cmds) => sent.push(...cmds));
    let on = false;
    const step = async (t, manual) => {
      const s = await tick(exp, { now: new Date(t), zones: zones(23.5, false), pump: pump(on), manualSwitch: manual ?? null });
      for (const c of sent.splice(0)) if (c.code === 'switch') on = c.value;
      return s;
    };
    await step(L(13, 0));
    on = true; // switched on at the panel: cold
    let s = await step(L(13, 1), { on: true, at: L(13, 1) });
    assert.equal(s.wantOn, true);
    assert.match(s.doing, /ligada à mão às 13:01/);
    // An hour later (long past the minimum on time) it is still on: not undone.
    for (let t = L(13, 2); t <= L(14, 30); t += MIN) s = await step(t);
    assert.equal(on, true);
    // At 19:00 the window starts, at 23:00 it ends: from then the plan has it off again.
    for (let t = L(14, 31); t <= L(23, 45); t += 5 * MIN) s = await step(t);
    assert.equal(on, false, 'after the window the plan rules again');
  }

  // --- A person's off, in a window: kept until it ends ----------------------------------
  {
    const sent = [];
    const tick = createAutomation(async (_id, cmds) => sent.push(...cmds));
    let on = true;
    const step = async (t, manual, open = true) => {
      const s = await tick(exp, { now: new Date(t), zones: zones(22.5, open), pump: pump(on), manualSwitch: manual ?? null });
      for (const c of sent.splice(0)) if (c.code === 'switch') on = c.value;
      return s;
    };
    await step(L(19, 30));
    on = false; // off from the app: warm enough
    let s = await step(L(20, 0), { on: false, at: L(20, 0) });
    for (let t = L(20, 1); t <= L(22, 59); t += 5 * MIN) s = await step(t);
    assert.equal(on, false, 'not switched back on while the window lasts');
    assert.match(s.doing, /desligada à mão às 20:00/);
    // The morning: the warm-up (or the window) switches it on again.
    for (let t = L(23, 0); t <= L(6, 30, 11); t += 5 * MIN) s = await step(t);
    assert.equal(on, true, 'back on for the morning');
  }

  // --- Without a person, the window still undoes an outside off (the old rule) -----------
  {
    const sent = [];
    const tick = createAutomation(async (_id, cmds) => sent.push(...cmds));
    let on = true;
    await tick(exp, { now: new Date(L(20, 0)), zones: zones(22.5, true), pump: pump(on) });
    on = false; // the controller's timer, say: not a manualSwitch
    for (let t = L(20, 1); t <= L(20, 30); t += MIN) {
      await tick(exp, { now: new Date(t), zones: zones(22.5, true), pump: pump(on) });
      for (const c of sent.splice(0)) if (c.code === 'switch') on = c.value;
    }
    assert.equal(on, true);
  }
  console.log('windows: ok');
})().catch(err => { console.error(err); process.exit(1); });
