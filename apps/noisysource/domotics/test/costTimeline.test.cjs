// The Energia page's cost chart, no browser and no Firebase: that the bars and
// the fixed charges add up to the "Custo do período" tile, whatever the tariff,
// and that a gap never reads as 0 €. Run: pnpm --filter domotics test (again
// under a foreign time zone: only Lisbon's clock may count).
const assert = require('node:assert/strict');
const {
  COST_MARGINS, costState, costView, eurText, hourFacts, moneyLine, movedBeyondTap, niceEur, pressOutcome, pumpHoursByBucket, pumpHoursOf,
  pumpInBucket, pumpLaneOf, pumpText, rangePeriod, reconciliationText, splitBill, vazioRuns, zoomPeriod,
} = require('../node_modules/.tmp/test/costTimeline.cjs');
const { bucketize, expectedUntil, fmtEur, lastRecorded, periodContaining } = require('../node_modules/.tmp/test/view.cjs');
const { buildHeatingDay, dateRuns, hhmm, lisbonAt, parseClimateDay } = require('../node_modules/.tmp/test/heatingTimeline.cjs');
const { timeX } = require('../node_modules/.tmp/test/stripLogic.cjs');

const {
  DEFAULT_TARIFF, SLOT_MS, addDays, computeBill, computeScenarios, dayStart, isVazio, slotsInDay, summarize,
} = require('../node_modules/.tmp/test/energyBill.cjs');

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CONFIRMED = { ...DEFAULT_TARIFF, confirmed: true };

/** One flow-free slot buying `imp` Wh. */
const slot = (imp, extra = {}) => ({
  pv: 0, load: imp, imp, exp: 0, chg: 0, dis: 0, pvLoad: 0, batLoad: 0, gridBat: 0, sec: 900, ...extra,
});
/** A Lisbon day whose slot i (starting at instant t) is fn(i, t): a slot, or null for no data. */
function makeDay(date, fn) {
  const start = dayStart(date);
  return {
    date, start,
    slots: Array.from({ length: slotsInDay(date) }, (_, i) => fn(i, start + i * SLOT_MS)),
  };
}

/** Everything the page computes for a period, the way EnergyScreen does. */
function compute(period, days, tariff = CONFIRMED, now = dayStart(addDays(period.to, 1)) + DAY) {
  const last = lastRecorded(days);
  const dataNow = expectedUntil(now, last);
  const range = { from: dayStart(period.from), to: dayStart(addDays(period.to, 1)), now: dataNow };
  const summary = summarize(days, tariff, range);
  const billedDays = Math.max(0, Math.min(range.to, now) - range.from) / DAY;
  const scenarios = computeScenarios(summary, billedDays, tariff);
  const buckets = bucketize(period, days, tariff, dataNow);
  return { summary, billedDays, scenarios, cost: costView({ period, days, tariff, buckets, range, actual: scenarios.actual, billedDays, now }) };
}

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const cents = v => Math.round(v * 100);
const sumBars = cost => cost.buckets.reduce((s, b) => s + (b.eur ?? 0), 0);

/** Bars + fixed − credit is the tile, to the cent. The whole point of the chart. */
function assertAddsUp({ cost, scenarios, summary }) {
  const { split } = cost;
  assert.equal(split.total, scenarios.actual.total, 'the same total as the tile');
  assert.equal(cents(split.energy + split.fixed - split.credit), cents(scenarios.actual.total), 'energy + fixed − credit = total');
  close(sumBars(cost), split.energy, 1e-6);
  close(split.vazio + split.fora, split.energy, 1e-9);
  assert.ok(split.vazio >= 0 && split.fora >= 0, 'no negative band');
  for (const b of cost.buckets) assert.ok(b.eur === null || (b.eurVazio >= 0 && b.eurFora >= 0), 'no negative bar');
  // Exactly the kWh the bill was computed on.
  close(cost.kwhVazio, summary.vazio.imp / 1000, 1e-9);
  close(cost.kwhFora, summary.fora.imp / 1000, 1e-9);
}

// --- Adds up: one plain day ------------------------------------------------------------------
{
  const date = '2026-11-03';
  const day = makeDay(date, (i, t) => {
    const h = (t - dayStart(date)) / HOUR;
    return slot(h >= 8 && h < 9 ? 500 : 100);
  });
  const r = compute(periodContaining('day', date), [day]);
  assertAddsUp(r);
  assert.equal(r.cost.buckets.length, 24);
  assert.equal(r.cost.peak.title, '08:00–09:00');
  assert.equal(moneyLine(r.cost), `Mais caro: 08:00–09:00, ${fmtEur(r.cost.peak.eur)}`);

  // Fixed is the same bill with no energy at all.
  assert.equal(r.cost.split.fixed, computeBill({ kwhVazio: 0, kwhFora: 0, kwhExport: 0, days: 1 }, CONFIRMED).total);
  // What the page writes under the chart ends in the tile's figure.
  const text = reconciliationText(r.cost.split, false);
  assert.ok(text.endsWith(`= Custo do período ${fmtEur(r.scenarios.actual.total)}`), text);
  assert.ok(text.startsWith(`Energia ${fmtEur(r.cost.split.energy)} + potência e taxas ${fmtEur(r.cost.split.fixed)}`), text);
  assert.ok(!text.includes('excedente'), 'no export line without an export price');
}

// --- Adds up: an export credit is its own term, outside the bars -----------------------------
{
  const date = '2026-11-03';
  const tariff = { ...CONFIRMED, exportPrice: 0.05 };
  const day = makeDay(date, () => slot(100, { exp: 200 }));
  const r = compute(periodContaining('day', date), [day], tariff);
  assertAddsUp(r);
  assert.ok(r.cost.split.credit > 0);
  assert.equal(r.cost.split.credit, r.scenarios.actual.exportCredit);
  assert.ok(reconciliationText(r.cost.split, false).includes(`− excedente pago ${fmtEur(r.cost.split.credit)}`));
}

// --- Adds up: whatever the tariff, the period and the data (seeded, so a failure repeats) ----
{
  let a = 20261104;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = list => list[Math.floor(rnd() * list.length)];
  const periods = () => {
    const base = addDays('2026-01-01', Math.floor(rnd() * 360));
    return pick([
      periodContaining('day', base), periodContaining('week', base), periodContaining('month', base), periodContaining('year', base),
      { kind: 'custom', from: base, to: addDays(base, 1 + Math.floor(rnd() * 90)) },
    ]);
  };
  for (let run = 0; run < 400; run++) {
    const period = periods();
    const tariff = {
      ...CONFIRMED,
      priceVazio: pick([0, 0.0001, 0.105, 0.1234]),
      priceForaVazio: pick([0.2, 0.1871, 0.0002]),
      iecPerKwh: pick([0, 0.001, 0.0015, 0.05]),
      powerPerDay: pick([0, 0.36, 0.4567]),
      cavPerMonth: pick([0, 2.85]),
      dgegPerMonth: pick([0, 0.07]),
      vatReducedKwh: pick([0, 100, 200]),
      vatReduced: pick([6, 13, 23]),
      vatPower: pick([6, 23]),
      vatCav: pick([6, 23]),
      exportPrice: pick([0, 0.05]),
      vazioFrom: pick(['22:00', '21:30', '00:00']),
      vazioTo: pick(['08:00', '07:15', '06:45']),
    };
    const size = pick([0, 1, 7, 40, 400, 3000]);
    const gap = rnd() < 0.3;
    const days = [];
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) {
      if (gap && rnd() < 0.2) continue;
      days.push(makeDay(d, () => (gap && rnd() < 0.1 ? null : slot(Math.round(rnd() * size), { exp: Math.round(rnd() * 50), sec: rnd() < 0.05 ? 400 : 900 }))));
    }
    // Inside the period sometimes, so a fractional billed day and the upload lag are in play.
    const now = rnd() < 0.5 ? dayStart(addDays(period.to, 3)) : dayStart(period.from) + Math.floor(rnd() * (dayStart(addDays(period.to, 1)) - dayStart(period.from)));
    const shown = days.map(d => ({ ...d, slots: d.slots.map((s, i) => (d.start + (i + 1) * SLOT_MS <= now ? s : null)) }));
    assertAddsUp(compute(period, shown, tariff, now));
  }
}

// --- What has no per-slot answer: the reduced VAT belongs to the period ----------------------
{
  // A dear day in a quiet month: more of its kWh fall under the reduced rate in the month's sum than in its own.
  const dear = '2026-10-14';
  const days = [];
  for (let d = '2026-10-01'; d <= '2026-10-31'; d = addDays(d, 1)) days.push(makeDay(d, () => slot(d === dear ? 400 : 50)));
  const inMonth = compute(periodContaining('month', dear), days);
  const onItsOwn = compute(periodContaining('day', dear), days.filter(d => d.date === dear));
  assertAddsUp(inMonth);
  assertAddsUp(onItsOwn);
  const bar = inMonth.cost.buckets[13];
  close(bar.kwhVazio + bar.kwhFora, 38.4);
  // Each view adds up to its own tile, and they disagree on the day: that's the VAT, not a slip.
  assert.ok(onItsOwn.cost.split.energy - bar.eur > 0.2, `${onItsOwn.cost.split.energy} against ${bar.eur}`);
  // Without a reduced rate there's nothing to share out, and they agree to within the bill's rounding.
  const flat = { ...CONFIRMED, vatReducedKwh: 0 };
  const a = compute(periodContaining('month', dear), days, flat).cost.buckets[13].eur;
  const b = compute(periodContaining('day', dear), days.filter(d => d.date === dear), flat).cost.split.energy;
  close(a, b, 0.02);
}

// --- A bucket spanning both is split by slot, not by a flag on the bucket --------------------
{
  // The week view's day buckets always span both: 00:00–08:00 and 22:00–24:00 are vazio.
  const date = '2026-11-03';
  const day = makeDay(date, (i, t) => slot(isVazio(t, CONFIRMED) ? 100 : 300));
  const r = compute(periodContaining('week', date), [day]);
  assertAddsUp(r);
  const b = r.cost.buckets.find(x => x.start === dayStart(date));
  // 40 vazio slots at 100 Wh, 56 fora at 300 Wh.
  close(b.kwhVazio, 4);
  close(b.kwhFora, 16.8);
  assert.ok(b.eurVazio > 0 && b.eurFora > 0);
  // Only that one day has data, so the bars hold the whole bill's energy, and at the two prices.
  close(b.eur, r.cost.split.energy, 1e-6);
  const perKwhV = b.eurVazio / b.kwhVazio;
  const perKwhF = b.eurFora / b.kwhFora;
  assert.ok(perKwhF > perKwhV, 'fora dearer per kWh than vazio');
  close(perKwhF / perKwhV, (CONFIRMED.priceForaVazio + CONFIRMED.iecPerKwh * 1.23 / 1.11) / (CONFIRMED.priceVazio + CONFIRMED.iecPerKwh * 1.23 / 1.11), 0.03);

  // And an hour bucket, with the vazio ending mid-hour.
  const tariff = { ...CONFIRMED, vazioTo: '08:30' };
  const hours = compute(periodContaining('day', date), [makeDay(date, () => slot(100))], tariff);
  const eight = hours.cost.buckets[8];
  close(eight.kwhVazio, 0.2);
  close(eight.kwhFora, 0.2);
  assert.ok(eight.eurVazio > 0 && eight.eurFora > eight.eurVazio);
  assert.equal(hours.cost.buckets[7].kwhFora, 0);
  assert.equal(hours.cost.buckets[9].kwhVazio, 0);
  assertAddsUp(hours);

  assert.deepEqual(vazioRuns(dayStart(date), dayStart(addDays(date, 1)), tariff).map(v => `${hhmm(v.from)}-${hhmm(v.to)}`), ['00:00-08:30', '22:00-00:00']);
}

// --- A gap isn't 0 € --------------------------------------------------------------------------
{
  const date = '2026-11-03';
  const start = dayStart(date);
  const day = makeDay(date, (i, t) => {
    const h = (t - start) / HOUR;
    if (h >= 3 && h < 5) return null; // Two hours nobody recorded.
    if (h >= 12 && h < 13) return slot(0); // An hour with readings and nothing bought: that's a real 0.
    if (h >= 14 && h < 15) return i % 4 === 0 ? slot(200) : null; // A quarter of the hour.
    return slot(100);
  });
  const r = compute(periodContaining('day', date), [day]);
  assertAddsUp(r);
  const at = h => r.cost.buckets[h];
  assert.equal(at(3).state, 'nodata');
  assert.equal(at(3).eur, null);
  assert.equal(eurText(at(3)), 'sem dados');
  assert.match(hourFacts(at(3))[0], /não quer dizer 0 €/);
  assert.equal(at(12).state, 'ok');
  assert.equal(at(12).eur, 0);
  assert.equal(eurText(at(12)), fmtEur(0));
  assert.equal(at(14).state, 'partial');
  assert.ok(at(14).eur > 0);
  assert.match(eurText(at(14)), /^pelo menos /);
  assert.equal(r.cost.incomplete, true);
  assert.ok(reconciliationText(r.cost.split, r.cost.incomplete).startsWith('Energia registada '));

  // A partial bucket as the dearest says so.
  const partialPeak = compute(periodContaining('day', date), [makeDay(date, (i, t) => {
    const h = (t - start) / HOUR;
    return h >= 14 && h < 15 ? (i % 4 === 0 ? slot(900) : null) : slot(10);
  })]);
  assert.match(moneyLine(partialPeak.cost), /^Mais caro: 14:00–15:00, pelo menos /);

  // A period with nothing at all says that, not "no purchases".
  const empty = compute(periodContaining('day', date), []);
  assert.equal(moneyLine(empty.cost), 'Sem dados neste período.');
  assert.ok(empty.cost.buckets.every(b => b.eur === null && b.state === 'nodata'));
  assertAddsUp(empty);

  // Readings and nothing bought: that's what it says, and an hour missing makes it careful.
  assert.equal(moneyLine(compute(periodContaining('day', date), [makeDay(date, () => slot(0))]).cost), 'Sem compras à rede neste período.');
  assert.equal(moneyLine(compute(periodContaining('day', date), [makeDay(date, (i, t) => ((t - start) / HOUR < 2 ? null : slot(0)))]).cost), 'Sem compras à rede nas horas com dados.');
}

// --- Today: the future and what's still on the Pi aren't 0 € ---------------------------------
{
  const date = '2026-11-04';
  const start = dayStart(date);
  const now = lisbonAt(date, '17:30');
  // The bridge writes hourly: at 17:30 the slots stop at 16:45.
  const written = lisbonAt(date, '16:45');
  const day = makeDay(date, (i, t) => (t + SLOT_MS <= written ? slot(100) : null));
  const r = compute(periodContaining('day', date), [day], CONFIRMED, now);
  assertAddsUp(r);
  const at = h => r.cost.buckets[h];
  assert.equal(at(15).state, 'ok');
  assert.equal(at(15).until, undefined);
  // 16:00–17:00 has what has arrived, up to where it has arrived.
  assert.equal(at(16).state, 'ok');
  assert.equal(at(16).until, written);
  assert.ok(hourFacts(at(16)).includes('Até às 16:45.'));
  // 17:00–18:00 has begun, and isn't here yet.
  assert.equal(at(17).state, 'pending');
  assert.equal(at(17).eur, null);
  assert.equal(eurText(at(17)), 'ainda a chegar');
  assert.match(hourFacts(at(17))[0], /de hora a hora/);
  // 18:00 hasn't happened.
  assert.equal(at(18).state, 'future');
  assert.equal(at(18).eur, null);
  assert.equal(eurText(at(18)), 'ainda não aconteceu');
  // Only the time so far is billed, and it still adds up.
  close(r.billedDays, (now - start) / DAY);
  assert.equal(costState({ start: now + 1, coveredSec: 0, expectedSec: 0 }, now), 'future');
}

// --- The clock-change days -------------------------------------------------------------------
for (const [date, hoursInDay, slotsThatDay] of [['2026-03-29', 23, 92], ['2026-10-25', 25, 100]]) {
  const period = periodContaining('day', date);
  const day = makeDay(date, () => slot(100));
  assert.equal(day.slots.length, slotsThatDay);
  const r = compute(period, [day]);
  assertAddsUp(r);
  assert.equal(r.cost.buckets.length, hoursInDay);
  close(r.cost.kwhVazio + r.cost.kwhFora, slotsThatDay * 0.1);
  close(r.billedDays, hoursInDay / 24);
  // Every hour bucket has its four slots, the repeated or skipped one included.
  for (const b of r.cost.buckets) close(b.kwhVazio + b.kwhFora, 0.4);
  // The vazio stretches come out by the wall clock on both days.
  assert.deepEqual(
    vazioRuns(dayStart(date), dayStart(addDays(date, 1)), CONFIRMED).map(v => `${hhmm(v.from)}-${hhmm(v.to)}`),
    ['00:00-08:00', '22:00-00:00'],
  );
  // Bars sit over the strip's same instants: each bar's column starts where that hour starts on the strip.
  const from = r.cost.buckets[0].start;
  const to = r.cost.buckets[r.cost.buckets.length - 1].end;
  assert.equal(to - from, hoursInDay * HOUR);
  for (const width of [280, 640, 913]) {
    const step = (width - COST_MARGINS.left - COST_MARGINS.right) / r.cost.buckets.length;
    r.cost.buckets.forEach((b, i) => close(COST_MARGINS.left + i * step, timeX(b.start, from, to, width, COST_MARGINS), 1e-6));
  }
  // The day inside a week.
  assertAddsUp(compute(periodContaining('week', date), [day]));

  // 15 min × the on share, on a day that isn't 24 h long.
  const doc = { };
  for (let i = 0; i < slotsThatDay; i++) doc[`q${String(i).padStart(2, '0')}`] = { pn: 30, on: 1 };
  const hours = pumpHoursOf(parseClimateDay(date, doc), slotsThatDay);
  assert.equal(hours.hours, hoursInDay);
  assert.equal(hours.incomplete, false);
}

// --- A tap: where it goes --------------------------------------------------------------------
{
  const TODAY = '2026-11-04';
  const bucketOf = date => ({ start: dayStart(date) });
  // Year → month.
  assert.deepEqual(zoomPeriod(periodContaining('year', '2026-06-01'), bucketOf('2026-03-01'), TODAY), { kind: 'month', from: '2026-03-01', to: '2026-03-31' });
  // Month and week → day.
  assert.deepEqual(zoomPeriod(periodContaining('month', '2026-10-01'), bucketOf('2026-10-25'), TODAY), { kind: 'day', from: '2026-10-25', to: '2026-10-25' });
  assert.deepEqual(zoomPeriod(periodContaining('week', '2026-11-04'), bucketOf('2026-11-02'), TODAY), { kind: 'day', from: '2026-11-02', to: '2026-11-02' });
  // A day has nothing further to zoom into.
  assert.equal(zoomPeriod(periodContaining('day', '2026-11-03'), bucketOf('2026-11-03'), TODAY), null);
  // What hasn't happened can't be opened.
  assert.equal(zoomPeriod(periodContaining('week', '2026-11-04'), bucketOf('2026-11-05'), TODAY), null);
  assert.equal(zoomPeriod(periodContaining('year', '2026-11-04'), bucketOf('2026-12-01'), TODAY), null);
  // Today can.
  assert.deepEqual(zoomPeriod(periodContaining('week', '2026-11-04'), bucketOf(TODAY), TODAY), periodContaining('day', TODAY));
  // A long custom period opens months, a short one days; a clipped first month opens the whole month.
  assert.deepEqual(zoomPeriod({ kind: 'custom', from: '2026-01-15', to: '2026-06-30' }, bucketOf('2026-01-15'), TODAY), { kind: 'month', from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(zoomPeriod({ kind: 'custom', from: '2026-01-15', to: '2026-01-20' }, bucketOf('2026-01-16'), TODAY), periodContaining('day', '2026-01-16'));

  // The buckets of a real month → its days, the 25-hour one included.
  const month = periodContaining('month', '2026-10-01');
  const r = compute(month, []);
  r.cost.buckets.forEach((b, i) => {
    assert.equal(zoomPeriod(month, b, TODAY).from, addDays('2026-10-01', i));
  });
  const year = periodContaining('year', '2026-10-01');
  compute(year, []).cost.buckets.forEach((b, i) => {
    assert.equal(zoomPeriod(year, b, '2027-06-01').from, `2026-${String(i + 1).padStart(2, '0')}-01`);
  });
}

// --- A drag: a custom period, whole days, no future ------------------------------------------
{
  const TODAY = '2026-11-04';
  const month = periodContaining('month', '2026-11-01');
  const { cost: { buckets } } = compute(month, []);
  assert.deepEqual(rangePeriod(month, buckets, 1, 2, TODAY), { kind: 'custom', from: '2026-11-02', to: '2026-11-03' });
  assert.deepEqual(rangePeriod(month, buckets, 2, 1, TODAY), { kind: 'custom', from: '2026-11-02', to: '2026-11-03' }, 'either way');
  assert.deepEqual(rangePeriod(month, buckets, 2, 20, TODAY), { kind: 'custom', from: '2026-11-03', to: TODAY }, 'stops today');
  assert.equal(rangePeriod(month, buckets, 3, 3, TODAY), null);
  assert.equal(rangePeriod(month, buckets, 10, 20, TODAY), null, 'all in the future');
  const year = periodContaining('year', '2026-01-01');
  const months = compute(year, []).cost.buckets;
  assert.deepEqual(rangePeriod(year, months, 1, 2, TODAY), { kind: 'custom', from: '2026-02-01', to: '2026-03-31' });
  const day = periodContaining('day', '2026-11-03');
  assert.equal(rangePeriod(day, compute(day, []).cost.buckets, 3, 5, TODAY), null, 'hours aren\'t a period');
}

// --- A press: a tap has no movement; only a mouse drags ---------------------------------------
{
  const base = { canDrag: true, from: 2, to: 5 };
  assert.equal(pressOutcome({ ...base, pointerType: 'touch', moved: false }), 'tap');
  assert.equal(pressOutcome({ ...base, pointerType: 'mouse', moved: false }), 'tap');
  assert.equal(pressOutcome({ ...base, pointerType: 'mouse', moved: true }), 'range');
  // A finger moving is the crosshair; a stylus too.
  assert.equal(pressOutcome({ ...base, pointerType: 'touch', moved: true }), 'none');
  assert.equal(pressOutcome({ ...base, pointerType: 'pen', moved: true }), 'none');
  // Back where it started, or nowhere to select: neither a tap nor a range.
  assert.equal(pressOutcome({ ...base, pointerType: 'mouse', moved: true, to: 2 }), 'none');
  assert.equal(pressOutcome({ ...base, pointerType: 'mouse', moved: true, canDrag: false }), 'none');
  assert.equal(movedBeyondTap(10, 10, 14, 14), false, 'a shaky finger is still a tap');
  assert.equal(movedBeyondTap(10, 10, 10, 30), true);
}

// --- The € scale ------------------------------------------------------------------------------
assert.equal(niceEur(0), 0.1);
assert.equal(niceEur(0.03), 0.1);
assert.equal(niceEur(0.42), 0.5);
assert.equal(niceEur(1), 1);
assert.equal(niceEur(2.2), 2.5);
assert.equal(niceEur(34), 50);

// --- The pump on the real 2026-11-04 ----------------------------------------------------------
{
  const DATE = '2026-11-04';
  const at = t => lisbonAt(DATE, t);
  const sw = (time, on, source, reason) => ({
    kind: 'switch', id: `sw-${time}`, deviceName: 'Bomba', at: at(time), on, source, reason, faults: [], before: [], origin: 'bridge',
  });
  const SWITCHES = [
    sw('05:30', true, 'automation', 'ligar (a aquecer para as 06:00)'),
    sw('08:00', false, 'automation', 'desligar (de dia só com sol: bateria 18 % de 40 %, a carregar 0,2 kW de 2,7 kW)'),
    sw('11:31', true, 'automation', 'ligar (com o sol: bateria 42 %, a carregar 3,0 kW)'),
    sw('11:54', false, 'outside'),
    sw('12:27', true, 'outside'),
    sw('15:54', false, 'outside'),
    sw('16:30', true, 'automation', 'ligar (a aquecer para as 17:00)'),
    sw('23:00', false, 'automation', 'desligar (de dia só com sol: bateria 30 % de 40 %, a carregar 0,0 kW de 2,7 kW)'),
  ];
  const on = t => SWITCHES.reduce((v, s) => (s.at <= t ? s.on : v), false);
  const doc = { date: DATE, zones: { a: 'Sala' } };
  const start = dayStart(DATE);
  for (let i = 0; i < 96; i++) {
    let share = 0;
    for (let k = 0; k < 15; k++) if (on(start + i * SLOT_MS + k * 60_000)) share += 1 / 15;
    doc[`q${String(i).padStart(2, '0')}`] = { n: 30, pn: 30, on: share, run: share, plan: 'day', z: { a: { t: 23, s: 25, v: 1 } } };
  }
  const climate = parseClimateDay(DATE, doc);
  const record = { climate, incidents: SWITCHES, before: null };
  const view = buildHeatingDay({ date: DATE, now: dayStart(addDays(DATE, 2)), record });

  const pump = pumpLaneOf(view);
  assert.equal(pump.lane.id, 'pump');
  assert.ok(pump.legend.includes('pump-schedule') && pump.legend.includes('pump-sun') && pump.legend.includes('pump-outside') && pump.legend.includes('pump-off'));
  assert.ok(!pump.legend.some(k => k.startsWith('plan-')), 'only the pump\'s own tones');
  assert.equal(pump.lane.note, 'ligada 12 h 50 min');

  // Hour by hour, from the switches' real times.
  const inHour = (a, b) => pumpInBucket(view.pump, at(a), at(b));
  assert.equal(inHour('05:00', '06:00').onMin, 30);
  assert.equal(inHour('08:00', '09:00').onMin, 0);
  assert.equal(inHour('11:00', '12:00').onMin, 23);
  assert.equal(inHour('12:00', '13:00').onMin, 33);
  assert.equal(pumpText(inHour('11:00', '12:00')), 'Bomba ligada 23 min');
  assert.equal(pumpText(inHour('09:00', '10:00')), 'Bomba desligada');
  assert.equal(inHour('11:00', '12:00').main.kind, 'sun');
  assert.equal(inHour('12:00', '13:00').main.kind, 'outside');
  assert.equal(pumpText({ onMin: 0, main: null }), undefined);
  // The words come from step 2, unchanged: an expensive hour can say why the pump was on.
  assert.match(view.describe({ lane: 'pump', t: at('11:40') }).text, /^11:31–11:54 · Ligada pela automação, com o sol: bateria 42 %/);

  // Per day: 15 min × share, the same 12 h 50 min.
  const hours = pumpHoursOf(climate, 96);
  close(hours.hours, 12 + 50 / 60, 0.01);
  assert.equal(hours.incomplete, false);
  // A slot the pump didn't answer in isn't "off"; too many of those and it's a lower bound.
  const quiet = {};
  for (let i = 0; i < 40; i++) quiet[`q${String(i).padStart(2, '0')}`] = { pn: 30, on: 1 };
  for (let i = 40; i < 96; i++) quiet[`q${String(i).padStart(2, '0')}`] = { pn: 0 };
  const partial = pumpHoursOf(parseClimateDay(DATE, quiet), 96);
  assert.equal(partial.hours, 10);
  assert.equal(partial.incomplete, true);
  // Nothing read, or no document: no number at all, not 0 h.
  assert.equal(pumpHoursOf(parseClimateDay(DATE, { q00: { pn: 0 } }), 96), null);
  assert.equal(pumpHoursOf(null, 96), null);

  // By bucket, for the week's row.
  const week = periodContaining('week', DATE);
  const today = DATE;
  const now = lisbonAt(today, '17:30');
  const weekDay = makeDay(today, (i, t) => (t + SLOT_MS <= lisbonAt(today, '16:45') ? slot(100) : null));
  const { cost } = compute(week, [weekDay], CONFIRMED, now);
  const byBucket = pumpHoursByBucket(cost.buckets, new Map([['2026-11-02', null], [today, climate]]));
  assert.equal(byBucket[0], null, 'a day read, with no document');
  assert.equal(byBucket[1], undefined, 'a day not read');
  assert.ok(byBucket[2].hours > 0);
  assert.equal(byBucket[3], undefined, 'hasn\'t happened');
}

// --- One query per unbroken run of days not known: nothing read twice ------------------------
assert.deepEqual(dateRuns([]), []);
assert.deepEqual(dateRuns(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-03', '2026-11-05', '2026-11-06']), [
  ['2026-10-30', '2026-10-31', '2026-11-01'], ['2026-11-03'], ['2026-11-05', '2026-11-06'],
]);

console.log('cost timeline: ok');
