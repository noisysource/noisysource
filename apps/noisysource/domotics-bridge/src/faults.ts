/**
 * Heat pump fault bitmaps -> E-codes, for the incidents the bridge records.
 *
 * A copy of the bit tables in the app (`apps/noisysource/domotics/src/data/
 * heatpumpFaults.ts`, which also holds the meanings), kept here because the
 * bridge is a separate deployable. Which bit is which code comes from the
 * pump's Tuya thing model; keep both copies in step if it ever changes.
 */

/** The pump's fault bitmaps, by Tuya status code. Any of them set = a fault. */
export const PUMP_FAULT_CODES = [
  'fault', 'smart_system', 'power_system', 'ithium_battery_system', 'electronic_system', 'bcu_com_state',
];

const E01_E16 = Array.from({ length: 16 }, (_, i) => `E${String(i + 1).padStart(2, '0')}`);

/** null = bit unused by the model. */
const FAULT_BITMAPS: Record<string, ReadonlyArray<string | null>> = {
  fault: E01_E16,
  smart_system: [
    'E17', 'E18', 'E19', 'E20', null, 'E22', 'E23', 'E24',
    'E21', 'E25', 'E26', 'E27', 'E28', 'E29', 'E58', null, 'E32',
  ],
  power_system: [null, null, null, 'E36', null, null, 'E59', 'E40', null, null, null, 'E44', 'E45'],
  ithium_battery_system: [null, 'E50'],
  electronic_system: [
    'E20_1', 'E20_5', null, null, null, 'E20_288', 'E20_384', 'E20_32',
    'E20_16', 'E20_264', 'E20_260', null, null, null, null, 'E20_257',
  ],
  bcu_com_state: ['E20_290', null, 'E20_4', null, 'E20_261'],
};

/**
 * Every active code across the bitmaps. A set bit the model doesn't name is
 * still reported (`<code>#<bit>`): an unexplained alarm beats a silent one.
 */
export function decodeFaults(get: (code: string) => unknown): string[] {
  const out: string[] = [];
  for (const code of PUMP_FAULT_CODES) {
    const v = get(code);
    let n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
    if (!Number.isInteger(n) || n <= 0) continue;
    // Division rather than bitwise ops, so values above 2^31 don't go negative.
    for (let bit = 0; n > 0; bit++, n = Math.floor(n / 2)) {
      if (n % 2 === 1) out.push(FAULT_BITMAPS[code][bit] ?? `${code}#${bit}`);
    }
  }
  return out;
}
