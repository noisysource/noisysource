import type { Device, DevicePlacement } from '@shared/models/Device';
import type { PlanRoom } from '@shared/models/Room';

/**
 * Where devices sit on the plan, shared by the 2D plan and the 3D house so the
 * two views can never disagree about which light is where.
 */

/**
 * Starting position for a device nobody has placed yet: lights in a grid across
 * the upper half of the room, blinds in a row along the bottom edge where the
 * windows tend to be. Deterministic, so markers don't shuffle between renders.
 */
export function autoPlace(kind: Device['type'], i: number, total: number): DevicePlacement {
  if (kind === 'blind') return { rx: (i + 0.5) / total, ry: 0.86 };
  // Climate devices get their own band so they don't land under the lights.
  if (kind === 'thermostat') return { rx: (i + 0.5) / total, ry: 0.68 };
  if (kind === 'heatpump') return { rx: (i + 0.5) / total, ry: 0.5 };
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  return {
    rx: ((i % cols) + 0.5) / cols,
    ry: 0.16 + ((Math.floor(i / cols) + 0.5) / rows) * 0.44,
  };
}

export interface PlacedDevice {
  device: Device;
  /** Absolute plan metres. */
  cx: number;
  cy: number;
}

/** Absolute plan position of every device whose room still exists. */
export function placeDevices(
  devices: Device[],
  roomById: Map<string, PlanRoom>,
  placements: Record<string, DevicePlacement>,
): PlacedDevice[] {
  const byRoom = new Map<string, Device[]>();
  for (const d of devices) {
    const list = byRoom.get(d.roomId);
    if (list) list.push(d); else byRoom.set(d.roomId, [d]);
  }
  const out: PlacedDevice[] = [];
  for (const [roomId, list] of byRoom) {
    const room = roomById.get(roomId);
    if (!room) continue; // unplaced — lives in the sidebar until dragged on
    // Annotated as Device[] so indexing by device.type doesn't produce a
    // union of array types, whose .indexOf() would demand LightDevice &
    // BlindDevice — an impossible intersection.
    const sameKind: Record<Device['type'], Device[]> = {
      light: list.filter(d => d.type === 'light'),
      blind: list.filter(d => d.type === 'blind'),
      thermostat: list.filter(d => d.type === 'thermostat'),
      heatpump: list.filter(d => d.type === 'heatpump'),
    };
    for (const device of list) {
      const peers = sameKind[device.type];
      const p = placements[device.id]
        ?? autoPlace(device.type, peers.indexOf(device), peers.length);
      out.push({ device, cx: room.x + p.rx * room.w, cy: room.y + p.ry * room.h });
    }
  }
  return out;
}

export function roomStats(devices: Device[], roomId: string) {
  const inRoom = devices.filter(d => d.roomId === roomId);
  const lights = inRoom.filter(d => d.type === 'light');
  const lit = lights.filter(d => d.type === 'light' && d.state.on).length;
  const blinds = inRoom.filter(d => d.type === 'blind');
  // Only a reachable thermostat contributes a reading; an unreachable one
  // reports 0 °C, which must never be shown as though it were real.
  const thermo = inRoom.find(
    (d): d is Extract<Device, { type: 'thermostat' }> =>
      d.type === 'thermostat' && d.online !== false,
  );
  return {
    count: inRoom.length,
    lights: lights.length,
    lit,
    blinds: blinds.length,
    temp: thermo?.state.current,
    humidity: thermo?.state.humidity,
    target: thermo?.state.target,
    heating: thermo?.state.heating ?? false,
  };
}
