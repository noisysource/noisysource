import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { SITE } from '../../data/site';
import { SITE_ROT, mapToWorld } from './common';

/**
 * What is around the house, from the satellite view: the road to the north,
 * the gravel drive and yard, the small building by the road, and the larger
 * trees. Context only — nothing here is tappable — but it is what makes the
 * house recognisable as itself, and it shows where the supply arrives.
 *
 * World coordinates (x east, z south), from the map metres in `site.ts`.
 */

const ROAD = '#1f2125';
const GRAVEL = '#3a3934';
const WALL = '#d6d3d1';
const ROOF = '#a85a3a';
const TRUNK = '#5b4636';
const CANOPY = '#2f5233';

function Road() {
  const { n, width, fromE, toE } = SITE.road;
  const [x1] = mapToWorld(fromE, n);
  const [x2, z] = mapToWorld(toE, n);
  const centreLine = useMemo(
    () => [new THREE.Vector3(x1, 0.02, z), new THREE.Vector3(x2, 0.02, z)],
    [x1, x2, z],
  );
  return (
    <group>
      <mesh position={[(x1 + x2) / 2, 0.005, z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[x2 - x1, width]} />
        <meshStandardMaterial color={ROAD} roughness={1} />
      </mesh>
      <Line points={centreLine} color="#e5e7eb" lineWidth={1.5} dashed dashSize={2} gapSize={2.5} transparent opacity={0.45} />
    </group>
  );
}

function Gravel() {
  return (
    <>
      {SITE.gravel.map((g, i) => {
        const [x1, z1] = mapToWorld(g.e1, g.n2);
        const [x2, z2] = mapToWorld(g.e2, g.n1);
        return (
          <mesh key={i} position={[(x1 + x2) / 2, 0.004, (z1 + z2) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[x2 - x1, z2 - z1]} />
            <meshStandardMaterial color={GRAVEL} roughness={1} />
          </mesh>
        );
      })}
    </>
  );
}

/** The small building by the road: walls and a hipped tile roof, aligned with the house. */
function Annex() {
  const { e, n, w, d, h } = SITE.annex;
  const [x, z] = mapToWorld(e, n);
  const roofH = 1.2;
  return (
    <group position={[x, 0, z]} rotation={[0, SITE_ROT, 0]}>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={WALL} roughness={0.9} />
      </mesh>
      {/* A four-sided cone is a square pyramid; turned 45° and stretched, a hipped roof. */}
      <mesh position={[0, h + roofH / 2, 0]} rotation={[0, Math.PI / 4, 0]} scale={[(w + 0.4) / Math.SQRT2, 1, (d + 0.4) / Math.SQRT2]}>
        <coneGeometry args={[1, roofH, 4]} />
        <meshStandardMaterial color={ROOF} roughness={0.8} flatShading />
      </mesh>
    </group>
  );
}

function Trees() {
  return (
    <>
      {SITE.trees.map((t, i) => {
        const [x, z] = mapToWorld(t.e, t.n);
        const trunk = 1.4;
        return (
          <group key={i} position={[x, 0, z]}>
            <mesh position={[0, trunk / 2, 0]}>
              <cylinderGeometry args={[0.12, 0.18, trunk, 6]} />
              <meshStandardMaterial color={TRUNK} roughness={1} />
            </mesh>
            <mesh position={[0, trunk + t.r * 0.7, 0]} scale={[1, 0.8, 1]}>
              <icosahedronGeometry args={[t.r, 0]} />
              <meshStandardMaterial color={CANOPY} roughness={1} flatShading />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

export default function SiteLayer() {
  return (
    <group>
      <Road />
      <Gravel />
      <Annex />
      <Trees />
    </group>
  );
}
