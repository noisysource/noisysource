import { join } from 'node:path';
import { isEmpty, loadMediaConfig } from './config';
import { createQueue } from './net';
import { createMediaStore } from './store';
import { createTv, type Tv } from './lgtv';
import { createRoomba, type Roomba } from './roomba';
import { createCamera, go2rtcStreams, type Camera } from './tapo';
import type { MediaCommand, MediaState } from './types';

/**
 * The TV, the Roomba and the cameras, on a loop of their own.
 *
 * Nothing here runs inside the Tuya poll: the heating loop never waits for a
 * TV that's off at the wall or a Roomba that takes ten seconds to say hello,
 * and none of these devices counts towards the bridge's "every device failed,
 * restart" rule.
 *
 * Demand-driven only: the devices are read while someone has the Aparelhos
 * screen open (a LAN `GET /media`, or a `{watch: true, scope: 'media'}` relay
 * message from away) and not at all otherwise. A Roomba holds one local client;
 * a TV woken by a poll would be worse than useless.
 */

const POLL_MS = Number(process.env.MEDIA_POLL_MS ?? 30_000);
const WATCH_WINDOW_MS = 120_000;
/** Relay writes, like the Tuya state: only on change, never more often than this. */
const PUBLISH_MIN_GAP_MS = 20_000;
export const MEDIA_STATE_DOC = 'domotics_state/media';
/** One snapshot document per camera, overwritten each time (`domotics_state/snap_<id>`). */
export const snapshotDoc = (camId: string) => `domotics_state/snap_${camId}`;
/** Per camera, so a stuck button can't turn into a stream of Firestore writes. */
const SNAPSHOT_MIN_GAP_MS = 10_000;
/** A hard daily ceiling on relayed snapshots: each is a ~100 kB document write. */
const SNAPSHOTS_PER_DAY = Number(process.env.SNAPSHOTS_PER_DAY ?? 200);

interface Db {
  getDoc(path: string): Promise<Record<string, unknown> | null>;
  setDoc(path: string, data: Record<string, unknown>): Promise<void>;
}

export interface MediaOptions {
  db?: Db;
  /** Publish to Firestore (the bridge's RELAY setting). */
  relay: boolean;
  /** Where the config cache and the TV key live (next to `lib/`). */
  dir: string;
  /** go2rtc as the bridge reaches it, normally http://127.0.0.1:1984. */
  go2rtcLocal: string | null;
  /** go2rtc as a browser on the LAN reaches it, e.g. http://192.168.1.125:1984. */
  liveBase: string | null;
}

type Driver = Tv | Roomba | Camera;

export function createMedia(opts: MediaOptions) {
  const store = createMediaStore(join(opts.dir, 'media-state.json'));
  let tvs: Tv[] = [];
  let roombas: Roomba[] = [];
  let cameras: Camera[] = [];
  const queues = new Map<string, ReturnType<typeof createQueue>>();
  let watchedAt = 0;
  let updatedAt = 0;
  let polling = false;
  let lastFingerprint = '';
  let lastPublishAt = 0;
  const lastSnapshotAt = new Map<string, number>();
  let snapshotDay = '';
  let snapshotsToday = 0;

  const all = (): Driver[] => [...tvs, ...roombas, ...cameras];
  const queue = (id: string) => {
    let q = queues.get(id);
    if (!q) queues.set(id, (q = createQueue()));
    return q;
  };

  function state(): MediaState {
    return {
      tvs: tvs.map(t => t.current()),
      roombas: roombas.map(r => r.current()),
      cameras: cameras.map(c => c.current()),
      liveBase: opts.liveBase,
      updatedAt,
    };
  }

  async function start() {
    const config = await loadMediaConfig(opts.db, join(opts.dir, 'media-cache.json'));
    tvs = config.tvs.map(c => createTv(c, store, opts.dir));
    roombas = config.roombas.map(c => createRoomba(c));
    cameras = config.cameras.map(c => createCamera(c, opts.go2rtcLocal));
    if (isEmpty(config)) {
      console.log('[media] no TV, Roomba or cameras configured (domotics_config/media_devices)');
      return;
    }
    console.log(`[media] ${tvs.length} TV, ${roombas.length} Roomba, ${cameras.length} cameras` +
      (opts.go2rtcLocal ? ` (go2rtc at ${opts.go2rtcLocal})` : ', no go2rtc'));
    void loop();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const streams = await go2rtcStreams(opts.go2rtcLocal);
      // Kinds in parallel (different devices, different ports); each device's own queue serialises it.
      await Promise.all([
        ...tvs.map(t => queue(t.id)(() => t.read())),
        ...roombas.map(r => queue(r.id)(() => r.read())),
        Promise.all(cameras.map(c => c.read(streams))),
      ]);
      updatedAt = Date.now();
      await publish();
    } catch (err) {
      console.warn('[media] poll failed:', (err as Error).message);
    } finally {
      polling = false;
    }
  }

  const isWatched = () => Date.now() - watchedAt < WATCH_WINDOW_MS;

  async function loop() {
    if (isWatched()) await poll();
    setTimeout(() => void loop(), isWatched() ? POLL_MS : 5_000);
  }

  /** Someone is looking. A request for state that's older than a poll gets one straight away. */
  function watch() {
    const wasIdle = !isWatched();
    watchedAt = Date.now();
    if (wasIdle || Date.now() - updatedAt > POLL_MS) void poll();
  }

  async function publish(force = false) {
    if (!opts.relay || !opts.db) return;
    const s = state();
    const { updatedAt: _u, ...rest } = s;
    // lastSeen moves every poll; it doesn't make a change worth a write by itself.
    const fingerprint = JSON.stringify(rest, (k, v) => (k === 'lastSeen' ? undefined : v));
    if (!force && (fingerprint === lastFingerprint || Date.now() - lastPublishAt < PUBLISH_MIN_GAP_MS)) return;
    try {
      await opts.db.setDoc(MEDIA_STATE_DOC, {
        ...s,
        // Tells the app this bridge understands `{watch: true, scope: 'media'}`.
        watchable: true,
        updatedAt: new Date(s.updatedAt || Date.now()),
      });
      lastFingerprint = fingerprint;
      lastPublishAt = Date.now();
    } catch (err) {
      console.warn('[media] publish failed:', (err as Error).message);
    }
  }

  function owns(deviceId: string) {
    return all().some(d => d.id === deviceId);
  }

  async function command(deviceId: string, commands: MediaCommand[]) {
    const d = all().find(x => x.id === deviceId);
    if (!d) throw new Error(`unknown device ${deviceId}`);
    watchedAt = Date.now();
    await queue(d.id)(async () => {
      await d.command(commands);
      console.log(`[media] ${deviceId} <- ${JSON.stringify(commands)}`);
    });
    // Read back what it did, so the answer (and the relay) shows reality, not the guess.
    const streams = d.id.startsWith('cam:') ? await go2rtcStreams(opts.go2rtcLocal) : new Set<string>();
    await queue(d.id)(async () => {
      if (d.id.startsWith('cam:')) await (d as Camera).read(streams);
      else await (d as Tv | Roomba).read();
    });
    updatedAt = Date.now();
    await publish(true);
  }

  function camera(deviceId: string) {
    const c = cameras.find(x => x.id === deviceId);
    if (!c) throw new Error(`unknown camera ${deviceId}`);
    return c;
  }

  /** A JPEG for the LAN (`GET /media/snapshot`). No Firestore, so only the per-camera gap applies. */
  async function snapshot(deviceId: string): Promise<Buffer> {
    const c = camera(deviceId);
    const since = Date.now() - (lastSnapshotAt.get(c.id) ?? 0);
    if (since < 2_000) throw new Error('one snapshot every 2 seconds');
    lastSnapshotAt.set(c.id, Date.now());
    return c.snapshot();
  }

  /** A snapshot for an app away from home: written to `domotics_state/snap_<id>`. */
  async function relaySnapshot(deviceId: string) {
    if (!opts.db || !opts.relay) throw new Error('relay is off');
    const c = camera(deviceId);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== snapshotDay) { snapshotDay = day; snapshotsToday = 0; }
    if (snapshotsToday >= SNAPSHOTS_PER_DAY) throw new Error(`daily snapshot limit reached (${SNAPSHOTS_PER_DAY})`);
    if (Date.now() - (lastSnapshotAt.get(c.id) ?? 0) < SNAPSHOT_MIN_GAP_MS) {
      throw new Error('one snapshot every 10 seconds per camera');
    }
    lastSnapshotAt.set(c.id, Date.now());
    snapshotsToday++;
    const jpeg = await c.snapshot();
    await opts.db.setDoc(snapshotDoc(c.id.slice(4)), {
      image: jpeg.toString('base64'),
      bytes: jpeg.length,
      takenAt: new Date(),
    });
  }

  return {
    start, state, watch, owns, command, snapshot, relaySnapshot,
    hasCameras: () => cameras.length > 0,
  };
}

export type Media = ReturnType<typeof createMedia>;
export { isMediaId } from './types';
