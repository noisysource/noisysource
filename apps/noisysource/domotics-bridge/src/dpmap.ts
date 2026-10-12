/**
 * Tuya datapoint numbers -> the string codes the Cloud API used.
 *
 * The bridge deliberately emits the *same* `{code, value}` shape the cloud
 * returned, so `apps/noisysource/domotics/src/data/tuyaData.ts` works unchanged
 * and the app stays agnostic about whether state came from the cloud or the LAN.
 *
 * The thermostat mapping was derived empirically: cloud status and local dps
 * were read back-to-back and matched on value. The heat pump mapping comes from
 * its Tuya cloud thing model — see the comment on `ZNRB`.
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
 * Zantia Vancouver 13 (single-phase, R32) heat pump, Zantia code 2301-0273,
 * talking through a Tuya module (category `znrb`, Tuya product "HY
 * Multifunctional Heat Pump V1.2"). Manual ("Vancouver 13DC-32"):
 * https://zantia.com/storage/products/vzau85qrqt.pdf
 *
 * Unlike the thermostat map above, this one comes from the device's Tuya cloud
 * thing model (`/v2.0/cloud/thing/{id}/model` + `/shadow/properties`), read on
 * 2026-10-02, and was cross-checked against live values. The Tuya `code`
 * strings are generic names the module vendor reused for whatever the unit
 * actually reports, so most of them are MISLEADING — the comment on each line
 * is the real meaning (the model's display name). The codes themselves are kept
 * verbatim because they are what the cloud returns, and this file's contract is
 * that cloud and LAN produce the same `{code, value}` shape.
 *
 * "x10" = tenths of a degree (Tuya scale 1). Bitmap DPs carry fault codes, one
 * bit each; the bit -> E-code tables live in the app
 * (`apps/noisysource/domotics/src/data/heatpumpFaults.ts`).
 */
const ZNRB: Record<string, string> = {
  '1': 'switch',                   // on/off
  '2': 'mode',                     // enum Hot | Heating | Hot_Heating | Cooling | Hot_Cooling (Hot = DHW)
  '15': 'fault',                   // bitmap, bit i -> E(i+1): E01..E16
  '16': 'temp_current',            // compressor frequency, Hz (scale 0)
  '18': 'power_consumption',       // C00 coil temperature, °C x10
  '20': 'compressor_strength',     // C01 discharge temperature, °C x10
  '21': 'temp_top',                // outdoor/ambient temperature, °C x10
  '22': 'temp_bottom',             // C03 suction temperature, °C x10
  '23': 'coiler_temp',             // water inlet temperature, °C x10
  '24': 'venting_temp',            // water outlet temperature (Tout), °C x10
  '25': 'effluent_temp',           // DHW tank temperature (TDHW), °C x10
  '109': 'smart_system',           // fault bitmap: E17..E32
  '117': 'p02_heating',            // heating setpoint, °C (scale 0)
  '118': 'p03_cooling',            // cooling setpoint, °C (scale 0)
  '119': 'p04_dhw',                // DHW setpoint, °C (scale 0)
  '120': 'power_system',           // fault bitmap: E36, E40, E44, E45, E59
  '121': 'ithium_battery_system',  // fault bitmap: E50 (sic, vendor's spelling)
  '122': 'electronic_system',      // fault bitmap: IPM module sub-codes E20_x
  '123': 'bcu_com_state',          // fault bitmap: IPM module sub-codes E20_x
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
