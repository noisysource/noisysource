import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Device, DevicePlacement, LightCommand, BlindCommand,
} from '@shared/models/Device';
import type { PlanRoom } from '@shared/models/Room';

/** Which layer the edit gestures act on. */
export type EditTarget = 'rooms' | 'devices';

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
  onPlaceDevice: (deviceId: string, roomId: string, rx: number, ry: number) => void;
  onExternalDragEnd: () => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
}

/** Smallest block we allow, in metres — below this a room can't be grabbed. */
const MIN_SIZE = 0.75;
const MARGIN = 1;
/** Marker geometry, in plan metres. */
const DOT = 0.26;
const HIT = 0.42;
/** Blind popover: overall height, and the slider track inside it. */
const POP_H = 2.7;
const TRACK_H = 1.6;

type Drag =
  | { kind: 'move'; id: string; grabX: number; grabY: number }
  | { kind: 'resize'; id: string }
  | { kind: 'device'; id: string };

function snapTo(value: number, grid: number) {
  return Math.round(value / grid) * grid;
}

function clamp01(v: number) {
  return Math.max(0.04, Math.min(0.96, v));
}

/**
 * Pick a label size that actually fits the block. Capped by the room's width
 * and by its height, then shrunk further for long names — "Casa de Banho
 * Miúdos" in a 3 m room otherwise runs straight out of its rectangle. The 0.55
 * factor approximates average glyph width relative to font size.
 */
function labelSize(name: string, w: number, h: number) {
  const byName = w / ((name.length + 2) * 0.55);
  return Math.max(0.14, Math.min(0.42, w / 8, h / 3, byName));
}

/**
 * Starting position for a device nobody has placed yet: lights in a grid across
 * the upper half of the room, blinds in a row along the bottom edge where the
 * windows tend to be. Deterministic, so markers don't shuffle between renders.
 */
function autoPlace(kind: Device['type'], i: number, total: number): DevicePlacement {
  if (kind === 'blind') return { rx: (i + 0.5) / total, ry: 0.86 };
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
  return { count: inRoom.length, lights: lights.length, lit, blinds: blinds.length };
}

export default function FloorPlan({
  rooms, devices, placements, grid, editMode, editTarget, selectedId, externalDragId,
  onSelect, onOpenRoom, onChange, onPlaceDevice, onExternalDragEnd,
  onLightCommand, onBlindCommand,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [openBlind, setOpenBlind] = useState<string | null>(null);
  /** Live thumb position while a blind slider is held, committed on release. */
  const [blindDrag, setBlindDrag] = useState<
    { id: string; pos: number; top: number; height: number } | null
  >(null);
  /** Live pointer position, in plan metres, while dragging in from the sidebar. */
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const editingRooms = editMode && editTarget === 'rooms';
  const editingDevices = editMode && editTarget === 'devices';

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
  function popoverOf(cy: number) {
    const above = cy - POP_H - 0.3 >= view.y;
    const baseY = above ? cy - POP_H - 0.3 : cy + 0.3;
    return { baseY, top: baseY + 0.55, height: TRACK_H };
  }

  function posFromY(y: number, top: number, height: number) {
    return Math.max(0, Math.min(100, Math.round((1 - (y - top) / height) * 100)));
  }

  function onPointerMove(e: React.PointerEvent) {
    if (blindDrag) {
      const p = toPlan(e);
      setBlindDrag({ ...blindDrag, pos: posFromY(p.y, blindDrag.top, blindDrag.height) });
      return;
    }
    if (!drag) return;
    const p = toPlan(e);

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
        if (blindDrag) {
          onBlindCommand(blindDrag.id, { action: 'setPosition', position: blindDrag.pos });
          setBlindDrag(null);
        }
        setDrag(null);
      }}
      onPointerCancel={() => { setBlindDrag(null); setDrag(null); }}
      onPointerDown={() => {
        if (editMode) onSelect(null);
        setOpenBlind(null);
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
                  : !room.controllable ? '#18181b'
                  : isLit ? `rgba(251, 191, 36, ${0.1 + litRatio * 0.2})`
                  : '#1f1f23'
              }
              stroke={
                isTarget ? '#60a5fa'
                  : isSelected && editingRooms ? '#fafafa'
                  : isLit ? 'rgba(251, 191, 36, 0.45)'
                  : '#3f3f46'
              }
              strokeWidth={isTarget || (isSelected && editingRooms) ? 0.09 : 0.05}
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

            {/* Room name sits at the top when markers are present so the two
                don't collide; centred otherwise. */}
            {room.w > 1.6 && room.h > 1.0 && (
              <text
                x={room.x + room.w / 2}
                y={editMode || stats.count > 0 ? room.y + 0.42 : room.y + room.h / 2}
                textAnchor="middle"
                fill={room.controllable ? '#e4e4e7' : '#52525b'}
                fontSize={labelSize(room.name, room.w, room.h)}
                className="pointer-events-none"
              >
                {room.icon} {room.name}
              </text>
            )}

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
                else setOpenBlind(openBlind === device.id ? null : device.id);
              }}
            />

            {openBlind === device.id && device.type === 'blind' && !editMode && (() => {
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
                      setOpenBlind(null);
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
