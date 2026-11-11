import { addDoc, doc, serverTimestamp, Timestamp } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { auth } from './firebase';
import { col } from './db';
import { impersonatingFamilyId } from './clientErrors';

// Steps of the enrollment forms, so a drop-off can be seen: the weekly funnel
// email (functions/src/kidclub/enrollFunnelWeekly.ts) reads these.
//
// Why: in Sept–Nov 2026 no parent created a subscription and nobody noticed.
// The submit button was simply disabled for study-only parents, and a disabled
// button throws nothing, so clientErrors had nothing to report.
//
// Signed-in only, no cookies, no new localStorage. Counts, booleans and a fixed
// reason: `data` is typed so that no name, email, address, note or other free
// text can get in, and firestore.rules refuses it if it did. Never throws into
// the caller and never awaits in its path. Hard-capped per page load.

export type EnrollService = 'study' | 'transport';
export type EnrollBlockReason = 'not_ready' | 'duplicate_study' | 'duplicate_transport';
export type ClientEventName =
  | 'enroll_form_opened'
  | 'enroll_days_chosen'
  | 'enroll_blocked'
  | 'enroll_submitted'
  | 'enroll_left';

export interface ClientEventData {
  studyDays?: number;
  transportDays?: number;
  tripsMissingAddress?: number;
  submitEnabled?: boolean;
  seconds?: number;
  reason?: EnrollBlockReason;
}

const MAX_EVENTS_PER_PAGE_LOAD = 30;
const RETENTION_DAYS = 90; // expireAt: the Firestore TTL policy on clientEvents deletes them
const FIRESTORE_REST = 'https://firestore.googleapis.com/v1';

let sent = 0;

type Encoded = Record<string, unknown>;

const encode = (value: string | number | boolean | null | object): Encoded => {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(Math.trunc(value)) };
  return { mapValue: { fields: encodeFields(value as Record<string, string | number | boolean | null | object>) } };
};
const encodeFields = (fields: Record<string, string | number | boolean | null | object>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encode(v)]));

/**
 * The same write as addDoc, for a page that's going away. The SDK's write needs
 * its stream, which closes after a minute idle and can't reopen during unload,
 * so closing the tab would lose nearly every enroll_left. A keepalive fetch
 * outlives the page. Same rules, same shape: createdAt is the server's time.
 */
function writeWhileUnloading(user: User, path: string, fields: Record<string, string | number | boolean | null | object>, expireAtMs: number): void {
  const projectId = auth.app.options.projectId;
  const documents = `projects/${projectId}/databases/(default)/documents`;
  const body = JSON.stringify({
    writes: [{
      update: {
        name: `${documents}/${path}`,
        fields: { ...encodeFields(fields), expireAt: { timestampValue: new Date(expireAtMs).toISOString() } },
      },
      updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: false },
    }],
  });
  user.getIdToken()
    .then(token => fetch(`${FIRESTORE_REST}/${documents}:commit`, {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    }))
    .catch(() => { /* best-effort */ });
}

export function reportClientEvent(
  event: ClientEventName,
  service: EnrollService,
  data: ClientEventData = {},
  options: { route?: string; unloading?: boolean } = {},
): void {
  try {
    const user = auth.currentUser;
    if (!user) return; // rules require a signed-in reporter
    if (sent >= MAX_EVENTS_PER_PAGE_LOAD) return;
    sent++;

    const expireAtMs = Date.now() + RETENTION_DAYS * 86_400_000;
    const fields = {
      userId: user.uid,
      impersonatingFamilyId: impersonatingFamilyId(),
      event,
      service,
      data,
      route: options.route ?? window.location.pathname, // never the query string: it holds the childId
      mode: import.meta.env.MODE as string,
    };

    if (options.unloading) {
      writeWhileUnloading(user, doc(col('clientEvents')).path, fields, expireAtMs);
      return;
    }
    addDoc(col('clientEvents'), {
      ...fields,
      createdAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(expireAtMs),
    }).catch(() => { /* best-effort */ });
  } catch {
    // tracking must never break the form
  }
}
