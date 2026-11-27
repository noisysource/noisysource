import type { MediaCommand, RoombaPhase, RoombaState } from './types';

/** The pure half of the Roomba driver. */

export const ROOMBA_ACTIONS = ['start', 'pause', 'resume', 'stop', 'dock', 'find'] as const;
export type RoombaAction = typeof ROOMBA_ACTIONS[number];

export function parseRoombaCommands(commands: MediaCommand[]): RoombaAction[] {
  return commands.flatMap(({ code, value }) =>
    code === 'action' && (ROOMBA_ACTIONS as readonly unknown[]).includes(value) ? [value as RoombaAction] : []);
}

/** The local API's command message (dorita980's `_apiCall`, the `cmd` topic). */
export function commandPayload(action: RoombaAction, nowMs = Date.now()) {
  return JSON.stringify({ command: action, time: Math.floor(nowMs / 1000), initiator: 'localApp' });
}

const PHASES: RoombaPhase[] = [
  'charge', 'run', 'pause', 'stop', 'stuck', 'hmUsrDock', 'hmMidMsn', 'hmPostMsn', 'evac', 'chargingerror',
];

/**
 * The robot sends its shadow in pieces: each MQTT message carries
 * `{state: {reported: {...}}}` with a few keys, and the picture is the merge
 * of all of them. Returns the merged `reported`.
 */
export function mergeReported(into: Record<string, unknown>, payload: string | Buffer): Record<string, unknown> {
  try {
    const msg = JSON.parse(payload.toString()) as { state?: { reported?: Record<string, unknown> } };
    const reported = msg?.state?.reported;
    if (reported && typeof reported === 'object') Object.assign(into, reported);
  } catch { /* not a shadow update */ }
  return into;
}

export function readRoomba(base: Pick<RoombaState, 'id' | 'name'>, r: Record<string, unknown>): RoombaState {
  const mission = (r.cleanMissionStatus ?? {}) as Record<string, unknown>;
  const bin = (r.bin ?? {}) as Record<string, unknown>;
  const phase = PHASES.includes(mission.phase as RoombaPhase) ? (mission.phase as RoombaPhase) : 'unknown';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    ...base,
    online: true,
    battery: num(r.batPct),
    phase,
    cycle: typeof mission.cycle === 'string' ? mission.cycle : undefined,
    binFull: typeof bin.full === 'boolean' ? bin.full : undefined,
    missionMinutes: num(mission.mssnM),
    errorCode: num(mission.error),
    notReady: num(mission.notReady),
    lastSeen: Date.now(),
  };
}

/** Enough of the state to show something: without the mission status there is nothing to say. */
export function isComplete(r: Record<string, unknown>) {
  return typeof r.cleanMissionStatus === 'object' && r.cleanMissionStatus !== null && typeof r.batPct === 'number';
}
