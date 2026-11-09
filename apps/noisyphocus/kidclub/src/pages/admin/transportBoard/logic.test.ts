import { describe, expect, it } from 'vitest';
import {
  buildGrid, buildRuns, dropOf, legNotes, moveBox, peakAfterPickups, seatsAt, seatsDuring, storedOf, toMin, VEHICLES, warnings,
  type StoredRun, type SubInput, type TransportRun,
} from './logic';

const run = (over: Partial<TransportRun>): TransportRun => ({ id: 'r1', source: 'plan', name: 'Lara', day: 3, vehicle: 'car', time: '17:15', ...over });
const TODAY = '2026-11-09';

describe('runs from subscriptions', () => {
  const lourenco: SubInput = {
    id: 'sub1', status: 'active', childName: 'Lourenço Bernardino',
    schedule: [
      { dayOfWeek: 'wednesday', pickupTime: '17:15', pickupLocation: 'Colégio Bissaya Barreto, Rua dos Plátanos, Coimbra', dropoffLocation: 'Arco - Íris Da Pequenada, Coimbra' },
      { dayOfWeek: 'wednesday', pickupTime: '08:00', pickupLocation: 'Rua A 1, Coimbra', dropoffLocation: 'Colégio Bissaya Barreto' },
    ],
  };
  it('makes one run per leg, in the van, numbered by time within the day', () => {
    const runs = buildRuns([lourenco], new Map(), TODAY);
    expect(runs.map(r => [r.id, r.time, r.vehicle, r.from])).toEqual([
      ['sub1_2_0', '08:00', 'van', 'Rua A 1'],
      ['sub1_2_1', '17:15', 'van', 'Colégio Bissaya Barreto'],
    ]);
  });
  it("applies the board's plan for a leg", () => {
    const stored = new Map<string, StoredRun>([['sub1_2_1', { subId: 'sub1', vehicle: 'car', time: '17:20', dropAt: '17:39', note: 'IPN' }]]);
    const r = buildRuns([lourenco], stored, TODAY).find(x => x.id === 'sub1_2_1')!;
    expect([r.vehicle, r.time, r.requested, r.dropAt, r.note]).toEqual(['car', '17:20', '17:15', '17:39', 'IPN']);
    expect(legNotes(r)).toEqual(['Pedido às 17:15']);
  });
  it('leaves out cancelled and ended subscriptions, and plans for legs that are gone', () => {
    const subs: SubInput[] = [{ ...lourenco, status: 'cancelled' }, { ...lourenco, id: 'old', endDate: '2026-07-31' }];
    const stored = new Map<string, StoredRun>([['sub9_0_0', { subId: 'sub9', vehicle: 'car' }]]);
    expect(buildRuns(subs, stored, TODAY)).toEqual([]);
  });
  it('marks pending, alternate-week and later-starting subscriptions', () => {
    const r = buildRuns([{ ...lourenco, status: 'pending', weekPattern: 'odd', startDate: '2026-12-01' }], new Map(), TODAY)[0];
    expect(r.status).toBe('pending');
    expect(legNotes(r)).toEqual(['1.ª e 3.ª semanas do mês', 'Começa a 01/12']);
  });
  it('adds planning-only runs, and skips broken ones', () => {
    const stored = new Map<string, StoredRun>([
      ['p1', { name: "Filipa's 3", day: 3, vehicle: 'car', time: '17:00', seats: 3, to: 'Piscina' }],
      ['p2', { name: 'No time', day: 1, vehicle: 'van' }],
    ]);
    expect(buildRuns([], stored, TODAY).map(r => [r.id, r.source, r.seats])).toEqual([['p1', 'plan', 3]]);
  });
  it('stores only the plan for a leg, and the full run for a planning-only one', () => {
    const leg = buildRuns([lourenco], new Map(), TODAY)[1];
    expect(storedOf({ ...leg, vehicle: 'car', dropAt: '17:39' })).toEqual({ subId: 'sub1', leg: 1, day: 2, vehicle: 'car', dropAt: '17:39' });
    expect(storedOf({ ...leg, time: '17:30' })).toMatchObject({ time: '17:30' });
    expect(storedOf(run({ seats: 3, from: 'Casa da Criança' }))).toEqual({ name: 'Lara', day: 3, time: '17:15', from: 'Casa da Criança', seats: 3, vehicle: 'car' });
  });
});

describe('drop-off times', () => {
  it('treats a missing drop-off as a 15-minute placeholder', () => {
    expect(dropOf({ time: '17:15' })).toEqual({ time: '17:30', guess: true });
  });
  it('keeps the time of a ~ placeholder', () => {
    expect(dropOf({ time: '18:00', dropAt: '~18:15' })).toEqual({ time: '18:15', guess: true });
  });
  it('reads a time set by hand as exact', () => {
    expect(dropOf({ time: '17:15', dropAt: '17:33' })).toEqual({ time: '17:33', guess: false });
  });
});

describe('seats on board', () => {
  const lane = [run({ id: 'a', time: '17:00', dropAt: '17:30', seats: 2 }), run({ id: 'b', time: '17:15', dropAt: '17:45' })];
  it('adds up overlapping runs', () => {
    expect(seatsAt(lane, toMin('17:20'))).toBe(3);
  });
  it('lets a child off at their drop-off minute', () => {
    expect(seatsAt(lane, toMin('17:30'))).toBe(1);
    expect(seatsAt(lane, toMin('17:45'))).toBe(0);
  });
  it('marks the row holding a drop-off as busy for the lane strip', () => {
    expect(seatsDuring(lane, toMin('17:45'))).toBe(1);
    expect(seatsDuring(lane, toMin('17:50'))).toBe(0);
  });
});

describe('overload', () => {
  const thursdayCar = [
    run({ id: 'lara', name: 'Lara', time: '17:15', dropAt: '17:33' }),
    run({ id: 'lou', name: 'Lourenço', time: '17:15', dropAt: '17:39' }),
    run({ id: 'fil', name: "Filipa's 3", time: '17:10', dropAt: '17:40', seats: 3 }),
  ];
  it('fits five children in the car', () => {
    expect(peakAfterPickups(thursdayCar, ['17:15'])).toBe(VEHICLES.car.seats);
  });
  it('flags a sixth child in the car', () => {
    const lane = [...thursdayCar, run({ id: 'x', name: 'Leonor', time: '17:30', dropAt: '17:44' })];
    expect(peakAfterPickups(lane, ['17:30'])).toBeGreaterThan(VEHICLES.car.seats);
  });
});

describe('warnings', () => {
  it('warns when the drop-off is after the must-arrive-by time', () => {
    expect(warnings(run({ dropAt: '17:55', by: '17:50' }), 'drop')).toEqual(['Depois do limite das 17:50']);
  });
  it('stays quiet when the drop-off is in time', () => {
    expect(warnings(run({ dropAt: '17:44', by: '17:50' }), 'drop')).toEqual([]);
  });
});

describe('moving boxes', () => {
  const lara = run({ time: '17:15', dropAt: '17:33' });
  it('carries the drop-off with a pick-up, keeping the drive time', () => {
    const out = moveBox(lara, 'pick', 3, 'car', '17:30');
    expect(out && 'run' in out && [out.run.time, out.run.dropAt]).toEqual(['17:30', '17:48']);
  });
  it('moves a drop-off alone', () => {
    const out = moveBox(lara, 'drop', 3, 'car', '17:45');
    expect(out && 'run' in out && [out.run.time, out.run.dropAt]).toEqual(['17:15', '17:45']);
  });
  it('refuses a drop-off before its pick-up', () => {
    expect(moveBox(lara, 'drop', 3, 'car', '17:10')).toEqual({ error: 'A entrega tem de ser depois da recolha das 17:15.' });
  });
  it('sets a placeholder dropped back on its own row', () => {
    const out = moveBox(run({}), 'drop', 3, 'car', '17:30');
    expect(out && 'run' in out && out.run.dropAt).toBe('17:30');
  });
  it('does nothing when a box lands where it was', () => {
    expect(moveBox(lara, 'pick', 3, 'car', '17:15')).toBeNull();
  });
  it("moves a planning-only run to another day, but not a subscription leg", () => {
    const out = moveBox(lara, 'drop', 2, 'van', '17:30');
    expect(out && 'run' in out && [out.run.day, out.run.vehicle]).toEqual([2, 'van']);
    expect(moveBox({ ...lara, source: 'sub' }, 'pick', 2, 'car', '17:15')).toHaveProperty('error');
    expect(moveBox({ ...lara, source: 'sub' }, 'pick', 3, 'van', '17:15')).toHaveProperty('run');
  });
});

describe('grid', () => {
  it('shows every run twice, in its pick-up and drop-off rows', () => {
    const grid = buildGrid([run({ dropAt: '17:33' })]);
    expect(grid.cells.get('3|car|17:15')?.map(b => b.part)).toEqual(['pick']);
    expect(grid.cells.get('3|car|17:30')?.map(b => b.part)).toEqual(['drop']);
  });
  it('adds a row for a box outside the usual hours', () => {
    expect(buildGrid([run({ time: '12:30' })]).slots).toContain('12:30');
  });
});
