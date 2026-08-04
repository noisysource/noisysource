import type { Room } from '@shared/models/Room';
import type { Device } from '@shared/models/Device';

// Real rooms from Netatmo homesdata
export const rooms: Room[] = [
  { id: '3478300960', name: 'Sala de Estar', icon: '🛋️' },
  { id: '902933326',  name: 'Quarto Master', icon: '🛏️' },
  { id: '3818500481', name: 'Cozinha', icon: '🍳' },
  { id: '4038969737', name: 'Sala de Jantar', icon: '🍽️' },
  { id: '536040817',  name: 'Quarto Diniz', icon: '🛏️' },
  { id: '699655279',  name: 'Quarto Duarte', icon: '🛏️' },
  { id: '1220347398', name: 'Corredor Quartos', icon: '🚪' },
  { id: '2311140314', name: 'Casa de Banho Master', icon: '🚿' },
  { id: '2463279956', name: 'Casa de Banho Miúdos', icon: '🚿' },
];

// Static device metadata (id, name, type, roomId) — state is loaded from API
export const deviceMeta: Omit<Device, 'state'>[] = [
  // ── Sala de Estar ─────────────────────────────────────────────────────────
  { id: '00:04:74:00:01:73:e6:37', roomId: '3478300960', name: 'Luz Sala 1',   type: 'light' },
  { id: '00:04:74:00:01:73:e6:16', roomId: '3478300960', name: 'Luz Sala 2',   type: 'light' },
  { id: '00:04:74:00:01:73:e6:39', roomId: '3478300960', name: 'Luz Sala 3',   type: 'light' },
  { id: '00:04:74:00:01:74:a2:fa', roomId: '3478300960', name: 'Luz Sala 4',   type: 'light' },
  { id: '00:04:74:00:01:74:55:89', roomId: '3478300960', name: 'Luz Sala 5',   type: 'light' },
  { id: '00:04:74:00:01:73:4f:47', roomId: '3478300960', name: 'Luz Sala 6',   type: 'light' },
  { id: '00:04:74:00:01:74:55:59', roomId: '3478300960', name: 'Luz Sala 7',   type: 'light' },
  { id: '00:04:74:00:01:74:55:64', roomId: '3478300960', name: 'Luz Sala 8',   type: 'light' },
  { id: '00:04:74:00:01:72:ef:26', roomId: '3478300960', name: 'Luz Sala 9',   type: 'light' },
  { id: '00:04:74:00:01:79:f2:9a', roomId: '3478300960', name: 'Persiana TV',  type: 'blind' },
  { id: '00:04:74:00:01:79:f2:b2', roomId: '3478300960', name: 'Persiana Sala', type: 'blind' },

  // ── Quarto Master ─────────────────────────────────────────────────────────
  { id: '00:04:74:00:01:73:e6:17', roomId: '902933326', name: 'Luzes Master',       type: 'light' },
  { id: '00:04:74:00:01:73:50:59', roomId: '902933326', name: 'Led Master',          type: 'light' },
  { id: '00:04:74:00:01:79:f2:ac', roomId: '902933326', name: 'Persiana Master',     type: 'blind' },

  // ── Cozinha ───────────────────────────────────────────────────────────────
  { id: '00:04:74:00:01:73:e6:56', roomId: '3818500481', name: 'Luz Cozinha 1',   type: 'light' },
  { id: '00:04:74:00:01:73:e6:5c', roomId: '3818500481', name: 'Luz Cozinha 2',   type: 'light' },
  { id: '00:04:74:00:01:79:f2:91', roomId: '3818500481', name: 'Persiana Cozinha', type: 'blind' },

  // ── Sala de Jantar ────────────────────────────────────────────────────────
  { id: '00:04:74:00:01:73:e6:68', roomId: '4038969737', name: 'Luzes Jantar',    type: 'light' },
  { id: '00:04:74:00:01:79:f2:b6', roomId: '4038969737', name: 'Persiana Jantar', type: 'blind' },

  // ── Quarto Diniz ──────────────────────────────────────────────────────────
  { id: '00:04:74:00:01:72:ef:48', roomId: '536040817', name: 'Luz Diniz',       type: 'light' },
  { id: '00:04:74:00:01:79:f2:b5', roomId: '536040817', name: 'Persiana Diniz',  type: 'blind' },

  // ── Quarto Duarte ─────────────────────────────────────────────────────────
  { id: '00:04:74:00:01:73:66:8a', roomId: '699655279', name: 'Luz Duarte',        type: 'light' },
  { id: '00:04:74:00:01:79:f2:8a', roomId: '699655279', name: 'Persiana Duarte',   type: 'blind' },

  // ── Corredor Quartos ──────────────────────────────────────────────────────
  { id: '00:04:74:00:01:72:ef:49', roomId: '1220347398', name: 'Luz Lobby',    type: 'light' },
  { id: '00:04:74:00:01:74:55:a2', roomId: '1220347398', name: 'Luz Lobby 2',  type: 'light' },

  // ── Casa de Banho Master ──────────────────────────────────────────────────
  { id: '00:04:74:00:01:79:f2:86', roomId: '2311140314', name: 'Persiana WC Master',  type: 'blind' },

  // ── Casa de Banho Miúdos ──────────────────────────────────────────────────
  { id: '00:04:74:00:01:79:f2:93', roomId: '2463279956', name: 'Persiana WC Miúdos', type: 'blind' },
];

// Module types that are dimmable (NLFN)
const DIMMABLE_IDS = new Set([
  '00:04:74:00:01:73:e6:37',
  '00:04:74:00:01:73:e6:16',
  '00:04:74:00:01:73:e6:39',
  '00:04:74:00:01:73:e6:17',
  '00:04:74:00:01:73:e6:56',
  '00:04:74:00:01:73:e6:5c',
  '00:04:74:00:01:73:e6:68',
]);

export function buildDevices(
  statusModules: Array<{ id: string; on?: boolean; current_position?: number }>
): Device[] {
  const statusMap = new Map(statusModules.map(m => [m.id, m]));
  return deviceMeta.map(meta => {
    const s = statusMap.get(meta.id);
    if (meta.type === 'light') {
      return {
        ...meta,
        state: {
          on: s?.on ?? false,
          brightness: 100,
          dimmable: DIMMABLE_IDS.has(meta.id),
        },
      } as Device;
    }
    return {
      ...meta,
      state: {
        position: s?.current_position ?? 0,
        isMoving: false,
        movingDirection: null,
      },
    } as Device;
  });
}
