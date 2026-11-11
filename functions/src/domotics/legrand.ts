import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

const TOKEN_URL = "https://api.netatmo.com/oauth2/token";
const API_BASE = "https://api.netatmo.com/api";
const CONFIG_DOC = "domotics_config/netatmo";

interface NetatmoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  homeId: string;
}

/**
 * These callables control the lights and blinds of a private home and were
 * reachable by anyone who knew the project id — a plain unauthenticated `curl`
 * against /legrandSetState worked. `onCall` does not reject anonymous callers
 * on its own; the check has to be explicit.
 */
function requireOwner(auth: { uid?: string; token?: { email?: string } } | undefined) {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign-in required");
  }
}

async function getAccessToken(): Promise<{ token: string; homeId: string }> {
  const snap = await admin.firestore().doc(CONFIG_DOC).get();
  if (!snap.exists) throw new HttpsError("not-found", "Netatmo config missing — run setup");
  const config = snap.data() as NetatmoConfig;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
    }),
  });

  const data = await resp.json() as Record<string, string>;
  if (!data.access_token) throw new HttpsError("internal", "Token refresh failed");

  if (data.refresh_token && data.refresh_token !== config.refreshToken) {
    await admin.firestore().doc(CONFIG_DOC).update({ refreshToken: data.refresh_token });
  }

  return { token: data.access_token, homeId: config.homeId };
}

export const legrandGetStatus = onCall({ region: "europe-west3" }, async (request) => {
  requireOwner(request.auth);
  const { token, homeId } = await getAccessToken();
  const resp = await fetch(`${API_BASE}/homestatus?home_id=${homeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new HttpsError("internal", `Netatmo error: ${resp.status}`);
  return resp.json();
});

export const legrandSetState = onCall<{
  // Netatmo's /setstate answers 400 unless each module carries the id of the
  // gateway it sits behind — and 400 again if `type` is included. The modules
  // array is forwarded verbatim, so the caller supplies `bridge`.
  modules: Array<{
    id: string; bridge?: string; on?: boolean; target_position?: number;
    /** Dimmers (NLFN) only, 0–100. */
    brightness?: number;
  }>;
}>({ region: "europe-west3" }, async (request) => {
  requireOwner(request.auth);
  const { data } = request;
  const { token, homeId } = await getAccessToken();
  const resp = await fetch(`${API_BASE}/setstate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ home: { id: homeId, modules: data.modules } }),
  });
  if (!resp.ok) throw new HttpsError("internal", `Netatmo error: ${resp.status}`);
  return resp.json();
});

