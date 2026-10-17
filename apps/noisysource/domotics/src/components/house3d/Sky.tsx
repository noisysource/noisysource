import { useMemo, type ReactNode } from 'react';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import SunCalc from 'suncalc';
import { SITE } from '../../data/site';
import { getGlowTexture } from './common';

/**
 * The real sun and moon over the house: where they are now, the path each
 * takes across today's sky, sunrise and sunset, and the moon's phase — and the
 * scene lit from where the sun actually is, so day and night follow the sky
 * rather than a clock.
 *
 * Everything here is world coordinates (x east, z south, y up); positions are
 * on a sphere around the house, not at astronomical distance, so the paths are
 * in view around it.
 */

/** A direction in the sky: compass bearing (radians clockwise from north) and altitude. */
interface SkyDir { bearing: number; alt: number }

export interface SkyState {
  sun: SkyDir;
  moon: SkyDir & { fraction: number };
  sunrise?: Date;
  sunset?: Date;
  /** Today's path above the horizon, as one or more runs of directions. */
  sunPath: SkyDir[][];
  moonPath: SkyDir[][];
  /** Sun more than 6° below the horizon — civil twilight over. */
  night: boolean;
  /** Sun below the horizon but not yet night. */
  dusk: boolean;
}

/** SunCalc measures azimuth from south, positive towards west; compass bearings start at north. */
function dirOf(p: { azimuth: number; altitude: number }): SkyDir {
  return { bearing: p.azimuth + Math.PI, alt: p.altitude };
}

/** Runs of consecutive samples above the horizon — the moon can set in the morning and rise at night. */
function runsAbove(samples: SkyDir[]): SkyDir[][] {
  const runs: SkyDir[][] = [];
  let run: SkyDir[] = [];
  for (const s of samples) {
    if (s.alt > -0.005) run.push(s);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs.filter(r => r.length > 1);
}

const DAY_STEP_MIN = { sun: 10, moon: 15 };

/** Sun and moon for a moment; paths for the whole local day it falls in. */
export function computeSky(now: Date): SkyState {
  const { lat, lon } = SITE;
  const sun = dirOf(SunCalc.getPosition(now, lat, lon));
  const moonPos = SunCalc.getMoonPosition(now, lat, lon);
  const moon = { ...dirOf(moonPos), fraction: SunCalc.getMoonIllumination(now).fraction };
  const times = SunCalc.getTimes(now, lat, lon);

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const sample = (stepMin: number, at: (d: Date) => SkyDir) => {
    const out: SkyDir[] = [];
    for (let m = 0; m <= 24 * 60; m += stepMin) out.push(at(new Date(midnight.getTime() + m * 60_000)));
    return out;
  };

  const valid = (d: Date) => (Number.isFinite(d.getTime()) ? d : undefined);
  return {
    sun,
    moon,
    sunrise: valid(times.sunrise),
    sunset: valid(times.sunset),
    sunPath: runsAbove(sample(DAY_STEP_MIN.sun, d => dirOf(SunCalc.getPosition(d, lat, lon)))),
    moonPath: runsAbove(sample(DAY_STEP_MIN.moon, d => dirOf(SunCalc.getMoonPosition(d, lat, lon)))),
    night: sun.alt < -6 * (Math.PI / 180),
    dusk: sun.alt < 0,
  };
}

/** Unit vector in world coordinates for a sky direction. */
function unit({ bearing, alt }: SkyDir) {
  const c = Math.cos(alt);
  return new THREE.Vector3(c * Math.sin(bearing), Math.sin(alt), -c * Math.cos(bearing));
}

function hhmm(d?: Date) {
  return d ? d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : '—';
}

function Tag({ position, children }: { position: THREE.Vector3; children: ReactNode }) {
  return (
    <Html position={position} center zIndexRange={[12, 0]} pointerEvents="none">
      <span className="block whitespace-nowrap rounded-md bg-zinc-950/70 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-300">
        {children}
      </span>
    </Html>
  );
}

interface Props {
  sky: SkyState;
  /** Centre of the sky sphere: the middle of the house, in world coordinates. */
  center: [number, number];
  radius: number;
}

export default function Sky({ sky, center, radius }: Props) {
  const [cx, cz] = center;
  const at = (d: SkyDir) => unit(d).multiplyScalar(radius).add(new THREE.Vector3(cx, 0, cz));

  // The paths change once a day; rebuilding them every minute would be waste.
  const sunPaths = useMemo(
    () => sky.sunPath.map(run => run.map(d => unit(d).multiplyScalar(radius).add(new THREE.Vector3(cx, 0, cz)))),
    [sky.sunPath, cx, cz, radius],
  );
  const moonPaths = useMemo(
    () => sky.moonPath.map(run => run.map(d => unit(d).multiplyScalar(radius).add(new THREE.Vector3(cx, 0, cz)))),
    [sky.moonPath, cx, cz, radius],
  );

  const sunUp = sky.sun.alt > 0;
  const moonUp = sky.moon.alt > 0;
  const sunAt = at(sky.sun);
  const moonAt = at(sky.moon);
  // The light shines from the sun's real direction, at whatever distance —
  // only its direction matters for a directional light.
  const sunLight = unit(sky.sun).multiplyScalar(60);
  const moonLight = unit(sky.moon).multiplyScalar(60);
  // Low sun is warm; high sun is white.
  const sunColour = sky.sun.alt < 0.17 ? '#ffd2a1' : '#fff7ea';
  const day = sunPaths[0];

  return (
    <group>
      <hemisphereLight args={['#dbeafe', '#1c1917', sky.night ? 0.45 : sky.dusk ? 0.7 : 1.0]} />
      <directionalLight position={sunLight} color={sunColour} intensity={sunUp ? 0.5 + 1.3 * Math.sin(sky.sun.alt) : 0} />
      <directionalLight position={moonLight} color="#c7d2fe" intensity={moonUp && sky.dusk ? 0.35 * sky.moon.fraction : 0} />

      {sunPaths.map((pts, i) => (
        <Line key={i} points={pts} color="#fbbf24" lineWidth={1.5} dashed dashSize={0.8} gapSize={0.6} transparent opacity={0.55} toneMapped={false} fog={false} />
      ))}
      {moonPaths.map((pts, i) => (
        <Line key={i} points={pts} color="#cbd5e1" lineWidth={1.2} dashed dashSize={0.5} gapSize={0.7} transparent opacity={0.35} toneMapped={false} fog={false} />
      ))}

      {/* Sunrise and sunset where the path meets the horizon. */}
      {day && <Tag position={day[0]}>☀ {hhmm(sky.sunrise)}</Tag>}
      {day && <Tag position={day[day.length - 1]}>☀ {hhmm(sky.sunset)}</Tag>}

      {sunUp && (
        <group position={sunAt}>
          <mesh>
            <sphereGeometry args={[1.4, 24, 16]} />
            <meshBasicMaterial color="#fde68a" toneMapped={false} fog={false} />
          </mesh>
          <sprite scale={[9, 9, 1]}>
            <spriteMaterial map={getGlowTexture()} color="#fbbf24" transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} fog={false} />
          </sprite>
        </group>
      )}

      {moonUp && (
        <group position={moonAt}>
          <mesh>
            <sphereGeometry args={[1.0, 24, 16]} />
            <meshBasicMaterial color="#e5e7eb" toneMapped={false} fog={false} />
          </mesh>
          <sprite scale={[4.5, 4.5, 1]}>
            <spriteMaterial map={getGlowTexture()} color="#c7d2fe" transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} fog={false} />
          </sprite>
          <Tag position={new THREE.Vector3(0, 1.9, 0)}>🌙 {Math.round(sky.moon.fraction * 100)}%</Tag>
        </group>
      )}
    </group>
  );
}
