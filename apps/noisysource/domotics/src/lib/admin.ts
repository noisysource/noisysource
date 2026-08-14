import {
  addDoc, collection, deleteDoc, doc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';

/**
 * Remote administration of the bridge.
 *
 * The Pi accepts no inbound connection — that is what lets it work behind NAT
 * without port forwarding — so there is no way to reach it from outside the
 * house. Instead a request is left in Firestore, the bridge picks it up on its
 * next poll and writes the answer back onto the same document.
 *
 * That makes this slower than a shell: expect a few seconds, bounded by the
 * bridge's poll interval. It is not a terminal and is not meant to be. The set
 * of actions is fixed on the bridge; nothing typed here reaches a shell.
 */

export const ADMIN_ACTIONS = ['status', 'logs', 'refresh', 'restart'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** Generous, because the bridge polls every 10s and a Pi 1 is not quick. */
const TIMEOUT_MS = 45_000;

export interface AdminOutcome {
  ok: boolean;
  output: string;
}

export async function runAdmin(
  action: AdminAction,
  args: { lines?: number } = {},
): Promise<AdminOutcome> {
  const ref = await addDoc(collection(db, 'domotics_admin'), {
    action,
    ...(args.lines === undefined ? {} : { lines: args.lines }),
    createdAt: serverTimestamp(),
  });

  try {
    return await new Promise<AdminOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        // Distinguishing this from a failed action matters: it usually means
        // the bridge is not running at all, which is the single most useful
        // thing to know from a thousand miles away.
        reject(new Error(
          'No answer from the bridge. It may be offline — check when the house '
          + 'state was last published.',
        ));
      }, TIMEOUT_MS);

      const stop = onSnapshot(doc(db, 'domotics_admin', ref.id), snap => {
        const data = snap.data();
        if (!data) return;
        if (data.result === undefined && data.error === undefined) return;
        clearTimeout(timer);
        stop();
        resolve(data.error !== undefined
          ? { ok: false, output: String(data.error) }
          : { ok: true, output: String(data.result) });
      }, err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    // The bridge sweeps answered requests eventually, but clearing up straight
    // away keeps the collection empty and the polling cheap.
    void deleteDoc(doc(db, 'domotics_admin', ref.id)).catch(() => {});
  }
}
