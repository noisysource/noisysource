import type { FloorPlan, PlanRoom } from '@shared/models/Room';

/**
 * Seed floor plan, traced from `Arquitectura3.pdf` ("Planta piso 0", Nov 2020,
 * 1:200). Building envelope is roughly 24.5 x 19.3 m.
 *
 * TWO DELIBERATE DEPARTURES FROM THE DRAWING, per the owner — the plans are out
 * of date:
 *   1. The WC that sat between the living space and the bedrooms (`wc 3,10 m2`)
 *      no longer exists and is omitted here.
 *   2. What the drawing shows as two unequal bedrooms (13,45 / 12,70 m2) is
 *      built as two mirrored bedrooms of equal size.
 *
 * Everything here is approximate on purpose. It exists to be dragged into shape
 * in the editor and then saved to Firestore, after which this file is only ever
 * the fallback for a first run.
 *
 * Ids of controllable rooms MUST stay equal to the Netatmo room ids in
 * `legrandData.ts` — that equality is what binds devices to blocks.
 */

const CONTROLLABLE: PlanRoom[] = [
  { id: '3818500481', name: 'Cozinha',              icon: '🍳', x: 5.25,  y: 0.5,  w: 3.5,  h: 5.0,  controllable: true },
  { id: '3478300960', name: 'Sala de Estar',        icon: '🛋️', x: 8.75,  y: 0.5,  w: 5.0,  h: 5.0,  controllable: true },
  { id: '4038969737', name: 'Sala de Jantar',       icon: '🍽️', x: 13.75, y: 0.5,  w: 3.25, h: 5.0,  controllable: true },
  { id: '536040817',  name: 'Quarto Diniz',         icon: '🛏️', x: 17.25, y: 0.5,  w: 3.5,  h: 3.75, controllable: true },
  { id: '699655279',  name: 'Quarto Duarte',        icon: '🛏️', x: 20.75, y: 0.5,  w: 3.5,  h: 3.75, controllable: true },
  { id: '2463279956', name: 'Casa de Banho Miúdos', icon: '🚿', x: 20.75, y: 4.25, w: 3.0,  h: 2.75, controllable: true },
  { id: '1220347398', name: 'Corredor Quartos',     icon: '🚪', x: 5.25,  y: 6.0,  w: 12.0, h: 1.25, controllable: true },
  { id: '2311140314', name: 'Casa de Banho Master', icon: '🚿', x: 20.75, y: 7.0,  w: 3.0,  h: 2.5,  controllable: true },
  { id: '902933326',  name: 'Quarto Master',        icon: '🛏️', x: 14.5,  y: 7.5,  w: 4.75, h: 5.0,  controllable: true },
];

/** Spaces with no smart devices — drawn for shape, not tappable. */
const STRUCTURAL: PlanRoom[] = [
  { id: 'plan-garagem',    name: 'Garagem',       icon: '🚗', x: 0,     y: 0,     w: 5.0,  h: 7.2  },
  { id: 'plan-hall',       name: 'Hall Quartos',  icon: '🚪', x: 17.25, y: 4.25,  w: 3.5,  h: 1.5  },
  { id: 'plan-closet',     name: 'Closet',        icon: '👕', x: 17.25, y: 5.75,  w: 2.25, h: 1.5  },
  { id: 'plan-deck',       name: 'Deck Exterior', icon: '🌳', x: 5.25,  y: 7.5,   w: 9.0,  h: 4.25 },
  { id: 'plan-arrumo-1',   name: 'Arrumo',        icon: '📦', x: 0,     y: 7.5,   w: 5.0,  h: 2.75 },
  { id: 'plan-wc-garagem', name: 'WC Garagem',    icon: '🚻', x: 0,     y: 10.5,  w: 2.5,  h: 2.25 },
  { id: 'plan-casa-maq',   name: 'Casa Máquinas', icon: '⚙️', x: 2.5,   y: 10.5,  w: 2.5,  h: 2.25 },
  { id: 'plan-arrumo-2',   name: 'Arrumo',        icon: '📦', x: 0,     y: 13.0,  w: 5.0,  h: 4.0  },
  { id: 'plan-arrumo-3',   name: 'Arrumo',        icon: '📦', x: 0,     y: 17.25, w: 5.0,  h: 2.0  },
];

export const defaultFloorPlan: FloorPlan = {
  grid: 0.25,
  rooms: [...CONTROLLABLE, ...STRUCTURAL],
};
