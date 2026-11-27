import { constants } from 'node:crypto';
import type { IClientOptions, MqttClient } from 'mqtt';

/** Loaded on first use, like lgtv2: no Roomba, no MQTT library in memory. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadMqtt = () => require('mqtt') as typeof import('mqtt');
import { withTimeout } from './net';
import { commandPayload, isComplete, mergeReported, parseRoombaCommands, readRoomba } from './roomba-logic';
import type { MediaCommand, RoombaConfig, RoombaState } from './types';

/**
 * iRobot Roomba over its local MQTT broker (TLS, port 8883), the same API
 * dorita980 uses. Credentials are the robot's BLID and a password it only
 * hands out while its HOME button is held (deploy/roomba-credentials.js).
 *
 * The robot takes exactly one local client. While the bridge is connected the
 * iRobot app can't use its local path (it falls back to the cloud, so it keeps
 * working, a little slower), so the bridge connects to read or command, then
 * hangs up. That also keeps the robot's single slot free when nobody is
 * looking at the app.
 */

const CONNECT_TIMEOUT_MS = 10_000;
/** How long to collect shadow pieces after connecting. The robot sends them all within a second or two. */
const COLLECT_MS = 4_000;

function options(config: RoombaConfig): IClientOptions {
  // mqtt hands its options to tls.connect as they are, TLS ones included; its types just don't list them.
  const tls = {
    // The robot's TLS predates OpenSSL 3's defaults (dorita980: AES128-SHA256 and legacy renegotiation).
    ciphers: process.env.ROOMBA_CIPHERS ?? 'AES128-SHA256:DEFAULT:@SECLEVEL=0',
    secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  };
  return {
    ...tls,
    port: 8883,
    protocol: 'mqtts',
    clientId: config.blid,
    username: config.blid,
    password: config.password,
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: false,
    rejectUnauthorized: false,
    reconnectPeriod: 0,
    connectTimeout: CONNECT_TIMEOUT_MS,
    keepalive: 30,
  } as IClientOptions;
}

function open(config: RoombaConfig): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = loadMqtt().connect(`mqtts://${config.ip}`, options(config));
    const timer = setTimeout(() => { client.end(true); reject(new Error('Roomba did not answer')); }, CONNECT_TIMEOUT_MS + 1000);
    client.once('connect', () => { clearTimeout(timer); resolve(client); });
    client.once('error', err => { clearTimeout(timer); client.end(true); reject(err); });
    // Later errors (the robot hanging up) are expected and handled by whoever is waiting.
    client.on('error', () => {});
  });
}

const hangUp = (c: MqttClient) => new Promise<void>(r => c.end(false, {}, () => r()));

export function createRoomba(config: RoombaConfig) {
  const base = { id: `roomba:${config.id}`, name: config.name };
  let last: RoombaState = { ...base, online: false, phase: 'unknown' };
  /** Everything the robot has reported so far: a short session may only carry part of it. */
  const lastReported: Record<string, unknown> = {};

  /** Connect, gather what the robot reports for a few seconds, optionally send something, hang up. */
  async function session(publish?: string): Promise<RoombaState> {
    const client = await open(config);
    const reported: Record<string, unknown> = {};
    try {
      client.on('message', (_topic, payload) => mergeReported(reported, payload));
      // Older firmware only pushes to subscribers; newer pushes regardless. Subscribing costs nothing.
      client.subscribe('#', () => {});
      if (publish) {
        await withTimeout(new Promise<void>((res, rej) =>
          client.publish('cmd', publish, { qos: 0 }, err => (err ? rej(err) : res()))), 5_000, 'Roomba publish');
      }
      const until = Date.now() + COLLECT_MS;
      while (Date.now() < until && !(isComplete(reported) && !publish)) {
        await new Promise(r => setTimeout(r, 250));
      }
      return isComplete(reported) || Object.keys(reported).length > 0
        ? readRoomba(base, { ...lastReported, ...reported })
        : { ...last, online: true, lastSeen: Date.now() };
    } finally {
      Object.assign(lastReported, reported);
      await withTimeout(hangUp(client), 3_000, 'Roomba hang up').catch(() => client.end(true));
    }
  }

  async function read(): Promise<RoombaState> {
    try {
      last = await session();
    } catch (err) {
      last = { ...last, online: false, error: (err as Error).message };
    }
    return last;
  }

  async function command(commands: MediaCommand[]) {
    const actions = parseRoombaCommands(commands);
    if (actions.length === 0) throw new Error('no Roomba command understood');
    // One at a time; the last state read is what the app sees next.
    for (const a of actions) last = await session(commandPayload(a));
  }

  return { id: base.id, read, command, close: () => {}, current: () => last };
}

export type Roomba = ReturnType<typeof createRoomba>;
