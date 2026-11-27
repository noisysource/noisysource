import { Socket } from 'node:net';

/** Whether something answers on `port` within `timeoutMs`. Used as the cheap "is it there" check. */
export function probe(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise(resolve => {
    const s = new Socket();
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.connect(port, host);
  });
}

/** Bound on any promise we don't fully trust to settle (see CALL_TIMEOUT_MS in ../tuya.ts for why). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Runs tasks one at a time. These devices take one control connection at a time. */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
