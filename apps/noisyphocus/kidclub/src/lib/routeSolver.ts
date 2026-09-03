export const DEPOT_ADDRESS =
  'Arco-Íris da Pequenada, Avenida da Guarda Inglesa, Coimbra, Portugal';

const DEFAULT_MAX_RIDE_MIN = 60;
const EARLIEST_DEPARTURE_MIN = 6 * 60; // 06:00

export interface SolverKid {
  kidId: string;
  kidName: string;
  pickupAddress: string;
  dropoffAddress: string;
  deadlineMin: number;       // latest arrival at dropoff (for morning: school start time)
  maxRideMin?: number;
  earliestPickupMin?: number; // earliest the van may pick up this kid (school dismissal for afternoon)
}

export interface RouteStop {
  address: string;
  type: 'depot' | 'pickup' | 'dropoff';
  kidId: string;
  kidName: string;
  arrivalMin: number;
  deviationMin?: number; // arrivalMin − earliestPickupMin: <0 van arrived early (waited), >0 late
}

export interface UnassignedKid {
  kidId: string;
  kidName: string;
  reason: 'capacity' | 'rideTime' | 'tooEarly' | 'unknown';
}

export interface SolverResult {
  stops: RouteStop[];
  driverDepartMin: number;
  totalTimeMin: number;
  totalDistanceKm: number;
  unassigned: UnassignedKid[];
  depotToStartMin: number; // always 0 in new model (depot is the start)
  depotToStartKm: number;  // always 0 in new model
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface StopNode {
  locIdx: number;
  address: string;
  type: 'depot' | 'pickup' | 'dropoff';
  kidId: string;
  kidName: string;
}

// ─── Matrix fetch ─────────────────────────────────────────────────────────────

function parseDurMin(d: unknown): number {
  if (typeof d === 'number') return d / 60;
  if (typeof d === 'string') return parseFloat(d.replace('s', '')) / 60;
  if (d && typeof d === 'object' && 'seconds' in d) return Number((d as Record<string, unknown>).seconds) / 60;
  return 0;
}

function nextTuesdayAt(minutesFromMidnight: number): string {
  const d = new Date();
  const daysUntilTuesday = ((2 - d.getDay() + 7) % 7) || 7;
  d.setDate(d.getDate() + daysUntilTuesday);
  d.setHours(Math.floor(minutesFromMidnight / 60), minutesFromMidnight % 60, 0, 0);
  return d.toISOString();
}

async function fetchMatrix(
  addresses: string[],
  mapsKey: string,
  departureMin?: number,
): Promise<{ time: number[][]; dist: number[][] }> {
  const n = addresses.length;
  const time: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );
  const dist: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );

  const routingPreference = n <= 10 ? 'TRAFFIC_AWARE_OPTIMAL' : 'TRAFFIC_AWARE';
  const body: Record<string, unknown> = {
    origins: addresses.map(a => ({ waypoint: { address: a } })),
    destinations: addresses.map(a => ({ waypoint: { address: a } })),
    travelMode: 'DRIVE',
    routingPreference,
  };
  if (departureMin != null) {
    body.departureTime = nextTuesdayAt(departureMin);
  }

  const resp = await fetch(
    'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': mapsKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,status',
      },
      body: JSON.stringify(body),
    },
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => null);
    throw new Error(`RouteMatrix ${resp.status}: ${JSON.stringify(err)}`);
  }

  const elements: Array<Record<string, unknown>> = await resp.json();
  for (const el of elements) {
    const oi = el.originIndex as number;
    const di = el.destinationIndex as number;
    if (oi == null || di == null) continue;
    time[oi][di] = parseDurMin(el.duration);
    dist[oi][di] = ((el.distanceMeters as number) ?? 0) / 1000;
  }
  return { time, dist };
}

// ─── Timing helpers ───────────────────────────────────────────────────────────

function travelTime(stops: StopNode[], matrix: number[][]): number {
  return stops
    .slice(1)
    .reduce((sum, s, i) => sum + matrix[stops[i].locIdx][s.locIdx], 0);
}

// Computes arrival times, inserting wait time at pickup stops when van arrives
// before the school's dismissal (earliestPickupMin). This is the only scheduling
// constraint for afternoon: the van waits at the school if it arrives early.
function computeTimesWithWaits(
  stops: StopNode[],
  matrix: number[][],
  startMin: number,
  kidsMap: Map<string, SolverKid>,
): number[] {
  const times = [startMin];
  for (let i = 1; i < stops.length; i++) {
    let t = times[i - 1] + matrix[stops[i - 1].locIdx][stops[i].locIdx];
    if (stops[i].type === 'pickup') {
      const earliest = kidsMap.get(stops[i].kidId)?.earliestPickupMin;
      if (earliest != null && t < earliest) t = earliest;
    }
    times.push(t);
  }
  return times;
}

// ─── Constraint checker ───────────────────────────────────────────────────────

type FailReason = 'capacity' | 'rideTime' | null;

function checkConstraints(
  proposed: StopNode[],
  times: number[],
  kidsOnRoute: Map<string, SolverKid>,
  capacity: number,
): FailReason {
  let passengers = 0;
  for (let i = 0; i < proposed.length; i++) {
    const t = proposed[i].type;
    if (t === 'pickup') passengers++;
    if (t === 'dropoff') passengers--;
    if (passengers > capacity || passengers < 0) return 'capacity';
  }

  for (const [kidId, kid] of kidsOnRoute) {
    const pi = proposed.findIndex(s => s.type === 'pickup' && s.kidId === kidId);
    const di = proposed.findIndex(s => s.type === 'dropoff' && s.kidId === kidId);
    if (pi === -1 || di === -1) continue;
    if (di < pi) return 'rideTime';
    const maxRide = kid.maxRideMin ?? DEFAULT_MAX_RIDE_MIN;
    if (times[di] - times[pi] > maxRide) return 'rideTime';
    if (times[di] > kid.deadlineMin) return 'rideTime';
  }
  return null;
}

function isValid(
  proposed: StopNode[],
  times: number[],
  kidsOnRoute: Map<string, SolverKid>,
  capacity: number,
): boolean {
  return checkConstraints(proposed, times, kidsOnRoute, capacity) === null;
}

function diagnoseKid(
  kid: KidWithIdx,
  route: StopNode[],
  matrix: { time: number[][] },
  assignedKids: Map<string, SolverKid>,
  capacity: number,
  direction: string,
  globalDeadline: number,
  driverDepartMin: number,
): UnassignedKid['reason'] {
  const n = route.length;
  const numPickups = route.filter(s => s.type === 'pickup').length;
  const allPickupsFirst = direction === 'morning';
  let hitCapacity = false;
  let hitRideTime = false;
  let hitTooEarly = false;

  const pickupNode: StopNode = { locIdx: kid.pickupLocIdx, address: kid.pickupAddress, type: 'pickup', kidId: kid.kidId, kidName: kid.kidName };
  const dropoffNode: StopNode = { locIdx: kid.dropoffLocIdx, address: kid.dropoffAddress, type: 'dropoff', kidId: kid.kidId, kidName: kid.kidName };

  const piMax = allPickupsFirst ? numPickups + 1 : n - 1;
  for (let pi = 1; pi <= piMax; pi++) {
    const withPickup = [...route.slice(0, pi), pickupNode, ...route.slice(pi)];
    const djMin = allPickupsFirst ? numPickups + 2 : pi + 1;
    for (let dj = djMin; dj <= n; dj++) {
      const proposed = [...withPickup.slice(0, dj), dropoffNode, ...withPickup.slice(dj)];
      const newTravel = travelTime(proposed, matrix.time);
      const depart = direction === 'morning' ? globalDeadline - newTravel : driverDepartMin;
      if (direction === 'morning' && depart < EARLIEST_DEPARTURE_MIN) { hitTooEarly = true; continue; }
      const kidsForCheck = new Map(assignedKids);
      kidsForCheck.set(kid.kidId, kid);
      const times = computeTimesWithWaits(proposed, matrix.time, depart, kidsForCheck);
      const reason = checkConstraints(proposed, times, kidsForCheck, capacity);
      if (reason === 'capacity') hitCapacity = true;
      if (reason === 'rideTime') hitRideTime = true;
    }
  }

  if (hitTooEarly && !hitCapacity && !hitRideTime) return 'tooEarly';
  if (hitCapacity && !hitRideTime) return 'capacity';
  if (hitRideTime) return 'rideTime';
  return 'unknown';
}

// ─── Main solver ──────────────────────────────────────────────────────────────

type KidWithIdx = SolverKid & { pickupLocIdx: number; dropoffLocIdx: number };

/**
 * Pickup-and-delivery solver for a single van.
 *
 * Morning: DEPOT → pickups (homes) → dropoffs (schools) → DEPOT
 *   All pickups before all dropoffs. Departure time worked back from tightest deadline.
 *
 * Afternoon/lunch: DEPOT → interleaved pickups (schools) + dropoffs (homes) → DEPOT
 *   Van picks up from multiple schools, interleaves dropoffs when van is at capacity.
 *   Van waits at a school if it arrives before dismissal (earliestPickupMin).
 *   Departure calculated to arrive at the earliest-dismissal school on time.
 */
export async function solveRoutes(
  kids: SolverKid[],
  capacity: number,
  mapsKey: string,
  direction: 'morning' | 'afternoon' = 'morning',
  departureHint?: number, // used only as traffic-time reference for afternoon
): Promise<SolverResult> {
  if (kids.length === 0) {
    return { stops: [], driverDepartMin: 0, totalTimeMin: 0, totalDistanceKm: 0, unassigned: [], depotToStartMin: 0, depotToStartKm: 0 };
  }

  // ── Build deduplicated address list (DEPOT always at index 0) ──────────────
  const addrToIdx = new Map<string, number>();
  const addresses: string[] = [DEPOT_ADDRESS];
  addrToIdx.set(DEPOT_ADDRESS, 0);

  for (const kid of kids) {
    for (const addr of [kid.pickupAddress, kid.dropoffAddress].filter(Boolean)) {
      if (!addrToIdx.has(addr)) {
        addrToIdx.set(addr, addresses.length);
        addresses.push(addr);
      }
    }
  }

  // Traffic reference: morning at 07:30, afternoon at earliest dismissal or hint
  const minEarliest = Math.min(...kids.map(k => k.earliestPickupMin ?? Infinity));
  const trafficRef = direction === 'morning'
    ? 7 * 60 + 30
    : (isFinite(minEarliest) ? minEarliest : (departureHint ?? 16 * 60));
  const matrix = await fetchMatrix(addresses, mapsKey, trafficRef);

  // ── Map kids to location indices ────────────────────────────────────────────
  const mappedKids: KidWithIdx[] = kids.map(k => ({
    ...k,
    pickupLocIdx: addrToIdx.get(k.pickupAddress) ?? 0,
    dropoffLocIdx: addrToIdx.get(k.dropoffAddress) ?? 0,
  }));

  // ── Compute afternoon departure: leave depot just in time for earliest school ─
  const depotIdx = 0;
  let driverDepartMin: number;
  const globalDeadline = Math.min(...kids.map(k => k.deadlineMin));

  if (direction === 'morning') {
    // Will be set after solving (works backwards from deadline)
    driverDepartMin = 0; // placeholder
  } else {
    // Leave depot so van arrives at the earliest-dismissal school right on time.
    // Use the minimum drive time from depot to any pickup school as estimate.
    const minDepotToPickup = Math.min(
      ...mappedKids.map(k => matrix.time[depotIdx][k.pickupLocIdx])
    );
    driverDepartMin = isFinite(minEarliest)
      ? Math.max(minEarliest - minDepotToPickup, EARLIEST_DEPARTURE_MIN)
      : Math.max((departureHint ?? 16 * 60) - 30, EARLIEST_DEPARTURE_MIN);
  }

  // ── Initial route: [DEPOT, DEPOT] ────────────────────────────────────────────
  const mkDepot = (): StopNode => ({ locIdx: 0, address: DEPOT_ADDRESS, type: 'depot', kidId: '', kidName: '' });
  let route: StopNode[] = [mkDepot(), mkDepot()];

  const assignedKids = new Map<string, SolverKid>();
  const unassigned: UnassignedKid[] = [];
  let remaining = [...mappedKids];

  // Morning: all pickups before all dropoffs (gather-then-deliver school-bus pattern).
  // Afternoon: fully interleaved — allows dropoffs between pickups to free capacity.
  const allPickupsFirst = direction === 'morning';

  const buildProposed = (
    base: StopNode[],
    kid: KidWithIdx,
    pi: number,
    dj: number,
  ): StopNode[] => {
    const pickupNode: StopNode = { locIdx: kid.pickupLocIdx, address: kid.pickupAddress, type: 'pickup', kidId: kid.kidId, kidName: kid.kidName };
    const dropoffNode: StopNode = { locIdx: kid.dropoffLocIdx, address: kid.dropoffAddress, type: 'dropoff', kidId: kid.kidId, kidName: kid.kidName };
    const withPickup = [...base.slice(0, pi), pickupNode, ...base.slice(pi)];
    return [...withPickup.slice(0, dj), dropoffNode, ...withPickup.slice(dj)];
  };

  // ── Greedy insertion loop ───────────────────────────────────────────────────
  while (remaining.length > 0) {
    // Baseline wall-clock for current route (used as cost reference)
    const baseDepart = direction === 'morning'
      ? globalDeadline - travelTime(route, matrix.time)
      : driverDepartMin;
    const baseTimes = computeTimesWithWaits(route, matrix.time, baseDepart, assignedKids);
    const baseWallClock = baseTimes.length > 1 ? baseTimes[baseTimes.length - 1] - baseTimes[0] : 0;

    let bestKid: KidWithIdx | null = null;
    let bestPi = -1;
    let bestDj = -1;
    let bestCost = Infinity;

    const n = route.length;
    const numPickups = route.filter(s => s.type === 'pickup').length;

    for (const kid of remaining) {
      const piMax = allPickupsFirst ? numPickups + 1 : n - 1;

      for (let pi = 1; pi <= piMax; pi++) {
        const djMin = allPickupsFirst ? numPickups + 2 : pi + 1;
        const djMax = n;

        for (let dj = djMin; dj <= djMax; dj++) {
          const proposed = buildProposed(route, kid, pi, dj);
          const kidsForCheck = new Map(assignedKids);
          kidsForCheck.set(kid.kidId, kid);

          const newTravel = travelTime(proposed, matrix.time);
          const newDepart = direction === 'morning'
            ? globalDeadline - newTravel
            : driverDepartMin;

          if (direction === 'morning' && newDepart < EARLIEST_DEPARTURE_MIN) continue;

          const times = computeTimesWithWaits(proposed, matrix.time, newDepart, kidsForCheck);
          if (!isValid(proposed, times, kidsForCheck, capacity)) continue;

          // Cost = additional wall-clock time (includes waits)
          const wallClock = times[times.length - 1] - times[0];
          const cost = wallClock - baseWallClock;

          if (cost < bestCost) {
            bestCost = cost;
            bestKid = kid;
            bestPi = pi;
            bestDj = dj;
          }
        }
      }
    }

    if (bestKid) {
      route = buildProposed(route, bestKid, bestPi, bestDj);
      assignedKids.set(bestKid.kidId, bestKid);
      remaining = remaining.filter(k => k.kidId !== bestKid!.kidId);
    } else {
      for (const kid of remaining) {
        const reason = diagnoseKid(kid, route, matrix, assignedKids, capacity, direction, globalDeadline, driverDepartMin);
        unassigned.push({ kidId: kid.kidId, kidName: kid.kidName, reason });
      }
      break;
    }
  }

  // ── Final timing ────────────────────────────────────────────────────────────
  const finalTravel = travelTime(route, matrix.time);
  if (direction === 'morning') {
    driverDepartMin = globalDeadline - finalTravel;
  }

  const finalTimes = computeTimesWithWaits(route, matrix.time, driverDepartMin, assignedKids);

  const totalDistKm = route
    .slice(1)
    .reduce((sum, s, i) => sum + matrix.dist[route[i].locIdx][s.locIdx], 0);

  const stops: RouteStop[] = route.map((s, i) => {
    const kid = assignedKids.get(s.kidId);
    const deviationMin = s.type === 'pickup' && kid?.earliestPickupMin != null
      ? Math.round(finalTimes[i] - kid.earliestPickupMin)
      : undefined;
    return { address: s.address, type: s.type, kidId: s.kidId, kidName: s.kidName, arrivalMin: finalTimes[i], deviationMin };
  });

  // Wall-clock duration = last stop time − departure time
  const wallClockMin = finalTimes.length > 1
    ? finalTimes[finalTimes.length - 1] - driverDepartMin
    : finalTravel;

  return {
    stops,
    driverDepartMin,
    totalTimeMin: Math.round(wallClockMin),
    totalDistanceKm: Math.round(totalDistKm * 10) / 10,
    unassigned,
    depotToStartMin: 0, // depot is always the start now
    depotToStartKm: 0,
  };
}
