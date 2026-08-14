import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { totalmem, freemem, loadavg, uptime } from 'node:os';

const run = promisify(execFile);

/**
 * Remote administration over the existing relay.
 *
 * The bridge never accepts an inbound connection — that is what lets it sit
 * behind NAT with no port forwarding, and it is worth keeping. The cost is that
 * from outside the house there is no way to see why something is wrong, or to
 * restart anything. Every question that came up while away was unanswerable for
 * exactly this reason.
 *
 * So administration travels the same outbound path as device commands: the
 * bridge polls for work and posts results back. No port is opened and no third
 * party is introduced.
 *
 * A FIXED ALLOWLIST, DELIBERATELY. This is a remote-execution channel into a
 * private house, so it must never grow an "arbitrary command" action however
 * convenient that would be. Each action below is a named operation with no
 * caller-supplied shell input; the only argument accepted anywhere is a line
 * count, which is parsed as a number and clamped. Anything else is refused.
 */

export const ADMIN_ACTIONS = ['status', 'logs', 'restart', 'refresh'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export function isAdminAction(value: unknown): value is AdminAction {
  return typeof value === 'string' && (ADMIN_ACTIONS as readonly string[]).includes(value);
}

export interface AdminDeps {
  /** Current device state, for the summary in `status`. */
  getState: () => { devices: Array<{ name: string; online: boolean }>; updatedAt: number };
  /** Force a device poll, for `refresh`. */
  refresh: () => Promise<void>;
  /** Requests process exit so systemd restarts us, for `restart`. */
  requestRestart: () => void;
}

const MAX_LOG_LINES = 200;
const DEFAULT_LOG_LINES = 60;
const EXEC_TIMEOUT_MS = 10_000;

function mb(bytes: number) {
  return `${Math.round(bytes / 1048576)}MB`;
}

function humanDuration(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Best-effort: a missing tool must degrade to a note, never fail the report. */
async function tryRun(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { timeout: EXEC_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function status(deps: AdminDeps): Promise<string> {
  const state = deps.getState();
  const online = state.devices.filter(d => d.online).length;
  const offline = state.devices.filter(d => !d.online).map(d => d.name);

  const df = await tryRun('df', ['-h', '/']);
  const diskLine = df?.split('\n')[1]?.split(/\s+/) ?? [];
  // Undervoltage on this board looks like random crashes and SD corruption, so
  // it is worth surfacing rather than diagnosing from the symptoms later.
  const throttled = await tryRun('vcgencmd', ['get_throttled']);
  const temp = await tryRun('vcgencmd', ['measure_temp']);

  const stateAge = state.updatedAt ? Math.round((Date.now() - state.updatedAt) / 1000) : null;

  return [
    `devices     ${online}/${state.devices.length} online` +
      (offline.length ? ` — down: ${offline.join(', ')}` : ''),
    `last poll   ${stateAge === null ? 'never' : `${stateAge}s ago`}`,
    `bridge up   ${humanDuration(process.uptime())}`,
    `bridge mem  ${mb(process.memoryUsage().rss)}`,
    `host up     ${humanDuration(uptime())}`,
    `host mem    ${mb(totalmem() - freemem())} used of ${mb(totalmem())}`,
    `load        ${loadavg().map(n => n.toFixed(2)).join(' ')}`,
    `disk        ${diskLine[2] ?? '?'} used of ${diskLine[1] ?? '?'} (${diskLine[4] ?? '?'} full)`,
    `throttled   ${throttled ?? 'unavailable'}${throttled === 'throttled=0x0' ? '  (power OK)' : ''}`,
    `temp        ${temp?.replace('temp=', '') ?? 'unavailable'}`,
    `node        ${process.version}`,
  ].join('\n');
}

async function logs(lines: number): Promise<string> {
  const n = Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(lines) || DEFAULT_LOG_LINES));
  const out = await tryRun('journalctl', [
    '-u', 'domotics-bridge', '-n', String(n), '--no-pager', '--output', 'short-iso',
  ]);
  return out ?? 'journalctl unavailable — is this running under systemd, and is the user in the adm group?';
}

export async function runAdminAction(
  action: AdminAction,
  args: { lines?: number } | undefined,
  deps: AdminDeps,
): Promise<string> {
  switch (action) {
    case 'status':
      return status(deps);
    case 'logs':
      return logs(args?.lines ?? DEFAULT_LOG_LINES);
    case 'refresh':
      await deps.refresh();
      return `Refreshed. ${deps.getState().devices.filter(d => d.online).length}/` +
        `${deps.getState().devices.length} devices online.`;
    case 'restart':
      // Exit rather than calling systemctl: the unit restarts on any exit, so
      // this needs no privileges and cannot be turned into a general-purpose
      // way of running things as root.
      deps.requestRestart();
      return 'Restarting. The supervisor will bring the bridge back in a few seconds.';
  }
}
