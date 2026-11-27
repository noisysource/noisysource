/**
 * The TV, the Roomba and the cameras as the bridge reports them
 * (domotics-bridge/src/media/types.ts, same shapes: keep them in step), and
 * the words the app shows for them.
 */

export type TvPower = 'on' | 'standby' | 'screen_off' | 'screen_saver' | 'off' | 'unknown';

export interface TvState {
  id: string;
  name: string;
  online: boolean;
  paired: boolean;
  prompting: boolean;
  canWake: boolean;
  power: TvPower;
  volume?: number;
  muted?: boolean;
  appId?: string;
  inputs: Array<{ id: string; label: string }>;
  apps: Array<{ id: string; title: string }>;
  error?: string;
  lastSeen?: number;
}

export type RoombaPhase =
  | 'charge' | 'run' | 'pause' | 'stop' | 'stuck' | 'hmUsrDock' | 'hmMidMsn' | 'hmPostMsn'
  | 'evac' | 'chargingerror' | 'unknown';

export interface RoombaState {
  id: string;
  name: string;
  online: boolean;
  battery?: number;
  phase: RoombaPhase;
  cycle?: string;
  binFull?: boolean;
  missionMinutes?: number;
  errorCode?: number;
  notReady?: number;
  error?: string;
  lastSeen?: number;
}

export interface CameraState {
  id: string;
  name: string;
  online: boolean;
  ptz: boolean;
  live: boolean;
  error?: string;
  lastSeen?: number;
}

export interface MediaState {
  tvs: TvState[];
  roombas: RoombaState[];
  cameras: CameraState[];
  liveBase: string | null;
  updatedAt: number;
}

export const ROOMBA_PHASE: Record<RoombaPhase, string> = {
  charge: 'Na base', run: 'A aspirar', pause: 'Em pausa', stop: 'Parado', stuck: 'Preso',
  hmUsrDock: 'A voltar à base', hmMidMsn: 'A voltar à base para carregar', hmPostMsn: 'A voltar à base (terminou)',
  evac: 'A esvaziar o depósito', chargingerror: 'Erro ao carregar', unknown: '—',
};

/** What the robot can be asked to do next, given what it's doing. */
export function roombaActions(r: RoombaState): Array<{ action: string; label: string }> {
  switch (r.phase) {
    case 'run':
      return [{ action: 'pause', label: 'Pausar' }, { action: 'dock', label: 'Voltar à base' }];
    case 'pause': case 'stop': case 'stuck':
      return [{ action: 'resume', label: 'Retomar' }, { action: 'dock', label: 'Voltar à base' }, { action: 'find', label: 'Tocar' }];
    case 'hmUsrDock': case 'hmMidMsn': case 'hmPostMsn':
      return [{ action: 'stop', label: 'Parar' }];
    default:
      return [{ action: 'start', label: 'Aspirar' }, { action: 'find', label: 'Tocar' }];
  }
}

export function tvPowerLabel(t: TvState): string {
  if (!t.online) return 'Desligado';
  switch (t.power) {
    case 'on': return 'Ligado';
    case 'screen_off': return 'Ecrã desligado';
    case 'screen_saver': return 'Proteção de ecrã';
    case 'standby': return 'Em espera';
    default: return 'Ligado';
  }
}

export const isTvOn = (t: TvState) => t.online && (t.power === 'on' || t.power === 'screen_saver' || t.power === 'screen_off');

/** For `?demo`: one of each, plausible. */
export function demoMedia(): MediaState {
  return {
    tvs: [{
      id: 'tv:sala', name: 'TV da sala', online: true, paired: true, prompting: false, canWake: true,
      power: 'on', volume: 14, muted: false, appId: 'netflix',
      inputs: [{ id: 'HDMI_1', label: 'PlayStation' }, { id: 'HDMI_2', label: 'Box MEO' }],
      apps: [{ id: 'netflix', title: 'Netflix' }, { id: 'youtube.leanback.v4', title: 'YouTube' },
        { id: 'com.disney.disneyplus-prod', title: 'Disney+' }, { id: 'spotify-beehive', title: 'Spotify' }],
    }],
    roombas: [{ id: 'roomba:roomba', name: 'Roomba', online: true, battery: 82, phase: 'charge', cycle: 'none', binFull: false, missionMinutes: 0, errorCode: 0, notReady: 0 }],
    cameras: [
      { id: 'cam:entrada', name: 'Entrada', online: true, ptz: true, live: true },
      { id: 'cam:quintal', name: 'Quintal', online: false, ptz: false, live: false, error: 'sem resposta na rede' },
    ],
    liveBase: null,
    updatedAt: Date.now(),
  };
}
