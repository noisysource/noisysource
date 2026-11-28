import { randomBytes } from "node:crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { requireOwner } from "../auth";
import {
  API_BASE, CLIENT_ID, DAILY_CALL_CAP, LIST_MIN_INTERVAL_MS, OAUTH_STATE_TTL_MS, PARTNER_DOMAIN, REDIRECT_URIS,
  SCOPES, TOKEN_URL, VEHICLE_DATA_ENDPOINTS, buildAuthUrl, firestoreSafe, lisbonDay, shouldReadCar, summarize, type CarSummary,
} from "./teslaLogic";
import {
  CHARGING_PER_CAR_PER_DAY, WAKES_PER_CAR_PER_DAY, buildCommand, commandOutcome, counterField, reasonText,
} from "./teslaCommands";
import {
  CHARGING_LOOKBACK_DAYS, CHARGING_MAX_PAGES, CHARGING_MIN_INTERVAL_MS, CHARGING_PAGE_SIZE, CHARGING_REFRESH_MIN_MS,
  capacityKwh, consumption, fullRangeByMonth, fullRangeKm, monthTotals, parseChargingHistory,
  type CarReading, type ChargingSession,
} from "./teslaCharging";

/**
 * Tesla Fleet API (EU). Read-only for now: the cars, their battery,
 * charging, lock state and position. Commands come later (the 2020 Model X
 * takes plain REST commands; the Model 3 needs them signed).
 *
 * Metered (pay per call). Every call goes through `teslaFetch`, which counts
 * it against DAILY_CALL_CAP first and never retries. Cars are never woken:
 * an asleep car is shown from the last reading.
 *
 * The client secret is a Firebase secret (TESLA_CLIENT_SECRET), set by
 * Renato. The tokens live in domotics_config/tesla, which no client can read
 * (firestore.rules: domotics_config is an allowlist). Tesla's refresh tokens
 * are single-use, so a refresh is leased (only one at a time) and the new one
 * is saved at once.
 */
const CLIENT_SECRET = defineSecret("TESLA_CLIENT_SECRET");
/**
 * The functions that read the secret name their runtime account in full. The
 * global "functions-runtime@" shorthand (options.ts) is fine for running a
 * function, but `firebase deploy` grants a secret to the account exactly as
 * written, and Secret Manager rejects the shorthand (400 "Invalid service
 * account", first prod deploy, 26/11/2026). The CLI sets GCLOUD_PROJECT both
 * when it reads the functions and when they run.
 */
const WITH_SECRET = {
  secrets: [CLIENT_SECRET],
  serviceAccount: `functions-runtime@${process.env.GCLOUD_PROJECT}.iam.gserviceaccount.com`,
};
const TOKEN_DOC = "domotics_config/tesla";
const STATE_DOC = "domotics_config/tesla_oauth";
const USAGE = "domotics_tesla_usage";
const CARS = "domotics_tesla";
const LIST_DOC = "domotics_tesla/_list";
/** Tesla's charging history, one document per session (teslaCharging.ts), and when it was last fetched. */
const CHARGING = "domotics_tesla_charging";
const CHARGING_META = "domotics_tesla/_charging";
/** One document per car data read: battery %, range, odometer, energy added. For consumption and the battery estimate. */
const READINGS = "domotics_tesla_readings";

const db = () => admin.firestore();

interface TokenDoc {
  refreshToken?: string;
  accessToken?: string;
  accessExpiresAt?: number;
  connectedAt?: number;
  leaseUntil?: number;
}

/** Count one call against today's budget, then make it. One attempt, no retries. */
async function teslaFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ref = db().collection(USAGE).doc(lisbonDay(Date.now()));
  await db().runTransaction(async tx => {
    const calls = ((await tx.get(ref)).data()?.calls as number | undefined) ?? 0;
    if (calls >= DAILY_CALL_CAP) {
      throw new HttpsError("resource-exhausted", `Limite diário de chamadas à Tesla atingido (${DAILY_CALL_CAP}).`);
    }
    tx.set(ref, { calls: calls + 1, updatedAt: Date.now() }, { merge: true });
  });
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, any>> {
  const resp = await teslaFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await resp.json().catch(() => ({})) as Record<string, any>;
  if (!resp.ok || !data.access_token) {
    throw new HttpsError("failed-precondition", `Tesla recusou o pedido de token (${resp.status} ${data.error ?? ""}).`.trim());
  }
  return data;
}

/** A valid user access token, refreshing it (leased, single-use refresh token) when it's about to expire. */
async function accessToken(): Promise<string> {
  const ref = db().doc(TOKEN_DOC);
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const lease = await db().runTransaction(async tx => {
      const t = ((await tx.get(ref)).data() ?? {}) as TokenDoc;
      if (!t.refreshToken) return { kind: "none" as const };
      if (t.accessToken && (t.accessExpiresAt ?? 0) > now + 60_000) return { kind: "valid" as const, token: t.accessToken };
      if ((t.leaseUntil ?? 0) > now) return { kind: "busy" as const };
      tx.update(ref, { leaseUntil: now + 20_000 });
      return { kind: "mine" as const, refreshToken: t.refreshToken };
    });
    if (lease.kind === "none") throw new HttpsError("failed-precondition", "A Tesla ainda não está ligada. Use “Ligar à Tesla”.");
    if (lease.kind === "valid") return lease.token;
    if (lease.kind === "busy") { await new Promise(r => setTimeout(r, 2000)); continue; }
    try {
      const data = await tokenRequest({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: lease.refreshToken });
      await ref.update({
        accessToken: data.access_token,
        accessExpiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        // Single-use: keep the new one, or the next refresh fails.
        ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        leaseUntil: 0,
      });
      return data.access_token as string;
    } catch (err) {
      await ref.update({ leaseUntil: 0 }).catch(() => {});
      throw err;
    }
  }
  throw new HttpsError("unavailable", "O token da Tesla está a ser renovado. Tente de novo.");
}

async function api(path: string, token: string): Promise<any> {
  const resp = await teslaFetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 408) return { asleep: true };
  if (!resp.ok) {
    // Tesla says why in the body ({"error": "..."}); keep it, it's the only clue (e.g. a scope not granted).
    const body = (await resp.text().catch(() => "")).slice(0, 300);
    throw new HttpsError("failed-precondition", `Tesla respondeu ${resp.status} a ${path.split("?")[0]}: ${body}`);
  }
  return resp.json();
}

/** Step 1 of signing in: a one-time state and the Tesla login address. */
export const teslaAuthStart = onCall<{ redirectUri: string }>(async request => {
  requireOwner(request.auth);
  const redirectUri = request.data?.redirectUri;
  if (!REDIRECT_URIS.includes(redirectUri)) throw new HttpsError("invalid-argument", "Endereço de regresso desconhecido.");
  const state = randomBytes(16).toString("hex");
  await db().doc(STATE_DOC).set({ state, redirectUri, createdAt: Date.now() });
  return { url: buildAuthUrl(redirectUri, state) };
});

/** Step 2: Tesla sent the browser back with a code; trade it for tokens. */
export const teslaAuthFinish = onCall<{ code: string; state: string }>(WITH_SECRET, async request => {
  requireOwner(request.auth);
  const { code, state } = request.data ?? {};
  if (typeof code !== "string" || typeof state !== "string") throw new HttpsError("invalid-argument", "Falta o código.");
  const saved = (await db().doc(STATE_DOC).get()).data();
  if (!saved || saved.state !== state || Date.now() - saved.createdAt > OAUTH_STATE_TTL_MS) {
    throw new HttpsError("permission-denied", "Este regresso da Tesla não corresponde ao pedido (ou expirou). Tente de novo.");
  }
  await db().doc(STATE_DOC).delete();
  const data = await tokenRequest({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET.value(),
    code,
    redirect_uri: saved.redirectUri,
    audience: API_BASE,
  });
  await db().doc(TOKEN_DOC).set({
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    accessExpiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    connectedAt: Date.now(),
    leaseUntil: 0,
  } satisfies TokenDoc);
  return { ok: true };
});

/**
 * One-off: register this app with Tesla for the EU region, now that our
 * public key is hosted on PARTNER_DOMAIN. Needs the "allowed origin" in the
 * Tesla dashboard to be that domain. Two calls.
 */
export const teslaRegisterPartner = onCall(WITH_SECRET, async request => {
  requireOwner(request.auth);
  const t = await tokenRequest({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET.value(),
    scope: SCOPES,
    audience: API_BASE,
  });
  const resp = await teslaFetch(`${API_BASE}/api/1/partner_accounts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain: PARTNER_DOMAIN }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new HttpsError("failed-precondition", `Tesla recusou o registo (${resp.status}): ${body.slice(0, 300)}`);
  return { ok: true };
});

/**
 * The cars and their latest data. The list is re-read at most every couple of
 * minutes; an awake car's data at most every few minutes; an asleep car never
 * (that would wake it). Returns what's known, with when each was read.
 */
export const teslaVehicles = onCall<{ refresh?: boolean }>(async request => {
  requireOwner(request.auth);
  const now = Date.now();
  const connected = !!(await db().doc(TOKEN_DOC).get()).data()?.refreshToken;
  if (!connected) return { connected: false, cars: [] as CarSummary[] };

  const listSnap = await db().doc(LIST_DOC).get();
  let listed = (listSnap.data()?.vehicles ?? []) as Array<Record<string, any>>;
  const listAge = now - ((listSnap.data()?.fetchedAt as number | undefined) ?? 0);
  let token: string | undefined;
  if (listAge >= LIST_MIN_INTERVAL_MS) {
    token = await accessToken();
    const r = await api("/api/1/vehicles", token);
    listed = (r.response ?? []).map((v: any) => ({ id_s: v.id_s, vin: v.vin, display_name: v.display_name, state: v.state }));
    await db().doc(LIST_DOC).set(firestoreSafe({ vehicles: listed, fetchedAt: now }));
  }

  const cars: CarSummary[] = [];
  for (const v of listed) {
    const ref = db().collection(CARS).doc(String(v.vin));
    const cached = (await ref.get()).data() as CarSummary | undefined;
    // A failed read waits as long as a good one before the next try, so a
    // refused car doesn't cost a call every time the page is opened.
    const lastTry = Math.max(cached?.readAt ?? 0, (cached as { errorAt?: number } | undefined)?.errorAt ?? 0) || undefined;
    if (shouldReadCar(v.state, lastTry, now)) {
      token ??= await accessToken();
      let r: any;
      try {
        r = await api(`/api/1/vehicles/${v.vin}/vehicle_data?endpoints=${encodeURIComponent(VEHICLE_DATA_ENDPOINTS)}`, token);
      } catch (err) {
        await ref.set(firestoreSafe({ ...(cached ?? summarize(v)), errorAt: now, error: (err as Error).message }), { merge: true });
        throw err;
      }
      if (!r.asleep && r.response) {
        const s = summarize(v, r.response, now);
        await ref.set(firestoreSafe(s));
        // A reading for the history: no extra Tesla call, it's the data just read.
        await db().collection(READINGS).doc(`${s.vin}_${now}`).set(firestoreSafe({
          vin: s.vin, t: now, soc: s.soc, rangeKm: s.rangeKm, odometerKm: s.odometerKm,
          energyAddedKwh: s.energyAddedKwh, chargingState: s.chargingState,
        } satisfies CarReading));
        cars.push(s);
        continue;
      }
    }
    // Asleep, or read recently: the last reading, with the current state.
    cars.push(cached ? { ...cached, state: v.state, name: v.display_name || cached.name } : summarize(v));
  }
  const usage = (await db().collection(USAGE).doc(lisbonDay(now)).get()).data()?.calls ?? 0;
  return { connected: true, cars, callsToday: usage, callCap: DAILY_CALL_CAP };
});

/** Lisbon-offset ISO time, as the charging history wants it (with an offset, no milliseconds). */
const isoWithOffset = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/**
 * Charging sessions (Tesla-billed: Superchargers), month totals, consumption
 * and a battery estimate, per car. The history is fetched from Tesla at most
 * every 6 h (CHARGING_MIN_INTERVAL_MS), or on "Atualizar" at most every
 * 15 min; up to 4 pages of 50. Everything else is computed from Firestore.
 */
export const teslaCharging = onCall<{ refresh?: boolean }>(async request => {
  requireOwner(request.auth);
  const now = Date.now();
  if (!(await db().doc(TOKEN_DOC).get()).data()?.refreshToken) {
    return { connected: false, sessions: [], cars: [] };
  }

  const meta = (await db().doc(CHARGING_META).get()).data() as { fetchedAt?: number; error?: string } | undefined;
  const age = now - (meta?.fetchedAt ?? 0);
  let fetchError: string | undefined;
  let fetchedAt = meta?.fetchedAt ?? null;
  if (age >= CHARGING_MIN_INTERVAL_MS || (request.data?.refresh === true && age >= CHARGING_REFRESH_MIN_MS)) {
    // Since the last fetch (a day of overlap for late invoices), or a year back the first time.
    const since = meta?.fetchedAt ? meta.fetchedAt - 24 * 3600_000 : now - CHARGING_LOOKBACK_DAYS * 24 * 3600_000;
    try {
      const token = await accessToken();
      const found: ChargingSession[] = [];
      for (let page = 1; page <= CHARGING_MAX_PAGES; page++) {
        const q = new URLSearchParams({
          startTime: isoWithOffset(since), endTime: isoWithOffset(now),
          pageNo: String(page), pageSize: String(CHARGING_PAGE_SIZE),
        });
        const got = parseChargingHistory(await api(`/api/1/dx/charging/history?${q}`, token));
        found.push(...got);
        if (got.length < CHARGING_PAGE_SIZE) break;
      }
      const batch = db().batch();
      for (const sess of found) batch.set(db().collection(CHARGING).doc(sess.id), firestoreSafe(sess));
      batch.set(db().doc(CHARGING_META), { fetchedAt: now, found: found.length, error: null });
      await batch.commit();
      fetchedAt = now;
    } catch (err) {
      // Kept, and shown; the next try waits like a good one would, so a refusal costs one call per interval.
      fetchError = (err as Error).message;
      await db().doc(CHARGING_META).set({ fetchedAt: now, error: fetchError }, { merge: true });
    }
  }

  const sessions = (await db().collection(CHARGING).orderBy("start", "desc").limit(300).get())
    .docs.map(d => d.data() as ChargingSession);
  const yearAgo = now - 365 * 24 * 3600_000;
  const readings = (await db().collection(READINGS).where("t", ">=", yearAgo).orderBy("t", "asc").limit(3000).get())
    .docs.map(d => d.data() as CarReading);
  const vins = [...new Set([...sessions.map(x => x.vin), ...readings.map(r => r.vin)].filter(Boolean))];

  const cars = vins.map(vin => {
    const mine = readings.filter(r => r.vin === vin);
    const latest = [...mine].reverse().find(r => fullRangeKm(r) !== undefined);
    return {
      vin,
      months: monthTotals(sessions, vin),
      consumption: consumption(sessions, readings, vin) ?? null,
      fullRangeKm: latest ? fullRangeKm(latest) : null,
      fullRangeByMonth: fullRangeByMonth(readings, vin),
      capacityKwh: capacityKwh(mine) ?? null,
      readings: mine.length,
    };
  });
  return {
    connected: true,
    sessions: sessions.slice(0, 100),
    cars,
    fetchedAt,
    // Only a fresh failure, or the last fetch's if nothing was fetched now.
    error: fetchError ?? (fetchedAt === meta?.fetchedAt ? meta?.error ?? null : null),
  };
});

/**
 * One command to one car (teslaCommands.ts has the whitelist and the limits).
 * Owner only. Checks, in order: the action is known and its value clamped;
 * the per-car daily limit for charging commands and wakes; then the call
 * itself, which also counts against the daily cap. An asleep car is refused
 * with a message, never woken unless "wake" was the command.
 */
export const teslaCommand = onCall<{ vin?: string; action?: string; value?: unknown }>(async request => {
  requireOwner(request.auth);
  const vin = String(request.data?.vin ?? "");
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new HttpsError("invalid-argument", "Carro desconhecido.");
  let cmd;
  try {
    cmd = buildCommand(request.data?.action, request.data?.value);
  } catch (err) {
    throw new HttpsError("invalid-argument", (err as Error).message);
  }
  // Only a car on this account (the cached list), so a VIN typed in elsewhere goes nowhere.
  const listed = ((await db().doc(LIST_DOC).get()).data()?.vehicles ?? []) as Array<{ vin?: string }>;
  if (!listed.some(v => v.vin === vin)) throw new HttpsError("not-found", "Carro desconhecido.");

  if (cmd.charging || cmd.wake) {
    const kind = cmd.wake ? "wake" : "charging";
    const limit = cmd.wake ? WAKES_PER_CAR_PER_DAY : CHARGING_PER_CAR_PER_DAY;
    const field = counterField(vin, kind);
    const ref = db().collection(USAGE).doc(lisbonDay(Date.now()));
    await db().runTransaction(async tx => {
      const used = ((await tx.get(ref)).data()?.[field] as number | undefined) ?? 0;
      if (used >= limit) {
        throw new HttpsError("resource-exhausted", cmd.wake
          ? `Já acordou este carro ${limit} vezes hoje (limite da app).`
          : `Já foram ${limit} comandos de carregamento a este carro hoje (limite da Tesla).`);
      }
      tx.set(ref, { [field]: used + 1, updatedAt: Date.now() }, { merge: true });
    });
  }

  const token = await accessToken();
  const resp = await teslaFetch(`${API_BASE}/api/1/vehicles/${vin}/${cmd.path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd.body ?? {}),
  });
  if (resp.status === 408) {
    throw new HttpsError("failed-precondition", "O carro está a dormir. Acorde-o primeiro (custa mais que um comando).");
  }
  const text = await resp.text().catch(() => "");
  let json: unknown = undefined;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!resp.ok) {
    const reason = (json as { error?: string } | undefined)?.error ?? text.slice(0, 200);
    throw new HttpsError("failed-precondition", reasonText(`${reason}`));
  }
  if (cmd.wake) return { ok: true, message: "A acordar: o carro responde em 10 a 60 segundos. Depois carregue em Atualizar." };

  const outcome = commandOutcome(json);
  if (!outcome.ok) throw new HttpsError("failed-precondition", outcome.message);
  if (cmd.patch) {
    await db().collection(CARS).doc(vin).set(firestoreSafe({ ...cmd.patch, commandAt: Date.now() }), { merge: true });
  }
  return { ok: true };
});
