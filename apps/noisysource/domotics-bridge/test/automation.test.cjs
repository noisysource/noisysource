// Heating automation decisions, against simulated readings — no house attached.
// Run: pnpm --filter domotics-bridge test (builds first).
const assert = require('node:assert/strict');
const { createAutomation, parseConfig, periodAt, flowFor } = require('../lib/automation.js');
const sent = [];
const send = async (id, cmds) => { sent.push(`${id}:${cmds.map(c => `${c.code}=${c.value}`).join(',')}`); };
const cfg = parseConfig({ enabled: true, dryRun: false });
const zones = (target, open = true, current = open ? 22 : 24) => ['z1', 'z2'].map(id => ({ id, name: id, online: true, current, target, mode: 'manual', valveOpen: open }));
const pump = (over = {}) => ({ id: 'hp', online: true, on: true, fault: false, outdoor: 11, flowSetpoint: 42, ...over });
const at = (h, m) => new Date(2026, 9, 19, h, m);
(async () => {
  // Periods and curve.
  assert.equal(periodAt(cfg, at(6, 0)), 'preheat');
  assert.equal(periodAt(cfg, at(12, 0)), 'day');
  assert.equal(periodAt(cfg, at(19, 0)), 'evening');
  assert.equal(periodAt(cfg, at(23, 0)), 'night');
  assert.equal(periodAt(cfg, at(3, 0)), 'night');
  assert.equal(flowFor(cfg, 11, 0), 33);
  assert.equal(flowFor(cfg, -5, 0), 38);   // clamped at max
  assert.equal(flowFor(cfg, 25, 0), 28);   // clamped at min

  // 1. Evening, everything at 24: zones to 23.5, water to 33.
  const tick = createAutomation(send);
  let s = await tick(cfg, { now: at(20, 30), zones: zones(24), pump: pump() });
  assert.deepEqual(sent, ['z1:temp_set=235', 'z2:temp_set=235', 'hp:p02_heating=33']);
  assert.equal(s.state, 'running'); assert.equal(s.roomTarget, 23.5); assert.equal(s.flowTarget, 33);

  // 2. A minute later, devices took it: nothing new.
  sent.length = 0;
  s = await tick(cfg, { now: at(20, 31), zones: zones(23.5), pump: pump({ flowSetpoint: 33 }) });
  assert.deepEqual(sent, []);
  assert.ok(s.zones.every(z => z.note === 'no alvo'));

  // 3. Someone sets z1 to 25 by hand: respected for the rest of the period.
  s = await tick(cfg, { now: at(20, 50), zones: [{ ...zones(23.5)[0], target: 25 }, zones(23.5)[1]], pump: pump({ flowSetpoint: 33 }) });
  assert.deepEqual(sent, []);
  assert.match(s.zones[0].note, /à mão/);

  // 4. Next period (night, 22:00): target back to 24 — z1 included again.
  s = await tick(cfg, { now: at(22, 5), zones: [{ ...zones(23.5)[0], target: 25 }, zones(23.5)[1]], pump: pump({ flowSetpoint: 33 }) });
  assert.deepEqual(sent, ['z1:temp_set=240', 'z2:temp_set=240']);
  sent.length = 0;

  // 5. All valves closed: pump off only after 20 min closed AND 30 min running.
  const closed = zones(24, false);
  await tick(cfg, { now: at(22, 10), zones: closed, pump: pump({ flowSetpoint: 33 }) });
  await tick(cfg, { now: at(22, 25), zones: closed, pump: pump({ flowSetpoint: 33 }) });
  assert.deepEqual(sent, [], 'not yet: closed 15 min');
  await tick(cfg, { now: at(22, 41), zones: closed, pump: pump({ flowSetpoint: 33 }) });
  assert.deepEqual(sent, ['hp:switch=false']);
  sent.length = 0;

  // 6. A zone opens: pump back on, but only after 15 min off.
  const open = zones(24, true);
  await tick(cfg, { now: at(22, 45), zones: open, pump: pump({ on: false, flowSetpoint: 33 }) });
  assert.deepEqual(sent, [], 'off only 0 min');
  await tick(cfg, { now: at(23, 1), zones: open, pump: pump({ on: false, flowSetpoint: 33 }) });
  assert.deepEqual(sent, ['hp:switch=true']);
  sent.length = 0;

  // 7. Pump switched off by hand (not by us): never switched on by the automation.
  const tick2 = createAutomation(send);
  s = await tick2(cfg, { now: at(23, 0), zones: open, pump: pump({ on: false, flowSetpoint: 33 }) });
  await tick2(cfg, { now: at(23, 30), zones: open, pump: pump({ on: false, flowSetpoint: 33 }) });
  assert.ok(!sent.includes('hp:switch=true'));
  assert.match(s.pumpHold, /à mão/);
  sent.length = 0;

  // 8. Fault: the pump is never touched; zones still are.
  const tick3 = createAutomation(send);
  s = await tick3(cfg, { now: at(20, 30), zones: zones(24), pump: pump({ fault: true }) });
  assert.deepEqual(sent, ['z1:temp_set=235', 'z2:temp_set=235']);
  assert.match(s.pumpHold, /avaria/);
  sent.length = 0;

  // 9. Dry-run: nothing sent, decisions logged once, not every poll.
  const tick4 = createAutomation(send);
  const dryCfg = parseConfig({ enabled: true, dryRun: true });
  s = await tick4(dryCfg, { now: at(20, 30), zones: zones(24), pump: pump() });
  const first = s.actions.length;
  s = await tick4(dryCfg, { now: at(20, 31), zones: zones(24), pump: pump() });
  s = await tick4(dryCfg, { now: at(20, 50), zones: zones(24), pump: pump() });
  assert.deepEqual(sent, []);
  assert.equal(s.actions.length, first, 'dry-run decisions not repeated');
  assert.equal(s.state, 'dry-run');
  assert.ok(s.actions.every(a => a.sent === false));

  // 10. Solar boost by day: exporting > 800 W → 24.5; disabled → 24.
  const tick5 = createAutomation(send);
  s = await tick5(cfg, { now: at(13, 0), zones: zones(24), pump: pump({ flowSetpoint: 33 }), energy: { gridW: 1500, pvW: 3500, loadW: 900, soc: 80 } });
  assert.equal(s.roomTarget, 24.5); assert.ok(s.boost);
  s = await tick5(parseConfig({ enabled: true, dryRun: false, solarBoost: { enabled: false } }), { now: at(13, 30), zones: zones(24.5), pump: pump({ flowSetpoint: 33 }), energy: { gridW: 1500 } });
  assert.equal(s.roomTarget, 24);

  // 11. Off: nothing evaluated.
  sent.length = 0;
  s = await createAutomation(send)(parseConfig({}), { now: at(20, 30), zones: zones(24), pump: pump() });
  assert.equal(s.state, 'off'); assert.deepEqual(sent, []);

  // 12. Bad stored config is clamped, never trusted.
  const bad = parseConfig({ enabled: true, comfort: 40, flow: { max: 90, min: 5 }, preheat: { from: '25:00' } });
  assert.equal(bad.comfort, 25); assert.equal(bad.flow.max, 45); assert.equal(bad.flow.min, 25); assert.equal(bad.preheat.from, '05:00');
  // 13. Rooms short of their own setpoints for 2 h → water +1 °C; satisfied 2 h → back.
  sent.length = 0;
  const tick6 = createAutomation(send);
  let st = await tick6(cfg, { now: at(9, 0), zones: zones(24, true, 22), pump: pump({ flowSetpoint: 33 }) });
  st = await tick6(cfg, { now: at(11, 1), zones: zones(24, true, 22), pump: pump({ flowSetpoint: 33 }) });
  assert.equal(st.flowCorrection, 1); assert.equal(st.flowTarget, 34);
  st = await tick6(cfg, { now: at(11, 30), zones: zones(24, true, 24.2), pump: pump({ flowSetpoint: 34 }) });
  st = await tick6(cfg, { now: at(13, 31), zones: zones(24, true, 24.2), pump: pump({ flowSetpoint: 34 }) });
  assert.equal(st.flowCorrection, 0);
  console.log('all automation scenarios pass');
})().catch(e => { console.error(e); process.exit(1); });
