import { useEffect, useRef, type ComponentProps } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { SITE } from '../../data/site';

/**
 * Pieces shared by the house scene and its layers: scale, materials, and how a
 * tap or a hold on a 3D object is told apart from orbiting the camera.
 */

/** Cut-away wall height — enough to read as walls, low enough to see over. */
export const WALL_H = 1.15;
export const FLOOR_T = 0.06;
/** A pointer that travelled further than this was orbiting, not tapping. */
export const TAP_SLOP_PX = 6;
/** Press this long on a light or blind for its slider instead of a toggle. */
export const HOLD_MS = 450;

// Shared across every mesh of a kind — dozens of walls need one material, not dozens.
export const MAT = {
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
export const HIT_MAT = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0, depthWrite: false, colorWrite: false,
});

/** A tap, as opposed to the end of an orbit drag. */
export function tapped(e: ThreeEvent<MouseEvent>) {
  return e.delta <= TAP_SLOP_PX;
}

/**
 * Tap and press-and-hold on a 3D object.
 *
 * A tap is the everyday action (light on/off, blind open/close) and must not
 * be mistaken for the end of an orbit drag; holding still opens the fine
 * control (dimmer level, blind position). Either way the event stops here, so
 * it never reaches the floor behind and selects the room as well.
 */
export function usePress(onTap: () => void, onHold?: () => void) {
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

/**
 * DOM overlay pinned to a point in the scene.
 *
 * Its events must stop here. Overlays live inside the element the 3D scene
 * listens on, so a tap on a control would otherwise bubble on into the scene,
 * be raycast against the floor behind it, and also select or deselect a room —
 * and a press would start an orbit drag.
 */
export function Overlay({ children, ...props }: ComponentProps<typeof Html>) {
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <Html {...props}>
      <div onPointerDown={stop} onPointerUp={stop} onClick={stop} onWheel={stop}>
        {children}
      </div>
    </Html>
  );
}

export const chip = 'flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs border shadow-lg shadow-black/50 active:scale-95 transition-transform';

let glowTexture: THREE.Texture | null = null;
/** Soft radial pool of light, drawn once and shared by every lit bulb. */
export function getGlowTexture() {
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

/**
 * Three frames meet in the scene:
 * - PLAN metres, as the floor plan is drawn (x right, y down the page);
 * - WORLD, as three.js renders it: x east, z south, y up;
 * - MAP metres from the plan origin: e east, n north (`src/data/site.ts`).
 * The house is drawn in plan coordinates inside a group turned by SITE_ROT,
 * which is what puts it at its real orientation; the site around it is drawn
 * straight in world coordinates.
 */
export const SITE_ROT = (SITE.planRotationDeg * Math.PI) / 180;
const COS = Math.cos(SITE_ROT);
const SIN = Math.sin(SITE_ROT);

/** Plan → world. Matches a three.js rotation of SITE_ROT about y. */
export function planToWorld(x: number, y: number): [number, number] {
  return [x * COS + y * SIN, -x * SIN + y * COS];
}

/** World → plan. */
export function worldToPlan(x: number, z: number): [number, number] {
  return [x * COS - z * SIN, x * SIN + z * COS];
}

/** Map (east, north) → world. */
export function mapToWorld(e: number, n: number): [number, number] {
  return [e, -n];
}
