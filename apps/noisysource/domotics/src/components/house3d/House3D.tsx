import { useEffect, useMemo, useRef, type ComponentProps } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { CameraControls, Edges, Html } from '@react-three/drei';
import * as THREE from 'three';
import { AlertTriangle, Flame, Lightbulb, LightbulbOff } from 'lucide-react';
import type { Device, DevicePlacement } from '@shared/models/Device';
import type { FloorPlan, PlanRoom, Wall } from '@shared/models/Room';
import { wallsFromRooms } from '../../data/walls';
import { placeDevices, roomStats, type PlacedDevice } from '../../data/placement';

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
  onLightToggle: (deviceId: string) => void;
  /** Non-light devices: bring their controls up in the side panel. */
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

function Bulb({ x, z, on, poolSize, night }: {
  x: number; z: number; on: boolean; poolSize: number; night: boolean;
}) {
  return (
    <group>
      <mesh position={[x, BULB_Y, z]} material={on ? MAT.bulbOn : MAT.bulbOff}>
        <sphereGeometry args={[0.11, 16, 12]} />
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
            opacity={night ? 0.95 : 0.6}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

/** A window shutter on the nearest wall: blue slats from the top for the closed part. */
function Shutter({ room, cx, cy, position }: {
  room: PlanRoom; cx: number; cy: number; position: number;
}) {
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
    </group>
  );
}

function HeatPumpUnit({ cx, cy, running, fault }: {
  cx: number; cy: number; running: boolean; fault: boolean;
}) {
  return (
    <group position={[cx, 0, cy]}>
      <mesh position={[0, 0.5, 0]} material={MAT.pump}>
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
 * DOM overlay pinned to a point in the scene.
 *
 * Its events must stop here. Overlays live inside the element the 3D scene
 * listens on, so a tap on a light chip would otherwise bubble on into the
 * scene, be raycast against the floor behind it, and also deselect the room —
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

function RoomLabel({ room, stats, dimmed, onTap }: {
  room: PlanRoom;
  stats: ReturnType<typeof roomStats>;
  dimmed: boolean;
  onTap: () => void;
}) {
  return (
    <Overlay
      position={[room.x + room.w / 2, WALL_H + 0.35, room.y + room.h / 2]}
      center
      zIndexRange={[20, 0]}
    >
      {/* Stacked rather than one long pill: neighbouring small rooms (the
          bedroom wing) sit ~100px apart on a tablet, and a single line with the
          full name ran straight into the next label. */}
      <button
        onClick={onTap}
        className={`flex flex-col items-center rounded-xl px-2 py-1 text-xs leading-tight backdrop-blur-sm border shadow-lg shadow-black/40 transition-opacity bg-zinc-950/75 border-zinc-700/70 text-zinc-200 ${
          dimmed ? 'opacity-40' : ''
        }`}
      >
        <span className="flex items-center gap-1 whitespace-nowrap">
          <span aria-hidden="true">{room.icon}</span>
          {stats.temp !== undefined && (
            <span className="tabular-nums text-zinc-50">{stats.temp.toFixed(1)}°</span>
          )}
          {stats.heating && <Flame size={11} className="text-orange-400" aria-label="a aquecer" />}
          {stats.lit > 0 && (
            <span className="flex items-center gap-0.5 text-amber-300">
              <Lightbulb size={11} />{stats.lit}
            </span>
          )}
        </span>
        {/* On a phone the icon and the numbers carry it; the panel lists names. */}
        <span className="hidden sm:block max-w-[6.5rem] truncate text-[10px] text-zinc-400">{room.name}</span>
      </button>
    </Overlay>
  );
}

const chip = 'flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs border shadow-lg shadow-black/50 active:scale-95 transition-transform';

/** Tappable control floating over a device in the room that's zoomed into. */
function DeviceChip({ placed, room, onLightToggle, onDeviceOpen }: {
  placed: PlacedDevice;
  room: PlanRoom;
  onLightToggle: (id: string) => void;
  onDeviceOpen: (id: string) => void;
}) {
  const { device, cx, cy } = placed;
  const offline = device.online === false;

  if (device.type === 'light') {
    const on = device.state.on;
    return (
      <Overlay position={[cx, BULB_Y + 0.45, cy]} center zIndexRange={[40, 21]}>
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={() => onLightToggle(device.id)}
            aria-label={`${device.name}: ${on ? 'acesa' : 'apagada'}`}
            aria-pressed={on}
            className={`w-11 h-11 rounded-full flex items-center justify-center border shadow-lg shadow-black/50 active:scale-90 transition-transform ${
              on ? 'bg-amber-400 border-amber-200 text-amber-950' : 'bg-zinc-900/90 border-zinc-600 text-zinc-400'
            }`}
          >
            {on ? <Lightbulb size={20} /> : <LightbulbOff size={20} />}
          </button>
          <span className="max-w-[6rem] truncate rounded bg-zinc-950/70 px-1 text-[10px] text-zinc-300">
            {device.name}
          </span>
        </div>
      </Overlay>
    );
  }

  if (device.type === 'blind') {
    const at = onNearestEdge(room, cx, cy);
    const pos = device.state.position;
    return (
      <Overlay position={[at.x, BLIND_Y0 + BLIND_H + 0.3, at.z]} center zIndexRange={[40, 21]}>
        <button
          onClick={() => onDeviceOpen(device.id)}
          className={`${chip} bg-zinc-900/90 border-blue-500/60 text-blue-200`}
          title={device.name}
        >
          <span className="inline-block w-2.5 h-3 rounded-sm border border-blue-300 overflow-hidden">
            <span className="block bg-blue-400" style={{ height: `${100 - pos}%` }} />
          </span>
          {pos === 100 ? 'Aberto' : pos === 0 ? 'Fechado' : `${pos}%`}
        </button>
      </Overlay>
    );
  }

  if (device.type === 'thermostat') {
    const t = device.state;
    return (
      <Overlay position={[cx, 1.0, cy]} center zIndexRange={[40, 21]}>
        <button
          onClick={() => onDeviceOpen(device.id)}
          className={`${chip} bg-zinc-900/90 ${t.heating ? 'border-orange-500/70 text-orange-200' : 'border-zinc-600 text-zinc-200'} ${offline ? 'opacity-50' : ''}`}
          title={device.name}
        >
          {t.heating && <Flame size={12} className="text-orange-400" />}
          <span className="tabular-nums">{offline ? '—' : `${t.current.toFixed(1)}°`}</span>
          <span className="text-zinc-500 tabular-nums">→ {t.target.toFixed(1)}°</span>
        </button>
      </Overlay>
    );
  }

  return null;
}

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

export default function House3D({
  plan, devices, placements, mode, selectedRoomId, onSelectRoom, onLightToggle, onDeviceOpen,
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

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: 'low-power' }}
      camera={{ fov: 40, near: 0.1, far: 400, position: [cx, 40, cz + 30] }}
      className="touch-none"
    >
      <color attach="background" args={[bg]} />
      <fog attach="fog" args={[bg, 70, 160]} />
      <hemisphereLight args={['#dbeafe', '#1c1917', night ? 0.45 : 1.0]} />
      <directionalLight position={[cx - 12, 30, cz + 16]} intensity={night ? 0.35 : 1.5} />

      <CameraRig house={home} focus={focus} />

      {/* Ground: tapping outside every room goes back to the whole house. */}
      <mesh
        position={[cx, -0.01, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={MAT.ground}
        onClick={e => { if (tapped(e)) onSelectRoom(null); }}
      >
        <planeGeometry args={[house.x2 - house.x1 + 40, house.z2 - house.z1 + 40]} />
      </mesh>

      {rooms.map(room => {
        const stats = roomStats(devices, room.id);
        return (
          <RoomFloor
            key={room.id}
            room={room}
            stats={stats}
            mode={mode}
            selected={room.id === selectedRoomId}
            night={night}
            onTap={e => {
              if (!tapped(e)) return;
              e.stopPropagation();
              onSelectRoom(interactive.has(room.id) ? room.id : null);
            }}
          />
        );
      })}

      {walls.map(w => <WallMesh key={w.id} wall={w} />)}

      {placed.map(({ device, cx: x, cy: y }) => {
        const room = roomById.get(device.roomId);
        if (!room) return null;
        if (device.type === 'light') {
          return (
            <Bulb
              key={device.id}
              x={x}
              z={y}
              on={device.state.on}
              poolSize={Math.min(3, Math.min(room.w, room.h) * 0.9)}
              night={night}
            />
          );
        }
        if (device.type === 'blind') {
          return <Shutter key={device.id} room={room} cx={x} cy={y} position={device.state.position} />;
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
            stats={roomStats(devices, room.id)}
            dimmed={selected !== null}
            onTap={() => onSelectRoom(room.id)}
          />
        ))}

      {selected && placed
        .filter(p => p.device.roomId === selected.id)
        .map(p => (
          <DeviceChip
            key={p.device.id}
            placed={p}
            room={selected}
            onLightToggle={onLightToggle}
            onDeviceOpen={onDeviceOpen}
          />
        ))}
    </Canvas>
  );
}
