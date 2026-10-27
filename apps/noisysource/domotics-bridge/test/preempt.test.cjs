// E13 early warning (src/preempt.ts) and what the guard does with it
// (src/guard.ts), against the recorded trips (test/fixtures/e13-trips.json,
// from `domotics_incidents` on kidclub-dev), the 21–24/10 logs in deploy/ and
// the end of the healthy run of 27/10. No house attached.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { watchDischarge, INITIAL_WATCH, RISE_PER_30S, MAX_BASE_DIS, COIL_DROP } = require('../lib/preempt.js');
const {
  createGuard, parseGuardConfig, INITIAL_GUARD, REST_PREEMPT_MS, REST_PREEMPT_LONG_MS, REST_AFTER_TRIP_MS,
} = require('../lib/guard.js');
const { DEFAULT_LOGS, readLog } = require('../deploy/backfill-incidents.cjs');

const MIN = 60_000;
const SEC = 1000;
const trips = require('./fixtures/e13-trips.json');
const healthy = require('./fixtures/healthy-run-2026-10-27.json').readings;
const running = s => s.on && s.hz > 0 && s.faults.length === 0;
const lisbonHHMM = t => new Date(t).toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit' });

function replay(samples, from = INITIAL_WATCH) {
  let w = from;
  const hits = [];
  for (const s of samples) {
    const r = watchDischarge(w, s);
    w = r.watch;
    if (r.hit) hits.push({ t: s.t, ...r.hit });
  }
  return { hits, watch: w };
}

// --- The rule, on made-up readings -------------------------------------------
{
  const T = Date.UTC(2026, 9, 27, 7, 0);
  const at = (sec, over = {}) => ({ t: T + sec * SEC, on: true, hz: 50, dis: 44, coil: 6, faults: [], ...over });
  const steady = Array.from({ length: 20 }, (_, i) => at(i * 30));
  // The jump at 10 min, coil falling with it: a hit, stated as the reason will say it.
  let r = replay([...steady, at(600, { dis: 47.5, coil: 5 })]);
  assert.equal(r.hits.length, 1);
  assert.deepEqual({ ...r.hits[0], t: undefined }, { t: undefined, from: 44, to: 47.5, seconds: 30, per30: 3.5, coilFrom: 6, coilTo: 5, runMin: 10 });
  // The same jump in the warm-up (run younger than 5 min): nothing. Warm-ups jump 4–8 °C a reading.
  assert.equal(replay([at(0), at(30), at(60, { dis: 52, coil: 4 })]).hits.length, 0);
  // From a high discharge (healthy runs sit at 60–100 °C): nothing.
  assert.equal(replay([...steady.map(s => ({ ...s, dis: 75 })), at(600, { dis: 80, coil: 4 })]).hits.length, 0);
  // Discharge up, coil steady (the healthy warm-ups through the low 40s): nothing.
  assert.equal(replay([...steady, at(600, { dis: 48, coil: 5.5 })]).hits.length, 0);
  // No coil reading: nothing — the discharge alone fires on healthy warm-ups.
  assert.equal(replay([...steady.map(s => ({ ...s, coil: undefined })), at(600, { dis: 48, coil: undefined })]).hits.length, 0);
  // 2.9 °C in 30 s: not enough. 3 °C over 32–35 s (poll jitter): enough.
  assert.equal(replay([...steady, at(600, { dis: 46.9, coil: 5 })]).hits.length, 0);
  assert.equal(replay([...steady, at(605, { dis: 47, coil: 5 })]).hits.length, 1);
  // Over a missed poll (60 s), 3 °C is half the rate: nothing; 6 °C is enough.
  assert.equal(replay([...steady.slice(0, -1), at(600, { dis: 47, coil: 5 })]).hits.length, 0);
  assert.equal(replay([...steady.slice(0, -1), at(600, { dis: 50.5, coil: 5 })]).hits.length, 1);
  // An extra read a few seconds after the last (someone opened the app) isn't scaled up…
  assert.equal(replay([...steady, at(575, { dis: 44.5, coil: 6 })]).hits.length, 0);
  // …and the next poll is still compared with the older reading.
  assert.equal(replay([...steady, at(575, { dis: 45.5, coil: 5.5 }), at(600, { dis: 47.5, coil: 5 })]).hits.length, 1);
  // A gap of more than 3 min (bridge restart, pump unreachable): the run counts from the next reading.
  r = replay([...steady.slice(0, 10), at(600, { dis: 44 }), at(630, { dis: 47.5, coil: 5 })]);
  assert.equal(r.hits.length, 0);
  // A second jump in the same run, once the first warning is stale, is a warning of its own.
  r = replay([...steady, at(600, { dis: 47.5, coil: 5 }), ...Array.from({ length: 10 }, (_, i) => at(630 + i * 30, { dis: 45, coil: 5 })), at(930, { dis: 48.5, coil: 4 })]);
  assert.equal(r.hits.length, 2);
  assert.equal(r.watch.warning.at, T + 930 * SEC);
  // The warning stays for the run and goes when it stops.
  r = replay([...steady, at(600, { dis: 47.5, coil: 5 })]);
  assert.equal(r.watch.warning.at, T + 600 * SEC);
  assert.equal(watchDischarge(r.watch, at(630, { on: false, hz: 0 })).watch.warning, null);
  assert.equal(watchDischarge(r.watch, at(630, { hz: 0, faults: ['E13'] })).watch.warning, null);
}

// --- Timing on every recorded trip -------------------------------------------
const leads = [];
{
  for (const trip of trips) {
    const rows = trip.before;
    let i = rows.length;
    while (i > 0 && running(rows[i - 1])) i--;
    const runFrom = i > 0 && i < rows.length ? rows[i].t : null;
    const hasCoil = rows.some(s => s.coil !== undefined);
    const hits = replay(rows).hits.filter(h => runFrom !== null && h.t >= runFrom);
    const when = new Date(trip.at).toISOString().slice(5, 16);
    if (runFrom === null || !hasCoil) {
      // 21/10: one reading a minute, no coil; 10:45 also began before the readings.
      assert.equal(hits.length, 0, `${when}: no coil, no warning`);
      leads.push(`${when} (sem C00)`);
      continue;
    }
    assert.ok(hits.length > 0, `${when}: a warning before the trip`);
    const lead = (trip.at - hits[0].t) / SEC;
    assert.ok(lead >= 30, `${when}: ${lead} s ahead, at least 30 s`);
    leads.push(`${when} ${Math.round(lead)} s`);
  }
  // Exactly what the PR and preempt.ts say.
  assert.deepEqual(leads.map(l => l.split(' ').at(-1)), [
    'C00)', 'C00)', // 21/10
    's', 's', 's', 's', 's', // 22/10
    's', 's', 's', 's', 's', 's', 's', 's', // 26–27/10
  ]);
  const secs = leads.filter(l => l.endsWith(' s')).map(l => Number(l.split(' ')[1]));
  assert.deepEqual(secs, [62, 73, 31, 62, 61, 91, 91, 92, 91, 61, 121, 91, 61]);
  console.log(`  early warning on the recorded trips (threshold ${RISE_PER_30S} °C/30 s, base ≤ ${MAX_BASE_DIS} °C, coil −${COIL_DROP} °C): ${leads.join(', ')}`);
}

// --- No warning in healthy runs ------------------------------------------------
{
  let inTripRuns = 0;
  let falsePositives = 0;
  let readings = 0;
  for (const spec of DEFAULT_LOGS) {
    const { samples } = readLog(spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1));
    readings += samples.length;
    const tripAt = samples.filter((s, i) => s.faults.length && (i === 0 || !samples[i - 1].faults.length)).map(s => s.t);
    for (const h of replay(samples).hits) {
      // A hit counts as right only if the same run, unbroken, ends in a trip.
      const next = tripAt.find(t => t > h.t);
      const sameRun = next !== undefined && samples.filter(s => s.t > h.t && s.t < next).every(running);
      if (sameRun) inTripRuns++; else falsePositives++;
    }
  }
  assert.equal(falsePositives, 0, 'no warning outside a run that ended in E13');
  assert.equal(inTripRuns, 5, 'the five 22/10 trips in the logs');
  // 27/10 evening, after the reset: 75 °C discharge at 54 Hz, water at the setpoint, no trip.
  assert.equal(replay(healthy).hits.length, 0);
  console.log(`  early warning on the logs: ${falsePositives} false positives in ${readings} readings (${inTripRuns} hits, all before a trip)`);
}

// --- Settings ------------------------------------------------------------------
assert.deepEqual(parseGuardConfig({ enabled: true }), { enabled: true, preempt: true }, 'absent means on (an older cache too)');
assert.deepEqual(parseGuardConfig({ enabled: true, preempt: false }), { enabled: true, preempt: false });
assert.deepEqual(parseGuardConfig(undefined), { enabled: false, preempt: true });

// --- The guard acting on it ----------------------------------------------------
const on = { enabled: true, preempt: true };
const noPreempt = { enabled: true, preempt: false };
const T0 = Date.UTC(2026, 9, 27, 19, 0); // winter time: Lisbon = UTC
/** A run like 26–27/10: steady at 50 Hz far below the setpoint, then the jump at `jumpMin`. */
function faultyRun(start, jumpMin = 8) {
  const out = [{ t: start, on: true, hz: 0, sp: 44, out: 28, dis: 40, coil: 12, faults: [] }];
  for (let sec = 30; sec <= jumpMin * 60; sec += 30) out.push({ t: start + sec * SEC, on: true, hz: 50, sp: 44, out: 33, dis: 43, coil: 6, faults: [] });
  out.push({ t: start + (jumpMin * 60 + 30) * SEC, on: true, hz: 50, sp: 44, out: 32.5, dis: 47, coil: 4.5, faults: [] });
  return out;
}
const pumpOf = s => ({ on: s.on, hz: s.hz, sp: s.sp, out: s.out, dis: s.dis, coil: s.coil, faults: s.faults });
const off = t => ({ on: false, hz: 0, sp: 44, out: 33, dis: 40, coil: 10, faults: [] });
/** Feeds readings; commits every action (the pump follows); returns the actions. */
function feed(g, cfg, rows, extra = {}) {
  const actions = [];
  for (const s of rows) {
    const d = g.decide(cfg, { now: s.t, pump: pumpOf(s), ...extra });
    if (d.action) { actions.push({ t: s.t, ...d.action, status: d.status }); g.commit(d.action.next); }
  }
  return actions;
}
{
  // Warning → off → 5 min → on, with the reason in Portuguese, and the status for the app.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const run = faultyRun(T0);
  const acts = feed(g, on, run);
  assert.equal(acts.length, 1);
  const stop = acts[0];
  assert.equal(stop.on, false);
  assert.equal(stop.t, run.at(-1).t, 'on the reading that showed the jump');
  assert.equal(stop.reason, `descarga a subir 43 → 47 °C em 30 s aos 8 min — desligada antes do E13, volta a ligar às ${lisbonHHMM(stop.t + REST_PREEMPT_MS)}`);
  assert.equal(g.state().mode, 'rest');
  assert.equal(g.state().restUntil, stop.t + REST_PREEMPT_MS);
  assert.equal(stop.status.preempt.stopsToday, 1);
  assert.equal(stop.status.preempt.note, 'Antecipa o E13 — desligou 1 vez hoje antes do disparo');
  assert.deepEqual(stop.status.preempt.lastStop, { at: stop.t, reason: stop.reason });
  // Resting: nothing until the 5 min are up, then back on ("fim do descanso").
  assert.equal(g.decide(on, { now: stop.t + 30 * SEC, pump: off() }).action, undefined);
  assert.equal(g.decide(on, { now: stop.t + 4.5 * MIN, pump: off() }).action, undefined);
  const back = g.decide(on, { now: stop.t + 5 * MIN, pump: off() });
  assert.equal(back.action.on, true);
  assert.equal(back.action.reason, 'fim do descanso');
  g.commit(back.action.next);
  assert.equal(g.state().restKind, null);
  // The next run starts the count again: its own warm-up doesn't fire.
  const acts2 = feed(g, on, faultyRun(stop.t + 5.5 * MIN, 3).slice(0, 6));
  assert.equal(acts2.length, 0);
}
{
  // Real readings: the guard switches off on the reading the detector flagged, before each 26–27/10 trip.
  for (const trip of trips.filter(t => t.origin === 'bridge')) {
    const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
    const stops = [];
    for (const s of trip.before) {
      const d = g.decide(on, { now: s.t, pump: pumpOf(s) });
      if (d.action) { stops.push(d.action); g.commit(d.action.next); }
    }
    const preempt = stops.filter(a => /antes do E13/.test(a.reason));
    assert.ok(preempt.length >= 1, `guard stops before ${new Date(trip.at).toISOString()}`);
    assert.match(preempt.at(-1).reason, /^descarga a subir \d+(,\d)? → \d+(,\d)? °C em \d+ s aos \d+ min — desligada antes do E13, volta a ligar às \d\d:\d\d$/);
  }
}
{
  // At most 5 a rolling hour; past that, rests of 30 min. (Runs of 5 min, so
  // the cycles are 11 min; the 7–9 min runs since 26/10 plus the pump's own
  // restart delay make ~4 an hour, under the cap.)
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  let t = T0;
  const rests = [];
  const reasons = [];
  for (let i = 0; i < 7; i++) {
    const [stop] = feed(g, on, faultyRun(t, 5));
    rests.push((stop.next.restUntil - stop.t) / MIN);
    reasons.push(stop.reason);
    const end = stop.next.restUntil;
    const back = g.decide(on, { now: end, pump: off() });
    assert.equal(back.action.on, true);
    g.commit(back.action.next);
    t = end + 30 * SEC;
  }
  assert.deepEqual(rests, [5, 5, 5, 5, 5, 30, 5], 'the 6th within the hour rests 30 min; after that, 3 in the hour again');
  assert.match(reasons[5], /, volta a ligar às \d\d:\d\d \(já 5 vezes na última hora: descanso de 30 min\)$/);
  assert.doesNotMatch(reasons[6], /última hora/);
}
{
  // Trips anyway: the usual 120 min after a trip; two within 6 h, and the warning is off for 24 h.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const run = faultyRun(T0, 8);
  feed(g, on, run.slice(0, -1)); // the warning came too late to be seen: straight to the trip
  let t = run.at(-1).t;
  let d = g.decide(on, { now: t, pump: { ...pumpOf(run.at(-1)), hz: 0, faults: ['E13'] } });
  assert.equal(d.action.on, false);
  assert.match(d.action.reason, /120 min/);
  g.commit(d.action.next);
  assert.equal(g.state().preemptTrips.length, 1);
  assert.equal(d.status.preempt.active, true, 'one trip: still on');
  // Back on after the rest; it trips again 3 h after the first.
  const second = faultyRun(t + 3 * 60 * MIN, 8);
  d = g.decide(on, { now: t + REST_AFTER_TRIP_MS, pump: off() });
  g.commit(d.action.next);
  feed(g, on, second.slice(0, -1));
  t = second.at(-1).t;
  d = g.decide(on, { now: t, pump: { ...pumpOf(second.at(-1)), hz: 0, faults: ['E13'] } });
  g.commit(d.action.next);
  assert.equal(d.status.preempt.active, false);
  assert.equal(d.status.preempt.offUntil, t + 24 * 60 * MIN);
  assert.match(d.status.note, new RegExp(`Antecipação desligada até amanhã às ${lisbonHHMM(t)}: dois E13 mesmo assim$`));
  assert.match(d.status.preempt.note, /^Antecipação desligada até amanhã às \d\d:\d\d: dois E13 mesmo assim$/);
  // Meanwhile a jump is left alone…
  d = g.decide(on, { now: t + REST_AFTER_TRIP_MS, pump: off() });
  g.commit(d.action.next);
  assert.equal(feed(g, on, faultyRun(t + REST_AFTER_TRIP_MS + 30 * SEC, 8)).length, 0, 'no stops while it is off');
  // …and 24 h later it's back.
  const later = t + 24 * 60 * MIN + MIN;
  g.decide(on, { now: later, pump: off() });
  const acts = feed(g, on, faultyRun(later + 30 * SEC, 8));
  assert.equal(acts.length, 1);
  assert.match(acts[0].reason, /antes do E13/);
  // Switched off and on in the app: the count starts afresh.
  const g2 = createGuard({ ...INITIAL_GUARD, mode: 'watch', preemptOffUntil: T0 + 10 * 60 * MIN, preemptTrips: [] });
  g2.decide(noPreempt, { now: T0, pump: off() });
  assert.equal(g2.state().preemptOffUntil, 0);
}
{
  // Trips anyway while it was being switched off (fault during the 5-min rest): the 120-min rest instead.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const [stop] = feed(g, on, faultyRun(T0));
  const t = stop.t + 30 * SEC;
  const d = g.decide(on, { now: t, pump: { ...off(), faults: ['E13'] } });
  assert.equal(d.action, undefined);
  assert.equal(g.state().restUntil, t + REST_AFTER_TRIP_MS);
  assert.equal(g.state().preemptTrips.length, 1);
  assert.equal(g.decide(on, { now: stop.t + 10 * MIN, pump: off() }).action, undefined, 'not back on at 5 min');
}
{
  // preempt: false — today's behaviour: the same jump switches nothing, everything else as before.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  assert.equal(feed(g, noPreempt, faultyRun(T0)).length, 0);
  const s = g.decide(noPreempt, { now: T0 + 10 * MIN, pump: pumpOf(faultyRun(T0).at(-1)) }).status;
  assert.equal(s.preempt.enabled, false);
  assert.equal(s.preempt.note, 'Antecipação do E13 desligada');
  assert.doesNotMatch(s.note, /Antecipação/);
  // The idle rule and the trip rest are unchanged, with the warning on or off.
  for (const cfg of [on, noPreempt]) {
    const g2 = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
    g2.decide(cfg, { now: T0, pump: { on: true, hz: 50, sp: 44, out: 40, faults: [] } });
    assert.match(g2.decide(cfg, { now: T0 + 10 * MIN, pump: { on: true, hz: 44, sp: 44, out: 43, faults: [] } }).action.reason, /no setpoint/);
    const g3 = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
    assert.match(g3.decide(cfg, { now: T0, pump: { on: true, hz: 0, sp: 44, out: 33, faults: ['E13'] } }).action.reason, /120 min/);
  }
  // Guard off altogether: no warning either.
  const g4 = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  assert.equal(feed(g4, { enabled: false, preempt: true }, faultyRun(T0)).length, 0);
}
{
  // The idle rule comes first when both apply: its 60-min rest.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const run = faultyRun(T0).map(s => ({ ...s, hz: s.hz ? 40 : 0, out: 43.5 }));
  const [stop] = feed(g, on, run);
  assert.match(stop.reason, /no setpoint/);
}
{
  // Automation live: the rest is held while its plan has the pump off, then the plan decides (holdRest).
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const [stop] = feed(g, on, faultyRun(T0), { automationOwns: true });
  assert.match(stop.reason, /descansa até às \d\d:\d\d e depois decide a automação$/);
  const end = stop.next.restUntil;
  let d = g.decide(on, { now: end, pump: off(), automationOwns: true, holdRest: true });
  assert.equal(d.action, undefined, 'plan has it off: the rest carries on');
  assert.match(d.status.note, /a automação não quer calor agora/);
  d = g.decide(on, { now: end + 40 * MIN, pump: off(), automationOwns: true, holdRest: true });
  assert.equal(d.action, undefined);
  d = g.decide(on, { now: end + 41 * MIN, pump: off(), automationOwns: true, holdRest: false });
  assert.equal(d.action.on, true, 'plan wants heat: back on');
  // Plan wants heat at the end of the rest: back on straight away.
  const g2 = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const [stop2] = feed(g2, on, faultyRun(T0), { automationOwns: true });
  assert.equal(g2.decide(on, { now: stop2.next.restUntil, pump: off(), automationOwns: true, holdRest: false }).action.on, true);
}
{
  // No switch-on when it shouldn't be: a pause; the guard switched off in the app while paused.
  const until = T0 + 3 * 60 * MIN;
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const [stop] = feed(g, on, faultyRun(T0), { pausedUntil: until });
  assert.match(stop.reason, /em pausa, só volta a ligar depois das/);
  assert.equal(g.decide(on, { now: stop.next.restUntil + MIN, pump: off(), pausedUntil: until }).action, undefined);
  assert.equal(g.decide({ enabled: false, preempt: true }, { now: stop.next.restUntil + 2 * MIN, pump: off(), pausedUntil: until }).action, undefined);
  // An outside off seen once it's running again is handled as before (5-min re-on, automation not live).
  const g2 = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const [s2] = feed(g2, on, faultyRun(T0));
  const back = g2.decide(on, { now: s2.next.restUntil, pump: off() });
  g2.commit(back.action.next);
  g2.decide(on, { now: s2.next.restUntil + MIN, pump: { on: true, hz: 50, sp: 44, out: 33, dis: 43, coil: 6, faults: [] } });
  g2.decide(on, { now: s2.next.restUntil + 30 * MIN, pump: off(), switchedBy: 'outside', automationOwns: true });
  assert.equal(g2.decide(on, { now: s2.next.restUntil + 40 * MIN, pump: off(), automationOwns: true }).action, undefined, 'automation live: its call');
}
{
  // A failed switch-off (nothing committed) is sent again at the next poll, while the warning is fresh.
  const g = createGuard({ ...INITIAL_GUARD, mode: 'watch' });
  const run = faultyRun(T0);
  for (const s of run.slice(0, -1)) g.decide(on, { now: s.t, pump: pumpOf(s) });
  const last = run.at(-1);
  assert.equal(g.decide(on, { now: last.t, pump: pumpOf(last) }).action.on, false);
  const retry = g.decide(on, { now: last.t + 30 * SEC, pump: { ...pumpOf(last), dis: 55, coil: 3 } });
  assert.equal(retry.action.on, false, 'again');
  assert.equal(g.decide(on, { now: last.t + 3 * MIN, pump: { ...pumpOf(last), dis: 60, coil: 3 } }).action, undefined, 'not after 2 min');
}
{
  // guard-state.json from the bridge on the Pi (#120: no early-warning fields) still loads and works.
  const old = { mode: 'watch', restUntil: 0, switchedOnAt: T0 - 60 * MIN, lastSeenOn: true, lastAction: { at: T0 - 60 * MIN, what: 'on', reason: 'fim do descanso' }, offOutsideAt: 0, reons: [], leftOffWhy: null };
  const g = createGuard({ ...INITIAL_GUARD, ...JSON.parse(JSON.stringify(old)) });
  assert.equal(g.decide(on, { now: T0, pump: off() }).status.preempt.stopsToday, 0);
  assert.equal(feed(g, on, faultyRun(T0 + 30 * SEC)).length, 1);
  // Mid-rest, from the old bridge: the rest still ends with the pump back on.
  const g2 = createGuard({ ...INITIAL_GUARD, ...{ ...old, mode: 'rest', restUntil: T0 + 10 * MIN } });
  assert.equal(g2.decide(on, { now: T0 + 10 * MIN, pump: off() }).action.on, true);
  // And the cached settings of the old bridge ({enabled}) mean the warning is on.
  assert.equal(parseGuardConfig({ enabled: true }).preempt, true);
}

console.log('all early-warning scenarios pass');
