/**
 * Tuya datapoint numbers -> the string codes the Cloud API used.
 *
 * The bridge deliberately emits the *same* `{code, value}` shape the cloud
 * returned, so `apps/noisysource/domotics/src/data/tuyaData.ts` works unchanged
 * and the app stays agnostic about whether state came from the cloud or the LAN.
 *
 * Every mapping below was derived empirically: cloud status and local dps were
 * read back-to-back and matched on value, rather than taken from documentation
 * that may not describe these particular products.
 */

/** TR01-WF radiator thermostat (category `wk`). */
const WK: Record<string, string> = {
  '2': 'mode',
  '8': 'window_check',
  '10': 'frost',
  '16': 'temp_set',
  '23': 'temp_unit_convert',
  '24': 'temp_current',
  '27': 'temp_correction',
  '31': 'work_days',
  '32': 'holiday_temp_set',
  '34': 'humidity',
  '35': 'battery_percentage',
  '36': 'valve_state',
  '40': 'child_lock',
  '45': 'fault',
  '46': 'holiday_set',
};

/**
 * MTATWHP-5C heat pump (category `znrb`).
 *
 * Only the datapoints confirmed by correlation are listed. `temp_set`,
 * `water_set`, `temp_current` and `child_lock` all read 0/false at the time of
 * sampling, so they could not be told apart from a dozen other zero-valued
 * datapoints and are deliberately left out rather than guessed. Re-run the
 * correlation once one of them is non-zero to pin it down.
 */
const ZNRB: Record<string, string> = {
  '1': 'switch',
  '2': 'mode',
  '18': 'power_consumption',
  '20': 'compressor_strength',
  '21': 'temp_top',
  '22': 'temp_bottom',
};

const BY_CATEGORY: Record<string, Record<string, string>> = { wk: WK, znrb: ZNRB };

/** Reverse lookup, for turning an app command back into a datapoint. */
export function dpForCode(category: string, code: string): string | undefined {
  const map = BY_CATEGORY[category];
  if (!map) return undefined;
  return Object.keys(map).find(dp => map[dp] === code);
}

/**
 * Convert a raw dps object into the cloud's status array. Unmapped datapoints
 * are dropped: the products expose plenty we have no meaning for, and passing
 * numeric keys downstream would just be noise.
 */
export function dpsToStatus(
  category: string,
  dps: Record<string, unknown>,
): Array<{ code: string; value: unknown }> {
  const map = BY_CATEGORY[category] ?? {};
  const out: Array<{ code: string; value: unknown }> = [];
  for (const [dp, value] of Object.entries(dps)) {
    const code = map[dp];
    if (code) out.push({ code, value });
  }
  return out;
}
