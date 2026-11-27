import { join } from 'node:path';
import type LGTVType from 'lgtv2';
import { probe, withTimeout } from './net';
import {
  parseTvCommands, readApps, readInputs, readPower, readVolume, type TvAction,
} from './lgtv-logic';
import type { MediaStore } from './store';
import type { MediaCommand, TvConfig, TvState } from './types';

/**
 * LG webOS TV over its local SSAP WebSocket (wss://tv:3001, ws://tv:3000 on
 * older sets), through lgtv2. Wake-on-LAN for switching it on, since a TV in
 * standby doesn't answer on the socket at all.
 *
 * Pairing happens once: the TV shows a prompt, someone accepts it with the
 * remote, and the TV issues a client key that the bridge keeps (store.ts).
 * Until then the bridge never opens the socket by itself, or every poll would
 * put the prompt back on the screen.
 *
 * One connection at a time, opened on demand and closed when nobody has used
 * it for a while: lgtv2's reconnect loop is off, so a TV switched off at the
 * wall costs a failed connect per poll and nothing more.
 */

/**
 * Loaded on first use, not at startup: a house without a TV shouldn't pay for
 * it in the bridge's 140 MB. ESM-only, but since Node 22.12 `require` loads it
 * and returns the constructor (lgtv2's own note).
 */
let lgtv: typeof LGTVType | undefined;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadLgtv = () => (lgtv ??= require('lgtv2') as typeof LGTVType);

const CONNECT_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 6_000;
/** How long the prompt stays answerable before we give up waiting. */
const PAIR_WINDOW_MS = 60_000;
const IDLE_CLOSE_MS = 90_000;
/** Inputs and installed apps barely change; re-read them now and then, not every poll. */
const CATALOGUE_EVERY_MS = 10 * 60_000;
const POINTER_SOCKET = 'ssap://com.webos.service.networkinput/getPointerInputSocket';

const MEDIA_URI: Record<string, string> = {
  play: 'ssap://media.controls/play', pause: 'ssap://media.controls/pause',
  stop: 'ssap://media.controls/stop', rewind: 'ssap://media.controls/rewind',
  fastForward: 'ssap://media.controls/fastForward',
};

export function createTv(config: TvConfig, store: MediaStore, macDir: string) {
  let tv: LGTVType | null = null;
  let pointer: LGTVType.SpecializedSocket | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let prompting = false;
  let lastError: string | undefined;
  let catalogue: { inputs: TvState['inputs']; apps: TvState['apps']; at: number } = { inputs: [], apps: [], at: 0 };
  let last: TvState = {
    id: `tv:${config.id}`, name: config.name, online: false, paired: !!store.tvKey(config.id),
    prompting: false, canWake: !!config.mac, power: 'unknown', inputs: [], apps: [],
  };

  function close() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    try { pointer?.close(); } catch { /* gone */ }
    pointer = null;
    const t = tv;
    tv = null;
    if (t) void t.disconnect().catch(() => {});
  }

  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_CLOSE_MS);
  }

  function open(allowPrompt: boolean): Promise<LGTVType> {
    if (tv?.connected) { touch(); return Promise.resolve(tv); }
    close();
    const key = store.tvKey(config.id);
    if (!key && !allowPrompt) return Promise.reject(new Error('not paired'));

    const LGTV = loadLgtv();
    const t = new LGTV({
      host: config.ip,
      reconnect: false,
      timeout: REQUEST_TIMEOUT_MS,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      clientKey: key,
      saveKey: (k: string, cb: (err?: Error | null) => void) => { store.setTvKey(config.id, k); cb(null); },
      ...(config.mac ? { mac: config.mac } : {}),
      macFile: join(macDir, `tv-${config.id}.mac.json`),
    });
    tv = t;

    return new Promise<LGTVType>((resolve, reject) => {
      // With a key the TV answers in a second; without one, a person has to walk to the remote.
      const timer = setTimeout(() => {
        const wasPrompting = prompting;
        cleanup();
        prompting = false;
        if (tv === t) close();
        reject(new Error(wasPrompting ? 'pairing not accepted on the TV in time' : 'TV did not answer'));
      }, key ? CONNECT_TIMEOUT_MS : PAIR_WINDOW_MS);
      const onConnect = () => { cleanup(); prompting = false; touch(); resolve(t); };
      const onPrompt = () => { prompting = true; };
      const onError = (err: Error) => {
        // A rejected key: the TV was reset or the pairing revoked. Forget it, so "Emparelhar" starts over.
        if (/denied|cancel|401|unauthor/i.test(err.message) && key) store.setTvKey(config.id, undefined);
        cleanup(); prompting = false; if (tv === t) close(); reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        t.removeListener('connect', onConnect);
        t.removeListener('prompt', onPrompt);
        t.removeListener('error', onError);
      };
      t.on('connect', onConnect);
      t.on('prompt', onPrompt);
      t.on('error', onError);
      // Errors after connecting (the TV switched off mid-session) must never be fatal.
      t.on('error', () => {});
      t.on('close', () => { if (tv === t) { tv = null; pointer = null; } });
    });
  }

  const ask = <T = unknown>(t: LGTVType, uri: string, payload?: Record<string, unknown>) =>
    withTimeout(t.request<T>(uri, payload ?? {}), REQUEST_TIMEOUT_MS + 1000, uri);

  async function read(): Promise<TvState> {
    const paired = !!store.tvKey(config.id);
    const canWake = !!(config.mac || tv?.mac || last.canWake);
    const base = { ...last, paired, prompting, canWake };
    if (!paired) {
      // Not paired: only say whether it's there. Opening the socket would show the prompt.
      const online = await probe(config.ip, 3001) || await probe(config.ip, 3000);
      last = { ...base, online, power: online ? 'on' : 'off', error: lastError };
      return last;
    }
    try {
      const t = await open(false);
      const power = await t.getPowerState().then(r => r.state as string, () => undefined);
      const vol = readVolume(await ask(t, 'ssap://audio/getVolume').catch(() => undefined));
      const fg = await ask<{ appId?: string }>(t, 'ssap://com.webos.applicationManager/getForegroundAppInfo')
        .catch(() => undefined);
      if (Date.now() - catalogue.at > CATALOGUE_EVERY_MS) {
        const inputs = readInputs(await ask(t, 'ssap://tv/getExternalInputList').catch(() => undefined));
        const apps = readApps(await ask(t, 'ssap://com.webos.applicationManager/listLaunchPoints').catch(() => undefined));
        if (inputs.length || apps.length) catalogue = { inputs, apps, at: Date.now() };
      }
      lastError = undefined;
      last = {
        ...base, online: true, canWake: !!(config.mac || t.mac), power: readPower(power, true),
        volume: vol.volume, muted: vol.muted, appId: fg?.appId || undefined,
        inputs: catalogue.inputs, apps: catalogue.apps, error: undefined, lastSeen: Date.now(),
      };
    } catch (err) {
      // Switched off (or at the wall): the normal case most of the day, not an error worth showing.
      last = { ...base, online: false, power: 'off', prompting, error: lastError };
      if (!/did not answer|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timed out|not paired/i.test((err as Error).message)) {
        console.warn(`[tv] ${config.name}:`, (err as Error).message);
      }
    }
    return last;
  }

  async function wake() {
    const macs = config.mac ? [config.mac] : [tv?.mac, ...Object.values(tv?.macs ?? {})].filter(Boolean) as string[];
    if (macs.length === 0) {
      throw new Error('no MAC address for Wake-on-LAN: add "mac" to the TV in media-devices.json');
    }
    // To the subnet's broadcast too: some routers drop 255.255.255.255.
    const subnet = config.ip.replace(/\.\d+$/, '.255');
    const LGTV = loadLgtv();
    await LGTV.wake(macs);
    await LGTV.wake(macs, { address: subnet });
  }

  async function run(action: TvAction) {
    switch (action.kind) {
      case 'pair':
        lastError = undefined;
        // Answered straight away; the prompt waits on the TV for up to a minute.
        void open(true).catch(err => { lastError = `Emparelhamento: ${(err as Error).message}`; });
        return;
      case 'unpair':
        store.setTvKey(config.id, undefined);
        close();
        return;
      case 'power':
        if (action.on) {
          if (tv?.connected) return;
          await wake();
          return;
        }
        await ask(await open(false), 'ssap://system/turnOff');
        close();
        return;
      default:
        break;
    }
    const t = await open(false);
    switch (action.kind) {
      case 'volume': await ask(t, 'ssap://audio/setVolume', { volume: action.level }); break;
      case 'volumeStep': await ask(t, action.up ? 'ssap://audio/volumeUp' : 'ssap://audio/volumeDown'); break;
      case 'mute': await ask(t, 'ssap://audio/setMute', { mute: action.mute }); break;
      case 'input': await ask(t, 'ssap://tv/switchInput', { inputId: action.inputId }); break;
      case 'app': await ask(t, 'ssap://system.launcher/launch', { id: action.appId }); break;
      case 'channelStep': await ask(t, action.up ? 'ssap://tv/channelUp' : 'ssap://tv/channelDown'); break;
      case 'media': await ask(t, MEDIA_URI[action.action]); break;
      case 'button': {
        if (!pointer) pointer = await withTimeout(t.getSocket(POINTER_SOCKET), REQUEST_TIMEOUT_MS, 'pointer socket');
        pointer.send('button', { name: action.name });
        break;
      }
    }
  }

  async function command(commands: MediaCommand[]) {
    const actions = parseTvCommands(commands);
    if (actions.length === 0) throw new Error('no TV command understood');
    for (const a of actions) await run(a);
  }

  return { id: `tv:${config.id}`, read, command, close, current: () => ({ ...last, prompting }) };
}

export type Tv = ReturnType<typeof createTv>;
