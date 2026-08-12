import type { PlanRoom, Wall } from '@shared/models/Room';

/**
 * Derive a starting wall layer from the room rectangles.
 *
 * Drawing thirty walls by hand is tedious, and the room blocks already encode
 * most of the geometry. So each room contributes its four edges, and edges
 * shared by two rooms collapse into a single wall — a partition between two
 * rooms is one wall, not two back-to-back.
 *
 * An edge belonging to only one room faces outside and is marked exterior;
 * shared edges are interior. That guess is right most of the time and wrong in
 * exactly the interesting places — the open-plan kitchen/dining/living, where
 * the generated partitions should simply be deleted.
 */

/** Coordinates are snapped before comparison so near-identical edges match. */
const PRECISION = 100;

function key(x1: number, y1: number, x2: number, y2: number) {
  // Normalise direction so an edge and its reverse produce the same key.
  const a = [Math.round(x1 * PRECISION), Math.round(y1 * PRECISION)];
  const b = [Math.round(x2 * PRECISION), Math.round(y2 * PRECISION)];
  const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
  return `${p[0]},${p[1]}|${q[0]},${q[1]}`;
}

function insideAnyRoom(rooms: PlanRoom[], x: number, y: number) {
  return rooms.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

/** How far either side of an edge to look when deciding interior vs exterior. */
const PROBE = 0.2;

export function wallsFromRooms(rooms: PlanRoom[]): Wall[] {
  const seen = new Map<string, { count: number; wall: Omit<Wall, 'id' | 'kind'> }>();

  for (const r of rooms) {
    const corners: Array<[number, number, number, number]> = [
      [r.x, r.y, r.x + r.w, r.y],                     // top
      [r.x + r.w, r.y, r.x + r.w, r.y + r.h],         // right
      [r.x + r.w, r.y + r.h, r.x, r.y + r.h],         // bottom
      [r.x, r.y + r.h, r.x, r.y],                     // left
    ];
    for (const [x1, y1, x2, y2] of corners) {
      const k = key(x1, y1, x2, y2);
      const existing = seen.get(k);
      if (existing) existing.count += 1;
      else seen.set(k, { count: 1, wall: { x1, y1, x2, y2 } });
    }
  }

  let n = 0;
  return [...seen.values()].map(({ wall }) => {
    // Classify by what actually lies on each side, not by whether two rooms
    // happen to share exact coordinates. Blocks dragged into place rarely align
    // to the millimetre, so counting shared edges called 48 of 54 walls
    // exterior — including partitions with a room plainly on both sides.
    const mx = (wall.x1 + wall.x2) / 2;
    const my = (wall.y1 + wall.y2) / 2;
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // unit normal
    const bothSides =
      insideAnyRoom(rooms, mx + nx * PROBE, my + ny * PROBE) &&
      insideAnyRoom(rooms, mx - nx * PROBE, my - ny * PROBE);

    return {
      ...wall,
      id: `wall-${Date.now()}-${n++}`,
      kind: bothSides ? ('interior' as const) : ('exterior' as const),
    };
  });
}

export function wallLength(w: Wall) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

/**
 * How many walls a straight line between two points crosses.
 *
 * Used to reason about wireless paths: each wall between an access point and a
 * device costs signal, and an exterior wall costs considerably more than a
 * stud partition. Segment intersection, ignoring the degenerate parallel case —
 * a path running exactly along a wall is not meaningfully obstructed by it.
 */
export function wallsBetween(
  walls: Wall[],
  ax: number, ay: number, bx: number, by: number,
): Wall[] {
  const cross = (x1: number, y1: number, x2: number, y2: number) => x1 * y2 - y1 * x2;

  return walls.filter(w => {
    const rx = bx - ax, ry = by - ay;
    const sx = w.x2 - w.x1, sy = w.y2 - w.y1;
    const denom = cross(rx, ry, sx, sy);
    if (Math.abs(denom) < 1e-9) return false; // parallel or collinear
    const t = cross(w.x1 - ax, w.y1 - ay, sx, sy) / denom;
    const u = cross(w.x1 - ax, w.y1 - ay, rx, ry) / denom;
    return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
  });
}
