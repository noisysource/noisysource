// The main board's amps on the home screen, from the inverter's figures.
const assert = require('node:assert/strict');
const { GRID_LIMIT_A, supplyNow, formatAmps } = require('../node_modules/.tmp/test/supply.cjs');

assert.equal(GRID_LIMIT_A, 30);
assert.equal(supplyNow(null), undefined);
assert.equal(supplyNow({ online: false, readAt: 0, gridPowerW: -1000 }), undefined);

// Exporting draws nothing from the grid.
const exp = supplyNow({ online: true, readAt: 0, gridPowerW: 500, consumptionW: 400, acVoltageV: 238 });
assert.equal(exp.gridA, 0);
assert.equal(exp.tone, 'ok');
assert.ok(Math.abs(exp.houseA - 400 / 238) < 1e-9);

// Importing 5.5 kW at 230 V is 23.9 A: warn; 6 kW is 80 %+: high.
assert.equal(supplyNow({ online: true, readAt: 0, gridPowerW: -5500, acVoltageV: 230 }).tone, 'warn');
assert.equal(supplyNow({ online: true, readAt: 0, gridPowerW: -6000, acVoltageV: 230 }).tone, 'high');
// A missing or nonsense voltage falls back to 230 V.
assert.equal(supplyNow({ online: true, readAt: 0, gridPowerW: -2300, acVoltageV: 0 }).gridA, 10);

assert.equal(formatAmps(undefined), '—');
assert.equal(formatAmps(14.56), '14,6 A');
console.log('supply: ok');
