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
  position: number; // 0 = fully open, 100 = fully closed
  isMoving: boolean;
  movingDirection: 'up' | 'down' | null;
}

interface DeviceBase {
  id: string;
  roomId: string;
  name: string;
  circuit?: string;
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

export type LightCommand =
  | { action: 'toggle' }
  | { action: 'setOn'; on: boolean }
  | { action: 'setBrightness'; brightness: number };

export type BlindCommand =
  | { action: 'moveUp' }
  | { action: 'moveDown' }
  | { action: 'stop' }
  | { action: 'setPosition'; position: number };
