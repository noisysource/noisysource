import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Device, DevicePlacement, LightCommand, BlindCommand,
  ThermostatCommand, HeatPumpCommand,
} from '@shared/models/Device';
import type { InfraItem, InfraKind, InfraLayer, PlanRoom, Wall } from '@shared/models/Room';
import { DEFAULT_LAYER } from '@shared/models/Room';
import { wallLength } from '../data/walls';
import type { EnergyReading } from '../data/energy';
import { formatWatts } from '../data/energy';

/** Which layer the edit gestures act on. */
export type EditTarget = 'rooms' | 'devices' | 'walls';

interface Props {
  rooms: PlanRoom[];
  devices: Device[];
  placements: Record<string, DevicePlacement>;
  grid: number;
  editMode: boolean;
  editTarget: EditTarget;
  selectedId: string | null;
  /** Device currently being dragged in from the sidebar, if any. */
  externalDragId: string | null;
  onSelect: (id: string | null) => void;
  onOpenRoom: (id: string) => void;
  onChange: (rooms: PlanRoom[]) => void;
  infrastructure: InfraItem[];
  onChangeInfra: (items: InfraItem[]) => void;
  walls: Wall[];
  onChangeWalls: (walls: Wall[]) => void;
  /** Toggles wall length labels. */
  showMeasures: boolean;
  /** Which layer is in focus; others render faded rather than hidden. */
  viewLayer: InfraLayer | 'all';
  energy: EnergyReading | null;
  onPlaceDevice: (deviceId: string, roomId: string, rx: number, ry: number) => void;
  onExternalDragEnd: () => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
}

/** Smallest block we allow, in metres — below this a room can't be grabbed. */
const MIN_SIZE = 0.75;
/** Padding around the plan. Kept tight — the house's aspect ratio already
 *  letterboxes it against a wide viewport, so every spare metre counts. */
const MARGIN = 0.4;
/** Marker geometry, in plan metres. Sized for fingers, not cursors. */
const DOT = 0.34;
const HIT = 0.58;
/** Blind popover: overall height, and the slider track inside it. */
const POP_H = 2.7;
const TRACK_H = 1.6;
/** Climate popovers. Roomier than the blind one because they carry readings,
 *  not just a control — the current temperature is the number you actually look
 *  at, and it was unreadably small when this was 2.0m tall. */
const THERMO_H = 3.3;
const THERMO_W = 3.8;
const TRACK_W = 2.9;
const PUMP_H = 1.7;
/** Range the TR01-WF accepts, and the granularity it steps in. */
const TEMP_MIN = 5;
const TEMP_MAX = 35;
const TEMP_STEP = 0.5;

type Drag =
  | { kind: 'move'; id: string; grabX: number; grabY: number }
  | { kind: 'resize'; id: string }
  | { kind: 'device'; id: string }
  | { kind: 'infra'; id: string; grabX: number; grabY: number }
  /** Dragging one end of a wall; the other end stays put. */
  | { kind: 'wallEnd'; id: string; end: 1 | 2 };

/**
 * Appearance per equipment kind. Wireless kinds get a coverage ring; the rest
 * are point markers, because drawing a radius around an inverter would imply a
 * relationship that isn't there.
 */
const INFRA_STYLE: Record<InfraKind, {
  icon: string; fill: string; stroke: string; label: string; reach?: number;
}> = {
  router:   { icon: '📶', fill: '#0c4a6e', stroke: '#38bdf8', label: '#7dd3fc', reach: 7 },
  repeater: { icon: '📡', fill: '#3b0764', stroke: '#a78bfa', label: '#c4b5fd', reach: 5 },
  gateway:  { icon: '🔌', fill: '#451a03', stroke: '#f59e0b', label: '#fcd34d' },
  inverter: { icon: '⚡', fill: '#064e3b', stroke: '#10b981', label: '#6ee7b7' },
  battery:  { icon: '🔋', fill: '#1a2e05', stroke: '#84cc16', label: '#bef264' },
  panels:   { icon: '☀️', fill: '#422006', stroke: '#eab308', label: '#fde047' },
};

/** Rendered thickness per wall kind, in plan metres. */
const WALL_WIDTH = { exterior: 0.26, interior: 0.13, glass: 0.1 } as const;
const WALL_COLOUR = { exterior: '#a1a1aa', interior: '#71717a', glass: '#38bdf8' } as const;

function snapTo(value: number, grid: number) {
  return Math.round(value / grid) * grid;
}

function clamp01(v: number) {
  return Math.max(0.04, Math.min(0.96, v));
}

/** Below this, text is unreadable; truncate rather than shrink further. */
const MIN_LABEL = 0.2;
/** Rough average glyph width as a fraction of font size. */
const GLYPH = 0.55;

/**
 * Fit a room name inside its block.
 *
 * Shrinking alone isn't enough: past a point the text is too small to read, and
 * shrinking indefinitely still let "Casa de Banho Miúdos" spill over its
 * neighbours. So the size has a floor and the *text* gives way instead —
 * truncated with an ellipsis, which never overflows regardless of room size.
 */
function fitLabel(name: string, w: number, h: number) {
  const size = Math.max(MIN_LABEL, Math.min(0.4, w / 7, h / 3.2));
  const maxChars = Math.floor((w * 0.92) / (size * GLYPH));
  const text = name.length > maxChars
    ? `${name.slice(0, Math.max(1, maxChars - 1))}…`
    : name;
  return { size, text, fits: name.length <= maxChars };
}

/**
 * Starting position for a device nobody has placed yet: lights in a grid across
 * the upper half of the room, blinds in a row along the bottom edge where the
 * windows tend to be. Deterministic, so markers don't shuffle between renders.
 */
function autoPlace(kind: Device['type'], i: number, total: number): DevicePlacement {
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

function roomStats(devices: Device[], roomId: string) {
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
    heating: thermo?.state.heating ?? false,
  };
}

export default function FloorPlan({
  rooms, devices, placements, grid, editMode, editTarget, selectedId, externalDragId,
  onSelect, onOpenRoom, onChange, onPlaceDevice, onExternalDragEnd,
  onLightCommand, onBlindCommand, onThermostatCommand, onHeatPumpCommand,
  infrastructure, onChangeInfra, walls, onChangeWalls, showMeasures, viewLayer, energy,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  /** Live thumb position while a blind slider is held, committed on release. */
  const [blindDrag, setBlindDrag] = useState<
    { id: string; pos: number; top: number; height: number } | null
  >(null);
  /** Live target while a thermostat slider is held, committed on release. */
  const [thermoDrag, setThermoDrag] = useState<
    { id: string; cx: number; target: number } | null
  >(null);
  /** Live pointer position, in plan metres, while dragging in from the sidebar. */
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const editingRooms = editMode && editTarget === 'rooms';
  const editingDevices = editMode && editTarget === 'devices';
  const editingWalls = editMode && editTarget === 'walls';

  const roomById = useMemo(() => new Map(rooms.map(r => [r.id, r])), [rooms]);

  // Fit the viewBox to whatever the rooms currently occupy, so dragging a block
  // past the old edge doesn't push it out of sight.
  const view = useMemo(() => {
    if (rooms.length === 0) return { x: 0, y: 0, w: 10, h: 10 };
    const x1 = Math.min(...rooms.map(r => r.x));
    const y1 = Math.min(...rooms.map(r => r.y));
    const x2 = Math.max(...rooms.map(r => r.x + r.w));
    const y2 = Math.max(...rooms.map(r => r.y + r.h));
    return {
      x: x1 - MARGIN, y: y1 - MARGIN,
      w: x2 - x1 + MARGIN * 2, h: y2 - y1 + MARGIN * 2,
    };
  }, [rooms]);

  /** Absolute plan position of every device whose room still exists. */
  const markers = useMemo(() => {
    const byRoom = new Map<string, Device[]>();
    for (const d of devices) {
      const list = byRoom.get(d.roomId);
      if (list) list.push(d); else byRoom.set(d.roomId, [d]);
    }
    const out: Array<{ device: Device; cx: number; cy: number }> = [];
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
  }, [devices, placements, roomById]);

  /** Client coords -> plan metres. */
  function toPlanXY(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function toPlan(e: React.PointerEvent) {
    return toPlanXY(e.clientX, e.clientY);
  }

  /** Topmost room under a point — later blocks win, matching paint order. */
  function roomAt(x: number, y: number) {
    let found: PlanRoom | null = null;
    for (const r of rooms) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) found = r;
    }
    return found;
  }

  /**
   * A drag started in the sidebar happens outside this SVG, so the pointer
   * stream has to be picked up from the window instead of from local handlers.
   */
  useEffect(() => {
    if (!externalDragId) {
      setGhost(null);
      return;
    }
    function move(e: PointerEvent) {
      setGhost(toPlanXY(e.clientX, e.clientY));
    }
    function up(e: PointerEvent) {
      const p = toPlanXY(e.clientX, e.clientY);
      const room = roomAt(p.x, p.y);
      if (room && externalDragId) {
        onPlaceDevice(
          externalDragId, room.id,
          clamp01((p.x - room.x) / room.w),
          clamp01((p.y - room.y) / room.h),
        );
      }
      setGhost(null);
      onExternalDragEnd();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [externalDragId, rooms]); // eslint-disable-line react-hooks/exhaustive-deps

  const hoverRoom = ghost ? roomAt(ghost.x, ghost.y) : null;

  function beginMove(e: React.PointerEvent, room: PlanRoom) {
    if (!editingRooms) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toPlan(e);
    onSelect(room.id);
    setDrag({ kind: 'move', id: room.id, grabX: p.x - room.x, grabY: p.y - room.y });
  }

  function beginResize(e: React.PointerEvent, room: PlanRoom) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    onSelect(room.id);
    setDrag({ kind: 'resize', id: room.id });
  }

  function beginDeviceDrag(e: React.PointerEvent, device: Device) {
    if (!editingDevices) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    onSelect(device.id);
    setDrag({ kind: 'device', id: device.id });
  }

  /**
   * Popover layout, all relative to its own top edge so the thing can sit above
   * or below the marker without the track semantics changing. Blinds in the top
   * row have no room above them and would otherwise render outside the viewBox.
   */
  function popoverBase(cy: number, height: number) {
    const above = cy - height - 0.3 >= view.y;
    return above ? cy - height - 0.3 : cy + 0.3;
  }

  function popoverOf(cy: number) {
    const baseY = popoverBase(cy, POP_H);
    return { baseY, top: baseY + 0.55, height: TRACK_H };
  }

  /** Slider x -> temperature, snapped to the half degrees the unit accepts. */
  function targetFromX(x: number, cx: number) {
    const frac = (x - (cx - TRACK_W / 2)) / TRACK_W;
    const raw = TEMP_MIN + Math.max(0, Math.min(1, frac)) * (TEMP_MAX - TEMP_MIN);
    return Math.round(raw / TEMP_STEP) * TEMP_STEP;
  }

  function posFromY(y: number, top: number, height: number) {
    return Math.max(0, Math.min(100, Math.round((1 - (y - top) / height) * 100)));
  }

  function onPointerMove(e: React.PointerEvent) {
    if (thermoDrag) {
      const p = toPlan(e);
      setThermoDrag({ ...thermoDrag, target: targetFromX(p.x, thermoDrag.cx) });
      return;
    }
    if (blindDrag) {
      const p = toPlan(e);
      setBlindDrag({ ...blindDrag, pos: posFromY(p.y, blindDrag.top, blindDrag.height) });
      return;
    }
    if (!drag) return;
    const p = toPlan(e);

    if (drag.kind === 'wallEnd') {
      const x = snapTo(p.x, grid), y = snapTo(p.y, grid);
      onChangeWalls(walls.map(w => (
        w.id !== drag.id ? w
          : drag.end === 1 ? { ...w, x1: x, y1: y } : { ...w, x2: x, y2: y }
      )));
      return;
    }

    if (drag.kind === 'infra') {
      onChangeInfra(infrastructure.map(i => (
        i.id === drag.id
          ? { ...i, x: snapTo(p.x - drag.grabX, grid), y: snapTo(p.y - drag.grabY, grid) }
          : i
      )));
      return;
    }

    if (drag.kind === 'device') {
      // Dropping a marker inside another room reassigns it to that room.
      const room = roomAt(p.x, p.y);
      if (room) {
        onPlaceDevice(
          drag.id, room.id,
          clamp01((p.x - room.x) / room.w),
          clamp01((p.y - room.y) / room.h),
        );
      }
      return;
    }

    onChange(rooms.map(r => {
      if (r.id !== drag.id) return r;
      if (drag.kind === 'move') {
        return { ...r, x: snapTo(p.x - drag.grabX, grid), y: snapTo(p.y - drag.grabY, grid) };
      }
      return {
        ...r,
        w: Math.max(MIN_SIZE, snapTo(p.x - r.x, grid)),
        h: Math.max(MIN_SIZE, snapTo(p.y - r.y, grid)),
      };
    }));
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      className="w-full h-full select-none"
      style={{ touchAction: editMode ? 'none' : 'auto' }}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        // One command on release, rather than one per step of the drag.
        if (thermoDrag) {
          onThermostatCommand(thermoDrag.id, {
            action: 'setTarget', target: thermoDrag.target,
          });
          setThermoDrag(null);
        }
        if (blindDrag) {
          onBlindCommand(blindDrag.id, { action: 'setPosition', position: blindDrag.pos });
          setBlindDrag(null);
        }
        setDrag(null);
      }}
      onPointerCancel={() => { setBlindDrag(null); setThermoDrag(null); setDrag(null); }}
      onPointerDown={() => {
        if (editMode) onSelect(null);
        setOpenPopover(null);
      }}
    >
      <defs>
        <pattern id="grid" width={1} height={1} patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#27272a" strokeWidth={0.02} />
        </pattern>
      </defs>

      {editingRooms && (
        <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#grid)" />
      )}

      {/* The building fades when attention is on another layer, so roof and
          outdoor equipment can be read against it without competing with it. */}
      <g opacity={viewLayer === 'roof' || viewLayer === 'exterior' ? 0.28 : 1}>
      {rooms.map(room => {
        const stats = roomStats(devices, room.id);
        const isSelected = selectedId === room.id;
        const isTarget = hoverRoom?.id === room.id;
        const isLit = stats.lit > 0;
        const litRatio = stats.lights > 0 ? stats.lit / stats.lights : 0;

        return (
          <g key={room.id}>
            <rect
              x={room.x}
              y={room.y}
              width={room.w}
              height={room.h}
              rx={0.12}
              fill={
                isTarget ? 'rgba(96, 165, 250, 0.22)'
                  // Storage recedes almost into the background: it gives the
                  // house its shape but should never compete for attention with
                  // the rooms you actually control.
                  : !room.controllable ? '#0f0f11'
                  : isLit ? `rgba(251, 191, 36, ${0.1 + litRatio * 0.22})`
                  : '#1f1f23'
              }
              stroke={
                isTarget ? '#60a5fa'
                  : isSelected && editingRooms ? '#fafafa'
                  // Once a wall layer exists it owns the structure. Keeping the
                  // room outline would redraw partitions the house doesn't
                  // have — exactly the open-plan problem.
                  : walls.length > 0 && !editingRooms ? 'transparent'
                  : !room.controllable ? '#232326'
                  : isLit ? 'rgba(251, 191, 36, 0.5)'
                  : '#4b4b52'
              }
              strokeWidth={
                isTarget || (isSelected && editingRooms) ? 0.09
                  : !room.controllable ? 0.03
                  : 0.05
              }
              className={
                editingRooms ? 'cursor-move'
                  : !editMode && room.controllable ? 'cursor-pointer' : ''
              }
              onPointerDown={e => beginMove(e, room)}
              onClick={e => {
                e.stopPropagation();
                if (editingRooms) return onSelect(room.id);
                if (!editMode && room.controllable) onOpenRoom(room.id);
              }}
            />

            {/* Name at the top when markers are present so the two don't
                collide; centred otherwise. Storage gets a smaller, dimmer
                label and never a summary line. */}
            {room.w > 1.3 && room.h > 0.8 && (() => {
              const label = fitLabel(room.name, room.w, room.h);
              const size = room.controllable ? label.size : label.size * 0.72;
              const hasSummary = room.controllable && stats.count > 0;
              const y = hasSummary || editMode
                ? room.y + size + 0.18
                : room.y + room.h / 2 + size * 0.35;
              return (
                <g className="pointer-events-none">
                  <text
                    x={room.x + room.w / 2}
                    y={y}
                    textAnchor="middle"
                    fill={room.controllable ? '#e4e4e7' : '#3f3f46'}
                    fontSize={size}
                  >
                    {label.text}
                  </text>
                  {hasSummary && !editMode && (
                    <text
                      x={room.x + room.w / 2}
                      y={y + size * 1.15}
                      textAnchor="middle"
                      fontSize={size * 0.8}
                      fill={stats.heating ? '#fdba74' : isLit ? '#fbbf24' : '#71717a'}
                    >
                      {[
                        stats.temp !== undefined && Number.isFinite(stats.temp)
                          ? `${stats.temp.toFixed(1)}°` : null,
                        stats.lights > 0 ? `${stats.lit}/${stats.lights}` : null,
                      ].filter(Boolean).join('  ·  ')}
                    </text>
                  )}
                </g>
              );
            })()}

            {editingRooms && isSelected && (
              <rect
                x={room.x + room.w - 0.28}
                y={room.y + room.h - 0.28}
                width={0.56}
                height={0.56}
                rx={0.08}
                fill="#fafafa"
                className="cursor-nwse-resize"
                onPointerDown={e => beginResize(e, room)}
              />
            )}
          </g>
        );
      })}

      {/* Markers paint above every room so they stay reachable. */}
      {markers.map(({ device, cx, cy }) => {
        const isSelected = selectedId === device.id;
        const on = device.type === 'light' && device.state.on;
        const openPct = device.type === 'blind' ? device.state.position : 0;

        return (
          <g
            key={device.id}
            className={
              editingRooms ? 'pointer-events-none'
                : editingDevices ? 'cursor-move' : 'cursor-pointer'
            }
          >
            {device.type === 'light' ? (
              <circle
                cx={cx} cy={cy} r={DOT}
                fill={on ? '#fbbf24' : '#27272a'}
                stroke={isSelected ? '#fafafa' : on ? '#fcd34d' : '#52525b'}
                strokeWidth={isSelected ? 0.07 : 0.04}
              />
            ) : device.type === 'thermostat' ? (
              // Wider than the dots because it carries a number. Orange only
              // when the valve is actually open, not merely when target > current.
              <g opacity={device.online === false ? 0.4 : 1}>
                <rect
                  x={cx - 0.54} y={cy - 0.31} width={1.08} height={0.62} rx={0.12}
                  fill={device.state.heating ? 'rgba(249, 115, 22, 0.28)' : '#27272a'}
                  stroke={
                    isSelected ? '#fafafa'
                      : device.state.heating ? '#f97316' : '#52525b'
                  }
                  strokeWidth={isSelected ? 0.07 : 0.04}
                />
                <text
                  x={cx} y={cy + 0.11} textAnchor="middle" fontSize={0.32}
                  fill={device.state.heating ? '#fdba74' : '#d4d4d8'}
                  className="pointer-events-none"
                >
                  {/* A sleeping valve head keeps its last reading, shown dimmed
                      by the group opacity above. Only a device we have never
                      reached shows nothing at all. */}
                  {Number.isFinite(device.state.current)
                    ? `${device.state.current.toFixed(1)}°`
                    : '—'}
                </text>
              </g>
            ) : device.type === 'heatpump' ? (
              <g opacity={device.online === false ? 0.4 : 1}>
                <rect
                  x={cx - 0.34} y={cy - 0.34} width={0.68} height={0.68} rx={0.34}
                  fill={device.state.on ? 'rgba(239, 68, 68, 0.25)' : '#27272a'}
                  stroke={
                    isSelected ? '#fafafa' : device.state.on ? '#ef4444' : '#52525b'
                  }
                  strokeWidth={isSelected ? 0.07 : 0.04}
                />
                <text
                  x={cx} y={cy + 0.11} textAnchor="middle" fontSize={0.34}
                  className="pointer-events-none"
                >
                  🔥
                </text>
              </g>
            ) : (
              <g>
                <rect
                  x={cx - DOT} y={cy - DOT} width={DOT * 2} height={DOT * 2} rx={0.06}
                  fill="#27272a"
                  stroke={isSelected ? '#fafafa' : '#52525b'}
                  strokeWidth={isSelected ? 0.07 : 0.04}
                />
                {/* Fill from the top down: a full box reads as a closed blind. */}
                <rect
                  x={cx - DOT + 0.05}
                  y={cy - DOT + 0.05}
                  width={DOT * 2 - 0.1}
                  height={Math.max(0, (DOT * 2 - 0.1) * (1 - openPct / 100))}
                  fill="#3b82f6"
                />
              </g>
            )}

            {/* Generous invisible hit area — the visible dot is ~12px on a tablet. */}
            <circle
              cx={cx} cy={cy} r={HIT} fill="transparent"
              onPointerDown={e => beginDeviceDrag(e, device)}
              onClick={e => {
                e.stopPropagation();
                if (editingDevices) return onSelect(device.id);
                if (editMode) return;
                if (device.type === 'light') onLightCommand(device.id, { action: 'toggle' });
                else setOpenPopover(openPopover === device.id ? null : device.id);
              }}
            />

            {openPopover === device.id && device.type === 'blind' && !editMode && (() => {
              const { baseY, top, height } = popoverOf(cy);
              const live = blindDrag?.id === device.id ? blindDrag.pos : device.state.position;
              const thumbY = top + (1 - live / 100) * height;

              return (
                <g>
                  <rect
                    x={cx - 0.85} y={baseY} width={1.7} height={POP_H} rx={0.14}
                    fill="#18181b" stroke="#52525b" strokeWidth={0.04}
                  />
                  <text
                    x={cx} y={baseY + 0.36} textAnchor="middle"
                    fontSize={0.26} fill="#e4e4e7" className="pointer-events-none"
                  >
                    {live}% aberto
                  </text>

                  {/* Track. Top = open, bottom = closed, so dragging up opens
                      the blind — the same direction the physical thing moves. */}
                  <rect
                    x={cx - 0.16} y={top} width={0.32} height={height} rx={0.16}
                    fill="#3f3f46"
                    className="cursor-pointer"
                    onPointerDown={e => {
                      e.stopPropagation();
                      (e.target as Element).setPointerCapture(e.pointerId);
                      const p = toPlan(e);
                      setBlindDrag({
                        id: device.id, top, height,
                        pos: posFromY(p.y, top, height),
                      });
                    }}
                  />
                  {/* Filled from the top: what's still covered by the blind. */}
                  <rect
                    x={cx - 0.16} y={top} width={0.32}
                    height={Math.max(0, (1 - live / 100) * height)}
                    rx={0.16}
                    fill="#3b82f6"
                    className="pointer-events-none"
                  />
                  <rect
                    x={cx - 0.3} y={thumbY - 0.09} width={0.6} height={0.18} rx={0.09}
                    fill="#fafafa"
                    className="pointer-events-none"
                  />

                  <rect
                    x={cx - 0.42} y={baseY + POP_H - 0.62} width={0.84} height={0.44} rx={0.1}
                    fill="#3f3f46" stroke="#71717a" strokeWidth={0.03}
                    className="cursor-pointer"
                    onClick={e => {
                      e.stopPropagation();
                      onBlindCommand(device.id, { action: 'stop' });
                      setOpenPopover(null);
                    }}
                  />
                  <text
                    x={cx} y={baseY + POP_H - 0.29} textAnchor="middle"
                    fontSize={0.24} fill="#e4e4e7" className="pointer-events-none"
                  >
                    Parar
                  </text>
                </g>
              );
            })()}

            {openPopover === device.id && device.type === 'thermostat' && !editMode && (() => {
              const baseY = popoverBase(cy, THERMO_H);
              const t = device.state;
              const live = thermoDrag?.id === device.id ? thermoDrag.target : t.target;
              const trackY = baseY + 1.62;
              const frac = (live - TEMP_MIN) / (TEMP_MAX - TEMP_MIN);
              const thumbX = cx - TRACK_W / 2 + frac * TRACK_W;

              return (
                <g>
                  <rect
                    x={cx - THERMO_W / 2} y={baseY} width={THERMO_W} height={THERMO_H} rx={0.16}
                    fill="#18181b" stroke="#52525b" strokeWidth={0.04}
                  />

                  {/* What the room actually is, stated plainly and large — this
                      is the number you look at; the target is the one you set. */}
                  <text
                    x={cx} y={baseY + 0.62} textAnchor="middle" fontSize={0.52}
                    fill={device.online === false ? '#71717a' : '#fafafa'}
                    className="pointer-events-none"
                  >
                    {Number.isFinite(t.current) ? `${t.current.toFixed(1)}°` : '—'}
                  </text>
                  <text
                    x={cx} y={baseY + 0.98} textAnchor="middle" fontSize={0.26}
                    fill="#a1a1aa" className="pointer-events-none"
                  >
                    {device.online === false ? 'última leitura' : 'agora'}
                    {t.humidity ? `  ·  ${t.humidity}% humidade` : ''}
                    {t.battery ? `  ·  ${t.battery}% bat` : ''}
                  </text>

                  <text
                    x={cx} y={baseY + 1.48} textAnchor="middle" fontSize={0.36}
                    fill={t.heating ? '#fdba74' : '#e4e4e7'} className="pointer-events-none"
                  >
                    alvo {live.toFixed(1)}°
                  </text>

                  {/* Slider track. Wider hit area than it looks: the visible bar
                      is 0.2m but the grab zone is 0.66m tall. */}
                  <rect
                    x={cx - TRACK_W / 2 - 0.1} y={trackY - 0.33}
                    width={TRACK_W + 0.2} height={0.66}
                    fill="transparent"
                    className="cursor-pointer"
                    onPointerDown={e => {
                      e.stopPropagation();
                      (e.target as Element).setPointerCapture(e.pointerId);
                      const p = toPlan(e);
                      setThermoDrag({ id: device.id, cx, target: targetFromX(p.x, cx) });
                    }}
                  />
                  <rect
                    x={cx - TRACK_W / 2} y={trackY - 0.1} width={TRACK_W} height={0.2} rx={0.1}
                    fill="#3f3f46" className="pointer-events-none"
                  />
                  <rect
                    x={cx - TRACK_W / 2} y={trackY - 0.1}
                    width={Math.max(0, frac * TRACK_W)} height={0.2} rx={0.1}
                    fill="#f97316" className="pointer-events-none"
                  />
                  <circle
                    cx={thumbX} cy={trackY} r={0.2}
                    fill="#fafafa" className="pointer-events-none"
                  />

                  <text
                    x={cx - TRACK_W / 2} y={trackY + 0.58} textAnchor="middle"
                    fontSize={0.22} fill="#71717a" className="pointer-events-none"
                  >
                    {TEMP_MIN}°
                  </text>
                  <text
                    x={cx + TRACK_W / 2} y={trackY + 0.58} textAnchor="middle"
                    fontSize={0.22} fill="#71717a" className="pointer-events-none"
                  >
                    {TEMP_MAX}°
                  </text>

                  <rect
                    x={cx - 0.75} y={baseY + THERMO_H - 0.66} width={1.5} height={0.5} rx={0.1}
                    fill="#3f3f46" stroke="#71717a" strokeWidth={0.03}
                    className="cursor-pointer"
                    onClick={e => {
                      e.stopPropagation();
                      onThermostatCommand(device.id, {
                        action: 'setMode',
                        mode: t.mode === 'auto' ? 'manual' : 'auto',
                      });
                    }}
                  />
                  <text
                    x={cx} y={baseY + THERMO_H - 0.3} textAnchor="middle"
                    fontSize={0.26} fill="#e4e4e7" className="pointer-events-none"
                  >
                    {t.mode === 'auto' ? 'Auto' : 'Manual'}
                  </text>
                </g>
              );
            })()}
            {openPopover === device.id && device.type === 'heatpump' && !editMode && (() => {
              const baseY = popoverBase(cy, PUMP_H);
              const p = device.state;
              return (
                <g>
                  <rect
                    x={cx - 1.4} y={baseY} width={2.8} height={PUMP_H} rx={0.14}
                    fill="#18181b" stroke="#52525b" strokeWidth={0.04}
                  />
                  <text
                    x={cx} y={baseY + 0.4} textAnchor="middle" fontSize={0.24}
                    fill="#a1a1aa" className="pointer-events-none"
                  >
                    Topo {p.tankTop?.toFixed(1) ?? '—'}° · Fundo {p.tankBottom?.toFixed(1) ?? '—'}°
                  </text>
                  <text
                    x={cx} y={baseY + 0.78} textAnchor="middle" fontSize={0.24}
                    fill="#a1a1aa" className="pointer-events-none"
                  >
                    {p.power !== undefined ? `${p.power} W` : 'consumo —'}
                  </text>

                  <rect
                    x={cx - 0.75} y={baseY + 1.0} width={1.5} height={0.48} rx={0.1}
                    fill={p.on ? '#7f1d1d' : '#3f3f46'} stroke="#71717a" strokeWidth={0.03}
                    className="cursor-pointer"
                    onClick={e => {
                      e.stopPropagation();
                      onHeatPumpCommand(device.id, { action: 'setOn', on: !p.on });
                      setOpenPopover(null);
                    }}
                  />
                  <text
                    x={cx} y={baseY + 1.33} textAnchor="middle" fontSize={0.24}
                    fill="#e4e4e7" className="pointer-events-none"
                  >
                    {p.on ? 'Desligar' : 'Ligar'}
                  </text>
                </g>
              );
            })()}
          </g>
        );
      })}

      </g>

      {/* Walls: the real structure, drawn over the room fills. */}
      <g opacity={viewLayer === 'roof' || viewLayer === 'exterior' ? 0.28 : 1}>
      {walls.map(w => {
        const kind = w.kind ?? 'interior';
        const isSelected = selectedId === w.id;
        const len = wallLength(w);
        const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
        // Keep length labels upright: flip any wall that would read upside down.
        let angle = (Math.atan2(w.y2 - w.y1, w.x2 - w.x1) * 180) / Math.PI;
        if (angle > 90 || angle < -90) angle += 180;

        return (
          <g key={w.id}>
            <line
              x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2}
              stroke={isSelected && editingWalls ? '#fafafa' : WALL_COLOUR[kind]}
              strokeWidth={WALL_WIDTH[kind]}
              strokeLinecap="round"
              strokeDasharray={kind === 'glass' ? '0.4 0.25' : undefined}
              className={editingWalls ? 'cursor-pointer' : 'pointer-events-none'}
              onClick={e => {
                if (!editingWalls) return;
                e.stopPropagation();
                onSelect(w.id);
              }}
            />
            {editingWalls && isSelected && ([1, 2] as const).map(end => (
              <circle
                key={end}
                cx={end === 1 ? w.x1 : w.x2}
                cy={end === 1 ? w.y1 : w.y2}
                r={0.22}
                fill="#fafafa"
                className="cursor-move"
                onPointerDown={e => {
                  e.stopPropagation();
                  (e.target as Element).setPointerCapture(e.pointerId);
                  setDrag({ kind: 'wallEnd', id: w.id, end });
                }}
              />
            ))}
            {showMeasures && len > 0.4 && (
              <text
                x={mx} y={my - 0.16}
                textAnchor="middle"
                fontSize={0.26}
                fill="#a1a1aa"
                transform={`rotate(${angle} ${mx} ${my})`}
                className="pointer-events-none"
              >
                {len.toFixed(2)} m
              </text>
            )}
          </g>
        );
      })}

      {/* Network hardware. Drawn above rooms so it stays visible, and only
          draggable while editing rooms — it is part of the building, not a
          controllable device. */}
      </g>

      {infrastructure.map(item => {
        const isSelected = selectedId === item.id;
        const style = INFRA_STYLE[item.kind] ?? INFRA_STYLE.router;
        const layer = item.layer ?? DEFAULT_LAYER[item.kind] ?? 'interior';
        const dimmed = viewLayer !== 'all' && layer !== viewLayer;
        const hasReading = !editMode && !!energy?.online
          && (item.kind === 'inverter' || item.kind === 'battery');
        return (
          <g
            key={item.id}
            opacity={dimmed ? 0.2 : 1}
            className={editingRooms && !dimmed ? 'cursor-move' : 'pointer-events-none'}
            onPointerDown={e => {
              if (!editingRooms) return;
              e.stopPropagation();
              (e.target as Element).setPointerCapture(e.pointerId);
              const p = toPlan(e);
              onSelect(item.id);
              setDrag({ kind: 'infra', id: item.id, grabX: p.x - item.x, grabY: p.y - item.y });
            }}
          >
            {/* Coverage hint, not a measurement. Shown only while the item is
                selected: as permanent furniture these rings swamped the plan,
                and having established that signal geometry is not the problem
                here, they have not earned the space. */}
            {style.reach !== undefined && isSelected && (
              <circle
                cx={item.x} cy={item.y} r={style.reach}
                fill={`${style.stroke}0d`}
                stroke={`${style.stroke}47`}
                strokeWidth={0.04}
                strokeDasharray="0.3 0.25"
              />
            )}
            {/* Anything not on this storey gets a halo, so it reads as "not in
                that room" even when every layer is shown at once. */}
            {layer !== 'interior' && (
              <circle
                cx={item.x} cy={item.y} r={0.66}
                fill="none"
                stroke={style.stroke}
                strokeWidth={0.05}
                strokeDasharray={layer === 'roof' ? '0.16 0.14' : '0.5 0.2'}
                opacity={0.75}
              />
            )}
            <circle
              cx={item.x} cy={item.y} r={0.42}
              fill={style.fill}
              stroke={isSelected ? '#fafafa' : style.stroke}
              strokeWidth={isSelected ? 0.08 : 0.05}
            />
            <text
              x={item.x} y={item.y + 0.14} textAnchor="middle" fontSize={0.4}
              className="pointer-events-none"
            >
              {style.icon}
            </text>
            {/* Names matter while arranging things; once placed, the reading is
                what you actually look at. Equipment often sits close together —
                inverter beside battery — so showing both collides. */}
            <text
              x={item.x} y={item.y + 0.8} textAnchor="middle" fontSize={0.23}
              fill={style.label} className="pointer-events-none"
            >
              {editMode
                ? `${item.name}${item.band ? ` · ${item.band}` : ''}`
                : hasReading ? '' : item.name}
              {editMode && (layer === 'roof' ? '  ▲' : layer === 'exterior' ? '  ◇' : '')}
            </text>
            {/* Live figure beneath the thing that produces it. Panels share one
                array total between them rather than each claiming it, so the
                number sits on the inverter and the panels stay unlabelled. */}
            {hasReading && (
              <text
                x={item.x} y={item.y + 0.86} textAnchor="middle" fontSize={0.3}
                fill="#fafafa" className="pointer-events-none"
              >
                {item.kind === 'inverter'
                  ? formatWatts(energy.pvPowerW)
                  : `${energy.soc ?? '—'}%`}
              </text>
            )}
          </g>
        );
      })}

      {/* Ghost following the cursor while dragging in from the sidebar. */}
      {ghost && (
        <circle
          cx={ghost.x} cy={ghost.y} r={DOT}
          fill="rgba(96, 165, 250, 0.35)"
          stroke="#60a5fa"
          strokeWidth={0.05}
          strokeDasharray="0.1 0.08"
          className="pointer-events-none"
        />
      )}
    </svg>
  );
}
