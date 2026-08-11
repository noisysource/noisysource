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

interface DeviceBase {
  id: string;
  roomId: string;
  name: string;
  circuit?: string;
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

export type Device = LightDevice | BlindDevice;

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
