/**
 * The commands the app may send a car, as a whitelist: the app names an
 * action, this turns it into Tesla's REST command and body, with every value
 * clamped. Pure; tesla.ts sends it.
 *
 * REST commands (`POST /api/1/vehicles/{vin}/command/{name}`) work as they
 * are on cars without Tesla's Vehicle Command Protocol, like the 2020 Model X.
 * Newer cars (the Model 3) answer that the protocol is required; they need
 * the signing proxy, a later step. That answer is turned into a clear message.
 *
 * Limits on top of the daily call cap (each command is one call):
 *   - charging commands (start/stop, limit, current): CHARGING_PER_CAR_PER_DAY,
 *     Tesla's own limit for this kind of command;
 *   - waking a car (the dearest call, $0.02): WAKES_PER_CAR_PER_DAY, and only
 *     when asked for. A command to an asleep car is refused, never woken by itself.
 */

export type CarAction =
  | "lock" | "unlock"
  | "climate_on" | "climate_off" | "set_temp"
  | "charge_start" | "charge_stop" | "charge_limit" | "charging_amps"
  | "port_open" | "port_close"
  | "flash" | "honk"
  | "wake";

export interface TeslaCommand {
  /** Path after /api/1/vehicles/{vin}/ */
  path: string;
  body?: Record<string, number>;
  charging: boolean;
  wake: boolean;
  /** What to note on the cached car straight away, so the screen doesn't wait for the next read. */
  patch?: Record<string, unknown>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const CHARGING_PER_CAR_PER_DAY = 5;
export const WAKES_PER_CAR_PER_DAY = 5;
/** Charging current the app may set: 5 A up to the Schuko's 13 A (the Mobile Connector's own cap at home). */
export const AMPS_MIN = 5;
export const AMPS_MAX = 13;

/** Turns an action from the app into Tesla's command. Throws a readable message if it isn't one. */
export function buildCommand(action: unknown, value?: unknown): TeslaCommand {
  const c = (name: string, extra: Partial<TeslaCommand> = {}): TeslaCommand =>
    ({ path: `command/${name}`, charging: false, wake: false, ...extra });
  switch (action) {
    case "lock": return c("door_lock", { patch: { locked: true } });
    case "unlock": return c("door_unlock", { patch: { locked: false } });
    case "climate_on": return c("auto_conditioning_start", { patch: { climateOn: true } });
    case "climate_off": return c("auto_conditioning_stop", { patch: { climateOn: false } });
    case "set_temp": {
      const t = finite(value);
      if (t === undefined) throw new Error("Temperatura em falta.");
      const temp = Math.round(clamp(t, 15, 28) * 2) / 2;
      return c("set_temps", { body: { driver_temp: temp, passenger_temp: temp } });
    }
    case "charge_start": return c("charge_start", { charging: true });
    case "charge_stop": return c("charge_stop", { charging: true });
    case "charge_limit": {
      const p = finite(value);
      if (p === undefined) throw new Error("Limite em falta.");
      const percent = Math.round(clamp(p, 50, 100));
      return c("set_charge_limit", { body: { percent }, charging: true, patch: { chargeLimit: percent } });
    }
    case "charging_amps": {
      const a = finite(value);
      if (a === undefined) throw new Error("Corrente em falta.");
      const amps = Math.round(clamp(a, AMPS_MIN, AMPS_MAX));
      return c("set_charging_amps", { body: { charging_amps: amps }, charging: true, patch: { chargeAmpsRequest: amps } });
    }
    case "port_open": return c("charge_port_door_open");
    case "port_close": return c("charge_port_door_close");
    case "flash": return c("flash_lights");
    case "honk": return c("honk_horn");
    case "wake": return { path: "wake_up", charging: false, wake: true };
    default: throw new Error("Comando desconhecido.");
  }
}

/**
 * Tesla answers a command with `{response: {result, reason}}`. A false result
 * says why; the reasons that matter are put in Portuguese.
 */
export function commandOutcome(raw: unknown): { ok: true } | { ok: false; message: string } {
  const r = (raw ?? {}) as { response?: { result?: boolean; reason?: string } | null; error?: string };
  if (r.response?.result === true) return { ok: true };
  const reason = String(r.response?.reason ?? r.error ?? "sem razão");
  return { ok: false, message: reasonText(reason) };
}

export function reasonText(reason: string): string {
  const k = reason.toLowerCase();
  if (k.includes("vehicle command protocol") || k.includes("protocol required") || k.includes("signed")) {
    return "Este carro só aceita comandos assinados (falta o proxy de assinatura, próximo passo).";
  }
  if (k.includes("already_set") || k.includes("already set")) return "Já estava assim.";
  if (k.includes("not_charging")) return "Não está a carregar.";
  if (k.includes("is_charging")) return "Já está a carregar.";
  if (k.includes("disconnected") || k.includes("no_power")) return "O carro não está ligado ao carregador.";
  if (k.includes("complete")) return "A carga já está completa.";
  if (k.includes("user_present") || k.includes("in_use")) return "Há alguém no carro.";
  if (k.includes("not paired") || k.includes("unpaired") || k.includes("virtual key")) {
    return "A chave desta app não está emparelhada com o carro (tesla.com/_ak/…).";
  }
  return `Tesla recusou: ${reason}`;
}

/** The per-car, per-day counter's field name for a kind of command. */
export const counterField = (vin: string, kind: "charging" | "wake") => `${kind}_${vin.replace(/[^A-Za-z0-9]/g, "")}`;
