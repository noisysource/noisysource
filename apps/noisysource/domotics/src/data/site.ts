/**
 * Where the house actually stands, and what is around it.
 *
 * Read off the satellite view (Google Maps, 40.2486705, -8.4137036) on
 * 2026-10-18. The floor plan already matches it closely — the garage/storage
 * wing measures ~19.3 m on the image against 19.25 m on the plan — so the plan
 * is kept as drawn and only placed: rotated to true north, with the road, the
 * gate, the driveway, the small building by the road and the main trees put
 * around it.
 *
 * Coordinates here are MAP metres from the plan's origin (the north-west
 * corner of the garage wing): `e` east, `n` north. Rough, from an image at
 * ~16 px/m — nudge any of them freely.
 */

export const SITE = {
  lat: 40.2486705,
  lon: -8.4137036,
  /**
   * How far the plan's "up" is turned from true north, degrees anticlockwise
   * (west). On the image the house's long walls run ~12° off the map grid:
   * its north wall rises to the east, its garage wing leans east going south.
   */
  planRotationDeg: 12,

  /** The public road along the north of the plot, running east–west. */
  road: { n: 29.9, width: 6, fromE: -45, toE: 70 },

  /** Gate onto the road — where the electricity comes in. */
  gate: { e: 3.4, n: 24.7 },
  /** The supply pole by the gate. */
  gridPole: { e: 0.6, n: 26.2 },

  /** Gravel: the drive from the gate, and the yard north of the garage where the car parks. */
  gravel: [
    { e1: 1.5, e2: 6.5, n1: 9.5, n2: 26.6 },
    { e1: 0.5, e2: 7.5, n1: 0.3, n2: 10.0 },
  ],

  /** The small building by the road, north-west of the drive. */
  annex: { e: -1.8, n: 19.7, w: 7.3, d: 5.1, h: 2.8 },

  /** The larger trees, for orientation. `r` is the canopy radius. */
  trees: [
    { e: 7.7, n: 18.3, r: 3.2 },
    { e: -6.1, n: 19.8, r: 2.4 },
    { e: 28.0, n: 19.0, r: 3.0 },
    { e: 22.0, n: 9.0, r: 2.4 },
    { e: 29.0, n: -0.4, r: 3.4 },
    { e: -4.9, n: -9.6, r: 2.8 },
    { e: -2.5, n: -14.5, r: 2.6 },
  ],
} as const;
