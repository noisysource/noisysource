import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { createHash, createHmac } from "crypto";

/**
 * Tuya Cloud (SmartLife) integration.
 *
 * Separate ecosystem from Legrand/Netatmo: different cloud, different auth,
 * different device model. The thermostats and the heat pump live here; lights
 * and blinds live in legrand.ts. Nothing is shared but the room they sit in.
 */

const CONFIG_DOC = "domotics_config/tuya";

/** Tuya routes by data centre. Portugal is on the EU one. */
const HOSTS: Record<string, string> = {
  eu: "https://openapi.tuyaeu.com",
  us: "https://openapi.tuyaus.com",
  cn: "https://openapi.tuyacn.com",
  in: "https://openapi.tuyain.com",
};

interface TuyaConfig {
  accessId: string;
  accessSecret: string;
  /** Key of HOSTS; defaults to "eu". */
  region?: string;
}

const EMPTY_BODY_SHA = createHash("sha256").update("").digest("hex");

/**
 * Access tokens last ~2h. Cloud Functions reuse warm instances, so caching in
 * module scope avoids a token round-trip on most calls; a cold start just
 * fetches again.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function loadConfig(): Promise<TuyaConfig & { host: string }> {
  const snap = await admin.firestore().doc(CONFIG_DOC).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Tuya config missing — run setup");
  }
  const config = snap.data() as TuyaConfig;
  const host = HOSTS[config.region ?? "eu"];
  if (!host) throw new HttpsError("failed-precondition", `Unknown Tuya region: ${config.region}`);
  return { ...config, host };
}

/**
 * Tuya signs `client_id + [access_token] + t + nonce + stringToSign`, where
 * stringToSign is METHOD\nbodySHA256\n\npathWithQuery. The access_token is part
 * of the signature for business calls but absent when fetching the token
 * itself — getting that wrong is the usual source of a 1004 sign-invalid.
 */
function sign(
  config: TuyaConfig,
  method: string,
  path: string,
  timestamp: string,
  token?: string,
  body = "",
) {
  const bodyHash = body ? createHash("sha256").update(body).digest("hex") : EMPTY_BODY_SHA;
  const stringToSign = `${method}\n${bodyHash}\n\n${path}`;
  const payload = `${config.accessId}${token ?? ""}${timestamp}${stringToSign}`;
  return createHmac("sha256", config.accessSecret)
    .update(payload)
    .digest("hex")
    .toUpperCase();
}

async function tuyaFetch(
  config: TuyaConfig & { host: string },
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: unknown,
) {
  const timestamp = Date.now().toString();
  const payload = body ? JSON.stringify(body) : "";
  const headers: Record<string, string> = {
    client_id: config.accessId,
    sign: sign(config, method, path, timestamp, token, payload),
    t: timestamp,
    sign_method: "HMAC-SHA256",
    "Content-Type": "application/json",
  };
  if (token) headers.access_token = token;

  const resp = await fetch(`${config.host}${path}`, {
    method,
    headers,
    ...(payload ? { body: payload } : {}),
  });
  const data = await resp.json() as { success?: boolean; result?: unknown; msg?: string; code?: number };

  // Tuya answers HTTP 200 even for application errors — `success` is the
  // field that actually matters.
  if (!data.success) {
    throw new HttpsError("internal", `Tuya error ${data.code ?? "?"}: ${data.msg ?? "unknown"}`);
  }
  return data.result;
}

async function getToken(config: TuyaConfig & { host: string }): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const result = await tuyaFetch(config, "GET", "/v1.0/token?grant_type=1") as {
    access_token: string; expire_time: number;
  };
  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + result.expire_time * 1000,
  };
  return result.access_token;
}

/**
 * Every device linked to the SmartLife account, with its live status.
 *
 * Doubles as the discovery call: Tuya status codes (`temp_set`, `upper_temp`,
 * `switch`, …) vary per product, so the UI can only be built once we have seen
 * what these particular thermostats actually report.
 */
/**
 * Same hole the Legrand callables had, and worse here: this one returns every
 * device's `local_key`, which is all anyone on the network needs to command the
 * heating directly. A plain unauthenticated `curl` retrieved the full set.
 * `onCall` does not reject anonymous callers by itself.
 */
function requireOwner(auth: { uid?: string } | undefined) {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign-in required");
  }
}

export const tuyaGetDevices = onCall({ region: "europe-west3" }, async ({ auth }) => {
  requireOwner(auth);
  const config = await loadConfig();
  const token = await getToken(config);
  const result = await tuyaFetch(
    config,
    "GET",
    "/v1.0/iot-01/associated-users/devices?page_size=100",
    token,
  ) as { devices?: unknown[] };
  return { devices: result?.devices ?? [] };
});

export const tuyaSetState = onCall<{
  deviceId: string;
  commands: Array<{ code: string; value: unknown }>;
}>({ region: "europe-west3" }, async ({ data, auth }) => {
  requireOwner(auth);
  if (!data?.deviceId || !Array.isArray(data.commands) || data.commands.length === 0) {
    throw new HttpsError("invalid-argument", "deviceId and a non-empty commands array are required");
  }
  const config = await loadConfig();
  const token = await getToken(config);
  return tuyaFetch(
    config,
    "POST",
    `/v1.0/devices/${data.deviceId}/commands`,
    token,
    { commands: data.commands },
  );
});
