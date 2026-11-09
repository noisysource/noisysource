import { describe, expect, it } from 'vitest';
import { buildGrid, dropOf, isRun, moveBox, peakAfterPickups, seatsAt, seatsDuring, toMin, VEHICLES, warnings, type TransportRun } from './logic';

const run = (over: Partial<TransportRun>): TransportRun => ({ id: 'r1', name: 'Lara', day: 3, vehicle: 'car', time: '17:15', ...over });

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
  it('ignores a malformed drop-off', () => {
    expect(dropOf({ time: '08:45', dropAt: 'soon' })).toEqual({ time: '09:00', guess: true });
  });
});

describe('seats on board', () => {
  const lane = [
    run({ id: 'a', time: '17:00', dropAt: '17:30', seats: 2 }),
    run({ id: 'b', time: '17:15', dropAt: '17:45' }),
  ];
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
    expect(peakAfterPickups(thursdayCar, ['17:15'])).toBe(5);
    expect(peakAfterPickups(thursdayCar, ['17:15'])).toBeLessThanOrEqual(VEHICLES.car.seats);
  });
  it('flags a sixth child in the car', () => {
    const lane = [...thursdayCar, run({ id: 'x', name: 'Leonor', time: '17:30', dropAt: '17:44' })];
    expect(peakAfterPickups(lane, ['17:30'])).toBe(6);
    expect(peakAfterPickups(lane, ['17:30'])).toBeGreaterThan(VEHICLES.car.seats);
  });
  it('counts a two-seat run as two children', () => {
    const lane = thursdayCar.map(r => (r.id === 'lara' ? { ...r, seats: 2 } : r));
    expect(peakAfterPickups(lane, ['17:15'])).toBe(6);
  });
});

describe('warnings', () => {
  it('warns when the drop-off is after the must-arrive-by time', () => {
    expect(warnings(run({ dropAt: '17:55', by: '17:50' }), 'drop')).toEqual(['Depois do limite das 17:50']);
  });
  it('stays quiet when the drop-off is in time', () => {
    expect(warnings(run({ dropAt: '17:44', by: '17:50' }), 'drop')).toEqual([]);
  });
  it('only asks the van driver about van runs', () => {
    expect(warnings(run({ vanCheck: true, vehicle: 'van' }), 'pick')).toEqual(['Motorista da carrinha a confirmar']);
    expect(warnings(run({ vanCheck: true, vehicle: 'car' }), 'pick')).toEqual([]);
  });
});

describe('moving boxes', () => {
  const lara = run({ time: '17:15', dropAt: '17:33' });
  it('carries the drop-off with a pick-up, keeping the drive time', () => {
    const out = moveBox(lara, 'pick', 3, 'car', '17:30');
    expect(out && 'body' in out && [out.body.time, out.body.dropAt]).toEqual(['17:30', '17:48']);
  });
  it('keeps a placeholder a placeholder when its pick-up moves', () => {
    const out = moveBox(run({ dropAt: '~17:30' }), 'pick', 3, 'car', '17:40');
    expect(out && 'body' in out && out.body.dropAt).toBe('~17:55');
  });
  it('moves a drop-off alone', () => {
    const out = moveBox(lara, 'drop', 3, 'car', '17:45');
    expect(out && 'body' in out && [out.body.time, out.body.dropAt]).toEqual(['17:15', '17:45']);
  });
  it('refuses a drop-off before its pick-up', () => {
    expect(moveBox(lara, 'drop', 3, 'car', '17:10')).toEqual({ error: 'A entrega tem de ser depois da recolha das 17:15.' });
  });
  it('sets a placeholder dropped back on its own row', () => {
    const out = moveBox(run({}), 'drop', 3, 'car', '17:30');
    expect(out && 'body' in out && out.body.dropAt).toBe('17:30');
  });
  it('does nothing when a box lands where it was', () => {
    expect(moveBox(lara, 'pick', 3, 'car', '17:15')).toBeNull();
    expect(moveBox(lara, 'drop', 3, 'car', '17:30')).toBeNull();
  });
  it('takes the whole run to another vehicle and day', () => {
    const out = moveBox(lara, 'drop', 2, 'van', '17:30');
    expect(out && 'body' in out && [out.body.day, out.body.vehicle, out.body.time, out.body.dropAt]).toEqual([2, 'van', '17:15', '17:33']);
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
  it('rejects documents that are not runs', () => {
    expect(isRun(run({}))).toBe(true);
    expect(isRun({ ...run({}), vehicle: 'bike' })).toBe(false);
    expect(isRun({ ...run({}), time: '9:00' })).toBe(false);
  });
});
