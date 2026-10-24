/**
 * Minimal Firestore client speaking the REST API as a signed-in Firebase Auth
 * user.
 *
 * Not firebase-admin, for two reasons. Service-account keys are refused by the
 * org policy `iam.disableServiceAccountKeyCreation`, and the role that path
 * needed (`roles/datastore.user`) would have given this Raspberry Pi read/write
 * over every collection in the project — including the finances app's bank
 * data. Signing in as an ordinary user means `firestore.rules` decides what the
 * bridge may touch, so a compromised SD card in the hall cupboard costs the
 * domotics collections and nothing else.
 *
 * Only four operations are needed, so the REST surface is small enough to hand
 * write. `fetch` is global in Node 18+, so this pulls in no dependencies at all
 * — welcome on a 256MB Pi 1.
 */

const TOKEN_TTL_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface FirestoreRestConfig {
  projectId: string;
  apiKey: string;
  email: string;
  password: string;
}

type FirestoreValue = Record<string, unknown>;

/** JS value -> Firestore REST `Value`. */
function encode(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  switch (typeof value) {
    case 'boolean':
      return { booleanValue: value };
    case 'string':
      return { stringValue: value };
    case 'number':
      // Firestore distinguishes the two, and integerValue is a *string* on the
      // wire. Getting this wrong turns 21 into 21.0 and back into a double.
      return Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encode) } };
  }
  return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
}

/** Exported for deploy/backfill-incidents.cjs, which writes with an admin token instead. */
export function encodeFields(data: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) fields[key] = encode(val);
  }
  return fields;
}

/** Firestore REST `Value` -> JS value. */
function decode(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return new Date(value.timestampValue as string);
  if ('arrayValue' in value) {
    const arr = (value.arrayValue as { values?: FirestoreValue[] }).values ?? [];
    return arr.map(decode);
  }
  if ('mapValue' in value) {
    return decodeFields((value.mapValue as { fields?: Record<string, FirestoreValue> }).fields ?? {});
  }
  return null;
}

function decodeFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) out[key] = decode(val);
  return out;
}

export interface FirestoreDoc {
  id: string;
  data: Record<string, unknown>;
}

export class FirestoreRest {
  private readonly base: string;
  private idToken?: string;
  private refreshToken?: string;
  private expiresAt = 0;
  private pending?: Promise<string>;

  constructor(private readonly config: FirestoreRestConfig) {
    this.base =
      `https://firestore.googleapis.com/v1/projects/${config.projectId}` +
      '/databases/(default)/documents';
  }

  /**
   * A single in-flight sign-in shared by every caller. Without this, the first
   * poll after startup fires the config read, the state publish and the command
   * list at once, and each would open its own sign-in.
   */
  private async token(): Promise<string> {
    if (this.idToken && Date.now() < this.expiresAt - TOKEN_TTL_MARGIN_MS) {
      return this.idToken;
    }
    this.pending ??= this.authenticate().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async authenticate(): Promise<string> {
    const { apiKey, email, password } = this.config;
    // A refresh token outlives the hour-long ID token and avoids replaying the
    // password, but it can be revoked server-side — so a failure here falls
    // back to a full sign-in rather than giving up.
    if (this.refreshToken) {
      try {
        return await this.refreshIdToken();
      } catch (err) {
        console.warn('[firestore] token refresh failed, signing in again:', (err as Error).message);
      }
    }

    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      throw new Error(`sign-in failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as {
      idToken: string;
      refreshToken: string;
      expiresIn: string;
    };
    this.idToken = body.idToken;
    this.refreshToken = body.refreshToken;
    this.expiresAt = Date.now() + Number(body.expiresIn) * 1000;
    console.log('[firestore] signed in as', this.config.email);
    return this.idToken;
  }

  private async refreshIdToken(): Promise<string> {
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken!,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      id_token: string;
      refresh_token: string;
      expires_in: string;
    };
    this.idToken = body.id_token;
    this.refreshToken = body.refresh_token;
    this.expiresAt = Date.now() + Number(body.expires_in) * 1000;
    return this.idToken;
  }

  /**
   * One retry on 401 only. Tokens expire mid-flight occasionally and that is
   * recoverable; a 403 is the rules saying no, and retrying that is pointless.
   */
  private async request(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<unknown> {
    const token = await this.token();
    const res = await fetch(`${this.base}/${path}`, {
      ...init,
      headers: {
        ...init.headers,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401 && retry) {
      this.idToken = undefined;
      this.expiresAt = 0;
      return this.request(path, init, false);
    }
    // A missing document is a normal answer to a question, not a failure.
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async getDoc(path: string): Promise<Record<string, unknown> | null> {
    const doc = (await this.request(path)) as { fields?: Record<string, FirestoreValue> } | null;
    if (!doc) return null;
    return decodeFields(doc.fields ?? {});
  }

  /**
   * `updateMask` is always sent explicitly. Without one the REST API's
   * behaviour around untouched fields is easy to get wrong, and this writes to
   * a document the app is reading live.
   */
  async setDoc(path: string, data: Record<string, unknown>): Promise<void> {
    const mask = Object.keys(data)
      .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&');
    await this.request(`${path}?${mask}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
  }

  async listDocs(collection: string, pageSize = 50): Promise<FirestoreDoc[]> {
    const res = (await this.request(`${collection}?pageSize=${pageSize}`)) as {
      documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
    } | null;
    return (res?.documents ?? []).map(doc => ({
      id: doc.name.slice(doc.name.lastIndexOf('/') + 1),
      data: decodeFields(doc.fields ?? {}),
    }));
  }

  async deleteDoc(path: string): Promise<void> {
    await this.request(path, { method: 'DELETE' });
  }
}
