/**
 * The house's media and security devices: the LG TV, the Roomba and the Tapo
 * cameras. Kept apart from the Tuya devices on purpose. Those drive the heating
 * and the automation; nothing here may slow a thermostat poll, count towards
 * the "every device failed" restart, or appear in `domotics_state/tuya`, which
 * Atlas reads under a contract (root CLAUDE.md, "Cross-App Data Contracts").
 *
 * Every id the app sends is prefixed with the kind (`tv:sala`, `roomba:r1`,
 * `cam:entrada`), so `/command` can route by id alone and a media id can never
 * collide with a Tuya device id.
 */

export interface TvConfig {
  id: string;
  name: string;
  ip: string;
  /** For Wake-on-LAN. The TV is learned too once paired, but switching it on the first time needs this. */
  mac?: string;
}

export interface RoombaConfig {
  id: string;
  name: string;
  ip: string;
  /** The robot's id, which is also its MQTT user name (deploy/roomba-credentials.js prints it). */
  blid: string;
  password: string;
}

export interface CameraConfig {
  id: string;
  name: string;
  ip: string;
  /** The camera account set in the Tapo app (Camera settings → Advanced → Camera account), not the TP-Link login. */
  username: string;
  password: string;
  /** Pan/tilt models (C200, C210, C225, C500…). The fixed ones (C100, C110, C310…) answer PTZ with an error. */
  ptz?: boolean;
}

export interface MediaConfig {
  tvs: TvConfig[];
  roombas: RoombaConfig[];
  cameras: CameraConfig[];
}

export type TvPower = 'on' | 'standby' | 'screen_off' | 'screen_saver' | 'off' | 'unknown';

export interface TvState {
  id: string;
  name: string;
  /** Answered on its control port. A TV in standby usually doesn't. */
  online: boolean;
  /** Whether the bridge holds a client key. Without one nothing is sent until "Emparelhar". */
  paired: boolean;
  /** The TV is showing the pairing prompt right now; accept it with the remote. */
  prompting: boolean;
  /** Whether Wake-on-LAN is possible (a MAC is configured or was learned). */
  canWake: boolean;
  power: TvPower;
  volume?: number;
  muted?: boolean;
  /** The app or input in front, e.g. `netflix`, `com.webos.app.hdmi1`. */
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
  /** The mission cycle: `none`, `clean`, `spot`, `dock`, `evac`, … */
  cycle?: string;
  binFull?: boolean;
  /** Minutes into the current or last mission. */
  missionMinutes?: number;
  /** iRobot error number, 0 for none. */
  errorCode?: number;
  /** Why a start was refused (e.g. 15 = battery too low); 0 for none. */
  notReady?: number;
  error?: string;
  lastSeen?: number;
}

export interface CameraState {
  id: string;
  name: string;
  /** Answered on RTSP (554). */
  online: boolean;
  ptz: boolean;
  /** go2rtc has a stream for it, so live view and snapshots can work. */
  live: boolean;
  error?: string;
  lastSeen?: number;
}

export interface MediaState {
  tvs: TvState[];
  roombas: RoombaState[];
  cameras: CameraState[];
  /**
   * Base URL of go2rtc for live view, as the browser on the LAN must call it
   * (e.g. `http://192.168.1.125:1984`). Null when not set up.
   */
  liveBase: string | null;
  updatedAt: number;
}

export type MediaCommand = { code: string; value: unknown };

export const MEDIA_PREFIXES = ['tv:', 'roomba:', 'cam:'] as const;

export function isMediaId(deviceId: string): boolean {
  return MEDIA_PREFIXES.some(p => deviceId.startsWith(p));
}
