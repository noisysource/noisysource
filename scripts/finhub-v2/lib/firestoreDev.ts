// Firestore REST on kidclub-dev ONLY, for the FinHub v2 dev scripts. Auth is the caller's gcloud
// session (`gcloud auth print-access-token`), the same way scripts/copy-prod-billing-to-dev.mjs
// (#94) writes to dev; IAM, not security rules, decides. Every function here refuses any project
// but kidclub-dev and any path outside finhub/noisysource/events. No retries: one call per batch.

import { execSync } from 'node:child_process';

export const DEV_PROJECT = 'kidclub-dev';
const API = 'https://firestore.googleapis.com/v1';
const DOCS = `projects/${DEV_PROJECT}/databases/(default)/documents`;
export const EVENTS_PREFIX = `${DOCS}/finhub/noisysource/events/`;

/** Exits unless the project asked for is kidclub-dev. Call before anything else. */
export function requireDevProject(args: string[]): void {
  const i = args.indexOf('--project');
  const asked = i >= 0 ? args[i + 1] : DEV_PROJECT;
  if (asked !== DEV_PROJECT) {
    console.error(`Refusing: this script only ever touches ${DEV_PROJECT} (asked: ${asked}).`);
    process.exit(1);
  }
}

let token: string | null = null;
function auth(): string {
  token ??= execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  return token;
}

async function call(method: string, url: string, body?: unknown): Promise<any> {
  if (!url.startsWith(`${API}/${DOCS}`)) throw new Error(`Refusing a call outside ${DEV_PROJECT}: ${url}`);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${auth()}`, 'x-goog-user-project': DEV_PROJECT, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${DEV_PROJECT}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Ids of every doc in finhub/noisysource/events. */
export async function listEventIds(): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  for (let i = 0; i < 100; i++) {
    const url = `${API}/${EVENTS_PREFIX.slice(0, -1)}?pageSize=300&mask.fieldPaths=id${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = await call('GET', url);
    for (const d of r.documents ?? []) ids.push(String(d.name).slice(EVENTS_PREFIX.length));
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return ids;
}

/** Every doc in finhub/noisysource/events, as plain JSON (recordedAt as an ISO string). */
export async function listEvents(): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let pageToken = '';
  for (let i = 0; i < 100; i++) {
    const url = `${API}/${EVENTS_PREFIX.slice(0, -1)}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const r = await call('GET', url);
    for (const d of r.documents ?? []) {
      const doc = fromFields(d.fields ?? {});
      out.push({ ...doc, id: doc.id ?? String(d.name).slice(EVENTS_PREFIX.length) });
    }
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  return out;
}

function fromValue(v: FsValue): unknown {
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return new Date(String(v.timestampValue)).toISOString();
  if ('arrayValue' in v) return ((v.arrayValue as { values?: FsValue[] }).values ?? []).map(fromValue);
  if ('mapValue' in v) return fromFields((v.mapValue as { fields?: Record<string, FsValue> }).fields ?? {});
  throw new Error(`unsupported Firestore value: ${Object.keys(v).join(',')}`);
}
function fromFields(f: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) out[k] = fromValue(v);
  return out;
}

type FsValue = Record<string, unknown>;
export function toValue(v: unknown): FsValue {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
  throw new Error(`unsupported value: ${typeof v}`);
}
function toFields(o: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = toValue(v);
  return out;
}

/**
 * Creates docs that don't exist yet (precondition exists=false, so nothing is ever overwritten),
 * stamping recordedAt with the server time. Batches of 400.
 */
export async function createEvents(events: { id: string; [k: string]: unknown }[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < events.length; i += 400) {
    const writes = events.slice(i, i + 400).map(e => {
      const name = `${EVENTS_PREFIX}${e.id}`;
      if (!name.startsWith(EVENTS_PREFIX) || e.id.includes('/')) throw new Error(`Refusing to write ${name}`);
      const { recordedAt: _ignored, ...rest } = e;
      return {
        update: { name, fields: toFields(rest) },
        updateTransforms: [{ fieldPath: 'recordedAt', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: false },
      };
    });
    await call('POST', `${API}/${DOCS}:commit`, { writes });
    written += writes.length;
  }
  return written;
}

/** Deletes docs in finhub/noisysource/events by id. Batches of 400. */
export async function deleteEvents(ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 400) {
    const writes = ids.slice(i, i + 400).map(id => {
      const name = `${EVENTS_PREFIX}${id}`;
      if (id.includes('/')) throw new Error(`Refusing to delete ${name}`);
      return { delete: name };
    });
    await call('POST', `${API}/${DOCS}:commit`, { writes });
    deleted += writes.length;
  }
  return deleted;
}
