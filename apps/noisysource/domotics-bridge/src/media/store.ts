import { readFileSync, writeFileSync } from 'node:fs';

/**
 * What the bridge learns from the media devices and must keep across restarts:
 * the TV's client key (issued once, when someone accepts the prompt on the TV).
 * Gitignored and 0600, next to `lib/` like the other state files: the key lets
 * anything on the LAN drive the TV.
 */
export interface MediaMemory {
  tvKeys: Record<string, string>;
}

export function createMediaStore(path: string) {
  let memory: MediaMemory = { tvKeys: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<MediaMemory>;
    if (raw && typeof raw.tvKeys === 'object' && raw.tvKeys) memory = { tvKeys: { ...raw.tvKeys } };
  } catch { /* first run */ }

  return {
    tvKey: (id: string): string | undefined => memory.tvKeys[id],
    setTvKey(id: string, key: string | undefined) {
      if (key) memory.tvKeys[id] = key; else delete memory.tvKeys[id];
      try {
        writeFileSync(path, JSON.stringify(memory, null, 2), { mode: 0o600 });
      } catch (err) {
        console.warn(`[media] could not save ${path}:`, (err as Error).message);
      }
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
