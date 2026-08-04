import type { Room } from '@shared/models/Room';
import type { Device } from '@shared/models/Device';

export const initialRooms: Room[] = [
  { id: 'sala', name: 'Sala de Estar', icon: '🛋️' },
  { id: 'quarto', name: 'Quarto Principal', icon: '🛏️' },
  { id: 'cozinha', name: 'Cozinha', icon: '🍳' },
  { id: 'escritorio', name: 'Escritório', icon: '💻' },
];

export const initialDevices: Device[] = [
  // ── Sala de Estar ────────────────────────────────────────────────
  {
    id: 'sala-luz-teto',
    roomId: 'sala',
    name: 'Teto',
    type: 'light',
    state: { on: true, brightness: 80, dimmable: true },
  },
  {
    id: 'sala-luz-sofa',
    roomId: 'sala',
    name: 'Sofá',
    type: 'light',
    state: { on: false, brightness: 50, dimmable: true },
  },
  {
    id: 'sala-luz-leitura',
    roomId: 'sala',
    name: 'Leitura',
    type: 'light',
    state: { on: false, brightness: 100, dimmable: false },
  },
  {
    id: 'sala-store-esquerda',
    roomId: 'sala',
    name: 'Janela Esquerda',
    type: 'blind',
    state: { position: 40, isMoving: false, movingDirection: null },
  },
  {
    id: 'sala-store-direita',
    roomId: 'sala',
    name: 'Janela Direita',
    type: 'blind',
    state: { position: 0, isMoving: false, movingDirection: null },
  },

  // ── Quarto Principal ─────────────────────────────────────────────
  {
    id: 'quarto-luz-teto',
    roomId: 'quarto',
    name: 'Teto',
    type: 'light',
    state: { on: false, brightness: 100, dimmable: true },
  },
  {
    id: 'quarto-luz-cabeceira',
    roomId: 'quarto',
    name: 'Cabeceira',
    type: 'light',
    state: { on: true, brightness: 30, dimmable: true },
  },
  {
    id: 'quarto-store-janela',
    roomId: 'quarto',
    name: 'Janela',
    type: 'blind',
    state: { position: 100, isMoving: false, movingDirection: null },
  },
  {
    id: 'quarto-store-terraco',
    roomId: 'quarto',
    name: 'Terraço',
    type: 'blind',
    state: { position: 80, isMoving: false, movingDirection: null },
  },

  // ── Cozinha ──────────────────────────────────────────────────────
  {
    id: 'cozinha-luz-teto',
    roomId: 'cozinha',
    name: 'Teto',
    type: 'light',
    state: { on: true, brightness: 100, dimmable: false },
  },
  {
    id: 'cozinha-luz-bancada',
    roomId: 'cozinha',
    name: 'Bancada',
    type: 'light',
    state: { on: true, brightness: 100, dimmable: false },
  },
  {
    id: 'cozinha-store-janela',
    roomId: 'cozinha',
    name: 'Janela',
    type: 'blind',
    state: { position: 20, isMoving: false, movingDirection: null },
  },

  // ── Escritório ───────────────────────────────────────────────────
  {
    id: 'escritorio-luz-teto',
    roomId: 'escritorio',
    name: 'Teto',
    type: 'light',
    state: { on: true, brightness: 100, dimmable: false },
  },
  {
    id: 'escritorio-luz-mesa',
    roomId: 'escritorio',
    name: 'Mesa',
    type: 'light',
    state: { on: true, brightness: 70, dimmable: true },
  },
  {
    id: 'escritorio-store-janela',
    roomId: 'escritorio',
    name: 'Janela',
    type: 'blind',
    state: { position: 60, isMoving: false, movingDirection: null },
  },
];
