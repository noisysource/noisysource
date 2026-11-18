/**
 * What Atlas may send to Netatmo's /setstate through legrandSetState: lights
 * on/off, dimmer brightness, blind position. The app's own calls are forwarded
 * verbatim; Atlas's are held to these shapes, so that it can't reach anything
 * else /setstate accepts. Pure, so it can be tested without Firebase.
 */

const MAX_MODULES = 30;
const KEYS = new Set(["id", "bridge", "on", "target_position", "brightness"]);

const isPercent = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;

/** Why `modules` isn't acceptable from Atlas, or null when it is. */
export function agentModulesError(modules: unknown): string | null {
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > MAX_MODULES) {
    return `modules must be a list of 1 to ${MAX_MODULES} entries`;
  }
  for (const [i, m] of modules.entries()) {
    const at = `modules[${i}]`;
    if (!m || typeof m !== "object" || Array.isArray(m)) return `${at} must be an object`;
    const mod = m as Record<string, unknown>;
    const extra = Object.keys(mod).find(k => !KEYS.has(k));
    if (extra) return `${at}.${extra} is not allowed`;
    if (typeof mod.id !== "string" || !mod.id) return `${at}.id must be a string`;
    if (mod.bridge !== undefined && typeof mod.bridge !== "string") return `${at}.bridge must be a string`;
    if (mod.on !== undefined && typeof mod.on !== "boolean") return `${at}.on must be a boolean`;
    if (mod.target_position !== undefined && !isPercent(mod.target_position)) {
      return `${at}.target_position must be an integer from 0 to 100`;
    }
    if (mod.brightness !== undefined && !isPercent(mod.brightness)) {
      return `${at}.brightness must be an integer from 0 to 100`;
    }
  }
  return null;
}
