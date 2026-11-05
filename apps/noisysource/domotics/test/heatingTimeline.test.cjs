// The heating timeline's logic against the real 2026-11-04 and the awkward days,
// no browser and no Firebase. Run: pnpm --filter domotics test (bundles
// src/data/heatingTimeline.ts and the strip's logic with esbuild, then this,
// again under a foreign time zone: only Lisbon's clock may count).
const assert = require('node:assert/strict');
const {
  buildHeatingDay, hhmm, lisbonAt, nextPlanStep, parseClimateDay, reasonText, warmForecast,
} = require('../node_modules/.tmp/test/heatingTimeline.cjs');
const { axisTicks, pickSegment, stepLane, stepSelection, lineRuns, lineDomain } = require('../node_modules/.tmp/test/stripLogic.cjs');

const MIN = 60_000;
const DATE = '2026-11-04';
const at = (time, date = DATE) => lisbonAt(date, time);
const SETTINGS = {
  warmFrom: '17:00', warmTo: '23:00', comfort: 25, dayMin: 21, socOn: 40,
  windows: [{ from: '17:00', to: '23:00' }, { from: '06:00', to: '08:00' }],
  solar: { enabled: true, boost: 1 },
};
const sw = (time, on, source, reason, extra = {}) => ({
  kind: 'switch', id: `sw-${time}`, deviceName: 'Bomba', at: at(time), on, source, reason, faults: [], before: [], origin: 'bridge', ...extra,
});

/** The real day's switches, up to the given time. */
const SWITCHES = [
  sw('05:30', true, 'automation', 'ligar (a aquecer para as 06:00)'),
  sw('08:00', false, 'automation', 'desligar (de dia só com sol: bateria 18 % de 40 %, a carregar 0,2 kW de 2,7 kW)'),
  sw('11:31', true, 'automation', 'ligar (com o sol: bateria 42 %, a carregar 3,0 kW)'),
  sw('11:54', false, 'outside'),
  sw('12:27', true, 'outside'),
  sw('15:54', false, 'outside'),
  sw('16:30', true, 'automation', 'ligar (a aquecer para as 17:00)'),
];
const YESTERDAY_OFF = sw('23:00', false, 'automation', 'desligar (de dia só com sol: bateria 30 % de 40 %, a carregar 0,0 kW de 2,7 kW)', { at: at('23:00', '2026-11-03') });

const expected = time => (SWITCHES.reduce((on, s) => (s.at <= at(time) ? s.on : on), false));
const planOf = t => (t >= at('05:30') && t < at('06:00') ? 'warmup' : t >= at('06:00') && t < at('08:00') ? 'warm'
  : t >= at('16:30') && t < at('17:00') ? 'warmup' : t >= at('17:00') && t < at('23:00') ? 'warm' : 'day');

/** Slots up to `until`, as the bridge wrote them: the on share, the plan at the end of the slot, rooms and target. */
function climateDoc(until, date = DATE, base = at('00:00', date)) {
  const doc = { date, zones: { a: 'Sala', b: 'Quarto' } };
  for (let i = 0; base + i * 15 * MIN < until; i++) {
    const s = base + i * 15 * MIN;
    let onMs = 0;
    for (let k = 0; k < 15; k++) if (expected(hhmm(s + k * MIN))) onMs++;
    const mean = 22 + i * 0.02;
    const boosted = s >= at('11:30') && s < at('11:45');
    doc[`q${String(i).padStart(2, '0')}`] = {
      n: 30, pn: 30, on: onMs / 15, run: onMs / 15,
      plan: planOf(s + 14 * MIN), want: planOf(s + 14 * MIN) !== 'day', soc: 40, ext: 12,
      z: { a: { t: mean, lo: mean, hi: mean, s: boosted ? 26 : 25, v: 1 }, b: { t: mean, lo: mean, hi: mean, s: boosted ? 26 : 25, v: 1 } },
    };
  }
  return doc;
}
const statusAt = (now, over = {}) => ({
  enabled: true, dryRun: false, state: 'running', pausedUntil: null, settings: SETTINGS,
  mode: planOf(now), meanRoom: 23.8, roomTarget: 25, reasons: [], zones: [], actions: [], evaluatedAt: now,
  warm: { from: '17:00', to: '23:00', inWindow: planOf(now) === 'warm', nextStart: at('17:00'), end: at('23:00'), warmupAt: at('16:30'), warmupStarted: false, leadMin: 30, capped: true, need: 1.2, expectedAt: null },
  model: { floorMin: 90, roomRatePerH: 0.15, floorSamples: 5, roomSamples: 5 },
  ...over,
});
const record = (until, incidents = SWITCHES.filter(s => s.at <= until)) => ({
  climate: parseClimateDay(DATE, climateDoc(until)),
  incidents,
  before: YESTERDAY_OFF,
});
const lane = (view, id) => view.lanes.find(l => l.id === id);
const spans = list => list.map(p => `${hhmm(p.from)}-${hhmm(p.to)} ${p.kind ?? p.state}`);

// --- The real day, 2026-11-04, at 17:30 --------------------------------------
{
  const now = at('17:30');
  // The bridge writes hourly: the slots stop at 16:45, the switches don't.
  const view = buildHeatingDay({ date: DATE, now, status: statusAt(now), pumpOn: true, record: record(at('16:45'), SWITCHES), warmupMaxMin: 30 });
  assert.equal(view.phase, 'today');
  assert.deepEqual(spans(view.plan), [
    '00:00-05:30 off', '05:30-06:00 warmup', '06:00-08:00 warm', '08:00-16:30 sun',
    '16:30-17:00 warmup', '17:00-23:00 warm', '23:00-00:00 off',
  ]);
  assert.deepEqual(view.pump.map(s => `${hhmm(s.from)}-${hhmm(s.to)} ${s.state === 'on' ? s.kind : `off:${s.source}`}`), [
    '00:00-05:30 off:automation',
    '05:30-08:00 schedule',
    '08:00-11:31 off:automation',
    '11:31-11:54 sun',
    '11:54-12:27 off:outside',
    '12:27-15:54 outside',
    '15:54-16:30 off:outside',
    '16:30-17:30 schedule',
  ]);
  assert.deepEqual(view.lanes.map(l => l.id), ['plan', 'pump', 'temp']);

  // The brief's sentence, word for word.
  const sun = view.pump.find(s => s.kind === 'sun');
  assert.equal(
    view.describe({ lane: 'pump', id: `pump:${sun.from}`, t: sun.from }).text,
    '11:31–11:54 · Ligada pela automação, com o sol: bateria 42 %, a carregar 3,0 kW. As divisões a 26° enquanto trabalha.',
  );

  // Now, by default; running, it says "agora".
  assert.equal(view.defaultSelection.lane, 'pump');
  const nowText = view.describe(view.defaultSelection);
  assert.match(nowText.text, /^16:30–agora · Ligada pela automação, pelo horário: a aquecer para as 17:00/);

  // Outside the app: can't tell who, and a person is respected until the plan moves.
  const hand = view.pump.find(s => s.state === 'on' && s.kind === 'outside');
  const handText = view.describe({ lane: 'pump', id: `pump:${hand.from}`, t: hand.from }).text;
  assert.match(handText, /Ligada de fora da app: painel, SmartLife ou temporizador, a ponte não os distingue/);
  assert.match(handText, /respeita-o até o plano mudar, às 16:30/);

  // The window's end, by day and at the small hours.
  const eight = view.pump.find(s => hhmm(s.from) === '08:00');
  assert.match(view.describe({ lane: 'pump', id: `pump:${eight.from}`, t: eight.from }).text,
    /Desligada pela automação: acabou o horário quente; de dia só liga com sol \(bateria 18 % de 40 %.*\)\. Também aquece se as divisões descerem dos 21°\./);
  const dawn = view.pump[0];
  assert.match(view.describe({ lane: 'pump', id: `pump:${dawn.from}`, t: dawn.from }).text,
    /Desligada pela automação: de noite não há sol, só volta a ligar às 05:30\. Também aquece/);
  assert.match(view.describe({ lane: 'pump', id: `pump:${dawn.from}`, t: dawn.from }).note, /dia anterior/);

  // The plan's taps.
  const planText = time => view.describe({ lane: 'plan', t: at(time) }).text;
  assert.match(planText('10:00'), /^08:00–16:30 · Só com sol: liga se a bateria tiver ≥ 40 % e houver sol a sobrar \(as divisões a 26° enquanto trabalha\)\. Também aquece se as divisões descerem dos 21°\./);
  assert.match(planText('23:30'), /^23:00–24:00 · Desligada: sem sol, fora do horário quente\. Também aquece se as divisões descerem dos 21°\./);
  assert.match(planText('16:40'), /^16:30–17:00 · A aquecer para as 17:00/);
  assert.match(planText('18:00'), /^17:00–23:00 · Horário quente: mantém as divisões a 25°/);

  // The day's events, in order, with who and why.
  const rows = view.events.map(e => `${hhmm(e.at)} ${e.who}: ${e.what}`);
  assert.deepEqual(rows, [
    '05:30 Automação: Ligou a bomba',
    '08:00 Automação: Desligou a bomba',
    '11:31 Automação: Ligou a bomba',
    '11:54 De fora da app: Desligou a bomba',
    '12:27 De fora da app: Ligou a bomba',
    '15:54 De fora da app: Desligou a bomba',
    '16:30 Automação: Ligou a bomba',
  ]);
  assert.match(view.events[2].why, /^com o sol: bateria 42 %/);
  assert.match(view.events[4].why, /a ponte não os distingue.*respeita até às 16:30/);
  assert.equal(view.events[2].select.id, `pump:${at('11:31')}`, 'tapping a row selects its stretch');

  // Temperatures: to the last slot, then the live reading, with the batch gap unbroken by "off".
  const temp = lane(view, 'temp');
  assert.equal(temp.points.at(-1).v, 23.8);
  assert.equal(temp.points.at(-1).t, now);
  assert.equal(lineRuns(temp.points, 30 * MIN).at(-1).length, 1, 'a batch gap breaks the line, it isn\'t joined');
  assert.equal(temp.reference.at(-1).v, 25);
}

// --- Today's latest slots behind: not a gap, not "off" ---------------------------
{
  const now = at('12:07');
  const view = buildHeatingDay({ date: DATE, now, status: statusAt(now), pumpOn: false, record: record(at('11:00'), SWITCHES.filter(s => s.at <= now)), warmupMaxMin: 30 });
  assert.ok(view.pump.every(s => s.state !== 'nodata'), 'the batch delay is not "no data"');
  assert.equal(`${hhmm(view.pump.at(-1).from)}`, '11:54');
  assert.equal(view.pump.at(-1).state, 'off');
  assert.equal(view.pump.at(-1).ongoing, true);
  // The tail of the plan is filled from the settings, seamlessly.
  assert.ok(view.plan.some(p => p.kind === 'sun' && hhmm(p.from) === '08:00' && hhmm(p.to) === '16:30'));
}

// --- The bridge gone quiet: today's tail is "Sem registo", not off --------------
{
  const now = at('14:00');
  const view = buildHeatingDay({ date: DATE, now, status: statusAt(at('12:40')), pumpOn: undefined, record: record(at('11:00'), SWITCHES.filter(s => s.at <= at('12:40'))), warmupMaxMin: 30 });
  const last = view.pump.at(-1);
  assert.equal(last.state, 'nodata');
  assert.equal(hhmm(last.from), '12:40');
  assert.match(view.describe({ lane: 'pump', id: `pump:${last.from}`, t: last.from }).text, /a ponte não dá notícias\. Não quer dizer que estivesse desligada/);
}

// --- A slot with no pump reading, on a past day ----------------------------------
{
  const doc = climateDoc(at('23:00'));
  delete doc.q40;
  doc.q41.pn = 0;
  const yesterday = '2026-11-04';
  const now = at('10:00', '2026-11-05');
  const view = buildHeatingDay({
    date: yesterday, now, status: statusAt(now, { warm: undefined }),
    record: { climate: parseClimateDay(yesterday, doc), incidents: SWITCHES, before: YESTERDAY_OFF }, warmupMaxMin: 30,
  });
  assert.equal(view.phase, 'past');
  assert.equal(view.now, undefined);
  assert.equal(view.defaultSelection, null);
  const gap = view.pump.find(s => s.state === 'nodata');
  assert.equal(`${hhmm(gap.from)}-${hhmm(gap.to)}`, '10:00-10:30');
  assert.equal(view.plan.find(p => p.kind === 'nodata').from, at('10:00'), 'nor does the plan pretend');
  // Slots stop at 23:00 on this past day, after the last switch: the end isn't "off" either.
  assert.equal(hhmm(view.pump.at(-1).from), '23:00');
  assert.equal(view.pump.at(-1).state, 'nodata');
}

// --- Why: `reason`, then the status's actions, then worked out --------
{
  const now = at('12:00');
  const viewWith = incidents => buildHeatingDay({
    date: DATE, now, pumpOn: true, warmupMaxMin: 30,
    status: statusAt(now, { actions: [{ at: at('11:30'), device: 'Bomba de calor', what: 'ligar (com o sol: das ações)', sent: true }] }),
    record: { climate: parseClimateDay(DATE, climateDoc(at('11:45'))), incidents, before: null },
  });
  const sunAt = v => v.pump.find(s => s.from === at('11:31'));
  const textOf = v => v.describe({ lane: 'pump', id: `pump:${at('11:31')}`, t: at('11:31') });

  let v = viewWith([sw('11:31', true, 'automation', 'ligar (com o sol: do reason)')]);
  assert.match(textOf(v).text, /com o sol: do reason/);
  v = viewWith([sw('11:31', true, 'automation', undefined)]);
  assert.match(textOf(v).text, /com o sol: das ações/);

  // Nothing written down: worked out from the plan, and it says so.
  const later = at('14:00');
  v = buildHeatingDay({
    date: DATE, now: later, pumpOn: true, status: statusAt(later), warmupMaxMin: 30,
    record: { climate: parseClimateDay(DATE, climateDoc(at('13:45'))), incidents: [sw('11:31', true, 'automation', undefined), sw('11:54', false, 'automation', undefined), sw('12:27', true, 'automation', undefined)], before: null },
  });
  assert.equal(sunAt(v).kind, 'sun');
  const t = textOf(v);
  assert.match(t.text, /Ligada pela automação, com o sol: bateria 40 %/);
  assert.match(t.note, /deduzido/);
  assert.equal(v.events.find(e => e.at === at('11:31')).derived, true);
  // Below the day minimum it isn't the sun.
  const cold = climateDoc(at('13:45'));
  for (const z of Object.values(cold.q46.z)) z.t = 20.5;
  v = buildHeatingDay({
    date: DATE, now: later, pumpOn: true, status: statusAt(later), warmupMaxMin: 30,
    record: { climate: parseClimateDay(DATE, cold), incidents: [sw('11:31', true, 'automation', undefined)], before: null },
  });
  assert.equal(sunAt(v).kind, 'daymin');
  assert.match(textOf(v).text, /pelo mínimo de dia: casa a 20,5° de média, abaixo do mínimo de dia \(21°\)/);

  assert.equal(reasonText('desligar 60 min (no setpoint a 28 Hz — não deixa voltar a acelerar)'), 'descanso de 60 min: no setpoint a 28 Hz — não deixa voltar a acelerar');
  assert.equal(reasonText('fim do descanso'), 'fim do descanso');
}

// --- Who: the pump's timer, the app, the old guard -------------------------------
{
  const now = at('23:59');
  const doc = climateDoc(at('23:45'));
  doc.x_235430_pump = { at: at('23:54'), time: '23:54:30', kind: 'pump', by: 'timer', meaning: 'none', on: false, rooms: {}, mean: 24 };
  doc.x_120000_a = { at: at('12:00'), time: '12:00:00', kind: 'target', by: 'outside', meaning: 'warmer', zone: 'a', zoneName: 'Sala', from: 25, to: 26, rooms: {}, mean: 23.4 };
  const incidents = [
    ...SWITCHES,
    sw('23:54', false, 'outside', undefined),
    { kind: 'switch', id: 'old', deviceName: 'Bomba', at: at('09:00'), on: true, source: 'guard', reason: 'fim do descanso', faults: [], before: [], origin: 'bridge' },
    { kind: 'switch', id: 'old2', deviceName: 'Bomba', at: at('09:30'), on: false, source: 'app', faults: [], before: [], origin: 'bridge' },
  ];
  const view = buildHeatingDay({ date: DATE, now, status: statusAt(now), pumpOn: false, record: { climate: parseClimateDay(DATE, doc), incidents, before: YESTERDAY_OFF }, warmupMaxMin: 30 });
  const timer = view.pump.find(s => s.from === at('23:54'));
  assert.equal(timer.source, 'timer');
  assert.equal(view.lanes.find(l => l.id === 'pump').segments.find(s => s.from === at('23:54')).tone, 'off-timer');
  assert.match(view.describe({ lane: 'pump', id: `pump:${timer.from}`, t: timer.from }).text, /temporizador da bomba\. Não é uma pessoa/);
  assert.ok(view.legend.includes('off-timer'));
  const guardS = view.pump.find(s => s.from === at('09:00'));
  assert.equal(guardS.kind, 'guard');
  assert.match(view.describe({ lane: 'pump', id: `pump:${guardS.from}`, t: guardS.from }).text, /pela proteção E13: fim do descanso/);
  assert.match(view.describe({ lane: 'pump', id: `pump:${guardS.from}`, t: guardS.from }).note, /Registo antigo/);
  const appS = view.pump.find(s => s.from === at('09:30'));
  assert.match(view.describe({ lane: 'pump', id: `pump:${appS.from}`, t: appS.from }).text, /Desligada à mão, na app\. A automação respeita-o até o plano mudar, às 16:30/);
  const row = view.events.find(e => e.what.startsWith('Sala'));
  assert.equal(row.what, 'Sala: 25° → 26°');
  assert.equal(row.who, 'De fora da app');
  assert.equal(row.why, 'mais quente, casa a 23,4°');
}

// --- Faults: a clear band, cut into the stretch -------------------------------------
{
  const now = at('20:00');
  const fault = {
    kind: 'fault', id: 'f', device: 'hp', deviceName: 'Bomba', code: 'E13', codes: ['E13'], at: at('18:00'), status: 'ended',
    lockout: false, endedAt: at('18:04'), endedHow: 'self', offlineDuring: false, before: [], after: [], actions: [], origin: 'bridge',
  };
  const doc = climateDoc(at('19:45'));
  doc.q02 = { ...doc.q02, fault: true };
  const view = buildHeatingDay({ date: DATE, now, status: statusAt(now), pumpOn: true, record: { climate: parseClimateDay(DATE, doc), incidents: [...SWITCHES, fault], before: YESTERDAY_OFF }, warmupMaxMin: 30 });
  const band = view.pump.find(s => s.state === 'fault' && s.fault);
  assert.equal(`${hhmm(band.from)}-${hhmm(band.to)}`, '18:00-18:04');
  assert.ok(view.pump.some(s => s.state === 'on' && s.to === band.from) && view.pump.some(s => s.state === 'on' && s.from === band.to), 'the pump either side');
  assert.match(view.describe({ lane: 'pump', id: `pump:${band.from}`, t: band.from }).text, /Avaria E13: Proteção alta pressão.*Limpou sozinho/);
  const slotOnly = view.pump.find(s => s.state === 'fault' && !s.fault);
  assert.equal(`${hhmm(slotOnly.from)}-${hhmm(slotOnly.to)}`, '00:30-00:45', 'flagged only on a slot: its 15 min, not invented');
  assert.equal(view.events.filter(e => e.tone === 'fault').length, 1);
  assert.equal(view.events.filter(e => e.what === 'Ligou a bomba').length, 4, 'the band doesn\'t add a switch: the same four ons');
  assert.ok(view.legend.includes('fault'));
}

// --- Tomorrow: only the plan --------------------------------------------------------
{
  const now = at('12:07');
  const view = buildHeatingDay({ date: '2026-11-05', now, status: statusAt(now), warmupMaxMin: 30 });
  assert.equal(view.phase, 'future');
  assert.deepEqual(view.lanes.map(l => l.id), ['plan']);
  assert.equal(view.now, undefined);
  assert.deepEqual(spans(view.plan), [
    '00:00-05:30 off', '05:30-06:00 warmup', '06:00-08:00 warm', '08:00-16:30 sun',
    '16:30-17:00 warmup', '17:00-23:00 warm', '23:00-00:00 off',
  ]);
  assert.equal(view.events.length, 0);
}

// --- Signed out on the LAN: plan, now, no pump lane ----------------------------------
{
  const now = at('12:07');
  const actions = [{ at: at('11:31'), device: 'Bomba de calor', what: 'ligar (com o sol: bateria 42 %)', sent: true }, { at: at('11:32'), device: 'Sala', what: 'alvo 25°C → 26°C', sent: true }];
  const view = buildHeatingDay({ date: DATE, now, status: statusAt(now, { actions }), pumpOn: true });
  assert.deepEqual(view.lanes.map(l => l.id), ['plan']);
  assert.equal(view.now, now);
  assert.equal(view.defaultSelection.lane, 'plan');
  assert.ok(view.plan.every(p => p.kind !== 'nodata'));
  const dawn = view.plan.find(p => p.kind === 'warmup');
  assert.equal(hhmm(dawn.from), '05:30', 'the cap from the status: capped at 30');
  assert.match(view.describe({ lane: 'plan', t: at('10:00') }).note, /Deduzido/);
  assert.deepEqual(view.events.map(e => e.what), ['Bomba de calor: ligar', 'Sala: alvo 25°C → 26°C'], 'the status\'s actions are all it has');
}

// --- A clock change: 100 and 92 slots -------------------------------------------------
for (const [date, slots, hours] of [['2026-10-25', 100, 25], ['2027-03-28', 92, 23], ['2026-11-04', 96, 24]]) {
  const from = lisbonAt(date, '00:00');
  const now = from + 80 * 86_400_000;
  const view = buildHeatingDay({ date, now, status: statusAt(now), record: { climate: parseClimateDay(date, Object.fromEntries(Array.from({ length: slots }, (_, i) => [`q${String(i).padStart(2, '0')}`, { n: 1, pn: 1, on: 0, plan: 'day', z: {} }]))), incidents: [], before: null } });
  assert.equal(view.to - view.from, hours * 3_600_000, date);
  assert.equal(view.plan.reduce((a, p) => a + (p.to - p.from), 0), view.to - view.from, `${date}: the plan covers the day`);
  assert.equal(view.pump.reduce((a, p) => a + (p.to - p.from), 0), view.to - view.from, `${date}: so does the pump`);
  assert.equal(view.pump.filter(s => s.state === 'nodata').length, 0, `${date}: every slot read`);
  const ticks = axisTicks(view.from, view.to, 264);
  assert.equal(ticks[0].label, '00');
  assert.equal(ticks.at(-1).label, '24');
  assert.equal(ticks.at(-1).t, view.to);
  assert.ok(ticks.every((t, i) => i === 0 || t.t > ticks[i - 1].t), `${date}: ticks in order`);
  // A slot past the day's end (bad data) doesn't stretch it.
  assert.equal(parseClimateDay(date, { q99: { pn: 1 }, 'q100': { pn: 1 } }).slots.length, slots);
}
{
  // On those days the windows land at the right wall-clock time.
  for (const date of ['2026-10-25', '2027-03-28']) {
    const from = lisbonAt(date, '00:00');
    const now = from - 86_400_000;
    const view = buildHeatingDay({ date, now, status: statusAt(now), warmupMaxMin: 30 });
    assert.deepEqual(spans(view.plan).slice(1, 3), ['05:30-06:00 warmup', '06:00-08:00 warm'], date);
    assert.ok(spans(view.plan).includes('17:00-23:00 warm'), date);
  }
  const d = lisbonAt('2026-10-25', '00:00');
  const ticks = axisTicks(d, d + 25 * 3_600_000, 700).map(t => t.label);
  assert.equal(ticks.filter(l => l === '01').length, 2, 'October: 01 twice');
  const m = lisbonAt('2027-03-28', '00:00');
  assert.ok(!axisTicks(m, m + 23 * 3_600_000, 700).some(t => t.label === '01'), 'March: no 01');
}

// --- A window across midnight, and a warm-up the day before it starts -----------------
{
  const st = { ...SETTINGS, windows: undefined, warmFrom: '19:00', warmTo: '09:00' };
  const now = at('12:00');
  const view = buildHeatingDay({ date: DATE, now, status: statusAt(now, { settings: st, warm: undefined }), warmupMaxMin: 60 });
  // Sunset is at 17:29 here on this day: the rest of the gap is off, not "only with sun".
  assert.deepEqual(spans(view.plan).slice(-4), ['09:00-17:29 sun', '17:29-18:00 off', '18:00-19:00 warmup', '19:00-00:00 warm']);
  const v2 = buildHeatingDay({ date: DATE, now, status: statusAt(now, { settings: { ...SETTINGS, windows: [{ from: '00:10', to: '02:00' }] }, warm: undefined }), warmupMaxMin: 30 });
  assert.equal(spans(v2.plan)[0], '00:00-00:10 warmup', 'its warm-up started the evening before');
  assert.ok(spans(v2.plan).at(-1).endsWith('warmup'), 'and tonight\'s starts before midnight');
}

// --- Solar off, a pause, a one-off request, the automation off --------------------------
{
  const now = at('10:00');
  let v = buildHeatingDay({ date: DATE, now, status: statusAt(now, { settings: { ...SETTINGS, solar: { enabled: false, boost: 0 } } }), warmupMaxMin: 30 });
  assert.ok(!v.plan.some(p => p.kind === 'sun'));
  assert.match(v.describe({ lane: 'plan', t: at('10:00') }).text, /aquecer com o sol está desligado/);

  v = buildHeatingDay({ date: DATE, now, status: statusAt(now, { pausedUntil: at('12:00') }), warmupMaxMin: 30 });
  assert.equal(`${hhmm(v.plan.find(p => p.kind === 'pause').from)}-${hhmm(v.plan.find(p => p.kind === 'pause').to)}`, '10:00-12:00');
  assert.deepEqual(nextPlanStep(statusAt(now, { pausedUntil: at('12:00') }), now, 30), { at: at('12:00'), text: '12:00 — acaba a pausa, volta ao plano' });

  const warmBy = { at: at('14:00'), startAt: at('12:30'), phase: 'waiting', target: 25, setAt: now, source: 'app', leadMin: 90, current: 24, expectedAt: at('13:30'), late: false, outcome: null, note: '' };
  v = buildHeatingDay({ date: DATE, now, status: statusAt(now, { warmBy }), warmupMaxMin: 30 });
  assert.equal(`${hhmm(v.plan.find(p => p.kind === 'request').from)}-${hhmm(v.plan.find(p => p.kind === 'request').to)}`, '12:30-15:00');
  assert.ok(v.legend.includes('plan-request'));
  // A pause holds over a request: the two never overlap.
  v = buildHeatingDay({ date: DATE, now, status: statusAt(now, { warmBy, pausedUntil: at('13:00') }), warmupMaxMin: 30 });
  assert.equal(`${hhmm(v.plan.find(p => p.kind === 'request').from)}-${hhmm(v.plan.find(p => p.kind === 'request').to)}`, '13:00-15:00');
  assert.equal(v.plan.reduce((a, p) => a + (p.to - p.from), 0), v.to - v.from);

  v = buildHeatingDay({ date: DATE, now, status: statusAt(now, { state: 'off', enabled: false }), warmupMaxMin: 30 });
  assert.equal(v.plan.at(-1).kind, 'none');
  assert.equal(nextPlanStep(statusAt(now, { state: 'off', enabled: false }), now), null);
}

// --- A person's switch not recorded yet, and a switch nobody recorded --------------------
{
  const now = at('12:00');
  const action = { at: at('11:58'), device: 'Bomba de calor', what: 'ligar (com o sol: bateria 42 %, a carregar 3,0 kW)', sent: true };
  let v = buildHeatingDay({ date: DATE, now, status: statusAt(now, { actions: [action] }), pumpOn: true, record: { climate: parseClimateDay(DATE, climateDoc(at('11:00'))), incidents: SWITCHES.slice(0, 2), before: null }, warmupMaxMin: 30 });
  assert.equal(v.pump.at(-1).kind, 'sun', 'the live reading is ahead of the record: the status\'s action explains it');
  assert.equal(v.pump.at(-1).from, at('11:58'));

  // Slots saying on with no switch in them: on, with no record of who, from that slot.
  const doc = climateDoc(at('11:00'));
  for (const q of ['q16', 'q17', 'q18']) doc[q].on = 1;
  v = buildHeatingDay({ date: DATE, now, status: statusAt(now), pumpOn: false, record: { climate: parseClimateDay(DATE, doc), incidents: SWITCHES.slice(0, 2), before: null }, warmupMaxMin: 30 });
  const guess = v.pump.find(s => s.synthetic && s.state === 'on');
  assert.equal(`${hhmm(guess.from)}-${hhmm(guess.to)}`, '04:00-04:45');
  assert.equal(guess.kind, 'unknown');
  assert.match(v.describe({ lane: 'pump', id: `pump:${guess.from}`, t: guess.from }).note, /aproximada/);
}

// --- A day with nothing on record ----------------------------------------------------------
{
  const now = at('10:00');
  const view = buildHeatingDay({ date: '2026-10-01', now, status: statusAt(now), record: { climate: null, incidents: [], before: null } });
  assert.equal(view.empty, true);
  assert.deepEqual(spans(view.pump), ['00:00-00:00 nodata']);
  // Switches but no slots (before the climate history): the switches stand.
  const early = sw('10:00', true, 'automation', 'ligar (horário quente)', { at: lisbonAt('2026-10-27', '10:00') });
  const v2 = buildHeatingDay({ date: '2026-10-27', now, status: statusAt(now), record: { climate: null, incidents: [early], before: null } });
  assert.equal(v2.empty, false);
  assert.deepEqual(v2.pump.map(s => s.state), ['off', 'on']);
}

// --- A slot recording ' (sim)' and an automation that was off ----------------------------
{
  const doc = climateDoc(at('01:00'));
  doc.q00.plan = 'day (sim)';
  doc.q01.plan = 'day (sim)';
  doc.q02.plan = 'off';
  doc.q03.plan = '?';
  const now = at('10:00');
  const v = buildHeatingDay({ date: DATE, now, status: statusAt(now), record: { climate: parseClimateDay(DATE, doc), incidents: [], before: null }, warmupMaxMin: 30 });
  assert.equal(v.plan[0].sim, true);
  assert.match(v.describe({ lane: 'plan', t: v.plan[0].from }).text, /Em simulação: não mexeu em nada/);
  assert.equal(v.plan[1].kind, 'none');
  assert.equal(v.plan[2].kind, 'nodata');
}

// --- What's next -------------------------------------------------------------------------
{
  const step = (time, date = DATE, over = {}) => {
    const now = at(time, date);
    return nextPlanStep(statusAt(now, { warm: { ...statusAt(now).warm, inWindow: false, nextStart: 0 }, ...over }), now, 30);
  };
  assert.equal(step('12:07').text, '16:30 — começa a aquecer para as 17:00');
  assert.equal(step('16:40').text, '17:00 — começa o horário quente, até às 23:00');
  assert.equal(step('17:30').text, '23:00 — desliga, acaba o horário quente');
  assert.equal(step('23:30').text, 'amanhã às 05:30 — começa a aquecer para as 06:00');
  assert.equal(step('03:00').text, '05:30 — começa a aquecer para as 06:00');
  assert.equal(step('07:00').text, '08:00 — desliga, acaba o horário quente');
}

// --- The honest forecast: today's nonsense, at 12:07 ------------------------------------
{
  const now = at('12:07');
  const late = statusAt(now, {
    warm: { from: '17:00', to: '23:00', inWindow: false, nextStart: at('17:00'), end: at('23:00'), warmupAt: at('16:30'), warmupStarted: false, leadMin: 30, capped: true, need: 2.6, expectedAt: at('10:00', '2026-11-05') },
  });
  assert.equal(
    warmForecast(late, now).text,
    'Não vai chegar aos 25° às 17:00: faltam 2,6°, a casa aquece ~0,15°/h, só começa às 16:30 (no máximo 30 min antes). Previsto só amanhã às 10:00, e isso com a bomba sempre ligada: o horário quente acaba às 23:00.',
  );
  // The same day, before the window ends.
  const sameDay = statusAt(now, { warm: { ...late.warm, expectedAt: at('18:10') } });
  assert.match(warmForecast(sameDay, now).text, /Previsto só hoje às 18:10\.$/);
  // Further off: the date.
  const farther = statusAt(now, { warm: { ...late.warm, expectedAt: at('10:00', '2026-11-06') } });
  assert.match(warmForecast(farther, now).text, /Previsto só a 06\/11 às 10:00/);
  // In time, in the window, no warm plan: says nothing.
  assert.equal(warmForecast(statusAt(now), now), null);
  assert.equal(warmForecast(statusAt(now, { warm: { ...late.warm, inWindow: true } }), now), null);
  assert.equal(warmForecast(statusAt(now, { warm: undefined }), now), null);
  // The next start being tomorrow.
  const night = at('23:30');
  const tomorrow = statusAt(night, { warm: { ...late.warm, nextStart: at('06:00', '2026-11-05'), end: at('08:00', '2026-11-05'), warmupAt: at('05:30', '2026-11-05'), expectedAt: at('07:00', '2026-11-05') } });
  assert.match(warmForecast(tomorrow, night).text, /^Não vai chegar aos 25° amanhã às 06:00:.*só começa amanhã às 05:30/);
}

// --- The strip's logic -----------------------------------------------------------------------
{
  const segs = [
    { id: 'off1', from: 0, to: 100, tone: 'off', label: '' },
    { id: 'sun', from: 100, to: 104, tone: 'on', label: '' },
    { id: 'off2', from: 104, to: 200, tone: 'off', label: '' },
  ];
  const prominent = s => s.tone === 'on';
  assert.equal(pickSegment(segs, 102, 8, prominent).id, 'sun');
  assert.equal(pickSegment(segs, 95, 8, prominent).id, 'sun', 'a thin band wins nearby');
  assert.equal(pickSegment(segs, 110, 8, prominent).id, 'sun');
  assert.equal(pickSegment(segs, 50, 8, prominent).id, 'off1', 'beyond the slop, what\'s under the tap');
  assert.equal(pickSegment(segs, 500, 8, prominent).id, 'off2', 'past the end, the nearest');
  assert.equal(pickSegment([], 500, 8, prominent), null);

  const lanes = [
    { id: 'a', label: 'A', segments: segs },
    { kind: 'line', id: 't', label: 'T', points: [{ t: 10, v: 1 }, { t: 110, v: 2 }, { t: 190, v: 3 }], format: String },
    { id: 'empty', label: 'E', segments: [] },
  ];
  assert.equal(stepSelection(lanes, { lane: 'a', id: 'off1', t: 0 }, 1).id, 'sun');
  assert.equal(stepSelection(lanes, { lane: 'a', id: 'off1', t: 0 }, -1).id, 'off1', 'stops at the ends');
  assert.equal(stepSelection(lanes, { lane: 'a', t: 150 }, 1).id, 'off2', 'no id yet: starts from the time');
  assert.equal(stepSelection(lanes, { lane: 't', t: 110 }, 1).t, 190);
  assert.equal(stepLane(lanes, { lane: 'a', id: 'sun', t: 102 }, 1).lane, 't');
  assert.equal(stepLane(lanes, { lane: 'a', id: 'sun', t: 102 }, 1).t, 110, 'nearest point');
  assert.equal(stepLane(lanes, { lane: 't', t: 110 }, 1).lane, 't', 'nothing below but an empty lane');
  assert.equal(stepLane(lanes, { lane: 't', t: 110 }, -1).id, 'off2');

  assert.deepEqual(lineRuns([{ t: 0, v: 1 }, { t: 10, v: 1 }, { t: 100, v: 2 }], 30).map(r => r.length), [2, 1]);
  const [lo, hi] = lineDomain([22, 22.1]);
  assert.ok(hi - lo >= 1, 'a flat day stays flat');
  assert.ok(lo <= 22 && hi >= 22.1);
  const [lo2, hi2] = lineDomain([20, 26]);
  assert.ok(lo2 <= 20 && hi2 >= 26);
}

console.log('heating timeline: ok');
