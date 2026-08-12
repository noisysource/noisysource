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

/**
 * Network hardware placed on the plan.
 *
 * Not a Device: these are never controlled, they are recorded so signal
 * problems can be reasoned about against where things physically sit. Position
 * is absolute plan metres rather than room-relative, because an access point
 * often sits in a hallway or against a wall rather than inside one room.
 */
export interface InfraItem {
  id: string;
  kind: 'router' | 'repeater';
  name: string;
  x: number;
  y: number;
  /** 2.4 / 5 GHz, free text — a repeater may be one band only. */
  band?: string;
}

/**
 * A physical wall segment, in plan metres.
 *
 * Walls are modelled separately from rooms because the two are not the same
 * thing. A room rectangle implies four walls, which is wrong for an open plan:
 * the kitchen, dining and living areas are one continuous space, and drawing a
 * border between them invents structure that isn't there.
 *
 * The distinction matters beyond looks — wireless attenuation depends on what
 * physically stands between an access point and a device, so an accurate wall
 * layer is what makes signal reasoning meaningful rather than guesswork.
 */
export interface Wall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Exterior walls are thicker and attenuate far more than interior ones. */
  kind?: 'exterior' | 'interior' | 'glass';
}

export interface FloorPlan {
  /** Snap step in metres. */
  grid: number;
  rooms: PlanRoom[];
  infrastructure?: InfraItem[];
  walls?: Wall[];
}
