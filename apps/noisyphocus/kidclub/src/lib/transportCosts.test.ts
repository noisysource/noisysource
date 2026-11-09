import { describe, expect, it } from 'vitest';
import { LEGACY_VAN_ID, TransportationConfig, TransportVehicle, vehiclesOf } from '@shared/models/Transportation';
import {
  addVehicle,
  hourlyDriverMonthlyCost,
  parseVehicleField,
  removeVehicle,
  transportCosts,
  updateVehicle,
} from './transportCosts';

// Made-up figures: the real ones live only in Firestore and differ between prod and dev.
const oldDoc: Partial<TransportationConfig> = {
  flatRatePerTrip: 4,
  vanCapacity: 8,
  vanMonthlyCost: 500,
  driverMonthlyCost: 1200,
  electricityMonthlyCost: 150,
};

const van: TransportVehicle = {
  id: 'van', label: 'Carrinha', seats: 8,
  vehicleMonthlyCost: 500, driverMonthlyCost: 1200, electricityMonthlyCost: 150,
};
const tesla: TransportVehicle = {
  id: 'v-tesla', label: 'Tesla Model X', seats: 5,
  vehicleMonthlyCost: 0, driverMonthlyCost: 260, electricityMonthlyCost: 40,
};

describe('vehiclesOf', () => {
  it('builds one van from the old single-van fields', () => {
    expect(vehiclesOf(oldDoc)).toEqual([{ ...van, id: LEGACY_VAN_ID }]);
  });

  it('treats a missing doc or missing old fields as €0, not as made-up costs', () => {
    for (const cfg of [null, undefined, {}]) {
      expect(vehiclesOf(cfg)).toEqual([{
        id: LEGACY_VAN_ID, label: 'Carrinha', seats: 8,
        vehicleMonthlyCost: 0, driverMonthlyCost: 0, electricityMonthlyCost: 0,
      }]);
    }
  });

  it('takes the van seats from vanCapacity when it is set', () => {
    expect(vehiclesOf({ vanCapacity: 9 })[0].seats).toBe(9);
    expect(vehiclesOf({ vanCapacity: 0 })[0].seats).toBe(8);
  });

  it('uses the list when there is one and ignores the old fields', () => {
    const cfg = { ...oldDoc, vanMonthlyCost: 999, vehicles: [van, tesla] };
    expect(vehiclesOf(cfg)).toEqual([van, tesla]);
  });

  it('falls back to the old fields for an empty list', () => {
    expect(vehiclesOf({ ...oldDoc, vehicles: [] })).toEqual([van]);
  });

  it('sanitises bad stored values instead of producing NaN', () => {
    const cfg = { vehicles: [{ id: '', label: ' ', seats: -1, vehicleMonthlyCost: 'x', driverMonthlyCost: NaN } as unknown as TransportVehicle] };
    expect(vehiclesOf(cfg)).toEqual([{
      id: 'vehicle-1', label: 'Viatura 1', seats: 0,
      vehicleMonthlyCost: 0, driverMonthlyCost: 0, electricityMonthlyCost: 0,
    }]);
  });
});

describe('transportCosts', () => {
  it('costs an old doc exactly as the single-van page did (fields × months)', () => {
    const months = 10;
    const old = {
      van: (oldDoc.vanMonthlyCost ?? 0) * months,
      driver: (oldDoc.driverMonthlyCost ?? 0) * months,
      electricity: (oldDoc.electricityMonthlyCost ?? 0) * months,
    };
    const c = transportCosts(oldDoc, months);
    expect(c.vehicleCost).toBe(old.van);
    expect(c.driverCost).toBe(old.driver);
    expect(c.electricityCost).toBe(old.electricity);
    expect(c.total).toBe(old.van + old.driver + old.electricity);
  });

  it('sums every vehicle’s three costs × months', () => {
    const c = transportCosts({ vehicles: [van, tesla] }, 3);
    expect(c.perVehicle.map(p => p.total)).toEqual([(500 + 1200 + 150) * 3, (0 + 260 + 40) * 3]);
    expect(c.vehicleCost).toBe(1500);
    expect(c.driverCost).toBe((1200 + 260) * 3);
    expect(c.electricityCost).toBe((150 + 40) * 3);
    expect(c.total).toBe((1850 + 300) * 3);
  });

  it('a first save of an old doc (its vehiclesOf list) costs the same as the old doc', () => {
    const saved = { ...oldDoc, vehicles: vehiclesOf(oldDoc) };
    expect(transportCosts(saved, 7)).toEqual(transportCosts(oldDoc, 7));
  });

  it('adding a vehicle with no costs yet changes nothing', () => {
    const before = transportCosts(oldDoc, 5).total;
    const after = transportCosts({ ...oldDoc, vehicles: addVehicle(vehiclesOf(oldDoc), 'v-new') }, 5).total;
    expect(after).toBe(before);
  });

  it('rounds to cents', () => {
    const c = transportCosts({ vehicles: [{ ...tesla, driverMonthlyCost: 0.1, electricityMonthlyCost: 0.2 }] }, 3);
    expect(c.total).toBe(0.9);
  });

  it('costs nothing over zero or invalid months', () => {
    expect(transportCosts(oldDoc, 0).total).toBe(0);
    expect(transportCosts(oldDoc, NaN).total).toBe(0);
  });
});

describe('editing the list', () => {
  it('parses inputs like the old cost inputs (blank = 0) and rejects bad ones', () => {
    expect(parseVehicleField('driverMonthlyCost', '')).toBe(0);
    expect(parseVehicleField('driverMonthlyCost', ' 1200 ')).toBe(1200);
    expect(parseVehicleField('electricityMonthlyCost', '12,5')).toBe(12.5);
    expect(parseVehicleField('vehicleMonthlyCost', '-1')).toBeNull();
    expect(parseVehicleField('vehicleMonthlyCost', 'abc')).toBeNull();
    expect(parseVehicleField('seats', '5')).toBe(5);
    expect(parseVehicleField('seats', '5.5')).toBeNull();
    expect(parseVehicleField('label', '  Tesla Model X ')).toBe('Tesla Model X');
    expect(parseVehicleField('label', '   ')).toBeNull();
  });

  it('updates one field of one vehicle only', () => {
    const next = updateVehicle([van, tesla], 'v-tesla', 'driverMonthlyCost', 300);
    expect(next).toEqual([van, { ...tesla, driverMonthlyCost: 300 }]);
    expect(updateVehicle([van], 'nope', 'seats', 3)).toEqual([van]);
  });

  it('adds a vehicle with zero costs, a default name and a unique id', () => {
    const next = addVehicle([van], 'van');
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(van);
    expect(next[1]).toEqual({
      id: 'van-2', label: 'Viatura 2', seats: 0,
      vehicleMonthlyCost: 0, driverMonthlyCost: 0, electricityMonthlyCost: 0,
    });
  });

  it('removes a vehicle but never the last one', () => {
    expect(removeVehicle([van, tesla], 'v-tesla')).toEqual([van]);
    expect(removeVehicle([van], 'van')).toEqual([van]);
  });
});

describe('hourlyDriverMonthlyCost', () => {
  it('is hours a week × €6 × 4.33', () => {
    expect(hourlyDriverMonthlyCost('10')).toBe(259.8);
    expect(hourlyDriverMonthlyCost('7,5')).toBe(194.85);
    expect(hourlyDriverMonthlyCost('0')).toBe(0);
  });

  it('gives nothing for blank or bad hours', () => {
    expect(hourlyDriverMonthlyCost('')).toBeNull();
    expect(hourlyDriverMonthlyCost('-2')).toBeNull();
    expect(hourlyDriverMonthlyCost('x')).toBeNull();
  });
});
