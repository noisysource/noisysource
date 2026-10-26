// The 2026-10-26 heating plan: warm floor 19:00–09:00, daytime heating only on
// spare sun (battery ≥ 90 %), a 21 °C day minimum, the automation owning on/off
// whoever switched the pump, "Pausar", and the E13 guard first. Against a small
// simulated house — no house attached. Run: pnpm --filter domotics-bridge test
// (it runs this file under a foreign time zone too: every instant here is UTC,
// and the automation must find Lisbon's clock by itself).
const assert = require('node:assert/strict');
const {
  createAutomation, parseConfig, inWarmWindow, lisbonAt, lisbonClock, nextLisbon, spareSun, MAX_ONS_PER_DAY,
} = require('../lib/automation.js');
const { createGuard, INITIAL_GUARD } = require('../lib/guard.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
/** November: Lisbon is on UTC, so these read as Lisbon times. */
const L = (h, m = 0, d = 10) => Date.UTC(2026, 10, d, h, m);
const live = parseConfig({ enabled: true, dryRun: false });
const dry = parseConfig({ enabled: true, dryRun: true });
const OFFSETS = [-0.2, 0, 0.1, 0.3];

/**
 * A tiny house. The pump does what it's told (by the automation, the guard or
 * `events`); its compressor runs 2 min after a switch-on. Rooms warm `gain` °C/h
 * through an open valve while it runs and cool `loss` °C/h otherwise; each
 * thermostat opens at 0.3 below its 24 and closes at 24. The inverter: panels
 * `pv(t)`, house `base(t)` + 3.3 kW while the compressor runs, a 30 kWh battery
 * taking or giving the difference, the grid the rest.
 */
async function simulate(o) {
  const step = o.step ?? MIN;
  const cfgAt = typeof o.cfg === 'function' ? o.cfg : () => o.cfg;
  const st = {
    on: o.on ?? false, since: o.from - (o.onFor ?? 0) * MIN, by: 'start',
    rooms: o.rooms ?? 24, sp: 44, soc: o.soc ?? 50,
    open: OFFSETS.map(d => (o.rooms ?? 24) + d < 24),
  };
  const log = [];
  let now = o.from;
  const sw = (on, by, reason) => {
    if (st.on !== on) { st.on = on; st.since = now; st.by = by; }
    log.push({ t: now, on, by, reason });
  };
  const tick = createAutomation(async (_id, cmds, reason) => {
    for (const c of cmds) {
      if (c.code === 'switch') sw(c.value, 'automation', reason);
      if (c.code === 'p02_heating') st.sp = c.value;
    }
  }, { flow: { value: 44, at: 0 }, ...(o.memory ?? {}) });
  const guard = o.guard ? createGuard({ ...INITIAL_GUARD, mode: 'watch', ...o.guard }) : null;
  let lastOn = st.on;
  let status;
  const statuses = [];
  for (now = o.from; now <= o.to; now += step) {
    o.events?.(now, st, sw);
    const running = st.on && now - st.since >= 2 * MIN;
    const cfg = cfgAt(now);
    // Rooms and valves.
    const h = step / HOUR;
    const anyOpen = st.open.some(Boolean);
    st.rooms += running && anyOpen ? (o.gain ?? 0.3) * h : -(o.loss ?? 0.1) * h;
    st.open = OFFSETS.map((d, i) => (st.rooms + d >= 24 ? false : st.rooms + d <= 23.7 ? true : st.open[i]));
    // Inverter and battery.
    let energy;
    if (o.pv) {
      const pv = o.pv(now);
      const load = (o.base?.(now) ?? 500) + (running ? 3300 : 0);
      let bat = Math.max(-5000, Math.min(5000, pv - load));
      if (st.soc >= 100 && bat > 0) bat = 0;
      if (st.soc <= 10 && bat < 0) bat = 0;
      st.soc = Math.min(100, st.soc + (bat * h) / 30_000 * 100);
      energy = { pvW: pv, loadW: load, gridW: pv - load - bat, batteryW: bat, soc: st.soc };
    }
    const pump = { id: 'hp', online: true, on: st.on, fault: false, outdoor: 10, flowSetpoint: st.sp, hz: running ? 60 : 0, waterOut: running ? 38 : 30, waterIn: running ? 34 : 28 };
    const zones = OFFSETS.map((d, i) => ({ id: `z${i}`, name: `z${i}`, online: true, current: Math.round((st.rooms + d) * 10) / 10, target: 24, mode: 'manual', valveOpen: st.open[i] }));
    // The guard first, as in index.ts, with the automation's previous step.
    let gv;
    if (guard) {
      const switchedBy = st.on !== lastOn ? (st.by === 'start' ? undefined : st.by) : undefined;
      const owns = cfg.enabled && !cfg.dryRun && status?.state === 'running';
      const pausedUntil = cfg.pauseUntil && now < cfg.pauseUntil ? cfg.pauseUntil : null;
      const d = guard.decide({ enabled: true }, {
        now, switchedBy, automationOwns: owns, holdRest: owns && status?.holdRest === true, pausedUntil,
        pump: { on: st.on, hz: pump.hz, sp: st.sp, out: pump.waterOut, faults: [] },
      });
      if (d.action) { sw(d.action.on, 'guard', d.action.reason); guard.commit(d.action.next); }
      gv = { enabled: true, mode: d.status.mode, restUntil: d.status.restUntil };
      pump.on = st.on;
      pump.hz = st.on && now - st.since >= 2 * MIN ? 60 : 0;
    }
    lastOn = st.on;
    status = await tick(cfg, { now: new Date(now), zones, pump, energy, guard: gv });
    lastOn = st.on;
    statuses.push({ t: now, s: status, soc: st.soc, rooms: st.rooms, on: st.on });
  }
  return { log, statuses, st, at: t => statuses.find(x => x.t >= t) };
}
const ons = log => log.filter(x => x.on);
const offs = log => log.filter(x => !x.on);
const hm = t => lisbonClock(t);

(async () => {
  // --- Lisbon clock, whatever the machine's time zone, across both changes ---
  {
    const c = live;
    // Summer time (WEST, UTC+1) on 24/10; winter (WET, UTC+0) from 01:00 UTC on 25/10.
    assert.equal(inWarmWindow(c, Date.UTC(2026, 9, 24, 7, 59)), true, '24/10 08:59 WEST');
    assert.equal(inWarmWindow(c, Date.UTC(2026, 9, 24, 8, 1)), false, '24/10 09:01 WEST');
    assert.equal(inWarmWindow(c, Date.UTC(2026, 9, 24, 17, 59)), false, '24/10 18:59 WEST');
    assert.equal(inWarmWindow(c, Date.UTC(2026, 9, 24, 18, 0)), true, '24/10 19:00 WEST');
    assert.equal(inWarmWindow(c, Date.UTC(2026, 9, 25, 8, 59)), true, '25/10 08:59 WET (the change day)');
    assert.equal(inWarmWindow(c, Date.UTC(2026, 9, 25, 9, 1)), false, '25/10 09:01 WET');
    assert.equal(inWarmWindow(c, Date.UTC(2026, 2, 29, 7, 59)), true, '29/03 08:59 WEST (spring change day)');
    assert.equal(inWarmWindow(c, Date.UTC(2026, 2, 29, 8, 1)), false, '29/03 09:01 WEST');
    assert.equal(lisbonAt('2026-10-25', '09:00'), Date.UTC(2026, 9, 25, 9, 0));
    assert.equal(lisbonAt('2026-10-24', '19:00'), Date.UTC(2026, 9, 24, 18, 0));
    assert.equal(lisbonAt('2026-03-29', '09:00'), Date.UTC(2026, 2, 29, 8, 0));
    // From the evening of 24/10 (summer), the window ends at 09:00 winter time.
    assert.equal(nextLisbon(Date.UTC(2026, 9, 24, 20, 0), '09:00'), Date.UTC(2026, 9, 25, 9, 0));
    assert.equal(nextLisbon(Date.UTC(2026, 9, 25, 15, 0), '19:00'), Date.UTC(2026, 9, 25, 19, 0));
    assert.equal(lisbonClock(Date.UTC(2026, 9, 24, 18, 0)), '19:00');
    assert.equal(lisbonClock(Date.UTC(2026, 9, 25, 18, 0)), '18:00');
    // The plan on the change day: the warm-up aims at 19:00 WET.
    const s = await createAutomation(async () => {})(c, { now: new Date(Date.UTC(2026, 9, 25, 12, 0)), zones: [], pump: undefined });
    assert.equal(s.warm.nextStart, Date.UTC(2026, 9, 25, 19, 0));
    assert.equal(s.mode, 'day');
  }

  // --- Sunny day: the battery reaches 90 % about 13:00 → daytime solar heating ---
  {
    const pv = t => Math.max(0, 6000 * Math.sin(Math.PI * ((t - L(0)) / HOUR - 8) / 10));
    const r = await simulate({ cfg: live, from: L(9), to: L(17), pv, soc: 38, rooms: 23.8, loss: 0.1 });
    const t90 = r.statuses.find(x => x.soc >= 90).t;
    assert.ok(t90 >= L(12, 30) && t90 <= L(13, 30), `battery at 90 % at ${hm(t90)}`);
    const first = ons(r.log)[0];
    assert.ok(first, 'switched on for the sun');
    assert.ok(first.t >= t90 + 10 * MIN && first.t <= t90 + 12 * MIN, `on at ${hm(first.t)}, 10 min after 90 % at ${hm(t90)}`);
    assert.match(first.reason, /com o sol: bateria 9\d %/);
    // Its own draw doesn't make the surplus vanish: no off for at least 1.5 h.
    assert.equal(r.log.filter(x => !x.on && x.t < first.t + 90 * MIN).length, 0);
    assert.ok(r.statuses.filter(x => x.t > first.t && x.t < first.t + 90 * MIN).every(x => x.s.solar.on));
    // The battery keeps charging meanwhile (the sun covers house + pump).
    assert.ok(r.at(first.t + 60 * MIN).soc > r.at(first.t).soc);
    assert.ok(ons(r.log).length <= 3, `${ons(r.log).length} switch-ons by 17:00`);
    // Before 90 %, the morning said why it was off.
    assert.match(r.at(L(11)).s.doing, /^Bomba desligada — de dia só com sol: bateria \d+ % de 90 %, [\d,]+ kW de sol a sobrar de 3,3 kW\.$/);
  }

  // --- Cloudy day: never 90 % → no daytime heating; the warm-up starts in time for 19:00 ---
  {
    const pv = t => Math.max(0, 1500 * Math.sin(Math.PI * ((t - L(0)) / HOUR - 8) / 10));
    const r = await simulate({ cfg: live, from: L(9), to: L(19, 30), pv, soc: 30, rooms: 24, loss: 0.12 });
    assert.ok(Math.max(...r.statuses.map(x => x.soc)) < 90);
    const first = ons(r.log)[0];
    assert.ok(first, 'switched on for the evening');
    assert.ok(first.t >= L(13) && first.t <= L(17, 30), `warm-up from ${hm(first.t)}: floor warm by 19:00`);
    assert.match(first.reason, /a aquecer para as 19:00/);
    const before = r.at(first.t - 30 * MIN).s;
    assert.equal(before.mode, 'day');
    assert.match(before.plan, /^Aquece a partir das \d\d:\d\d para estar quente às 19:00/);
    assert.match(before.plan, /de dia só com sol e bateria ≥ 90 %/);
    assert.equal(r.at(first.t).s.mode, 'warmup');
    assert.match(r.at(first.t + 30 * MIN).s.plan, new RegExp(`^A aquecer desde as ${hm(first.t)} para estar quente às 19:00`));
    assert.equal(r.at(L(19)).s.mode, 'warm');
    assert.ok(r.at(L(19)).s.meanRoom >= 23.9, `warm at 19:00 (${r.at(L(19)).s.meanRoom}°)`);
    // Once there, the thermostats close the valves and it stops for lack of demand, not for the clock.
    assert.ok(offs(r.log).every(x => /nenhuma zona pede calor/.test(x.reason)));
  }

  // --- The controller's 23:54 UTC timer in the warm window: back on after the minimum off time ---
  {
    const r = await simulate({
      cfg: live, from: L(23, 30), to: L(0, 40, 11), on: true, onFor: 120, rooms: 23.5,
      guard: {}, events: (t, _st, sw) => { if (t === L(23, 54)) sw(false, 'outside'); },
    });
    const back = ons(r.log);
    assert.equal(back.length, 1);
    assert.equal(back[0].t, L(0, 9, 11), `back on at ${hm(back[0].t)}`);
    assert.equal(back[0].by, 'automation', 'by the automation; the guard leaves it to it');
    assert.match(r.at(L(23, 56)).s.doing, /liga às 00:09/);
  }

  // --- A person switches it off in the warm window: back on — unless paused ---
  {
    const off2030 = (t, _st, sw) => { if (t === L(20, 30)) sw(false, 'outside'); };
    let r = await simulate({ cfg: live, from: L(20), to: L(21, 30), on: true, onFor: 60, rooms: 23.5, guard: {}, events: off2030 });
    assert.deepEqual(ons(r.log).map(x => [hm(x.t), x.by]), [['20:45', 'automation']]);
    // Paused at 20:31 until 22:30 (the app writes pauseUntil): stays off until then, by the automation and the guard alike.
    const until = L(22, 30);
    const cfgAt = t => (t >= L(20, 31) ? parseConfig({ enabled: true, dryRun: false, pauseUntil: until }) : live);
    r = await simulate({ cfg: cfgAt, from: L(20), to: L(23), on: true, onFor: 60, rooms: 23.5, guard: {}, events: off2030 });
    assert.deepEqual(ons(r.log).map(x => hm(x.t)), ['22:30'], 'back on when the pause ends');
    assert.match(r.at(L(21)).s.doing, /em pausa até às 22:30/);
    assert.match(r.at(L(21)).s.plan, /^Em pausa até às 22:30/);
    assert.equal(r.at(L(21)).s.pausedUntil, until);
    // In dry-run the guard would undo the off after 5 min; paused, it doesn't.
    r = await simulate({ cfg: parseConfig({ enabled: true, dryRun: true }), from: L(20), to: L(20, 50), on: true, onFor: 60, rooms: 23.5, guard: {}, events: off2030 });
    assert.deepEqual(ons(r.log).map(x => [hm(x.t), x.by]), [['20:35', 'guard']]);
    r = await simulate({ cfg: t => (t >= L(20, 31) ? parseConfig({ enabled: true, dryRun: true, pauseUntil: until }) : dry), from: L(20), to: L(23), on: true, onFor: 60, rooms: 23.5, guard: {}, events: off2030 });
    assert.deepEqual(ons(r.log), [], 'paused: nobody switches it back on (the dry-run automation only simulates)');
  }

  // --- Pausing a running pump switches it off at once (no minimum on time) ---
  {
    const until = L(23);
    const r = await simulate({ cfg: t => (t >= L(21) ? parseConfig({ enabled: true, dryRun: false, pauseUntil: until }) : live), from: L(20, 58), to: L(21, 5), on: true, onFor: 0, rooms: 23 });
    assert.deepEqual(offs(r.log).map(x => hm(x.t)), ['21:00']);
    assert.match(offs(r.log)[0].reason, /em pausa até às 23:00/);
  }

  // --- The guard's rest is respected: never switched on from here, held while the plan says off ---
  {
    // Warm window: the guard rests the pump 21:00–22:00 (idle at the setpoint); the automation wants heat and waits.
    const t0 = L(21);
    const r = await simulate({ cfg: live, from: L(21, 1), to: L(22, 10), on: false, onFor: 0, rooms: 23.2,
      guard: { mode: 'rest', restUntil: L(22), lastAction: { at: t0, what: 'off', reason: 'no setpoint' } } });
    assert.deepEqual(r.log.map(x => [hm(x.t), x.on, x.by]), [['22:00', true, 'guard']]);
    assert.match(r.at(L(21, 30)).s.doing, /Proteção E13: bomba em descanso até às 22:00 — liga a seguir/);
    assert.equal(r.at(L(21, 30)).s.holdRest, false);
    // By day, a rest that ends at 11:00 carries on while the plan has the pump off (no sun), until the warm-up.
    const pv = () => 800;
    const d = await simulate({ cfg: live, from: L(10, 30), to: L(19, 10), on: false, onFor: 0, rooms: 24, loss: 0.12, pv, soc: 40,
      guard: { mode: 'rest', restUntil: L(11), lastAction: { at: L(10), what: 'off', reason: 'no setpoint' } } });
    const first = d.log[0];
    assert.equal(first.by, 'guard');
    assert.ok(first.t > L(13), `held past 11:00, ended at ${hm(first.t)} when the warm-up wanted heat`);
    assert.equal(d.at(L(12)).s.holdRest, true);
    assert.equal(d.at(first.t).s.mode, 'warmup');
  }

  // --- The pump's own draw: no flapping on solar ---
  {
    const cfg = live;
    // The pitfall, in numbers: 4.5 kW of sun, the house 0.6 kW + the pump 3.3 kW.
    assert.equal(spareSun(cfg, { pvW: 4500, loadW: 3900 }, true), 3900, 'the pump taken out of the house');
    assert.equal(spareSun(cfg, { pvW: 4500, loadW: 3900 }, false), 600, 'what it would look like without that: switch itself off');
    // Three hours of steady sun with noise and an appliance's 3 kW spikes: one switch-on, no off.
    const pv = t => 4500 + 400 * Math.sin(t / (7 * MIN));
    const base = t => 600 + (((t - L(12)) / MIN) % 47 < 6 ? 3000 : 0);
    // (A house at 23.6, steady: the evening warm-up stays out of it, so this is the sun alone.)
    let r = await simulate({ cfg, from: L(12), to: L(15), pv, base, soc: 95, rooms: 23.6, loss: 0, gain: 0 });
    assert.ok(r.statuses.every(x => x.s.mode === 'day'));
    assert.equal(ons(r.log).length, 1);
    assert.equal(offs(r.log).length, 0);
    assert.ok(r.statuses.filter(x => x.t > r.log[0].t).every(x => x.s.solar.on), 'never even looked like stopping');
    // A cloud for 25 min: off after 15 min without enough sun, back on only after the minimum off time and 10 min of sun.
    const cloudy = t => (t >= L(13, 30) && t < L(13, 55) ? 600 : 4500);
    r = await simulate({ cfg, from: L(12), to: L(15), pv: cloudy, soc: 95, rooms: 23.6, loss: 0, gain: 0 });
    assert.ok(r.statuses.every(x => x.s.mode === 'day'));
    const seq = r.log.map(x => [hm(x.t), x.on]);
    assert.equal(seq.length, 3, JSON.stringify(seq));
    assert.deepEqual(seq.map(x => x[1]), [true, false, true]);
    assert.ok(r.log[1].t >= L(13, 45), `off at ${seq[1][0]}: 15 min into the cloud`);
    assert.ok(r.log[2].t - r.log[1].t >= 15 * MIN, 'minimum off time');
    assert.ok(r.log[2].t >= L(14, 5), `on again at ${seq[2][0]}: 10 min of sun back`);
  }

  // --- 21 °C day minimum: the rooms' mean, whatever the sun ---
  {
    const pv = () => 300;
    const r = await simulate({ cfg: live, from: L(10), to: L(14), pv, soc: 20, rooms: 20.75, loss: 0, gain: 0.4 });
    const seq = r.log.map(x => [hm(x.t), x.on]);
    assert.equal(seq[0][1], true);
    assert.equal(r.log[0].t, L(10, 15), 'after the minimum off time, counted from when it was first seen off (a restart knows no better)');
    assert.match(r.log[0].reason, /abaixo do mínimo de dia \(21°\)/);
    // Back to 21.5 (rising 0.4 °C/h from 20.8 mean): off, after its minimum on time.
    // Then, still 2.5° short of 24, the evening warm-up starts at its 6 h cap: 13:00.
    assert.deepEqual(seq.map(x => x[1]), [true, false, true]);
    assert.ok(r.at(r.log[1].t).rooms + 0.05 >= 21.5);
    assert.equal(seq[2][0], '13:00');
    assert.match(r.log[2].reason, /a aquecer para as 19:00/);
    assert.equal(r.at(L(12)).s.warm.capped, true);
    assert.match(r.at(L(12)).s.plan, /no máximo 6 h antes/);
    // One cold room (20.5) with the mean at 22: no heating — the mean decides, not one sensor.
    const tick = createAutomation(async () => { throw new Error('nothing to send'); }, { flow: { value: 44, at: 0 } });
    const z = [20.5, 22.5, 22.5, 22.5].map((c, i) => ({ id: `z${i}`, name: `z${i}`, online: true, current: c, target: 24, mode: 'manual', valveOpen: true }));
    const off = { id: 'hp', online: true, on: false, fault: false, outdoor: 10, flowSetpoint: 44, hz: 0 };
    const s = await tick(parseConfig({ enabled: true, dryRun: true }), { now: new Date(L(11)), zones: z, pump: off });
    assert.equal(s.wantOn, false);
    assert.equal(s.dayMinActive, false);
  }

  // --- By day, an on outside the plan is switched back off after the minimum on time; the window's end too ---
  {
    const r = await simulate({ cfg: live, from: L(11), to: L(12), rooms: 23.5, pv: () => 500, soc: 50,
      events: (t, _st, sw) => { if (t === L(11, 5)) sw(true, 'outside'); } });
    assert.deepEqual(offs(r.log).map(x => hm(x.t)), ['11:35']);
    const w = await simulate({ cfg: live, from: L(8, 30), to: L(9, 30), on: true, onFor: 120, rooms: 23.5, pv: () => 300, soc: 50 });
    assert.deepEqual(w.log.map(x => [hm(x.t), x.on]), [['09:00', false]]);
  }

  // --- Something switching the pump off over and over: re-ons capped per 24 h ---
  {
    const r = await simulate({ cfg: live, from: L(19), to: L(8, 59, 11), on: true, onFor: 60, rooms: 23,
      events: (t, st, sw) => { if (st.on && t - st.since >= 20 * MIN) sw(false, 'outside'); } });
    assert.equal(ons(r.log).filter(x => x.by === 'automation').length, MAX_ONS_PER_DAY);
    assert.match(r.statuses.at(-1).s.doing, new RegExp(`já a ligou ${MAX_ONS_PER_DAY} vezes`));
  }

  // --- Dry-run: decides and records, sends nothing; records again when the plan changes its mind ---
  {
    const r = await simulate({ cfg: dry, from: L(18), to: L(20), on: false, onFor: 300, rooms: 23.6, loss: 0 });
    assert.deepEqual(r.log, []);
    const s = r.statuses.at(-1).s;
    assert.equal(s.state, 'dry-run');
    assert.ok(s.actions.some(a => /^ligar \(a aquecer para as 19:00\)/.test(a.what) && !a.sent), 'the warm-up, simulated');
    assert.equal(s.actions.filter(a => /^ligar/.test(a.what)).length, 1, 'recorded once');
  }

  // --- The status carries what the app shows on top ---
  {
    const s = await createAutomation(async () => {})(live, { now: new Date(L(15)), zones: [], pump: undefined });
    assert.deepEqual(s.settings, { warmFrom: '19:00', warmTo: '09:00', comfort: 24, dayMin: 21, socOn: 90 });
    assert.equal(s.pausedUntil, null);
    const off = await createAutomation(async () => {})(parseConfig({ pauseUntil: L(18) }), { now: new Date(L(15)), zones: [], pump: undefined });
    assert.equal(off.state, 'off');
    assert.equal(off.pausedUntil, L(18), 'a pause shows even with the automation off (it holds the guard)');
  }

  console.log('all solar-heating scenarios pass');
})().catch(e => { console.error(e); process.exit(1); });
