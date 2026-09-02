export const DEPOT_ADDRESS =
  'Arco-Íris da Pequenada, Avenida da Guarda Inglesa, Coimbra, Portugal';

const DEFAULT_MAX_RIDE_MIN = 45;
const EARLIEST_DEPARTURE_MIN = 6 * 60; // 06:00

export interface SolverKid {
  kidId: string;
  kidName: string;
  pickupAddress: string;
  dropoffAddress: string;
  deadlineMin: number;   // latest arrival at dropoff (minutes from midnight)
  maxRideMin?: number;   // max time in van (defaults to DEFAULT_MAX_RIDE_MIN)
}

export interface RouteStop {
  address: string;
  type: 'depot' | 'pickup' | 'dropoff';
  kidId: string;
  kidName: string;
  arrivalMin: number;
}

export interface UnassignedKid {
  kidId: string;
  kidName: string;
  reason: 'capacity' | 'rideTime' | 'tooEarly' | 'unknown';
}

export interface SolverResult {
  stops: RouteStop[];
  driverDepartMin: number;   // departure time from the route's first stop (school for afternoon)
  totalTimeMin: number;
  totalDistanceKm: number;
  unassigned: UnassignedKid[];
  // For afternoon runs: travel from DEPOT to the school (before the solver's route begins).
  // The driver's actual departure from Arco-Íris = driverDepartMin - depotToStartMin.
  depotToStartMin: number;
  depotToStartKm: number;
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

// Returns an RFC3339 timestamp for next Tuesday at the given minute-of-day.
// Tuesday is a stable mid-week reference for historical traffic patterns.
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
  departureMin?: number, // minutes from midnight — pins departure time for stable traffic results
): Promise<{ time: number[][]; dist: number[][] }> {
  const n = addresses.length;
  const time: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );
  const dist: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );

  // TRAFFIC_AWARE_OPTIMAL requires origins×destinations ≤ 100 (n ≤ 10).
  // Fall back to TRAFFIC_AWARE for larger matrices.
  const routingPreference = n <= 10 ? 'TRAFFIC_AWARE_OPTIMAL' : 'TRAFFIC_AWARE';

  const body: Record<string, unknown> = {
    origins: addresses.map(a => ({ waypoint: { address: a } })),
    destinations: addresses.map(a => ({ waypoint: { address: a } })),
    travelMode: 'DRIVE',
    routingPreference,
  };
  // Pin departure time so results don't change based on when the button is clicked.
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

function computeTimes(stops: StopNode[], matrix: number[][], startMin: number): number[] {
  const times = [startMin];
  for (let i = 1; i < stops.length; i++) {
    times.push(times[i - 1] + matrix[stops[i - 1].locIdx][stops[i].locIdx]);
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
  // Capacity
  let passengers = 0;
  for (let i = 0; i < proposed.length; i++) {
    const t = proposed[i].type;
    if (t === 'pickup') passengers++;
    if (t === 'dropoff') passengers--;
    if (passengers > capacity || passengers < 0) return 'capacity';
  }

  // Per-kid deadline and max ride time
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
  departureMin?: number,
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
      const newTime = travelTime(proposed, matrix.time);
      const depart = direction === 'morning' ? globalDeadline - newTime : (departureMin ?? globalDeadline);
      if (direction === 'morning' && depart < EARLIEST_DEPARTURE_MIN) { hitTooEarly = true; continue; }
      const times = computeTimes(proposed, matrix.time, depart);
      const kidsForCheck = new Map(assignedKids);
      kidsForCheck.set(kid.kidId, kid);
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
 * Greedy cheapest-insertion heuristic for a single van.
 *
 * Morning: route = DEPOT → pickups/dropoffs → DEPOT (round-trip)
 *   Departure time is derived by working back from the tightest deadline.
 *
 * Afternoon: route = school → dropoffs → DEPOT
 *   Departure is fixed at `departureMin` (school dismissal time).
 */
export async function solveRoutes(
  kids: SolverKid[],
  capacity: number,
  mapsKey: string,
  direction: 'morning' | 'afternoon' = 'morning',
  departureMin?: number,
): Promise<SolverResult> {
  if (kids.length === 0) {
    return { stops: [], driverDepartMin: 0, totalTimeMin: 0, totalDistanceKm: 0, unassigned: [], depotToStartMin: 0, depotToStartKm: 0 };
  }

  // ── Build deduplicated address list (DEPOT always at index 0) ──────────────
  const addrToIdx = new Map<string, number>();
  const addresses: string[] = [DEPOT_ADDRESS];
  addrToIdx.set(DEPOT_ADDRESS, 0);

  const startAddress = direction === 'afternoon' && kids[0]?.pickupAddress
    ? kids[0].pickupAddress   // all afternoon kids share the same school
    : DEPOT_ADDRESS;

  const effectiveStart = direction === 'afternoon' ? startAddress : DEPOT_ADDRESS;
  if (!addrToIdx.has(effectiveStart)) {
    addrToIdx.set(effectiveStart, addresses.length);
    addresses.push(effectiveStart);
  }

  for (const kid of kids) {
    for (const addr of [kid.pickupAddress, kid.dropoffAddress].filter(Boolean)) {
      if (!addrToIdx.has(addr)) {
        addrToIdx.set(addr, addresses.length);
        addresses.push(addr);
      }
    }
  }

  // For morning runs use 07:30 as the reference departure time for traffic modelling.
  const trafficDepartureMin = direction === 'morning' ? 7 * 60 + 30 : (departureMin ?? 16 * 60);
  const matrix = await fetchMatrix(addresses, mapsKey, trafficDepartureMin);

  // ── Map kids to location indices ────────────────────────────────────────────
  const mappedKids: KidWithIdx[] = kids.map(k => ({
    ...k,
    pickupLocIdx: addrToIdx.get(k.pickupAddress) ?? 0,
    dropoffLocIdx: addrToIdx.get(k.dropoffAddress) ?? 0,
  }));

  // ── Initial route: [startDepot, endDepot] ───────────────────────────────────
  const startIdx = addrToIdx.get(effectiveStart) ?? 0;
  const endIdx = 0; // DEPOT_ADDRESS is always index 0

  const mkDepot = (idx: number): StopNode => ({
    locIdx: idx, address: addresses[idx], type: 'depot', kidId: '', kidName: '',
  });
  let route: StopNode[] = [mkDepot(startIdx), mkDepot(endIdx)];

  const assignedKids = new Map<string, SolverKid>();
  const unassigned: UnassignedKid[] = [];
  let remaining = [...mappedKids];

  // Tight deadline for working backwards (morning only)
  const globalDeadline = Math.min(...kids.map(k => k.deadlineMin));

  // Morning runs: all pickups before all dropoffs (school-bus pattern — gather then deliver).
  // This prevents the van zigzagging back to the same school multiple times.
  const allPickupsFirst = direction === 'morning';

  // Two-step insertion helper: inserts pickup at pi in original route, then
  // dropoff at dj in the resulting (longer) route. Keeps the final depot last.
  const buildProposed = (
    base: StopNode[],
    kid: KidWithIdx,
    pi: number, // position in base (1 … base.length-1)
    dj: number, // position in base+pickup (pi+1 … base.length)
  ): StopNode[] => {
    const pickupNode: StopNode = { locIdx: kid.pickupLocIdx, address: kid.pickupAddress, type: 'pickup', kidId: kid.kidId, kidName: kid.kidName };
    const dropoffNode: StopNode = { locIdx: kid.dropoffLocIdx, address: kid.dropoffAddress, type: 'dropoff', kidId: kid.kidId, kidName: kid.kidName };
    const withPickup = [...base.slice(0, pi), pickupNode, ...base.slice(pi)];
    return [...withPickup.slice(0, dj), dropoffNode, ...withPickup.slice(dj)];
  };

  // ── Greedy insertion loop ───────────────────────────────────────────────────
  while (remaining.length > 0) {
    let bestKid: KidWithIdx | null = null;
    let bestPi = -1;
    let bestDj = -1;
    let bestCost = Infinity;

    const n = route.length; // current route length (final depot is at index n-1)
    const oldTime = travelTime(route, matrix.time);
    const numPickups = route.filter(s => s.type === 'pickup').length;

    for (const kid of remaining) {
      // pi: where to insert the pickup in the original route.
      //   allPickupsFirst → only positions before the first existing dropoff (≤ numPickups+1).
      //   Otherwise → anywhere except before the start depot or after the end depot.
      const piMax = allPickupsFirst ? numPickups + 1 : n - 1;

      for (let pi = 1; pi <= piMax; pi++) {
        // dj: where to insert the dropoff in the route-after-pickup (length n+1, depot at index n).
        //   allPickupsFirst → only positions after all pickups (≥ numPickups+2).
        //   Otherwise → anywhere after the pickup just inserted.
        const djMin = allPickupsFirst ? numPickups + 2 : pi + 1;
        const djMax = n; // insert before the final depot which is now at index n

        for (let dj = djMin; dj <= djMax; dj++) {
          const proposed = buildProposed(route, kid, pi, dj);
          const newTime = travelTime(proposed, matrix.time);
          const depart = direction === 'morning'
            ? globalDeadline - newTime
            : (departureMin ?? globalDeadline);

          if (direction === 'morning' && depart < EARLIEST_DEPARTURE_MIN) continue;

          const times = computeTimes(proposed, matrix.time, depart);
          const kidsForCheck = new Map(assignedKids);
          kidsForCheck.set(kid.kidId, kid);

          if (!isValid(proposed, times, kidsForCheck, capacity)) continue;

          const cost = newTime - oldTime;
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
      // No valid insertion found for any remaining kid → diagnose and flag them
      for (const kid of remaining) {
        const reason = diagnoseKid(kid, route, matrix, assignedKids, capacity, direction, globalDeadline, departureMin);
        unassigned.push({ kidId: kid.kidId, kidName: kid.kidName, reason });
      }
      break;
    }
  }

  // ── Final timing ────────────────────────────────────────────────────────────
  const finalTime = travelTime(route, matrix.time);
  const driverDepartMin = direction === 'morning'
    ? globalDeadline - finalTime
    : (departureMin ?? globalDeadline);
  const times = computeTimes(route, matrix.time, driverDepartMin);

  // ── Aggregate total distance ────────────────────────────────────────────────
  const totalDistKm = route
    .slice(1)
    .reduce((sum, s, i) => sum + matrix.dist[route[i].locIdx][s.locIdx], 0);

  const stops: RouteStop[] = route.map((s, i) => ({
    address: s.address,
    type: s.type,
    kidId: s.kidId,
    kidName: s.kidName,
    arrivalMin: times[i],
  }));

  // For afternoon: compute the DEPOT → school leg that precedes the solver's route.
  // The driver's actual departure from Arco-Íris is driverDepartMin - depotToStartMin.
  const depotToStartMin = startIdx !== 0 ? Math.round(matrix.time[0][startIdx]) : 0;
  const depotToStartKm = startIdx !== 0 ? Math.round(matrix.dist[0][startIdx] * 10) / 10 : 0;

  return {
    stops,
    driverDepartMin,
    totalTimeMin: Math.round(finalTime),
    totalDistanceKm: Math.round(totalDistKm * 10) / 10,
    unassigned,
    depotToStartMin,
    depotToStartKm,
  };
}
