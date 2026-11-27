import type { MediaCommand, TvPower } from './types';

/**
 * The pure half of the TV driver: what the app may ask for, and how the TV's
 * answers are read. Kept apart so the tests don't need a TV.
 */

export const TV_BUTTONS = [
  'HOME', 'BACK', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'MENU', 'INFO', 'EXIT',
] as const;
export const TV_MEDIA = ['play', 'pause', 'stop', 'rewind', 'fastForward'] as const;

export type TvAction =
  | { kind: 'power'; on: boolean }
  | { kind: 'volume'; level: number }
  | { kind: 'volumeStep'; up: boolean }
  | { kind: 'mute'; mute: boolean }
  | { kind: 'input'; inputId: string }
  | { kind: 'app'; appId: string }
  | { kind: 'channelStep'; up: boolean }
  | { kind: 'media'; action: typeof TV_MEDIA[number] }
  | { kind: 'button'; name: typeof TV_BUTTONS[number] }
  | { kind: 'pair' }
  | { kind: 'unpair' };

/** webOS ids are dotted names (`com.webos.app.hdmi1`, `netflix`, `HDMI_1`). Nothing else is passed on. */
const WEBOS_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** Translates `{code, value}` into actions, dropping anything not understood. */
export function parseTvCommands(commands: MediaCommand[]): TvAction[] {
  const out: TvAction[] = [];
  for (const { code, value } of commands) {
    switch (code) {
      case 'power': if (typeof value === 'boolean') out.push({ kind: 'power', on: value }); break;
      case 'volume':
        if (typeof value === 'number' && Number.isFinite(value)) {
          out.push({ kind: 'volume', level: Math.max(0, Math.min(100, Math.round(value))) });
        }
        break;
      case 'volume_step': if (value === 'up' || value === 'down') out.push({ kind: 'volumeStep', up: value === 'up' }); break;
      case 'mute': if (typeof value === 'boolean') out.push({ kind: 'mute', mute: value }); break;
      case 'input': if (typeof value === 'string' && WEBOS_ID.test(value)) out.push({ kind: 'input', inputId: value }); break;
      case 'app': if (typeof value === 'string' && WEBOS_ID.test(value)) out.push({ kind: 'app', appId: value }); break;
      case 'channel_step': if (value === 'up' || value === 'down') out.push({ kind: 'channelStep', up: value === 'up' }); break;
      case 'media':
        if ((TV_MEDIA as readonly unknown[]).includes(value)) out.push({ kind: 'media', action: value as TvAction & never });
        break;
      case 'button':
        if ((TV_BUTTONS as readonly unknown[]).includes(value)) out.push({ kind: 'button', name: value as TvAction & never });
        break;
      case 'pair': if (value === true) out.push({ kind: 'pair' }); break;
      case 'unpair': if (value === true) out.push({ kind: 'unpair' }); break;
    }
  }
  return out;
}

/**
 * `ssap://audio/getVolume` changed shape over the years: older webOS answers
 * `{volume, muted}`, 2022+ `{volumeStatus: {volume, muteStatus}}`.
 */
export function readVolume(res: unknown): { volume?: number; muted?: boolean } {
  const r = (res ?? {}) as Record<string, unknown>;
  const vs = (r.volumeStatus ?? {}) as Record<string, unknown>;
  const volume = typeof vs.volume === 'number' ? vs.volume : typeof r.volume === 'number' ? r.volume : undefined;
  const muted = typeof vs.muteStatus === 'boolean' ? vs.muteStatus : typeof r.muted === 'boolean' ? r.muted
    : typeof r.mute === 'boolean' ? r.mute : undefined;
  return { volume, muted };
}

export function readInputs(res: unknown): Array<{ id: string; label: string }> {
  const devices = ((res ?? {}) as { devices?: unknown[] }).devices;
  if (!Array.isArray(devices)) return [];
  return devices.flatMap(d => {
    const e = (d ?? {}) as Record<string, unknown>;
    return typeof e.id === 'string' ? [{ id: e.id, label: typeof e.label === 'string' ? e.label : e.id }] : [];
  });
}

/**
 * The launcher lists everything installed, settings screens included. The
 * app gets the visible ones, ordered as on the TV's own launcher, capped so
 * the published state stays small.
 */
export function readApps(res: unknown, max = 24): Array<{ id: string; title: string }> {
  const points = ((res ?? {}) as { launchPoints?: unknown[] }).launchPoints;
  if (!Array.isArray(points)) return [];
  return points.flatMap(p => {
    const e = (p ?? {}) as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.visible === false) return [];
    return [{ id: e.id, title: typeof e.title === 'string' ? e.title : e.id }];
  }).slice(0, max);
}

const POWER: Record<string, TvPower> = {
  Active: 'on', 'Active Standby': 'standby', Suspend: 'off', 'Screen Off': 'screen_off',
  'Screen Saver': 'screen_saver', 'Power Off': 'off',
};

export function readPower(state: unknown, connected: boolean): TvPower {
  if (typeof state === 'string' && POWER[state]) return POWER[state];
  // lgtv2 hands it over already mapped.
  if (typeof state === 'string' && ['on', 'standby', 'screen_off', 'screen_saver', 'off'].includes(state)) {
    return state as TvPower;
  }
  // Older webOS has no power service: answering at all means on.
  return connected ? 'on' : 'off';
}
