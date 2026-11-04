// Heating automation decisions, against simulated readings — no house attached.
// Run: pnpm --filter domotics-bridge test (builds first).
//
// These are the scenarios from before the 2026-10-26 rework (zones, water,
// rests, warm-by), kept as regressions of the WARM WINDOW (19:00–09:00), where
// the pump still follows the zones. The ones that used to run by day were moved
// into the warm window: by day the pump is now off unless there is spare sun or
// the house is below the day minimum, so a running pump would be switched off
// there. The new day/solar/pause rules are in solar-heating.test.cjs.
// `at()` is local time on a Lisbon machine, like the old tests; the new file
// uses UTC instants and runs under a foreign time zone too.
const assert = require('node:assert/strict');
const { createAutomation, parseConfig, inWarmWindow, flowFor } = require('../lib/automation.js');
const sent = [];
const send = async (id, cmds) => { sent.push(`${id}:${cmds.map(c => `${c.code}=${c.value}`).join(',')}`); };
const cfg = parseConfig({ enabled: true, dryRun: false });
const dryCfg = parseConfig({ enabled: true, dryRun: true });
/** Two zones; `current` defaults to the target (rooms at target). */
const zones = (target, { open = true, current = target, n = 2 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `z${i + 1}`, name: `z${i + 1}`, online: true, current, target, mode: 'manual', valveOpen: open }));
/** Running hard, well below its setpoint: not idling. */
const pump = (over = {}) => ({ id: 'hp', online: true, on: true, fault: false, outdoor: 11, flowSetpoint: 42, hz: 60, waterOut: 36, waterIn: 33, ...over });
const at = (h, m, d = 19) => new Date(2026, 9, d, h, m);
/** An automation that sent the pump's current setpoint itself (otherwise the one found at start-up counts as set by hand). */
const fresh = (sp = 42) => createAutomation(send, { flow: { value: sp, at: 0 } });
const reset = () => { sent.length = 0; };
const guardOn = (mode = 'watch', restUntil = null) => ({ enabled: true, mode, restUntil });
(async () => {
  // Warm window and curve.
  for (const [h, m, warm] of [[6, 0, true], [8, 59, true], [9, 0, false], [12, 0, false], [18, 59, false], [19, 0, true], [23, 0, true], [3, 0, true]]) {
    assert.equal(inWarmWindow(cfg, at(h, m).getTime()), warm, `${h}:${m}`);
  }
  assert.equal(flowFor(cfg, 11, 0), 33);
  assert.equal(flowFor(cfg, -5, 0), 45);   // clamped at max
  assert.equal(flowFor(cfg, 25, 0), 28);   // clamped at min
  assert.equal(cfg.comfort, 24);

  // 1. Evening, zones left at 23.5 (rooms at 24): zones to the comfort 24 (one
  // temperature all day now: no evening setback); water down towards 33, a degree at a time.
  {
    const tick = fresh();
    let s = await tick(cfg, { now: at(20, 30), zones: zones(23.5, { current: 24 }), pump: pump() });
    assert.deepEqual(sent, ['z1:temp_set=240', 'z2:temp_set=240', 'hp:p02_heating=41']);
    assert.equal(s.state, 'running'); assert.equal(s.roomTarget, 24); assert.equal(s.flowTarget, 33);
    assert.equal(s.mode, 'warm');
    assert.equal(tick.memory().flow.value, 41, 'remembers its own setpoint');
    reset();
    // A minute later the devices took it (its own write, not a hand change): nothing new.
    s = await tick(cfg, { now: at(20, 31), zones: zones(24), pump: pump({ flowSetpoint: 41 }) });
    assert.deepEqual(sent, []);
    assert.ok(s.zones.every(z => z.note === 'no alvo'));
    assert.equal(s.flowManual, false);
    // 30 min on, the next degree.
    s = await tick(cfg, { now: at(21, 1), zones: zones(24), pump: pump({ flowSetpoint: 41 }) });
    assert.deepEqual(sent, ['hp:p02_heating=40']);
    reset();

    // 2. Someone sets z1 to 25 by hand: respected through the night.
    const handZ = () => [{ ...zones(24)[0], target: 25 }, zones(24)[1]];
    s = await tick(cfg, { now: at(21, 10), zones: handZ(), pump: pump({ flowSetpoint: 40 }) });
    assert.deepEqual(sent, []);
    assert.match(s.zones[0].note, /à mão/);
    s = await tick(cfg, { now: at(4, 0, 20), zones: handZ(), pump: pump({ flowSetpoint: 40 }) });
    assert.deepEqual(sent, [], 'still respected at 04:00');

    // 3. The plan moves to day at 09:00: z1 goes back to 24. z1 is still 1°
    // short of its own 25, so the water is not lowered any further. (By day the
    // pump is switched off too: no sun in this test.)
    s = await tick(cfg, { now: at(9, 5, 20), zones: handZ(), pump: pump({ flowSetpoint: 40 }) });
    assert.ok(sent.includes('z1:temp_set=240'));
    assert.ok(!sent.some(x => x.startsWith('z2:')));
    assert.ok(!sent.some(x => x.startsWith('hp:p02_heating')));
    assert.ok(s.reasons.some(r => /Não baixa a água/.test(r)));
    assert.equal(s.mode, 'day');
    reset();
  }

  // 4. All valves closed: pump off only after 20 min closed AND 30 min running; back on after 15 min off.
  {
    const tick = fresh(33);
    const closed = zones(24, { open: false });
    await tick(cfg, { now: at(22, 10), zones: closed, pump: pump({ flowSetpoint: 33 }) });
    await tick(cfg, { now: at(22, 25), zones: closed, pump: pump({ flowSetpoint: 33 }) });
    assert.deepEqual(sent, [], 'not yet: closed 15 min');
    await tick(cfg, { now: at(22, 41), zones: closed, pump: pump({ flowSetpoint: 33 }) });
    assert.deepEqual(sent, ['hp:switch=false']);
    reset();
    const open = zones(24, { open: true });
    await tick(cfg, { now: at(22, 45), zones: open, pump: pump({ on: false, hz: 0, flowSetpoint: 33 }) });
    assert.deepEqual(sent, [], 'off only 4 min');
    await tick(cfg, { now: at(23, 1), zones: open, pump: pump({ on: false, hz: 0, flowSetpoint: 33 }) });
    assert.deepEqual(sent, ['hp:switch=true']);
    reset();
  }

  // 5. Pump switched off from outside (not by us): switched back on when a zone
  // wants heat, after the minimum off time (Renato, 2026-10-25). In dry-run only recorded.
  for (const c of [cfg, dryCfg]) {
    const tick = fresh(33);
    const off = pump({ on: false, hz: 0, flowSetpoint: 33 });
    let s = await tick(c, { now: at(23, 0), zones: zones(24, { open: false }), pump: off });
    assert.ok(s.reasons.some(r => /nenhuma zona pede calor/.test(r)), 'valves closed: stays off');
    s = await tick(c, { now: at(23, 5), zones: zones(24, { open: true }), pump: off });
    assert.ok(s.reasons.some(r => /desligada às 23:00 — liga(ria)? às 23:15/.test(r)));
    assert.equal(s.pumpHold, undefined);
    s = await tick(c, { now: at(23, 16), zones: zones(24, { open: true }), pump: off });
    assert.deepEqual(sent, c.dryRun ? [] : ['hp:switch=true']);
    assert.ok(s.actions.some(a => /^ligar \(horário quente\)/.test(a.what) && a.sent === !c.dryRun));
    reset();
  }
  // 5b. With "follow the zones" off, the pump runs through the warm window
  // whatever the valves; by day the plan is the same as ever (off, no sun here),
  // whatever recovery says.
  {
    const noPz = parseConfig({ enabled: true, dryRun: false, pumpFollowsZones: { enabled: false } });
    const tick = fresh(33);
    const off = pump({ on: false, hz: 0, flowSetpoint: 33 });
    await tick(noPz, { now: at(20, 0), zones: zones(24, { open: false }), pump: off });
    await tick(noPz, { now: at(20, 16), zones: zones(24, { open: false }), pump: off });
    assert.deepEqual(sent, ['hp:switch=true'], 'valves closed, still switched on');
    reset();
    const t2 = fresh(45);
    const off45 = pump({ on: false, hz: 0, flowSetpoint: 45 });
    await t2(noPz, { now: at(12, 0), zones: zones(24, { current: 22.5 }), pump: off45 });
    const s = await t2(noPz, { now: at(12, 16), zones: zones(24, { current: 22.5 }), pump: off45 });
    assert.deepEqual(sent, [], 'by day, recovery alone does not switch it on');
    assert.equal(s.recovery, true);
    reset();
  }

  // 6. Fault: the pump is never touched; zones still are.
  {
    const s = await fresh()(cfg, { now: at(20, 30), zones: zones(23.5, { current: 24 }), pump: pump({ fault: true }) });
    assert.deepEqual(sent, ['z1:temp_set=240', 'z2:temp_set=240']);
    assert.match(s.pumpHold, /avaria/);
    reset();
  }

  // 7. Dry-run: nothing sent, decisions logged once, not every poll.
  {
    const tick = fresh();
    let s = await tick(dryCfg, { now: at(20, 30), zones: zones(24), pump: pump() });
    const first = s.actions.length;
    assert.ok(first > 0);
    s = await tick(dryCfg, { now: at(20, 31), zones: zones(24), pump: pump() });
    s = await tick(dryCfg, { now: at(20, 50), zones: zones(24), pump: pump() });
    assert.deepEqual(sent, []);
    assert.equal(s.actions.length, first, 'dry-run decisions not repeated');
    assert.equal(s.state, 'dry-run');
    assert.ok(s.actions.every(a => a.sent === false));
    assert.equal(tick.memory().flow.value, 42, 'dry-run sends nothing, so remembers nothing new');
  }

  // 8. The old periods are gone: what was pre-heat (06:00, +0.5), solar boost
  // (exporting by day, +0.5) and the evening setback (20:00, −0.5) all target the
  // comfort 24 now, and their stored settings are ignored.
  {
    const old = parseConfig({ enabled: true, dryRun: false, preheat: { from: '05:00', to: '08:00', delta: 0.5 }, evening: { from: '18:00', to: '22:00', delta: -0.5 }, solarBoost: { enabled: true, delta: 0.5, exportW: 800 } });
    assert.equal('preheat' in old || 'evening' in old || 'solarBoost' in old, false);
    for (const [h, energy] of [[6, undefined], [13, { gridW: 1500, pvW: 3500, loadW: 900, soc: 80 }], [20, undefined]]) {
      const s = await fresh(33)(old, { now: at(h, 0), zones: zones(24), pump: pump({ flowSetpoint: 33 }), energy });
      assert.equal(s.roomTarget, 24, `${h}:00`);
    }
    reset();
  }

  // 9. Off: nothing evaluated.
  {
    const s = await fresh()(parseConfig({}), { now: at(20, 30), zones: zones(24), pump: pump() });
    assert.equal(s.state, 'off'); assert.deepEqual(sent, []);
  }

  // 10. Bad stored config is clamped, never trusted.
  {
    const bad = parseConfig({ enabled: true, comfort: 40, flow: { max: 90, min: 5 }, warm: { from: '25:00', to: '07:00' }, rest: { minutes: 1 }, dayMin: 30, solar: { socOn: 5, pumpW: 1e9 }, pauseUntil: 'soon' });
    assert.equal(bad.comfort, 25); assert.equal(bad.flow.max, 45); assert.equal(bad.flow.min, 25);
    assert.deepEqual(bad.warm, { from: '19:00', to: '07:00' });
    assert.equal(bad.rest.minutes, 15); assert.equal(bad.recovery.enabled, true);
    assert.equal(bad.dayMin, 25, 'day minimum never above the comfort temperature');
    assert.equal(bad.solar.socOn, 20); assert.equal(bad.solar.pumpW, 10000);
    assert.equal(bad.pauseUntil, null);
    assert.deepEqual(parseConfig({ warm: { from: '10:00', to: '10:00' } }).warm, { from: '19:00', to: '09:00' }, 'an empty window is a typo');
    assert.equal(parseConfig({ pauseUntil: new Date(1793030000000) }).pauseUntil, 1793030000000, 'a Firestore timestamp');
    assert.equal(parseConfig({ pauseUntil: 1793030000000 }).pauseUntil, 1793030000000, 'ms, as the app writes it');
  }

  // 11. Faster correction: rooms 0.3° short (not enough for recovery) → water +1 °C
  // every 30 min; at target for an hour → back down by one.
  {
    const tick = fresh(33);
    let s = await tick(cfg, { now: at(21, 0), zones: zones(24, { current: 23.7 }), pump: pump({ flowSetpoint: 33 }) });
    assert.equal(s.recovery, false);
    s = await tick(cfg, { now: at(21, 31), zones: zones(24, { current: 23.7 }), pump: pump({ flowSetpoint: 33 }) });
    assert.equal(s.flowCorrection, 1); assert.equal(s.flowTarget, 34);
    s = await tick(cfg, { now: at(22, 2), zones: zones(24, { current: 23.7 }), pump: pump({ flowSetpoint: 34 }) });
    assert.equal(s.flowCorrection, 2);
    s = await tick(cfg, { now: at(22, 30), zones: zones(24, { current: 24.1 }), pump: pump({ flowSetpoint: 35 }) });
    s = await tick(cfg, { now: at(23, 31), zones: zones(24, { current: 24.1 }), pump: pump({ flowSetpoint: 35 }) });
    assert.equal(s.flowCorrection, 1);
    reset();
  }

  // 12. Recovery: rooms 1.5° short → water to the top of the range (45) straight
  // away; back within 0.2° → recovery ends and the water comes down a degree at a time.
  {
    const tick = fresh(33);
    let s = await tick(cfg, { now: at(20, 0), zones: zones(24, { current: 22.5 }), pump: pump({ flowSetpoint: 33, hz: 70, waterOut: 30 }) });
    assert.equal(s.recovery, true);
    assert.equal(s.flowTarget, 45);
    assert.deepEqual(sent, ['hp:p02_heating=45']);
    assert.ok(s.reasons.some(r => /Recuperação/.test(r)));
    reset();
    s = await tick(cfg, { now: at(0, 0, 20), zones: zones(24, { current: 23.6 }), pump: pump({ flowSetpoint: 45 }) });
    assert.equal(s.recovery, true, 'still 0.4° short: carries on');
    s = await tick(cfg, { now: at(1, 0, 20), zones: zones(24, { current: 23.9 }), pump: pump({ flowSetpoint: 45 }) });
    assert.equal(s.recovery, false);
    assert.deepEqual(sent, ['hp:p02_heating=44']);
    reset();
  }

  // 13. Never lowered while the rooms are below target: 0.4° short (no recovery), the curve says 33, the pump is at 38.
  {
    const tick = fresh(38);
    const s = await tick(cfg, { now: at(21, 0), zones: zones(24, { current: 23.6 }), pump: pump({ flowSetpoint: 38 }) });
    assert.equal(s.recovery, false);
    assert.deepEqual(sent, []);
    assert.equal(s.flowTarget, 38);
    assert.ok(s.reasons.some(r => /Não baixa a água/.test(r)));
  }

  // 14. The cold morning of 20/10: comfort 23, outdoor 12 °C, rooms 21.7–22.8. The old
  // rules lowered the water to 29–31 °C; now it goes to the top of the range.
  {
    const tick = fresh(31);
    const cold = [21.7, 22.0, 22.4, 22.8, 22.6, 21.9].map((c, i) => ({ id: `z${i}`, name: `z${i}`, online: true, current: c, target: 23, mode: 'manual', valveOpen: i === 0 }));
    const s = await tick(parseConfig({ enabled: true, dryRun: false, comfort: 23 }), { now: at(7, 0, 20), zones: cold, pump: pump({ outdoor: 12, flowSetpoint: 31, hz: 0, waterOut: 30 }) });
    assert.equal(s.recovery, true);
    assert.equal(s.flowTarget, 45);
    assert.ok(sent.includes('hp:p02_heating=45'));
    reset();
  }

  // 15. A water setpoint changed by hand: left alone until the plan moves from
  // warm to day (or back) — that's 09:00 here.
  {
    const tick = fresh(33);
    await tick(cfg, { now: at(21, 0), zones: zones(24), pump: pump({ flowSetpoint: 33 }) });
    let s = await tick(cfg, { now: at(21, 10), zones: zones(24), pump: pump({ flowSetpoint: 44 }) });
    assert.equal(s.flowManual, true); assert.equal(s.flowTarget, 44);
    s = await tick(cfg, { now: at(8, 0, 20), zones: zones(24), pump: pump({ flowSetpoint: 44 }) });
    assert.deepEqual(sent, [], 'not touched all night');
    s = await tick(cfg, { now: at(9, 5, 20), zones: zones(24), pump: pump({ flowSetpoint: 44 }) });
    assert.equal(s.flowManual, false);
    assert.ok(sent.includes('hp:p02_heating=43'), 'next stretch: the automation takes over, a degree at a time');
    reset();
  }

  // 16. At start-up, a setpoint the automation didn't send (the technicians' 44) is treated the same way.
  {
    const tick = createAutomation(send);
    let s = await tick(cfg, { now: at(21, 0), zones: zones(24), pump: pump({ flowSetpoint: 44 }) });
    assert.equal(s.flowManual, true);
    assert.deepEqual(sent, []);
    s = await tick(cfg, { now: at(9, 5, 20), zones: zones(24), pump: pump({ flowSetpoint: 44 }) });
    assert.ok(sent.includes('hp:p02_heating=43'));
    reset();
  }

  // 17. E13: the water is never raised while the compressor idles at the setpoint;
  // with the guard off, the automation rests the pump itself, raises the water
  // while it is off, and switches it back on after the rest.
  {
    const tick = fresh(33);
    const short = zones(24, { current: 22.5 }); // recovery: wants 45
    const idle = pump({ flowSetpoint: 33, hz: 40, waterOut: 32.5 });
    let s = await tick(cfg, { now: at(21, 0), zones: short, pump: idle });
    assert.deepEqual(sent, [], 'no raise while idling, no rest during the grace after switching on');
    assert.ok(s.reasons.some(r => /quando o compressor parar/.test(r)));
    s = await tick(cfg, { now: at(21, 5), zones: short, pump: idle });
    assert.deepEqual(sent, ['hp:switch=false'], 'rested instead of idling');
    assert.ok(s.restUntil > at(21, 5).getTime());
    reset();
    const off = pump({ on: false, hz: 0, flowSetpoint: 33, waterOut: 31 });
    s = await tick(cfg, { now: at(21, 6), zones: short, pump: off });
    assert.deepEqual(sent, ['hp:p02_heating=45'], 'raised while off');
    reset();
    s = await tick(cfg, { now: at(21, 40), zones: short, pump: pump({ on: false, hz: 0, flowSetpoint: 45, waterOut: 28 }) });
    assert.deepEqual(sent, [], 'still resting');
    assert.ok(s.reasons.some(r => /liga às/.test(r)));
    s = await tick(cfg, { now: at(22, 6), zones: short, pump: pump({ on: false, hz: 0, flowSetpoint: 45, waterOut: 26 }) });
    assert.deepEqual(sent, ['hp:switch=true'], 'back on from standstill after the rest');
    reset();
  }

  // 18. With the guard on, it does the resting: the automation sends no off of its own,
  // never switches on a pump the guard parked, and (live only) asks the guard to
  // keep resting while the plan has the pump off (here: no zone wants heat).
  {
    const tick = fresh(33);
    const idle = pump({ flowSetpoint: 33, hz: 40, waterOut: 32.8 });
    await tick(cfg, { now: at(21, 0), zones: zones(24), pump: idle, guard: guardOn() });
    let s = await tick(cfg, { now: at(21, 10), zones: zones(24), pump: idle, guard: guardOn() });
    assert.deepEqual(sent, []);
    assert.ok(s.reasons.some(r => /proteção E13 desliga-a/.test(r)));
    const resting = pump({ on: false, hz: 0, flowSetpoint: 33, waterOut: 30 });
    const closed = zones(24, { open: false });
    s = await tick(cfg, { now: at(22, 15), zones: closed, pump: resting, guard: guardOn('rest', at(22, 10).getTime()) });
    assert.equal(s.holdRest, true);
    assert.deepEqual(sent, []);
    s = await tick(cfg, { now: at(22, 20), zones: zones(24, { open: true }), pump: resting, guard: guardOn('rest', at(22, 10).getTime()) });
    assert.equal(s.holdRest, false, 'a zone wants heat: the guard ends its rest');
    assert.deepEqual(sent, [], 'and switching on is the guard\'s');
    s = await createAutomation(send)(dryCfg, { now: at(22, 15), zones: closed, pump: resting, guard: guardOn('rest', at(22, 10).getTime()) });
    assert.equal(s.holdRest, false, 'dry-run never holds the guard');
    assert.ok(s.reasons.some(r => /manteria/.test(r)));
  }

  // 19. Too few thermostats answering (1 of 4): "all valves closed" means nothing —
  // the pump isn't switched off for it and the guard isn't asked to hold.
  {
    const tick = fresh(33);
    const few = zones(24, { open: false, n: 4 }).map((z, i) => ({ ...z, online: i === 0 }));
    for (const m of [0, 25, 50]) await tick(cfg, { now: at(20, m), zones: few, pump: pump({ flowSetpoint: 33 }) });
    assert.ok(!sent.includes('hp:switch=false'));
    const s = await tick(cfg, { now: at(21, 0), zones: few, pump: pump({ on: false, hz: 0, flowSetpoint: 33 }), guard: guardOn('rest', at(20, 55).getTime()) });
    assert.equal(s.holdRest, false);
    reset();
  }

  // 20. Warm by 07:00 at 25 °C, asked at 20:00 with the rooms at the evening's 23.5.
  // 1.5° to make up: floor 90 min + 1.5 / 0.3 °C/h = 300 min + 30 min margin = 7 h → starts at 00:00.
  {
    const tick = fresh(33);
    const req = { at: at(7, 0, 20).getTime(), target: 25, setAt: at(20, 0).getTime(), source: 'app' };
    const standby = pump({ flowSetpoint: 33, hz: 0, waterOut: 33 });
    let s = await tick(cfg, { now: at(20, 0), zones: zones(23.5), pump: standby, warmBy: req });
    assert.equal(s.warmBy.phase, 'waiting');
    assert.equal(s.warmBy.leadMin, 420);
    assert.equal(s.warmBy.startAt, at(0, 0, 20).getTime());
    assert.match(s.warmBy.note, /Começa a aquecer às 00:00/);
    assert.equal(s.roomTarget, 24, 'the comfort temperature until the start');
    reset();
    // 00:00: heating — zones to 25, water to the top of the range.
    s = await tick(cfg, { now: at(0, 0, 20), zones: zones(24, { current: 23.5 }), pump: standby, warmBy: req });
    assert.equal(s.warmBy.phase, 'heating');
    assert.equal(s.roomTarget, 25);
    assert.equal(s.flowTarget, 45);
    assert.deepEqual(sent, ['z1:temp_set=250', 'z2:temp_set=250', 'hp:p02_heating=45']);
    reset();
    // 07:00: holding, with how the house was then.
    s = await tick(cfg, { now: at(7, 0, 20), zones: zones(25, { current: 24.8 }), pump: standby, warmBy: req });
    assert.equal(s.warmBy.phase, 'holding');
    assert.deepEqual(s.warmBy.outcome, { mean: 24.8, reached: true });
    assert.equal(s.roomTarget, 25);
    // 08:01: done, the request is dropped.
    s = await tick(cfg, { now: at(8, 1, 20), zones: zones(25), pump: standby, warmBy: req });
    assert.equal(s.warmBy, null);
    assert.equal(s.roomTarget, 24);
    reset();
  }

  // 21. Asked too late: heating starts at once and says when it expects to get there.
  {
    const req = { at: at(23, 0).getTime(), target: 25, setAt: null, source: 'chat' };
    const s = await fresh(33)(cfg, { now: at(20, 0), zones: zones(23.5), pump: pump({ flowSetpoint: 33, hz: 0 }), warmBy: req });
    assert.equal(s.warmBy.phase, 'heating');
    assert.equal(s.warmBy.late, true);
    assert.equal(s.warmBy.expectedAt, at(2, 30, 20).getTime());
    assert.match(s.warmBy.note, /depois da hora pedida/);
    reset();
  }

  // 22. Warm-by in dry-run: planned and shown, nothing sent. Automation off: kept, but it says it won't heat.
  // Pump switched off from outside, rooms 1° short (recovery wants heat): no
  // warning; switched back on after the minimum off time, at the latest by the request.
  {
    const req = { at: at(7, 0, 20).getTime(), target: null, setAt: null, source: 'app' };
    let s = await fresh(33)(dryCfg, { now: at(23, 0), zones: zones(24, { current: 23 }), pump: pump({ flowSetpoint: 33 }), warmBy: req });
    assert.equal(s.warmBy.target, 24, 'no target = comfort');
    assert.deepEqual(sent, []);
    s = await fresh(33)(parseConfig({}), { now: at(23, 0), zones: zones(24), pump: pump(), warmBy: req });
    assert.match(s.warmBy.note, /desligada/);
    const tick = fresh(33);
    const closed = zones(24, { current: 23, open: false });
    const off = pump({ on: false, hz: 0, flowSetpoint: 33 });
    s = await tick(cfg, { now: at(23, 0), zones: closed, pump: off, warmBy: req });
    assert.equal(s.warmBy.phase, 'waiting');
    assert.doesNotMatch(s.warmBy.note, /Atenção/);
    assert.ok(!sent.includes('hp:switch=true'), 'not straight after it was seen off');
    s = await tick(cfg, { now: at(4, 0, 20), zones: closed, pump: off, warmBy: req });
    assert.equal(s.warmBy.phase, 'heating');
    assert.ok(sent.includes('hp:switch=true'), 'the requested time switches it on');
    reset();
  }

  // A pump switch hands over its reason twice: whole for `reason`, alone for `why`. A thermostat has no `why`.
  {
    const calls = [];
    const tick = createAutomation(async (id, cmds, reason, why) => { calls.push({ id, cmds, reason, why }); }, { flow: { value: 42, at: 0 } });
    const onDuty = at(20, 0);
    await tick(cfg, { now: new Date(onDuty.getTime() - 60 * 60_000), zones: zones(23, { current: 22 }), pump: pump({ on: false, hz: 0 }) });
    await tick(cfg, { now: onDuty, zones: zones(23, { current: 22 }), pump: pump({ on: false, hz: 0 }) });
    const sw = calls.find(c => c.cmds[0].code === 'switch');
    assert.equal(sw.reason, `ligar (${sw.why})`);
    assert.match(sw.why, /horário quente/);
    const zone = calls.find(c => c.cmds[0].code === 'temp_set');
    assert.ok(zone.reason, 'the thermostat keeps its text');
    assert.equal(zone.why, undefined);
    reset();
  }

  console.log('all automation scenarios pass');
})().catch(e => { console.error(e); process.exit(1); });
