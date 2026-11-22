// The 2026-10-26 heating plan: warm floor 19:00–09:00, daytime heating only on
// spare sun (battery ≥ 90 %), a 21 °C day minimum, the automation owning on/off
// whoever switched the pump, and "Pausar". Against a small
// simulated house — no house attached. Run: pnpm --filter domotics-bridge test
// (it runs this file under a foreign time zone too: every instant here is UTC,
// and the automation must find Lisbon's clock by itself).
const assert = require('node:assert/strict');
const {
  createAutomation, parseConfig, inWarmWindow, lisbonAt, lisbonClock, nextLisbon, spareSun, MAX_ONS_PER_DAY,
} = require('../lib/automation.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
/** November: Lisbon is on UTC, so these read as Lisbon times. */
const L = (h, m = 0, d = 10) => Date.UTC(2026, 10, d, h, m);
const live = parseConfig({ enabled: true, dryRun: false });
const dry = parseConfig({ enabled: true, dryRun: true });
const OFFSETS = [-0.2, 0, 0.1, 0.3];

/**
 * A tiny house. The pump does what it's told (by the automation or
 * `events`); its compressor runs 2 min after a switch-on. Rooms warm `gain` °C/h
 * through an open valve while it runs and cool `loss` °C/h otherwise; each
 * thermostat opens at 0.3 below its target (24 until the automation sets
 * another) and closes at it. The inverter: panels `pv(t)`, house `base(t)` +
 * 3.3 kW while the compressor runs, a 30 kWh battery taking or giving the
 * difference, the grid the rest. With `cap` (W), the house's RENAC instead:
 * the battery charges at most `cap`, and the panels make only what the house
 * and the battery take (no export), `pv(t)` being what they could make.
 */
async function simulate(o) {
  const step = o.step ?? MIN;
  const cfgAt = typeof o.cfg === 'function' ? o.cfg : () => o.cfg;
  const st = {
    on: o.on ?? false, since: o.from - (o.onFor ?? 0) * MIN, by: 'start',
    rooms: o.rooms ?? 24, sp: 44, soc: o.soc ?? 50,
    open: OFFSETS.map(d => (o.rooms ?? 24) + d < 24),
    tgt: OFFSETS.map(() => 24),
  };
  const log = [];
  let now = o.from;
  const sw = (on, by, reason) => {
    if (st.on !== on) { st.on = on; st.since = now; st.by = by; }
    log.push({ t: now, on, by, reason });
  };
  const tick = createAutomation(async (id, cmds, reason) => {
    for (const c of cmds) {
      if (c.code === 'switch') sw(c.value, 'automation', reason);
      if (c.code === 'p02_heating') st.sp = c.value;
      if (c.code === 'temp_set' && /^z\d$/.test(id)) st.tgt[Number(id.slice(1))] = c.value / 10;
    }
  }, { flow: { value: 44, at: 0 }, ...(o.memory ?? {}) });
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
    st.open = OFFSETS.map((d, i) => (st.rooms + d >= st.tgt[i] ? false : st.rooms + d <= st.tgt[i] - 0.3 ? true : st.open[i]));
    // Inverter and battery.
    let energy;
    if (o.pv && o.cap) {
      const could = o.pv(now);
      const load = (o.base?.(now) ?? 300) + (running ? 3300 : 0);
      const takes = st.soc >= 100 ? 0 : o.cap;
      const pv = Math.min(could, load + takes);
      let bat = Math.max(-5000, pv - load);
      if (st.soc <= 10 && bat < 0) bat = 0;
      st.soc = Math.min(100, st.soc + (bat * h) / 30_000 * 100);
      energy = { pvW: pv, loadW: load, gridW: pv - load - bat, batteryW: bat, soc: st.soc };
    } else if (o.pv) {
      const pv = o.pv(now);
      const load = (o.base?.(now) ?? 500) + (running ? 3300 : 0);
      let bat = Math.max(-5000, Math.min(5000, pv - load));
      if (st.soc >= 100 && bat > 0) bat = 0;
      if (st.soc <= 10 && bat < 0) bat = 0;
      st.soc = Math.min(100, st.soc + (bat * h) / 30_000 * 100);
      energy = { pvW: pv, loadW: load, gridW: pv - load - bat, batteryW: bat, soc: st.soc };
    }
    const pump = { id: 'hp', online: true, on: st.on, fault: false, outdoor: 10, flowSetpoint: st.sp, hz: running ? 60 : 0, waterOut: running ? 38 : 30, waterIn: running ? 34 : 28 };
    const zones = OFFSETS.map((d, i) => ({ id: `z${i}`, name: `z${i}`, online: true, current: Math.round((st.rooms + d) * 10) / 10, target: st.tgt[i], mode: 'manual', valveOpen: st.open[i] }));
    status = await tick(cfg, { now: new Date(now), zones, pump, energy });
    statuses.push({ t: now, s: status, soc: st.soc, rooms: st.rooms, on: st.on, energy, tgt: [...st.tgt] });
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
    assert.match(r.at(L(11)).s.doing, /^Bomba desligada — de dia só com sol: bateria \d+ % de 90 %, a carregar [\d,]+ kW de 2,7 kW\.$/);
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
      events: (t, _st, sw) => { if (t === L(23, 54)) sw(false, 'outside'); },
    });
    const back = ons(r.log);
    assert.equal(back.length, 1);
    assert.equal(back[0].t, L(0, 9, 11), `back on at ${hm(back[0].t)}`);
    assert.equal(back[0].by, 'automation', 'by the automation');
    assert.match(r.at(L(23, 56)).s.doing, /liga às 00:09/);
  }

  // --- A person switches it off in the warm window: back on — unless paused ---
  {
    const off2030 = (t, _st, sw) => { if (t === L(20, 30)) sw(false, 'outside'); };
    let r = await simulate({ cfg: live, from: L(20), to: L(21, 30), on: true, onFor: 60, rooms: 23.5, events: off2030 });
    assert.deepEqual(ons(r.log).map(x => [hm(x.t), x.by]), [['20:45', 'automation']]);
    // Paused at 20:31 until 22:30 (the app writes pauseUntil): stays off until then.
    const until = L(22, 30);
    const cfgAt = t => (t >= L(20, 31) ? parseConfig({ enabled: true, dryRun: false, pauseUntil: until }) : live);
    r = await simulate({ cfg: cfgAt, from: L(20), to: L(23), on: true, onFor: 60, rooms: 23.5, events: off2030 });
    assert.deepEqual(ons(r.log).map(x => hm(x.t)), ['22:30'], 'back on when the pause ends');
    assert.match(r.at(L(21)).s.doing, /em pausa até às 22:30/);
    assert.match(r.at(L(21)).s.plan, /^Em pausa até às 22:30/);
    assert.equal(r.at(L(21)).s.pausedUntil, until);
    // In dry-run nothing is sent, so nobody undoes the off, paused or not.
    r = await simulate({ cfg: parseConfig({ enabled: true, dryRun: true }), from: L(20), to: L(20, 50), on: true, onFor: 60, rooms: 23.5, events: off2030 });
    assert.deepEqual(ons(r.log), [], 'dry-run: the automation only simulates');
    assert.match(r.at(L(20, 46)).s.doing, /^Ligaria a bomba/);
    r = await simulate({ cfg: t => (t >= L(20, 31) ? parseConfig({ enabled: true, dryRun: true, pauseUntil: until }) : dry), from: L(20), to: L(23), on: true, onFor: 60, rooms: 23.5, events: off2030 });
    assert.deepEqual(ons(r.log), [], 'paused: nobody switches it back on (the dry-run automation only simulates)');
  }

  // --- Pausing a running pump switches it off at once (no minimum on time) ---
  {
    const until = L(23);
    const r = await simulate({ cfg: t => (t >= L(21) ? parseConfig({ enabled: true, dryRun: false, pauseUntil: until }) : live), from: L(20, 58), to: L(21, 5), on: true, onFor: 0, rooms: 23 });
    assert.deepEqual(offs(r.log).map(x => hm(x.t)), ['21:00']);
    assert.match(offs(r.log)[0].reason, /em pausa até às 23:00/);
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

  // --- The sun the inverter holds back (2026-11-02): the battery at its 3 kW limit, far from full ---
  {
    // The plan agreed on 2/11, with heating on sun: 25 in the rooms, 26 while on sun, battery ≥ 40 %.
    const nov = (extra = {}) => parseConfig({
      enabled: true, dryRun: false, comfort: 25, dayMin: 21,
      windows: [{ from: '17:00', to: '23:00' }, { from: '06:00', to: '08:00' }], warmupMaxMin: 30,
      solar: { enabled: true, socOn: 40, chargeW: 2700, keepChargeW: 1500, boost: 1 },
      flow: { enabled: false }, recovery: { enabled: false }, rest: { enabled: false },
      limits: { roomMin: 21, roomMax: 26 }, ...extra,
    });
    // What the panels could make on a sunny November day: 5.4 kW at 10:00, 7 kW at 12:00, 2.4 kW at 15:30.
    const could = t => Math.max(0, 7000 * Math.sin(Math.PI * ((t - L(0)) / HOUR - 7.5) / 9));
    const day = { from: L(9), to: L(17), pv: could, cap: 3000, soc: 20, rooms: 23.5, loss: 0.1, gain: 0.3 };
    const r = await simulate({ ...day, cfg: nov() });
    // Before, the throttled inverter: the battery at its limit, nothing going out, no spare sun to see.
    const t40 = r.statuses.find(x => x.soc >= 40).t;
    const before = r.at(t40 - 5 * MIN);
    assert.ok(before.energy.batteryW >= 2900 && before.energy.gridW === 0, JSON.stringify(before.energy));
    assert.ok(spareSun(nov(), before.energy, false) < 3300, 'what the old rule waited for never shows');
    assert.ok(r.statuses.filter(x => x.t < t40).every(x => !x.s.solar.on), 'not before the battery has 40 %');
    const first = ons(r.log)[0];
    assert.ok(first && first.t >= t40 + 10 * MIN && first.t <= t40 + 15 * MIN, `on at ${first && hm(first.t)}, battery at 40 % at ${hm(t40)}`);
    assert.match(first.reason, /com o sol: bateria \d+ %, a carregar [\d,]+ kW/);
    // The thermostats at 26 while it heats on sun, so the floor takes the heat.
    const mid = r.at(first.t + 30 * MIN);
    assert.equal(mid.s.roomTarget, 26);
    assert.ok(mid.tgt.every(x => x === 26), JSON.stringify(mid.tgt));
    assert.ok(mid.s.reasons.some(x => /^Com o sol: divisões a 26°C/.test(x)));
    // On the sun the panels were holding back: the battery still charging, nothing bought.
    const run = r.statuses.filter(x => x.t > first.t + 5 * MIN && x.t < offs(r.log)[0].t);
    assert.ok(run.length > 120, `${run.length} min on sun`);
    assert.ok(run.every(x => x.energy.gridW >= 0), 'nothing bought');
    assert.ok(run.filter(x => x.energy.batteryW < 1500).length <= 15, 'below the keep level only until it stops');
    // It stops as the sun weakens, and doesn't flap back on through the afternoon.
    const stop = offs(r.log)[0];
    assert.ok(stop.t >= L(14) && stop.t <= L(15, 30), `off at ${hm(stop.t)}`);
    assert.deepEqual(r.log.filter(x => x.t > stop.t && x.t < L(16, 30)).map(x => [hm(x.t), x.on]), []);
    assert.match(r.at(stop.t + 20 * MIN).s.solar.note, /o sol não chegou para a bomba, volta a tentar às \d\d:\d\d/);
    // The warm-up at 16:30, the thermostats back to 25.
    assert.equal(r.at(L(16, 45)).s.mode, 'warmup');
    assert.equal(r.at(L(16, 45)).s.roomTarget, 25);
    assert.ok(r.at(L(16, 55)).tgt.every(x => x === 25));
    // Against the same day without it: rooms ~1° warmer at 16:25, the battery only a few points lower.
    const w = await simulate({ ...day, cfg: nov({ solar: { enabled: false } }) });
    const a = r.at(L(16, 25)), b = w.at(L(16, 25));
    assert.ok(a.rooms - b.rooms >= 0.8, `rooms ${a.rooms.toFixed(2)} vs ${b.rooms.toFixed(2)}`);
    assert.ok(b.soc - a.soc <= 8, `battery ${a.soc.toFixed(0)} % vs ${b.soc.toFixed(0)} %`);
    assert.equal(ons(w.log).filter(x => x.t < L(16, 30)).length, 0, 'without it, off all day');
    console.log(`  November sun (simulated): on ${hm(first.t)}–${hm(stop.t)}; at 16:25 rooms ${b.rooms.toFixed(1)} → ${a.rooms.toFixed(1)}°, battery ${b.soc.toFixed(0)} → ${a.soc.toFixed(0)} %`);

    // A cloud while it runs: off 15 min in (the pump would be on the battery), back on only an hour later.
    const cloud = t => (t >= L(12) && t < L(12, 40) ? 2000 : could(t));
    const c = await simulate({ ...day, pv: cloud, cfg: nov() });
    const cOff = offs(c.log)[0];
    assert.ok(cOff.t >= L(12, 15) && cOff.t <= L(12, 17), `off at ${hm(cOff.t)}`);
    const drained = c.statuses.filter(x => x.t >= L(12) && x.t < cOff.t && x.energy.batteryW < 0)
      .reduce((sum, x) => sum - x.energy.batteryW / 60, 0);
    assert.ok(drained < 600, `${Math.round(drained)} Wh from the battery`);
    const again = ons(c.log).find(x => x.t > cOff.t);
    assert.ok(again && again.t >= cOff.t + 70 * MIN && again.t <= cOff.t + 75 * MIN, `on again at ${again && hm(again.t)}`);
  }

  // --- A full battery: the panels make only what the house takes; heating on sun until a cloud ---
  {
    const cfg = parseConfig({ enabled: true, dryRun: false, comfort: 25, solar: { socOn: 40, boost: 1 }, limits: { roomMax: 26 }, flow: { enabled: false } });
    const pv = t => (t >= L(12) && t < L(12, 40) ? 800 : 4500);
    const r = await simulate({ cfg, from: L(11), to: L(13), pv, cap: 3000, soc: 100, rooms: 23.5, loss: 0, gain: 0 });
    const s0 = r.at(L(11, 5));
    assert.equal(s0.energy.batteryW, 0, 'full: nothing to charge');
    assert.equal(s0.energy.pvW, 300, 'the panels held to what the house takes');
    const first = ons(r.log)[0];
    // 10 min of it, then the minimum off time counted from when it was first seen off (11:00).
    assert.equal(first.t, L(11, 15), `on at ${hm(first.t)}`);
    assert.match(first.reason, /com o sol: bateria 100 %, cheia/);
    assert.equal(r.at(L(11, 40)).energy.batteryW, 0, 'the panels cover the pump');
    assert.equal(r.at(L(11, 40)).s.roomTarget, 26);
    const off = offs(r.log)[0];
    assert.ok(off.t >= L(12, 15) && off.t <= L(12, 17), `off at ${hm(off.t)}`);
    // Weak sun on a full battery is no signal: it would be the battery heating the house.
    const weak = await simulate({ cfg, from: L(11), to: L(12), pv: () => 150, cap: 3000, soc: 100, rooms: 23.5, loss: 0, gain: 0 });
    assert.deepEqual(weak.log, []);
  }

  // --- The status carries what the app shows on top ---
  {
    const s = await createAutomation(async () => {})(live, { now: new Date(L(15)), zones: [], pump: undefined });
    assert.deepEqual(s.settings, { warmFrom: '19:00', warmTo: '09:00', comfort: 24, dayMin: 21, socOn: 90, windows: [{ from: '19:00', to: '09:00' }], solar: { enabled: true, boost: 0 } });
    assert.equal(s.pausedUntil, null);
    const off = await createAutomation(async () => {})(parseConfig({ pauseUntil: L(18) }), { now: new Date(L(15)), zones: [], pump: undefined });
    assert.equal(off.state, 'off');
    assert.equal(off.pausedUntil, L(18), 'a pause shows even with the automation off');
  }

  console.log('all solar-heating scenarios pass');
})().catch(e => { console.error(e); process.exit(1); });
