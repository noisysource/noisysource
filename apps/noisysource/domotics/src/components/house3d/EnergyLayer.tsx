import { useEffect, useMemo, useRef, type ElementRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { InfraItem } from '@shared/models/Room';
import type { EnergyReading } from '../../data/energy';
import { batteryFlow, formatWatts, gridFlow } from '../../data/energy';
import { MAT, Overlay, WALL_H, usePress } from './common';

/**
 * The solar and power layer: where the energy is coming from and going to.
 *
 * Panels on the roof, the inverter and battery where the plan puts them, a grid
 * pylon outside, and a line from the inverter to each — solar, house, battery,
 * grid — with light running along it in the direction the power is flowing,
 * faster the more of it there is.
 *
 * That motion is the one thing in the house that needs continuous frames. They
 * run only while this layer is showing and something is actually flowing, at a
 * capped rate, and stop when the screen is hidden — a wall tablet left on this
 * view should not spend the day rendering at 60fps.
 */

/** An equipment item with its plan position as numbers (Firestore can return strings). */
export type Placed = InfraItem & { x: number; y: number };

export interface Equipment {
  panels: Placed[];
  inverters: Placed[];
  batteries: Placed[];
}

interface Props {
  equipment: Equipment;
  energy: EnergyReading | null;
  /** Where house consumption goes: the middle of the lived-in rooms. */
  homeCentre: { x: number; z: number };
  /** Where the supply arrives: the pole by the gate on the road, in plan metres. */
  gridAt: { x: number; z: number };
  onOpen: () => void;
}

/** One solar panel marker: footprint in metres, height above the (absent) roof, tilt south. */
export const PANEL_W = 1.7;
export const PANEL_D = 1.05;
export const PANEL_Y = 2.5;
const PANEL_TILT = 0.35;
/** Output at which the panels glow fully. Rough array size, not a rating. */
const PV_FULL_W = 4000;
const BATTERY_H = 1.1;
export const TOWER_H = 6.5;
/** Below this the flow counts as stopped — the readings hover around zero. */
const ACTIVE_W = 25;
/** Frame rate for the moving lines; enough to read as motion, a fraction of the GPU of 60. */
const FRAME_MS = 33;

const COLOUR = {
  solar: '#fbbf24',
  house: '#22d3ee',
  charge: '#a3e635',
  discharge: '#fb923c',
  importing: '#f87171',
  exporting: '#38bdf8',
  idle: '#64748b',
} as const;

let panelTexture: THREE.Texture | null = null;
/** Photovoltaic cells: a dark blue grid, drawn once and shared. */
function getPanelTexture() {
  if (panelTexture) return panelTexture;
  const W = 192;
  const H = 120;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#132a5e';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#4f6fc7';
  ctx.lineWidth = 2;
  for (let x = 0; x <= W; x += W / 6) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += H / 4) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  panelTexture = new THREE.CanvasTexture(canvas);
  panelTexture.colorSpace = THREE.SRGBColorSpace;
  return panelTexture;
}

function SolarPanel({ x, z, output, onTap }: { x: number; z: number; output: number; onTap: () => void }) {
  const press = usePress(onTap);
  return (
    <group position={[x, PANEL_Y, z]} rotation={[PANEL_TILT, 0, 0]}>
      <mesh position={[0, -0.03, 0]} material={MAT.pump}>
        <boxGeometry args={[PANEL_W + 0.08, 0.04, PANEL_D + 0.08]} />
      </mesh>
      <mesh {...press}>
        <boxGeometry args={[PANEL_W, 0.05, PANEL_D]} />
        <meshStandardMaterial
          map={getPanelTexture()}
          roughness={0.35}
          metalness={0.3}
          emissive="#60a5fa"
          emissiveIntensity={0.45 * output}
        />
      </mesh>
    </group>
  );
}

/** Wall-mounted inverter with a status light: green while it answers. */
function InverterBox({ x, z, online, onTap }: { x: number; z: number; online: boolean; onTap: () => void }) {
  const press = usePress(onTap);
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 1.0, 0]} material={MAT.pump} {...press}>
        <boxGeometry args={[0.45, 0.6, 0.2]} />
      </mesh>
      <mesh position={[0, 1.2, 0.101]}>
        <circleGeometry args={[0.035, 12]} />
        <meshStandardMaterial
          color={online ? '#22c55e' : '#52525b'}
          emissive={online ? '#22c55e' : '#000000'}
          emissiveIntensity={online ? 1.6 : 0}
        />
      </mesh>
    </group>
  );
}

/** Battery cabinet with its state of charge as a gauge on the front. */
function BatteryBox({ x, z, soc, colour, onTap }: {
  x: number; z: number; soc?: number; colour: string; onTap: () => void;
}) {
  const press = usePress(onTap);
  const fill = soc === undefined ? 0 : Math.min(1, Math.max(0, soc / 100));
  const track = BATTERY_H * 0.8;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, BATTERY_H / 2, 0]} material={MAT.pump} {...press}>
        <boxGeometry args={[0.6, BATTERY_H, 0.28]} />
      </mesh>
      <mesh position={[0, BATTERY_H / 2, 0.141]}>
        <planeGeometry args={[0.18, track]} />
        <meshBasicMaterial color="#27272a" />
      </mesh>
      {fill > 0 && (
        <mesh position={[0, BATTERY_H * 0.1 + (track * fill) / 2, 0.142]}>
          <planeGeometry args={[0.18, track * fill]} />
          <meshStandardMaterial color={colour} emissive={colour} emissiveIntensity={0.7} />
        </mesh>
      )}
    </group>
  );
}

/** Lattice pylon, drawn as lines: legs, rings, cross-bracing and two cross-arms. */
function pylonGeometry() {
  const pts: number[] = [];
  const seg = (a: number[], b: number[]) => pts.push(...a, ...b);
  const ring = (y: number) => {
    const t = y / TOWER_H;
    const w = 0.9 * (1 - t) + 0.22 * t;
    return [[-w, y, -w], [w, y, -w], [w, y, w], [-w, y, w]];
  };
  const levels = [0, 1.4, 2.7, 3.9, 5.0, 5.9, TOWER_H].map(ring);
  levels.forEach((r, i) => {
    for (let k = 0; k < 4; k++) seg(r[k], r[(k + 1) % 4]);
    if (i === 0) return;
    const p = levels[i - 1];
    for (let k = 0; k < 4; k++) {
      seg(p[k], r[k]);
      seg(p[k], r[(k + 1) % 4]);
      seg(p[(k + 1) % 4], r[k]);
    }
  });
  for (const y of [5.0, 5.9]) {
    seg([-1.6, y, 0], [1.6, y, 0]);
    seg([-1.6, y, 0], [-0.5, y + 0.4, 0]);
    seg([1.6, y, 0], [0.5, y + 0.4, 0]);
  }
  seg([0, TOWER_H, 0], [0, TOWER_H + 0.6, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function GridTower({ x, z, colour, onTap }: { x: number; z: number; colour: string; onTap: () => void }) {
  const press = usePress(onTap);
  const geometry = useMemo(pylonGeometry, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group position={[x, 0, z]}>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color={colour} transparent opacity={0.85} toneMapped={false} />
      </lineSegments>
      {/* Lines are a poor tap target; an invisible column stands in for them. */}
      <mesh position={[0, TOWER_H / 2, 0]} {...press}>
        <boxGeometry args={[1.6, TOWER_H, 1.6]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
    </group>
  );
}

/** Where the house's consumption lands: a glowing ring on the floor. */
function HouseNode({ x, z, colour }: { x: number; z: number; colour: string }) {
  return (
    <mesh position={[x, 0.1, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <torusGeometry args={[0.55, 0.05, 8, 40]} />
      <meshStandardMaterial color={colour} emissive={colour} emissiveIntensity={1.2} toneMapped={false} />
    </mesh>
  );
}

/**
 * A gentle arc between two points, so lines clear the cut walls instead of
 * crossing them. Longer runs rise higher — the supply from the road crosses
 * the whole plot, and a flat arc that long would skim the rooftops.
 */
function arc(from: [number, number, number], to: [number, number, number], lift: number) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const mid = a.clone().lerp(b, 0.5);
  mid.y = Math.max(a.y, b.y) + lift + a.distanceTo(b) * 0.12;
  return new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(32);
}

/**
 * One energy path. A faint line always; while power flows, bright dashes run
 * along it — from the first point to the last when `dir` is 1, back when -1.
 */
function FlowLine({ points, colour, dir, watts }: {
  points: THREE.Vector3[];
  colour: string;
  dir: -1 | 0 | 1;
  watts: number;
}) {
  const ref = useRef<ElementRef<typeof Line>>(null);
  const speed = 0.8 + 2.2 * Math.min(1, watts / 3000);
  useFrame((_, delta) => {
    const line = ref.current;
    if (!line || dir === 0) return;
    // A decreasing offset moves the dashes from the start of the line to its end.
    const material = line.material as unknown as { dashOffset: number };
    material.dashOffset -= dir * speed * Math.min(delta, 0.1);
  });
  return (
    <group>
      <Line points={points} color={colour} lineWidth={2} transparent opacity={dir === 0 ? 0.15 : 0.3} toneMapped={false} />
      {dir !== 0 && (
        <Line
          ref={ref}
          points={points}
          color={colour}
          lineWidth={4}
          dashed
          dashSize={0.4}
          gapSize={0.9}
          transparent
          opacity={0.95}
          toneMapped={false}
        />
      )}
    </group>
  );
}

/** Figure card at an end of the energy picture, in the style of the inverter's own app. */
function FlowLabel({ position, title, value, sub, colour, onTap }: {
  position: [number, number, number];
  title: string;
  value: string;
  sub?: string;
  colour: string;
  onTap: () => void;
}) {
  return (
    <Overlay position={position} center zIndexRange={[25, 0]}>
      <button
        onClick={onTap}
        className="flex flex-col items-start rounded-xl border px-2.5 py-1.5 bg-slate-900/80 backdrop-blur-sm shadow-lg shadow-black/50 text-left whitespace-nowrap"
        style={{ borderColor: `${colour}88` }}
      >
        <span className="text-[10px] uppercase tracking-widest text-slate-300">{title}</span>
        <span className="text-lg leading-tight font-light tabular-nums" style={{ color: colour }}>{value}</span>
        {sub && <span className="text-[10px] text-slate-400">{sub}</span>}
      </button>
    </Overlay>
  );
}

export default function EnergyLayer({ equipment, energy, homeCentre, gridAt, onOpen }: Props) {
  const invalidate = useThree(s => s.invalidate);
  const online = energy?.online === true;
  const r = online ? energy : null;

  const pv = r?.pvPowerW ?? 0;
  const load = r?.consumptionW ?? 0;
  const battW = Math.abs(r?.batteryPowerW ?? 0);
  const gridW = Math.abs(r?.gridPowerW ?? 0);
  const battery = r ? batteryFlow(r) : 'idle';
  const grid = r ? gridFlow(r) : 'idle';

  const inv = equipment.inverters[0];
  const bat = equipment.batteries[0];
  const panels = equipment.panels;
  const pc = panels.length
    ? {
        x: panels.reduce((a, p) => a + p.x, 0) / panels.length,
        z: panels.reduce((a, p) => a + p.y, 0) / panels.length,
      }
    : null;

  // Every path starts at the inverter (or ends there, for solar): it is where
  // the power is actually routed.
  const paths = useMemo(() => {
    if (!inv) return null;
    return {
      solar: pc ? arc([pc.x, PANEL_Y, pc.z], [inv.x, 1.3, inv.y], 1.4) : null,
      house: arc([inv.x, 1.0, inv.y], [homeCentre.x, 0.12, homeCentre.z], WALL_H + 1.4),
      battery: bat ? arc([inv.x, 0.8, inv.y], [bat.x, BATTERY_H, bat.y], 0.9) : null,
      grid: arc([inv.x, 1.0, inv.y], [gridAt.x, TOWER_H - 1.2, gridAt.z], 2.2),
    };
    // Keyed on coordinates: `pc` is rebuilt every render, its numbers are not.
  }, [inv, bat, pc?.x, pc?.z, homeCentre.x, homeCentre.z, gridAt.x, gridAt.z]);

  const flows = {
    solar: { dir: (pv > ACTIVE_W ? 1 : 0) as -1 | 0 | 1, watts: pv, colour: COLOUR.solar },
    house: { dir: (load > ACTIVE_W ? 1 : 0) as -1 | 0 | 1, watts: load, colour: COLOUR.house },
    battery: {
      dir: (battery === 'in' ? 1 : battery === 'out' ? -1 : 0) as -1 | 0 | 1,
      watts: battW,
      colour: battery === 'in' ? COLOUR.charge : battery === 'out' ? COLOUR.discharge : COLOUR.idle,
    },
    grid: {
      dir: (grid === 'out' ? 1 : grid === 'in' ? -1 : 0) as -1 | 0 | 1,
      watts: gridW,
      colour: grid === 'out' ? COLOUR.exporting : grid === 'in' ? COLOUR.importing : COLOUR.idle,
    },
  };
  const animating = online && Object.values(flows).some(f => f.dir !== 0);

  // Drive frames only while something moves, and never for a hidden page.
  useEffect(() => {
    if (!animating) return;
    const id = setInterval(() => { if (!document.hidden) invalidate(); }, FRAME_MS);
    return () => clearInterval(id);
  }, [animating, invalidate]);

  const dash = (w: number) => (online ? formatWatts(w) : '—');
  const output = Math.min(1, Math.max(0, pv / PV_FULL_W));

  return (
    <group>
      {panels.map(p => <SolarPanel key={p.id} x={p.x} z={p.y} output={online ? output : 0} onTap={onOpen} />)}
      {equipment.inverters.map(i => <InverterBox key={i.id} x={i.x} z={i.y} online={online} onTap={onOpen} />)}
      {equipment.batteries.map(b => (
        <BatteryBox key={b.id} x={b.x} z={b.y} soc={r?.soc} colour={flows.battery.colour === COLOUR.idle ? '#22c55e' : flows.battery.colour} onTap={onOpen} />
      ))}
      <GridTower x={gridAt.x} z={gridAt.z} colour={grid === 'idle' ? '#60a5fa' : flows.grid.colour} onTap={onOpen} />
      <HouseNode x={homeCentre.x} z={homeCentre.z} colour={COLOUR.house} />

      {paths && online && (
        <>
          {paths.solar && <FlowLine points={paths.solar} {...flows.solar} />}
          <FlowLine points={paths.house} {...flows.house} />
          {paths.battery && <FlowLine points={paths.battery} {...flows.battery} />}
          <FlowLine points={paths.grid} {...flows.grid} />
        </>
      )}

      {pc && (
        <FlowLabel position={[pc.x, PANEL_Y + 1.0, pc.z]} title="Solar" value={dash(pv)} colour={COLOUR.solar} onTap={onOpen} />
      )}
      <FlowLabel position={[homeCentre.x, 1.9, homeCentre.z]} title="Consumo" value={dash(load)} colour={COLOUR.house} onTap={onOpen} />
      {bat && (
        <FlowLabel
          position={[bat.x, BATTERY_H + 1.0, bat.y]}
          title="Bateria"
          value={dash(battW)}
          sub={online ? `SOC ${r?.soc ?? '—'}% · ${battery === 'in' ? 'a carregar' : battery === 'out' ? 'a descarregar' : 'em repouso'}` : undefined}
          colour={flows.battery.colour === COLOUR.idle ? '#a1a1aa' : flows.battery.colour}
          onTap={onOpen}
        />
      )}
      <FlowLabel
        position={[gridAt.x, TOWER_H + 1.3, gridAt.z]}
        title="Rede"
        value={dash(gridW)}
        sub={online ? (grid === 'out' ? 'a exportar' : grid === 'in' ? 'a importar' : 'sem trocas') : undefined}
        colour={grid === 'idle' ? '#a1a1aa' : flows.grid.colour}
        onTap={onOpen}
      />
    </group>
  );
}
