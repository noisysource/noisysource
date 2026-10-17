/**
 * Domotics device model — each Shelly/Legrand channel = one logical Device.
 * Devices are grouped by room (roomId) and optionally by circuit.
 */

export interface LightState {
  on: boolean;
  brightness: number; // 0–100
  dimmable: boolean;
}

export interface BlindState {
  /**
   * Percentage OPEN: 100 = fully open, 0 = fully closed.
   * Matches Netatmo's `current_position`/`target_position` exactly, so no
   * conversion happens at the API boundary — keep it that way.
   */
  position: number;
  isMoving: boolean;
  movingDirection: 'up' | 'down' | null;
}

/** Which cloud a device is reached through. Decides the command path. */
export type Vendor = 'legrand' | 'tuya';

interface DeviceBase {
  id: string;
  roomId: string;
  name: string;
  circuit?: string;
  /** Absent means 'legrand' — the original single-vendor devices. */
  vendor?: Vendor;
  /** False when the cloud reports the device unreachable. */
  online?: boolean;
  /**
   * Id of the gateway this module sits behind, read from `homestatus`.
   * Netatmo's /setstate answers 400 unless every module carries its `bridge`
   * — and, separately, 400 if you also send `type`. Send bridge, never type.
   */
  bridge?: string;
}

export interface LightDevice extends DeviceBase {
  type: 'light';
  state: LightState;
}

export interface BlindDevice extends DeviceBase {
  type: 'blind';
  state: BlindState;
}

/**
 * Tuya TR01-WF radiator thermostat. Temperatures here are DEGREES — the API
 * speaks tenths (`temp_set: 215` = 21.5 °C) and the conversion happens once, at
 * the data layer, so nothing downstream has to remember the scale.
 */
export interface ThermostatState {
  current: number;
  target: number;
  mode: 'manual' | 'auto';
  /** True while the valve is actually open, i.e. calling for heat. */
  heating: boolean;
  humidity?: number;
  battery?: number;
}

export interface ThermostatDevice extends DeviceBase {
  type: 'thermostat';
  state: ThermostatState;
}

/**
 * Zantia Vancouver 13 (R32) heat pump, via a Tuya module. Temperatures in °C,
 * all optional: the unit may not report a given probe, and a missing reading
 * must render as "—", not as a plausible-looking 0.
 */
export interface HeatPumpState {
  on: boolean;
  /** Raw Tuya mode: Hot (DHW) | Heating | Hot_Heating | Cooling | Hot_Cooling. */
  mode?: string;
  /** Compressor frequency in Hz; 0 while the compressor is stopped. */
  compressorHz?: number;
  outdoor?: number;
  waterIn?: number;
  waterOut?: number;
  /** Domestic hot water tank. */
  dhwTank?: number;
  heatingSetpoint?: number;
  coolingSetpoint?: number;
  dhwSetpoint?: number;
  /** Active fault codes, e.g. ['E13']; empty when healthy. */
  faults: string[];
}

export interface HeatPumpDevice extends DeviceBase {
  type: 'heatpump';
  state: HeatPumpState;
}

export type Device = LightDevice | BlindDevice | ThermostatDevice | HeatPumpDevice;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Where a device sits inside its room, as a FRACTION of the room's size —
 * (0,0) is the room's top-left corner, (1,1) its bottom-right.
 *
 * Fractions rather than metres so that moving *or* resizing a room carries its
 * devices along instead of stranding them outside the walls. Precision isn't
 * the point here; "the light nearest the window" is.
 */
export interface DevicePlacement {
  rx: number;
  ry: number;
}

export type LightCommand =
  | { action: 'toggle' }
  | { action: 'setOn'; on: boolean }
  | { action: 'setBrightness'; brightness: number };

export type BlindCommand =
  | { action: 'moveUp' }
  | { action: 'moveDown' }
  | { action: 'stop' }
  | { action: 'setPosition'; position: number };

/** `target` is in degrees; the data layer converts to Tuya's tenths. */
export type ThermostatCommand =
  | { action: 'setTarget'; target: number }
  | { action: 'setMode'; mode: 'manual' | 'auto' };

export type HeatPumpCommand = { action: 'setOn'; on: boolean };
