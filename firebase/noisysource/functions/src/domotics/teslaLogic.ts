/**
 * Tesla Fleet API, the parts that need no network: URLs, the call budget, when
 * a car may be asked for data, and turning `vehicle_data` into what the app
 * shows. The network side is tesla.ts.
 *
 * Region: EU. Login at auth.tesla.com, tokens from fleet-auth, data from the
 * EU Fleet API host (root CLAUDE.md, "Shared Integrations").
 */

export const CLIENT_ID = "be39cf7c-7435-456f-8cbe-327e2316b5bc";
export const AUTH_URL = "https://auth.tesla.com/oauth2/v3/authorize";
export const TOKEN_URL = "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";
export const API_BASE = "https://fleet-api.prd.eu.vn.cloud.tesla.com";
export const SCOPES = "openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds";

/**
 * Where Tesla may send the login back to: the house app, prod and dev. Must
 * also be registered in the Tesla dashboard, which refuses a bare "/" (26/11),
 * hence a path. Hosting serves the app there (the SPA rewrite); App.tsx
 * finishes the login and moves to /#/carros.
 */
export const REDIRECT_PATH = "/tesla/callback";
export const REDIRECT_URIS = [
  `https://noisysource-prod-domotics.web.app${REDIRECT_PATH}`,
  `https://noisysource-dev-domotics.web.app${REDIRECT_PATH}`,
];
/** The site that hosts our public key (/.well-known/appspecific/com.tesla.3p.public-key.pem). */
export const PARTNER_DOMAIN = "noisysource-prod-domotics.web.app";

/**
 * Every Tesla call this backend makes, per Lisbon day, counted before it is
 * made. The provider's own monthly cap (set in the Tesla dashboard) is the
 * backstop; this is what stops a bug from ever reaching it. 100 a day is far
 * above normal use: opening Carros costs 1 call for the list plus 1 per awake
 * car, and a car is asked at most every DATA_MIN_INTERVAL_MS.
 */
export const DAILY_CALL_CAP = 100;
/** A car's data is re-read at most this often, however often the page is opened. */
export const DATA_MIN_INTERVAL_MS = 5 * 60_000;
/** The vehicle list (with each car's online/asleep state) is re-read at most this often. */
export const LIST_MIN_INTERVAL_MS = 2 * 60_000;
/** A login attempt (state) is valid this long. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export function buildAuthUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    locale: "pt-PT",
    prompt: "login",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** Lisbon calendar day, for the call counter. */
export function lisbonDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(now));
}

/** Whether to ask a car for its data now. An asleep or offline car is never asked: that would wake it, or fail. */
export function shouldReadCar(state: string | undefined, lastReadAt: number | undefined, now: number): boolean {
  if (state !== "online") return false;
  return lastReadAt === undefined || now - lastReadAt >= DATA_MIN_INTERVAL_MS;
}

export interface CarSummary {
  vin: string;
  id: string;
  name: string;
  model?: string;
  state: string;
  soc?: number;
  rangeKm?: number;
  chargeLimit?: number;
  chargingState?: string;
  chargeAmps?: number;
  chargeAmpsMax?: number;
  chargerPowerKw?: number;
  energyAddedKwh?: number;
  minutesToFull?: number;
  locked?: boolean;
  sentry?: boolean;
  insideC?: number;
  outsideC?: number;
  climateOn?: boolean;
  odometerKm?: number;
  lat?: number;
  lon?: number;
  shiftState?: string | null;
  speedKmh?: number;
  software?: string;
  /** When the data was read from the car (ms); absent when the car has only been listed. */
  readAt?: number;
}

const MILES_TO_KM = 1.609344;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const round1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);

/** `/api/1/vehicles` entry (+ optional `vehicle_data` response) → what the app shows. Units: km, °C, kW. */
export function summarize(
  listed: { id_s?: string; id?: number | string; vin?: string; display_name?: string; state?: string },
  data?: Record<string, any>,
  readAt?: number,
): CarSummary {
  const ch = data?.charge_state ?? {};
  const cl = data?.climate_state ?? {};
  const dr = data?.drive_state ?? {};
  const vs = data?.vehicle_state ?? {};
  const vc = data?.vehicle_config ?? {};
  const model = typeof vc.car_type === "string" ? prettyModel(vc.car_type) : undefined;
  const range = num(ch.battery_range);
  const odo = num(vs.odometer);
  const speed = num(dr.speed);
  return {
    vin: String(listed.vin ?? ""),
    id: String(listed.id_s ?? listed.id ?? ""),
    name: listed.display_name || model || "Tesla",
    model,
    state: listed.state ?? "unknown",
    soc: num(ch.battery_level),
    rangeKm: range === undefined ? undefined : Math.round(range * MILES_TO_KM),
    chargeLimit: num(ch.charge_limit_soc),
    chargingState: typeof ch.charging_state === "string" ? ch.charging_state : undefined,
    chargeAmps: num(ch.charge_amps) ?? num(ch.charger_actual_current),
    chargeAmpsMax: num(ch.charge_current_request_max),
    chargerPowerKw: num(ch.charger_power),
    energyAddedKwh: round1(num(ch.charge_energy_added)),
    minutesToFull: (() => { const h = num(ch.time_to_full_charge); return h === undefined ? undefined : Math.round(h * 60); })(),
    locked: typeof vs.locked === "boolean" ? vs.locked : undefined,
    sentry: typeof vs.sentry_mode === "boolean" ? vs.sentry_mode : undefined,
    insideC: round1(num(cl.inside_temp)),
    outsideC: round1(num(cl.outside_temp)),
    climateOn: typeof cl.is_climate_on === "boolean" ? cl.is_climate_on : undefined,
    odometerKm: odo === undefined ? undefined : Math.round(odo * MILES_TO_KM),
    lat: num(dr.latitude) ?? num(dr.active_route_latitude),
    lon: num(dr.longitude) ?? num(dr.active_route_longitude),
    shiftState: dr.shift_state ?? null,
    speedKmh: speed === undefined ? undefined : Math.round(speed * MILES_TO_KM),
    software: typeof vs.car_version === "string" ? vs.car_version.split(" ")[0] : undefined,
    readAt,
  };
}

function prettyModel(carType: string): string {
  const t = carType.toLowerCase();
  if (t === "models" || t === "models2") return "Model S";
  if (t === "modelx") return "Model X";
  if (t === "model3") return "Model 3";
  if (t === "modely") return "Model Y";
  return carType;
}

/** The endpoints asked for in one vehicle_data call. location_data is needed for the position since 2024. */
export const VEHICLE_DATA_ENDPOINTS = "charge_state;climate_state;drive_state;location_data;vehicle_state;vehicle_config";
