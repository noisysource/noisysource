import TuyAPI from 'tuyapi';
import { dpsToStatus } from './dpmap';

/** Tuya datapoints only ever carry these; tuyapi's `set` rejects anything wider. */
export type DpValue = string | number | boolean;

export interface DeviceConfig {
  id: string;
  name: string;
  category: string;
  localKey: string;
  ip: string;
  version: string;
}

export interface DeviceState {
  id: string;
  name: string;
  category: string;
  online: boolean;
  status: Array<{ code: string; value: unknown }>;
  /** When `status` was last read successfully. Set while a device is offline. */
  lastSeen?: number;
}

/**
 * Tuya devices accept only a couple of concurrent local connections and
 * regularly refuse one outright — errors 901/905 were seen repeatedly during
 * the spike, with the same device succeeding on a later attempt. Retrying is
 * therefore normal operation, not exception handling.
 */
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 2500;

/**
 * Bound on every individual tuyapi call, enforced by us rather than trusted to
 * the library.
 *
 * Found the hard way: the bridge ran for 27 days with the process alive,
 * answering HTTP, CPU essentially idle — and had completed zero polls, because
 * one `await device.connect()` never settled. No socket was open by then
 * either, so the underlying connection was already gone; only the promise
 * wrapping it was still pending. tuyapi is documented (see openDevice below)
 * to report some failures via an `error` event rather than a rejection, and
 * this is what that gap costs when it actually happens: not a fast failure,
 * an infinite one, with nothing downstream ever finding out.
 */
const CALL_TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${CALL_TIMEOUT_MS}ms`)),
      CALL_TIMEOUT_MS,
    );
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Build a device with an `error` listener already attached.
 *
 * tuyapi reports socket failures by emitting `error` on the device, not by
 * rejecting the promise you are awaiting — a timeout fires asynchronously, well
 * outside the try/catch around `connect()`. An EventEmitter with no `error`
 * listener is fatal in Node, so without this the whole bridge dies the first
 * time a device is slow. These devices are slow often; this killed the process
 * after seven polls in testing.
 *
 * The listener is intentionally near-silent: the retry path already reports
 * what matters, and logging every transient socket blip would bury real news.
 */
function openDevice(config: DeviceConfig): TuyAPI {
  const device = new TuyAPI({
    id: config.id,
    key: config.localKey,
    ip: config.ip,
    version: config.version,
    issueGetOnConnect: false,
  });
  device.on('error', () => { /* handled by the retry logic below */ });
  return device;
}

async function readOnce(config: DeviceConfig): Promise<Record<string, unknown>> {
  const device = openDevice(config);
  try {
    await withTimeout(device.connect(), `${config.name} connect`);
    const data = await withTimeout(device.get({ schema: true }), `${config.name} get`);
    const dps = (data as { dps?: Record<string, unknown> })?.dps;
    if (!dps) throw new Error('no dps in response');
    return dps;
  } finally {
    // Always hang up: a leaked socket consumes one of the device's few slots
    // and makes the *next* poll fail.
    try { device.disconnect(); } catch { /* already gone */ }
  }
}

export async function readDevice(config: DeviceConfig): Promise<DeviceState> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const dps = await readOnce(config);
      return {
        id: config.id,
        name: config.name,
        category: config.category,
        online: true,
        status: dpsToStatus(config.category, dps),
      };
    } catch (err) {
      if (attempt === ATTEMPTS) {
        console.warn(`[tuya] ${config.name}: unreachable after ${ATTEMPTS} attempts —`,
          (err as Error).message);
        break;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  return {
    id: config.id,
    name: config.name,
    category: config.category,
    online: false,
    status: [],
  };
}

/**
 * Read every device. Sequential on purpose — hitting seven devices at once
 * competes for the same scarce connection slots and measurably increases the
 * failure rate.
 */
export async function readAll(configs: DeviceConfig[]): Promise<DeviceState[]> {
  const out: DeviceState[] = [];
  for (const config of configs) out.push(await readDevice(config));
  return out;
}

export async function sendCommands(
  config: DeviceConfig,
  dps: Record<string, DpValue>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const device = openDevice(config);
    try {
      await withTimeout(device.connect(), `${config.name} connect`);
      await withTimeout(device.set({ multiple: true, data: dps }), `${config.name} set`);
      return;
    } catch (err) {
      lastError = err;
      await sleep(RETRY_DELAY_MS);
    } finally {
      try { device.disconnect(); } catch { /* already gone */ }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
