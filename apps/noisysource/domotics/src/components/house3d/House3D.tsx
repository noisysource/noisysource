import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { CameraControls, Edges, Html } from '@react-three/drei';
import * as THREE from 'three';
import { AlertTriangle, Lightbulb, LightbulbOff, X } from 'lucide-react';
import type {
  BlindCommand, BlindDevice, Device, DevicePlacement, LightCommand, LightDevice,
  ThermostatCommand, ThermostatDevice,
} from '@shared/models/Device';
import type { FloorPlan, PlanRoom, Wall } from '@shared/models/Room';
import { wallsFromRooms } from '../../data/walls';
import { placeDevices, roomStats } from '../../data/placement';
import { ThermostatRow } from '../ClimatePanel';
import { BlindRow } from '../RoomPanel';

/**
 * The house as a cut-away dollhouse, built from the same floor plan the 2D
 * editor saves — so moving a room or a device there moves it here, and there
 * is no separate 3D model to keep in sync.
 *
 * Plan metres map straight onto world metres: plan x → world x, plan y → world
 * z, with y up. Walls are cut at about hip height so every room can be seen
 * into from above.
 *
 * Rendered on demand only (`frameloop="demand"`): the scene redraws when the
 * camera moves or a device changes, never in an idle loop. This is meant to run
 * all day on a wall tablet, and a continuous 60fps render would keep it warm
 * and draining for a picture that isn't changing.
 */

export type HouseMode = 'casa' | 'clima';

interface Props {
  plan: FloorPlan;
  devices: Device[];
  placements: Record<string, DevicePlacement>;
  mode: HouseMode;
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string | null) => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  /** The heat pump: its controls live in the side panel. */
  onDeviceOpen: (deviceId: string) => void;
}

/** Cut-away wall height — enough to read as walls, low enough to see over. */
const WALL_H = 1.15;
const FLOOR_T = 0.06;
/** Same thicknesses as the 2D plan's wall strokes. */
const WALL_T = { exterior: 0.26, interior: 0.13, glass: 0.08 } as const;
const BULB_Y = 1.55;
const BLIND_W = 0.9;
const BLIND_H = 1.0;
const BLIND_Y0 = 0.1;
/** Camera tilt from vertical: steep enough to see floors, shallow enough to read as 3D. */
const POLAR = 0.7;
/** A pointer that travelled further than this was orbiting, not tapping. */
const TAP_SLOP_PX = 6;
/** Press this long on a light or blind for its slider instead of a toggle. */
const HOLD_MS = 450;

const FLOOR = { room: '#4a505e', structural: '#30333b', outdoor: '#4a3f33' };

/** Room temperature → floor colour in climate mode. */
const TEMP_STOPS: Array<[number, string]> = [
  [16, '#1d4ed8'],
  [18.5, '#0891b2'],
  [20.5, '#059669'],
  [22.5, '#d97706'],
  [25, '#dc2626'],
];

function tempColor(t: number) {
  if (t <= TEMP_STOPS[0][0]) return new THREE.Color(TEMP_STOPS[0][1]);
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      return new THREE.Color(c0).lerp(new THREE.Color(c1), (t - t0) / (t1 - t0));
    }
  }
  return new THREE.Color(TEMP_STOPS[TEMP_STOPS.length - 1][1]);
}

// Shared across every mesh of a kind — dozens of walls need one material, not dozens.
const MAT = {
  wall: new THREE.MeshStandardMaterial({ color: '#d4d4d8', roughness: 0.85 }),
  // The cut face is darker, as in an architectural section: it is what tells
  // the eye these are walls sliced open, not low partitions.
  wallCut: new THREE.MeshStandardMaterial({ color: '#52525b', roughness: 1 }),
  glass: new THREE.MeshStandardMaterial({
    color: '#7dd3fc', transparent: true, opacity: 0.3, roughness: 0.1,
  }),
  ground: new THREE.MeshStandardMaterial({ color: '#0c0e13', roughness: 1 }),
  bulbOff: new THREE.MeshStandardMaterial({ color: '#52525b', roughness: 0.6 }),
  bulbOn: new THREE.MeshStandardMaterial({
    color: '#fef3c7', emissive: '#fbbf24', emissiveIntensity: 2.2,
  }),
  slats: new THREE.MeshStandardMaterial({ color: '#3b82f6', roughness: 0.7 }),
  pane: new THREE.MeshStandardMaterial({
    color: '#bae6fd', transparent: true, opacity: 0.3, roughness: 0.1,
  }),
  pump: new THREE.MeshStandardMaterial({ color: '#e4e4e7', roughness: 0.5 }),
};
/**
 * Invisible, generous tap area around a small device. Drawn (so the raycaster
 * finds it) but writes neither colour nor depth.
 */
const HIT_MAT = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0, depthWrite: false, colorWrite: false,
});
// BoxGeometry face order: +x, -x, +y (top), -y, +z, -z.
const WALL_FACES = [MAT.wall, MAT.wall, MAT.wallCut, MAT.wall, MAT.wall, MAT.wall];

let glowTexture: THREE.Texture | null = null;
/** Soft radial pool of light, drawn once and shared by every lit bulb. */
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,214,140,1)');
  g.addColorStop(0.35, 'rgba(255,190,90,0.45)');
  g.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

function isOutdoor(room: PlanRoom) {
  return /deck|exterior|jardim|terra[cç]o|varanda/i.test(room.name);
}

function isNight(date = new Date()) {
  const h = date.getHours();
  return h >= 20 || h < 7;
}

/** A tap, as opposed to the end of an orbit drag. */
function tapped(e: ThreeEvent<MouseEvent>) {
  return e.delta <= TAP_SLOP_PX;
}

/**
 * Which room edge a device sits nearest to, and the point on it. Blinds belong
 * on a wall, and the plan only knows roughly where inside the room they are.
 */
function onNearestEdge(room: PlanRoom, x: number, y: number, inset = 0.16) {
  const d = {
    top: y - room.y,
    bottom: room.y + room.h - y,
    left: x - room.x,
    right: room.x + room.w - x,
  };
  const side = (Object.keys(d) as Array<keyof typeof d>).reduce((a, b) => (d[a] <= d[b] ? a : b));
  switch (side) {
    case 'top': return { x, z: room.y + inset, rotY: 0 };
    case 'bottom': return { x, z: room.y + room.h - inset, rotY: 0 };
    case 'left': return { x: room.x + inset, z: y, rotY: Math.PI / 2 };
    case 'right': return { x: room.x + room.w - inset, z: y, rotY: Math.PI / 2 };
  }
}

interface Box { x1: number; z1: number; x2: number; z2: number }

function boundsOf(rooms: PlanRoom[]): Box {
  if (rooms.length === 0) return { x1: 0, z1: 0, x2: 10, z2: 10 };
  return {
    x1: Math.min(...rooms.map(r => r.x)),
    z1: Math.min(...rooms.map(r => r.y)),
    x2: Math.max(...rooms.map(r => r.x + r.w)),
    z2: Math.max(...rooms.map(r => r.y + r.h)),
  };
}

/**
 * Camera distance that fits a box on screen at the fixed tilt, for the current
 * heading and viewport shape — a phone in portrait needs to stand much further
 * back than a landscape tablet to see the same house.
 */
function fitDistance(b: Box, azimuth: number, fovDeg: number, aspect: number) {
  const w = b.x2 - b.x1;
  const d = b.z2 - b.z1;
  const c = Math.abs(Math.cos(azimuth));
  const s = Math.abs(Math.sin(azimuth));
  const across = w * c + d * s;
  const deep = w * s + d * c;
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  // The near edge is closer to the camera than the centre, so it appears wider.
  const nearEdge = (deep / 2) * Math.sin(POLAR);
  const byWidth = across / 2 / Math.tan(hfov / 2) + nearEdge;
  const projected = deep * Math.cos(POLAR) + WALL_H * Math.sin(POLAR);
  const byHeight = projected / 2 / Math.tan(vfov / 2) + nearEdge;
  return Math.max(byWidth, byHeight);
}

function CameraRig({ house, focus }: { house: Box; focus: Box | null }) {
  const ref = useRef<CameraControls>(null);
  const size = useThree(s => s.size);
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  const first = useRef(true);
  const focusKey = focus ? `${focus.x1},${focus.z1},${focus.x2},${focus.z2}` : '';
  const houseKey = `${house.x1},${house.z1},${house.x2},${house.z2}`;

  useEffect(() => {
    const c = ref.current;
    if (!c || size.width === 0 || size.height === 0) return;
    const box = focus ?? house;
    // Zooming into a room keeps whatever heading the user turned to; going
    // back to the whole house straightens up, so "home" is always the same view.
    const azimuth = focus ? c.azimuthAngle : 0;
    const dist = fitDistance(box, azimuth, camera.fov, size.width / size.height) * (focus ? 1.45 : 1.06);
    const tx = (box.x1 + box.x2) / 2;
    const tz = (box.z1 + box.z2) / 2;
    void c.setLookAt(
      tx + dist * Math.sin(POLAR) * Math.sin(azimuth),
      dist * Math.cos(POLAR),
      tz + dist * Math.sin(POLAR) * Math.cos(azimuth),
      tx, 0, tz,
      !first.current,
    );
    first.current = false;
    // Keyed on the boxes' coordinates, not their object identity, which
    // changes on every render.
  }, [focusKey, houseKey, size.width, size.height, camera]);

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minPolarAngle={0.12}
      maxPolarAngle={1.3}
      minDistance={3}
      maxDistance={90}
      smoothTime={0.35}
      dollyToCursor
    />
  );
}

function WallMesh({ wall }: { wall: Wall }) {
  const kind = wall.kind ?? 'interior';
  const dx = wall.x2 - wall.x1;
  const dz = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return null;
  const t = WALL_T[kind];
  return (
    <mesh
      position={[(wall.x1 + wall.x2) / 2, WALL_H / 2, (wall.y1 + wall.y2) / 2]}
      rotation={[0, Math.atan2(-dz, dx), 0]}
      // Lengthened by its own thickness so neighbouring walls close their corners.
      material={kind === 'glass' ? MAT.glass : WALL_FACES}
    >
      <boxGeometry args={[len + t, WALL_H, t]} />
    </mesh>
  );
}

function RoomFloor({
  room, stats, mode, selected, night, onTap,
}: {
  room: PlanRoom;
  stats: ReturnType<typeof roomStats>;
  mode: HouseMode;
  selected: boolean;
  night: boolean;
  onTap: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const { color, emissive, intensity } = useMemo(() => {
    if (mode === 'clima' && stats.temp !== undefined) {
      const c = tempColor(stats.temp);
      return { color: c, emissive: c, intensity: 0.25 };
    }
    const base = new THREE.Color(
      isOutdoor(room) ? FLOOR.outdoor : room.controllable ? FLOOR.room : FLOOR.structural,
    );
    if (stats.lit > 0) {
      return { color: base.lerp(new THREE.Color('#78501f'), 0.6), emissive: new THREE.Color('#f59e0b'), intensity: night ? 0.32 : 0.16 };
    }
    if (selected) return { color: base, emissive: new THREE.Color('#38bdf8'), intensity: 0.08 };
    return { color: base, emissive: new THREE.Color('#000000'), intensity: 0 };
  }, [mode, stats.temp, stats.lit, room, selected, night]);

  return (
    <mesh position={[room.x + room.w / 2, FLOOR_T / 2, room.y + room.h / 2]} onClick={onTap}>
      <boxGeometry args={[Math.max(0.05, room.w - 0.04), FLOOR_T, Math.max(0.05, room.h - 0.04)]} />
      <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={intensity} roughness={0.9} />
      {selected && <Edges color="#7dd3fc" />}
    </mesh>
  );
}

/**
 * Tap and press-and-hold on a 3D object.
 *
 * A tap is the everyday action (light on/off, blind open/close) and must not
 * be mistaken for the end of an orbit drag; holding still opens the fine
 * control (dimmer level, blind position). Either way the event stops here, so
 * it never reaches the floor behind and selects the room as well.
 */
function usePress(onTap: () => void, onHold?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = useRef<[number, number] | null>(null);
  const held = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const cancel = () => clearTimeout(timer.current);

  return {
    onPointerDown(e: ThreeEvent<PointerEvent>) {
      e.stopPropagation();
      held.current = false;
      start.current = [e.clientX, e.clientY];
      cancel();
      if (onHold) {
        timer.current = setTimeout(() => {
          held.current = true;
          onHold();
        }, HOLD_MS);
      }
    },
    onPointerMove(e: ThreeEvent<PointerEvent>) {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s[0], e.clientY - s[1]) > TAP_SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerOut: cancel,
    onClick(e: ThreeEvent<MouseEvent>) {
      e.stopPropagation();
      if (held.current) {
        held.current = false;
        return;
      }
      if (tapped(e)) onTap();
    },
  };
}

function Bulb({ x, z, light, poolSize, night, onTap, onHold }: {
  x: number;
  z: number;
  light: LightDevice;
  poolSize: number;
  night: boolean;
  onTap: () => void;
  onHold: () => void;
}) {
  const press = usePress(onTap, onHold);
  const on = light.state.on;
  // A dimmed light should look dimmed: plain switches report 100.
  const level = on ? Math.max(0.15, light.state.brightness / 100) : 0;
  return (
    <group>
      {on ? (
        <mesh position={[x, BULB_Y, z]}>
          <sphereGeometry args={[0.11, 16, 12]} />
          <meshStandardMaterial color="#fef3c7" emissive="#fbbf24" emissiveIntensity={0.6 + 1.8 * level} />
        </mesh>
      ) : (
        <mesh position={[x, BULB_Y, z]} material={MAT.bulbOff}>
          <sphereGeometry args={[0.11, 16, 12]} />
        </mesh>
      )}
      {/* Tap area: far bigger than the bulb, which is a few pixels across
          when the whole house is in view. */}
      <mesh position={[x, BULB_Y, z]} material={HIT_MAT} {...press}>
        <sphereGeometry args={[0.42, 10, 8]} />
      </mesh>
      {on && (
        // A painted pool of light rather than a real light source: real lights
        // cost per pixel per light, and a cheap tablet would choke on twenty.
        <mesh position={[x, FLOOR_T + 0.012, z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
          <planeGeometry args={[poolSize, poolSize]} />
          <meshBasicMaterial
            map={getGlowTexture()}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            opacity={(night ? 0.95 : 0.6) * level}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

/** A window shutter on the nearest wall: blue slats from the top for the closed part. */
function Shutter({ room, cx, cy, position, onTap, onHold }: {
  room: PlanRoom;
  cx: number;
  cy: number;
  position: number;
  onTap: () => void;
  onHold: () => void;
}) {
  const press = usePress(onTap, onHold);
  const at = onNearestEdge(room, cx, cy);
  const closed = Math.min(1, Math.max(0, 1 - position / 100));
  const slatH = BLIND_H * closed;
  const paneH = BLIND_H - slatH;
  return (
    <group position={[at.x, 0, at.z]} rotation={[0, at.rotY, 0]}>
      {slatH > 0.01 && (
        <mesh position={[0, BLIND_Y0 + BLIND_H - slatH / 2, 0]} material={MAT.slats}>
          <boxGeometry args={[BLIND_W, slatH, 0.05]} />
        </mesh>
      )}
      {paneH > 0.01 && (
        <mesh position={[0, BLIND_Y0 + paneH / 2, 0]} material={MAT.pane}>
          <boxGeometry args={[BLIND_W, paneH, 0.03]} />
        </mesh>
      )}
      <mesh position={[0, BLIND_Y0 + BLIND_H / 2, 0]} material={HIT_MAT} {...press}>
        <boxGeometry args={[BLIND_W + 0.3, BLIND_H + 0.4, 0.6]} />
      </mesh>
    </group>
  );
}

/** Wall thermostat: a small puck, glowing orange while it calls for heat. */
function ThermostatPuck({ x, z, device, onTap }: {
  x: number; z: number; device: ThermostatDevice; onTap: () => void;
}) {
  const press = usePress(onTap);
  const heating = device.online !== false && device.state.heating;
  return (
    <group position={[x, 1.0, z]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.1, 0.1, 0.05, 20]} />
        <meshStandardMaterial
          color={heating ? '#fdba74' : '#e4e4e7'}
          emissive={heating ? '#f97316' : '#000000'}
          emissiveIntensity={heating ? 0.8 : 0}
        />
      </mesh>
      <mesh material={HIT_MAT} {...press}>
        <sphereGeometry args={[0.35, 10, 8]} />
      </mesh>
    </group>
  );
}

function HeatPumpUnit({ cx, cy, running, fault, onTap }: {
  cx: number; cy: number; running: boolean; fault: boolean; onTap: () => void;
}) {
  const press = usePress(onTap);
  return (
    <group position={[cx, 0, cy]}>
      <mesh position={[0, 0.5, 0]} material={MAT.pump} {...press}>
        <boxGeometry args={[0.9, 1.0, 0.45]} />
      </mesh>
      <mesh position={[0, 0.55, 0.226]}>
        <circleGeometry args={[0.28, 24]} />
        <meshStandardMaterial
          color={fault ? '#7f1d1d' : running ? '#9a3412' : '#3f3f46'}
          emissive={fault ? '#ef4444' : running ? '#fb923c' : '#000000'}
          emissiveIntensity={fault || running ? 0.9 : 0}
        />
      </mesh>
    </group>
  );
}

/**
 * Temperature and humidity painted on the room's floor, so the house reads at a
 * glance without opening anything. Drawn into a texture rather than as DOM:
 * it lies flat on the floor, turns with the house, and grows as you zoom in.
 */
function ClimateDecal({ room, temp, humidity, heating }: {
  room: PlanRoom; temp: number; humidity?: number; heating: boolean;
}) {
  const gl = useThree(s => s.gl);
  const texture = useMemo(() => {
    const W = 512;
    const H = 256;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A soft dark halo keeps it legible on any floor colour, climate mode included.
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 14;
    const font = 'system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = heating ? '#fdba74' : '#fafafa';
    ctx.font = `600 124px ${font}`;
    ctx.fillText(`${temp.toFixed(1)}°`, W / 2, humidity === undefined ? H / 2 : 96);
    if (humidity !== undefined) {
      ctx.fillStyle = '#a5f3fc';
      ctx.font = `500 60px ${font}`;
      ctx.fillText(`${Math.round(humidity)}% humidade`, W / 2, 202);
    }
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    // Seen at a slant from the default camera; without this the text smears.
    t.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    return t;
  }, [temp, humidity, heating, gl]);
  useEffect(() => () => texture.dispose(), [texture]);

  const w = Math.min(room.w * 0.75, room.h * 1.5, 2.8);
  return (
    <mesh
      position={[room.x + room.w / 2, FLOOR_T + 0.02, room.y + room.h / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={2}
    >
      <planeGeometry args={[w, w / 2]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/**
 * DOM overlay pinned to a point in the scene.
 *
 * Its events must stop here. Overlays live inside the element the 3D scene
 * listens on, so a tap on a control would otherwise bubble on into the scene,
 * be raycast against the floor behind it, and also select or deselect a room —
 * and a press would start an orbit drag.
 */
function Overlay({ children, ...props }: ComponentProps<typeof Html>) {
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <Html {...props}>
      <div onPointerDown={stop} onPointerUp={stop} onClick={stop} onWheel={stop}>
        {children}
      </div>
    </Html>
  );
}

/** Room name tag; tapping it zooms into the room. Climate is on the floor itself. */
function RoomLabel({ room, lit, dimmed, onTap }: {
  room: PlanRoom;
  lit: number;
  dimmed: boolean;
  onTap: () => void;
}) {
  return (
    // Over the room's back wall rather than its middle, which is where the
    // temperature is painted on the floor.
    <Overlay
      position={[room.x + room.w / 2, WALL_H + 0.25, room.y + Math.min(0.5, room.h * 0.15)]}
      center
      zIndexRange={[20, 0]}
    >
      <button
        onClick={onTap}
        className={`flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-tight backdrop-blur-sm border shadow-lg shadow-black/40 transition-opacity bg-zinc-950/70 border-zinc-700/70 text-zinc-200 ${
          dimmed ? 'opacity-40' : ''
        }`}
      >
        <span aria-hidden="true">{room.icon}</span>
        {/* On a phone the icon carries it; the panel lists names. */}
        <span className="hidden sm:inline max-w-[7rem] truncate">{room.name}</span>
        {lit > 0 && (
          <span className="flex items-center gap-0.5 text-amber-300">
            <Lightbulb size={10} />{lit}
          </span>
        )}
      </button>
    </Overlay>
  );
}

/** Small name under each device of the room zoomed into. Never takes a tap. */
function DeviceName({ position, text }: { position: [number, number, number]; text: string }) {
  return (
    <Html position={position} center zIndexRange={[15, 0]} pointerEvents="none">
      <span className="block max-w-[7rem] truncate rounded bg-zinc-950/70 px-1 text-[10px] text-zinc-300 whitespace-nowrap">
        {text}
      </span>
    </Html>
  );
}

const chip = 'flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs border shadow-lg shadow-black/50 active:scale-95 transition-transform';

/** Fault on the heat pump — always shown, zoomed in or not. */
function FaultBadge({ cx, cy, codes, onTap }: {
  cx: number; cy: number; codes: string[]; onTap: () => void;
}) {
  return (
    <Overlay position={[cx, 1.4, cy]} center zIndexRange={[50, 41]}>
      <button onClick={onTap} className={`${chip} bg-red-600 border-red-200 text-white font-semibold`}>
        <AlertTriangle size={12} />
        {codes.length === 1 ? codes[0] : `${codes[0]} +${codes.length - 1}`}
      </button>
    </Overlay>
  );
}

/** Dimmer level and on/off, at the light. */
function LightControls({ light, onCommand }: {
  light: LightDevice;
  onCommand: Props['onLightCommand'];
}) {
  // Local while dragging; one command on release, not one per pixel.
  const [drag, setDrag] = useState<number | null>(null);
  const on = light.state.on;
  const level = drag ?? (on ? light.state.brightness : 0);
  function commit() {
    if (drag === null) return;
    onCommand(light.id, { action: 'setBrightness', brightness: drag });
    setDrag(null);
  }
  return (
    <div className="flex flex-col gap-3">
      {light.state.dimmable && (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={level}
            aria-label={`Intensidade de ${light.name}`}
            onChange={e => setDrag(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="flex-1 min-w-0 cursor-pointer touch-none"
          />
          <span className="w-10 text-right text-sm tabular-nums text-amber-200">{level}%</span>
        </div>
      )}
      <button
        onClick={() => onCommand(light.id, { action: 'toggle' })}
        className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm transition-colors ${
          on ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200' : 'bg-amber-400 hover:bg-amber-300 text-amber-950 font-semibold'
        }`}
      >
        {on ? <LightbulbOff size={15} /> : <Lightbulb size={15} />}
        {on ? 'Apagar' : 'Acender'}
      </button>
    </div>
  );
}

/** Fine control opened by holding a device (or tapping a thermostat), anchored above it. */
function DevicePopover({ device, position, onClose, onLightCommand, onBlindCommand, onThermostatCommand, roomName }: {
  device: Device;
  position: [number, number, number];
  roomName?: string;
  onClose: () => void;
  onLightCommand: Props['onLightCommand'];
  onBlindCommand: Props['onBlindCommand'];
  onThermostatCommand: Props['onThermostatCommand'];
}) {
  return (
    <Overlay position={position} zIndexRange={[90, 80]}>
      {/* Anchored by its bottom centre, just above the device, so it never covers it. */}
      <div
        style={{ transform: 'translate(-50%, calc(-100% - 14px))' }}
        className="relative w-72 max-w-[85vw] shadow-2xl shadow-black/70 rounded-2xl"
      >
        {device.type === 'light' ? (
          <div className="rounded-2xl border border-zinc-700 bg-zinc-950/95 backdrop-blur p-3 flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-sm font-medium text-zinc-100">{device.name}</span>
              <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100" aria-label="Fechar"><X size={16} /></button>
            </div>
            <LightControls light={device} onCommand={onLightCommand} />
          </div>
        ) : (
          <>
            {/* These rows are already cards; a second frame around them only
                added a border. The close button sits on the corner instead. */}
            {device.type === 'blind' && (
              <BlindRow device={device as BlindDevice} onCommand={cmd => onBlindCommand(device.id, cmd)} />
            )}
            {device.type === 'thermostat' && (
              <ThermostatRow device={device as ThermostatDevice} room={roomName} onCommand={onThermostatCommand} />
            )}
            <button
              onClick={onClose}
              aria-label="Fechar"
              className="absolute -top-2.5 -right-2.5 w-7 h-7 flex items-center justify-center rounded-full bg-zinc-800 border border-zinc-600 text-zinc-300 hover:text-white"
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </Overlay>
  );
}

/** Development builds only: the live scene on `window.__house3d`, for debugging from the console. */
function DevHandle() {
  const state = useThree();
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __house3d?: unknown }).__house3d = state;
  }, [state]);
  return null;
}

export default function House3D({
  plan, devices, placements, mode, selectedRoomId, onSelectRoom,
  onLightCommand, onBlindCommand, onThermostatCommand, onDeviceOpen,
}: Props) {
  const rooms = plan.rooms;
  const walls = useMemo(() => plan.walls?.length ? plan.walls : wallsFromRooms(rooms), [plan.walls, rooms]);
  const roomById = useMemo(() => new Map(rooms.map(r => [r.id, r])), [rooms]);
  const placed = useMemo(() => placeDevices(devices, roomById, placements), [devices, roomById, placements]);
  const house = useMemo(() => boundsOf(rooms), [rooms]);
  const selected = selectedRoomId ? roomById.get(selectedRoomId) ?? null : null;
  const focus = selected
    ? { x1: selected.x, z1: selected.y, x2: selected.x + selected.w, z2: selected.y + selected.h }
    : null;
  const night = isNight();
  const bg = night ? '#05060a' : '#0b0d12';
  /** Device whose fine control is open, if any. */
  const [popoverId, setPopoverId] = useState<string | null>(null);

  // Moving to another room (or back to the house) closes a control left open.
  useEffect(() => setPopoverId(null), [selectedRoomId]);

  useEffect(() => {
    if (!popoverId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopoverId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popoverId]);

  /** Rooms worth tapping: those with something in them to control or read. */
  const interactive = useMemo(() => {
    const withDevices = new Set(devices.map(d => d.roomId));
    return new Set(rooms.filter(r => r.controllable || withDevices.has(r.id)).map(r => r.id));
  }, [rooms, devices]);

  /**
   * What the default view frames: the rooms with something in them. The
   * garage and storage wing still render, but framing the whole envelope made
   * the lived-in part tiny on a phone for the sake of rooms with nothing to tap.
   */
  const home = useMemo(() => {
    const lived = rooms.filter(r => interactive.has(r.id));
    return boundsOf(lived.length ? lived : rooms);
  }, [rooms, interactive]);

  const cx = (house.x1 + house.x2) / 2;
  const cz = (house.z1 + house.z2) / 2;

  /** Where a device's popover and name tag hang, by kind. */
  function anchorOf(device: Device, x: number, y: number, room: PlanRoom): [number, number, number] {
    if (device.type === 'blind') {
      const at = onNearestEdge(room, x, y);
      return [at.x, BLIND_Y0 + BLIND_H + 0.15, at.z];
    }
    if (device.type === 'light') return [x, BULB_Y + 0.2, y];
    return [x, 1.2, y];
  }

  const open = popoverId ? placed.find(p => p.device.id === popoverId) : undefined;
  const openRoom = open ? roomById.get(open.device.roomId) : undefined;

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: 'low-power' }}
      camera={{ fov: 40, near: 0.1, far: 400, position: [cx, 40, cz + 30] }}
      // Holding a finger on a light must not bring up iOS's text callout.
      className="touch-none select-none"
      style={{ WebkitTouchCallout: 'none' }}
    >
      <color attach="background" args={[bg]} />
      <fog attach="fog" args={[bg, 70, 160]} />
      <hemisphereLight args={['#dbeafe', '#1c1917', night ? 0.45 : 1.0]} />
      <directionalLight position={[cx - 12, 30, cz + 16]} intensity={night ? 0.35 : 1.5} />

      <CameraRig house={home} focus={focus} />
      {import.meta.env.DEV && <DevHandle />}

      {/* Ground: tapping outside every room goes back to the whole house. */}
      <mesh
        position={[cx, -0.01, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={MAT.ground}
        onClick={e => {
          if (!tapped(e)) return;
          setPopoverId(null);
          onSelectRoom(null);
        }}
      >
        <planeGeometry args={[house.x2 - house.x1 + 40, house.z2 - house.z1 + 40]} />
      </mesh>

      {rooms.map(room => {
        const stats = roomStats(devices, room.id);
        return (
          <group key={room.id}>
            <RoomFloor
              room={room}
              stats={stats}
              mode={mode}
              selected={room.id === selectedRoomId}
              night={night}
              onTap={e => {
                if (!tapped(e)) return;
                e.stopPropagation();
                setPopoverId(null);
                onSelectRoom(interactive.has(room.id) ? room.id : null);
              }}
            />
            {stats.temp !== undefined && (
              <ClimateDecal room={room} temp={stats.temp} humidity={stats.humidity} heating={stats.heating} />
            )}
          </group>
        );
      })}

      {walls.map(w => <WallMesh key={w.id} wall={w} />)}

      {placed.map(({ device, cx: x, cy: y }) => {
        const room = roomById.get(device.roomId);
        if (!room) return null;
        const hold = () => setPopoverId(device.id);
        if (device.type === 'light') {
          return (
            <Bulb
              key={device.id}
              x={x}
              z={y}
              light={device}
              poolSize={Math.min(3, Math.min(room.w, room.h) * 0.9)}
              night={night}
              onTap={() => onLightCommand(device.id, { action: 'toggle' })}
              onHold={hold}
            />
          );
        }
        if (device.type === 'blind') {
          return (
            <Shutter
              key={device.id}
              room={room}
              cx={x}
              cy={y}
              position={device.state.position}
              // Mostly open closes, mostly closed opens — one tap, like a light.
              onTap={() => onBlindCommand(device.id, {
                action: 'setPosition', position: device.state.position >= 50 ? 0 : 100,
              })}
              onHold={hold}
            />
          );
        }
        if (device.type === 'thermostat') {
          return <ThermostatPuck key={device.id} x={x} z={y} device={device} onTap={hold} />;
        }
        if (device.type === 'heatpump') {
          const p = device.state;
          return (
            <group key={device.id}>
              <HeatPumpUnit
                cx={x}
                cy={y}
                running={device.online !== false && p.on && (p.compressorHz ?? 0) > 0}
                fault={p.faults.length > 0}
                onTap={() => onDeviceOpen(device.id)}
              />
              {p.faults.length > 0 && (
                <FaultBadge cx={x} cy={y} codes={p.faults} onTap={() => onDeviceOpen(device.id)} />
              )}
            </group>
          );
        }
        return null;
      })}

      {rooms
        .filter(r => interactive.has(r.id) && r.id !== selectedRoomId)
        .map(room => (
          <RoomLabel
            key={room.id}
            room={room}
            lit={roomStats(devices, room.id).lit}
            dimmed={selected !== null}
            onTap={() => {
              setPopoverId(null);
              onSelectRoom(room.id);
            }}
          />
        ))}

      {/* Names only where they can be read: the room zoomed into. */}
      {selected && placed
        .filter(p => p.device.roomId === selected.id && p.device.type !== 'heatpump' && p.device.id !== popoverId)
        .map(({ device, cx: x, cy: y }) => {
          const [ax, ay, az] = anchorOf(device, x, y, selected);
          const dimmed = device.type === 'light' && device.state.on && device.state.dimmable && device.state.brightness < 100;
          return (
            <DeviceName
              key={device.id}
              position={[ax, ay - (device.type === 'light' ? 0.75 : 0.05), az]}
              text={dimmed ? `${device.name} · ${device.state.brightness}%` : device.name}
            />
          );
        })}

      {open && openRoom && (
        <DevicePopover
          device={open.device}
          position={anchorOf(open.device, open.cx, open.cy, openRoom)}
          roomName={openRoom.name}
          onClose={() => setPopoverId(null)}
          onLightCommand={onLightCommand}
          onBlindCommand={onBlindCommand}
          onThermostatCommand={onThermostatCommand}
        />
      )}
    </Canvas>
  );
}
