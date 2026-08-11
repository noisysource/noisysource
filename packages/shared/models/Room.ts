/**
 * A Room groups devices by physical location.
 * icon is an emoji used in the UI.
 */
export interface Room {
  id: string;
  name: string;
  icon: string;
}

/**
 * An axis-aligned block on the floor plan.
 *
 * Units are METRES, measured from the plan origin (top-left of the building
 * envelope), x to the right and y downwards — same handedness as SVG, so the
 * renderer needs no flip. Rectangles only: an L-shaped space is drawn as two
 * adjacent blocks. Dimensions are deliberately approximate and user-editable.
 */
export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A room as it appears on the editable floor plan. */
export interface PlanRoom extends Room, RoomRect {
  /**
   * Rooms carrying no smart devices (garage, storage, deck) still get drawn —
   * they give the plan its real shape — but render muted and aren't tappable
   * for control. `id` matches the Netatmo room id wherever devices exist, which
   * is what binds Device.roomId to a block.
   */
  controllable?: boolean;
}

export interface FloorPlan {
  /** Snap step in metres. */
  grid: number;
  rooms: PlanRoom[];
}
