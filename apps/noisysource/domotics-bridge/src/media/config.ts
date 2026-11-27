import { readFileSync, writeFileSync } from 'node:fs';
import type { CameraConfig, MediaConfig, RoombaConfig, TvConfig } from './types';

/**
 * Where the media devices and their passwords come from.
 *
 * Same arrangement as the Tuya local keys: the sealed Firestore document
 * `domotics_config/media_devices` is authoritative (only the bridge can read
 * it, `firestore.rules`), and a copy on disk keeps the house working when the
 * cloud doesn't. It is written from the Mac by `deploy/sync-media-devices.js`,
 * never from the app, because it holds the cameras' and the Roomba's
 * passwords.
 */

export const MEDIA_CONFIG_DOC = 'domotics_config/media_devices';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

function ip(v: unknown): string | undefined {
  const s = str(v);
  const m = s?.match(IPV4);
  return m && m.slice(1).every(n => Number(n) <= 255) ? s : undefined;
}

/**
 * Keeps only entries that can actually be used, and says why it dropped the
 * rest. A typo in one camera must not take the TV and the Roomba down with it.
 */
export function parseMediaConfig(raw: unknown, warn: (msg: string) => void = () => {}): MediaConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]) : []);
  const seen = new Set<string>();

  const keep = (kind: string, e: Record<string, unknown>, missing: string[]) => {
    const id = str(e.id);
    if (!id || !ID.test(id)) { warn(`[media] ${kind} without a valid id (a-z, 0-9, _ -) skipped`); return false; }
    if (seen.has(`${kind}:${id}`)) { warn(`[media] duplicate ${kind} id "${id}" skipped`); return false; }
    if (missing.length) { warn(`[media] ${kind} "${id}" skipped: missing ${missing.join(', ')}`); return false; }
    seen.add(`${kind}:${id}`);
    return true;
  };

  const tvs: TvConfig[] = [];
  for (const item of list('tvs')) {
    const e = (item ?? {}) as Record<string, unknown>;
    const missing = ip(e.ip) ? [] : ['ip'];
    if (!keep('tv', e, missing)) continue;
    const mac = str(e.mac);
    if (mac && !MAC.test(mac)) warn(`[media] tv "${e.id}": mac "${mac}" ignored (expected aa:bb:cc:dd:ee:ff)`);
    tvs.push({
      id: str(e.id)!, name: str(e.name) ?? 'TV', ip: ip(e.ip)!,
      ...(mac && MAC.test(mac) ? { mac: mac.toLowerCase().replace(/-/g, ':') } : {}),
    });
  }

  const roombas: RoombaConfig[] = [];
  for (const item of list('roombas')) {
    const e = (item ?? {}) as Record<string, unknown>;
    const missing = [!ip(e.ip) && 'ip', !str(e.blid) && 'blid', !str(e.password) && 'password'].filter(Boolean) as string[];
    if (!keep('roomba', e, missing)) continue;
    roombas.push({ id: str(e.id)!, name: str(e.name) ?? 'Roomba', ip: ip(e.ip)!, blid: str(e.blid)!, password: str(e.password)! });
  }

  const cameras: CameraConfig[] = [];
  for (const item of list('cameras')) {
    const e = (item ?? {}) as Record<string, unknown>;
    const missing = [!ip(e.ip) && 'ip', !str(e.username) && 'username', !str(e.password) && 'password'].filter(Boolean) as string[];
    if (!keep('camera', e, missing)) continue;
    cameras.push({
      id: str(e.id)!, name: str(e.name) ?? 'Câmara', ip: ip(e.ip)!,
      username: str(e.username)!, password: str(e.password)!, ptz: e.ptz === true,
    });
  }

  return { tvs, roombas, cameras };
}

export const EMPTY_MEDIA: MediaConfig = { tvs: [], roombas: [], cameras: [] };

export function isEmpty(c: MediaConfig) {
  return c.tvs.length + c.roombas.length + c.cameras.length === 0;
}

interface DocReader { getDoc(path: string): Promise<Record<string, unknown> | null> }

/**
 * Firestore first, disk second, nothing third. Unlike the Tuya list, an empty
 * result is not an error: a house without these devices is a valid house, and
 * the heating must start regardless.
 */
export async function loadMediaConfig(db: DocReader | undefined, cachePath: string): Promise<MediaConfig> {
  const warn = (m: string) => console.warn(m);
  if (db) {
    try {
      const doc = await db.getDoc(MEDIA_CONFIG_DOC);
      if (doc) {
        const config = parseMediaConfig(doc, warn);
        writeFileSync(cachePath, JSON.stringify(config, null, 2), { mode: 0o600 });
        return config;
      }
    } catch (err) {
      console.warn(`[media] config from Firestore failed (${(err as Error).message}), trying the cache`);
    }
  }
  try {
    return parseMediaConfig(JSON.parse(readFileSync(cachePath, 'utf8')), warn);
  } catch {
    return EMPTY_MEDIA;
  }
}
