import { continuousMoveBody, envelope, faultReason, firstProfileToken, getProfilesBody, stopBody, type PtzDirection } from './onvif';
import { probe } from './net';
import type { CameraConfig, CameraState, MediaCommand } from './types';

/**
 * Tapo cameras. The bridge doesn't touch video: on a 256 MB Pi 1 with a
 * 140 MB cgroup it can't decode H.264 without risking the heating. Video goes
 * through go2rtc, its own service with its own memory (deploy/go2rtc.md):
 * it repackages the camera's RTSP for the browser without transcoding, and
 * makes the JPEG snapshots. The bridge only
 *   - says whether a camera is there (RTSP port answers),
 *   - pans and tilts it over ONVIF,
 *   - asks go2rtc for a snapshot, to hand to an app outside the house through
 *     the relay.
 */

const ONVIF_PORT = 2020;
const ONVIF_TIMEOUT_MS = 6_000;
/** How long one press keeps the camera moving. About 15° on a C200. */
const PTZ_PULSE_MS = 600;
const SNAPSHOT_TIMEOUT_MS = 25_000;
/** A snapshot from a Tapo sub-stream is 30–80 kB; refuse anything near Firestore's 1 MiB document limit. */
export const SNAPSHOT_MAX_BYTES = 600_000;

/** The go2rtc stream names for a camera (deploy/go2rtc-config.js writes the same). */
export const streamName = (id: string, sd = false) => `cam_${id}${sd ? '_sd' : ''}`;

export function parsePtz(commands: MediaCommand[]): PtzDirection[] {
  return commands.flatMap(({ code, value }) =>
    code === 'ptz' && (value === 'left' || value === 'right' || value === 'up' || value === 'down') ? [value] : []);
}

export function createCamera(config: CameraConfig, go2rtcLocal: string | null) {
  const base = { id: `cam:${config.id}`, name: config.name, ptz: config.ptz === true };
  let last: CameraState = { ...base, online: false, live: false };
  let profile: string | undefined;

  async function soap(body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ONVIF_TIMEOUT_MS);
    try {
      const resp = await fetch(`http://${config.ip}:${ONVIF_PORT}/onvif/service`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
        body: envelope(body, config.username, config.password),
        signal: controller.signal,
      });
      const xml = await resp.text();
      const fault = faultReason(xml);
      if (fault || !resp.ok) throw new Error(`ONVIF: ${fault ?? `HTTP ${resp.status}`}`);
      return xml;
    } finally {
      clearTimeout(timer);
    }
  }

  async function move(dir: PtzDirection) {
    if (!config.ptz) throw new Error(`${config.name} has no pan/tilt (set "ptz": true if it does)`);
    profile ??= firstProfileToken(await soap(getProfilesBody()));
    if (!profile) throw new Error('ONVIF: no media profile');
    await soap(continuousMoveBody(profile, dir));
    await new Promise(r => setTimeout(r, PTZ_PULSE_MS));
    await soap(stopBody(profile));
  }

  async function read(liveStreams: Set<string>): Promise<CameraState> {
    const online = await probe(config.ip, 554);
    last = {
      ...base, online, live: liveStreams.has(streamName(config.id, true)),
      error: online ? undefined : 'sem resposta na rede', lastSeen: online ? Date.now() : last.lastSeen,
    };
    return last;
  }

  /** A JPEG from go2rtc's sub-stream. Throws if go2rtc isn't there or the camera isn't answering. */
  async function snapshot(): Promise<Buffer> {
    if (!go2rtcLocal) throw new Error('go2rtc is not set up (GO2RTC_URL)');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
    try {
      const resp = await fetch(`${go2rtcLocal}/api/frame.jpeg?src=${encodeURIComponent(streamName(config.id, true))}`,
        { signal: controller.signal });
      if (!resp.ok) throw new Error(`go2rtc answered ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('go2rtc did not return a JPEG');
      if (buf.length > SNAPSHOT_MAX_BYTES) throw new Error(`snapshot too large (${buf.length} bytes)`);
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  async function command(commands: MediaCommand[]) {
    const moves = parsePtz(commands);
    if (moves.length === 0) throw new Error('no camera command understood');
    // At most two presses per command: a held button in the app sends one per press.
    for (const dir of moves.slice(0, 2)) await move(dir);
  }

  return { id: base.id, read, command, snapshot, close: () => {}, current: () => last };
}

export type Camera = ReturnType<typeof createCamera>;

/** Stream names go2rtc has configured, or an empty set if it isn't running. */
export async function go2rtcStreams(go2rtcLocal: string | null): Promise<Set<string>> {
  if (!go2rtcLocal) return new Set();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const resp = await fetch(`${go2rtcLocal}/api/streams`, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!resp.ok) return new Set();
    return new Set(Object.keys((await resp.json()) as Record<string, unknown>));
  } catch {
    return new Set();
  }
}
