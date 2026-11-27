import { addDoc, collection, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { BRIDGE_BASE, bridgeRequest, directPath } from './bridge';
import type { MediaState } from '../data/mediaData';

/**
 * The TV, the Roomba and the cameras, through the bridge: directly on the LAN
 * (`GET /media`, `POST /command`), through the Firestore relay away from home
 * (`domotics_state/media`, `domotics_commands`). Same rules as lib/bridge.ts.
 *
 * The bridge reads these devices only while someone is asking, so the screen
 * that shows them is what keeps them fresh: `fetchMediaState` on the LAN, and
 * `announceMediaWatching` away from home.
 */

const RELAY_MAX_AGE_MS = 15 * 60_000;
let relayWatchable = false;

export type MediaSource = 'direct' | 'relay';

export async function fetchMediaState(): Promise<{ state: MediaState; source: MediaSource } | null> {
  if (directPath.works()) {
    try {
      return { state: await bridgeRequest('/media') as MediaState, source: 'direct' };
    } catch {
      directPath.set(false);
    }
  }
  try {
    const snap = await getDoc(doc(db, 'domotics_state', 'media'));
    if (snap.exists()) {
      const data = snap.data() as Omit<MediaState, 'updatedAt'> & { updatedAt?: { toMillis(): number }; watchable?: boolean };
      relayWatchable = data.watchable === true;
      const updatedAt = data.updatedAt?.toMillis?.() ?? 0;
      if (Date.now() - updatedAt <= RELAY_MAX_AGE_MS) {
        return { state: { ...data, updatedAt }, source: 'relay' };
      }
      // Old: the bridge only publishes while watched. Ask, and show it meanwhile.
      void announceMediaWatching(true);
      return { state: { ...data, updatedAt }, source: 'relay' };
    }
  } catch { /* signed out, or offline */ }
  if (directPath.enabled) {
    // Back on the home network, perhaps.
    try {
      const state = await bridgeRequest('/media') as MediaState;
      directPath.set(true);
      return { state, source: 'direct' };
    } catch { /* really unreachable */ }
  }
  return null;
}

/** Direct: the fresh state comes back. Relay: null, the bridge picks it up within ~10 s. */
export async function sendMediaCommand(
  deviceId: string,
  commands: Array<{ code: string; value: unknown }>,
): Promise<MediaState | null> {
  if (directPath.works()) {
    try {
      const r = await bridgeRequest('/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, commands }),
      }) as { media?: MediaState };
      return r.media ?? null;
    } catch {
      directPath.set(false);
    }
  }
  await addDoc(collection(db, 'domotics_commands'), { deviceId, commands, createdAt: serverTimestamp() });
  return null;
}

const WATCH_EVERY_MS = 90_000;
let lastWatchAt = 0;

/** Away from home: tell the bridge the Aparelhos screen is open, so it reads the devices. */
export async function announceMediaWatching(force = false) {
  if (directPath.works()) return;
  if (!force && (!relayWatchable || Date.now() - lastWatchAt < WATCH_EVERY_MS)) return;
  if (force && Date.now() - lastWatchAt < 20_000) return;
  lastWatchAt = Date.now();
  try {
    await addDoc(collection(db, 'domotics_commands'), { watch: true, scope: 'media', createdAt: serverTimestamp() });
  } catch { /* signed out or offline */ }
}

/** On the LAN: an image URL straight from the bridge, fresh each call. */
export function lanSnapshotUrl(cameraId: string) {
  return `${BRIDGE_BASE}/media/snapshot?id=${encodeURIComponent(cameraId)}&t=${Date.now()}`;
}

/**
 * Away from home: ask the bridge for a snapshot and wait for it to land in
 * `domotics_state/snap_<id>`. One read every 2.5 s, 16 at most.
 */
export async function relaySnapshot(cameraId: string): Promise<string> {
  const id = cameraId.replace(/^cam:/, '');
  const ref = doc(db, 'domotics_state', `snap_${id}`);
  const before = await getDoc(ref).then(s => (s.data()?.takenAt as { toMillis(): number } | undefined)?.toMillis?.() ?? 0, () => 0);
  await addDoc(collection(db, 'domotics_commands'), {
    deviceId: cameraId, commands: [{ code: 'snapshot', value: true }], createdAt: serverTimestamp(),
  });
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const s = await getDoc(ref).catch(() => null);
    const data = s?.data() as { image?: string; takenAt?: { toMillis(): number } } | undefined;
    const at = data?.takenAt?.toMillis?.() ?? 0;
    if (data?.image && at > before) return `data:image/jpeg;base64,${data.image}`;
  }
  throw new Error('A câmara não respondeu a tempo.');
}

/** Live view needs go2rtc and a page the browser lets call http:// on the LAN. */
export function liveUrl(state: MediaState, cameraId: string): string | null {
  if (!state.liveBase || !directPath.works() || window.location.protocol === 'https:') return null;
  const src = `cam_${cameraId.replace(/^cam:/, '')}_sd`;
  return `${state.liveBase}/stream.html?src=${encodeURIComponent(src)}&mode=mse,webrtc`;
}
