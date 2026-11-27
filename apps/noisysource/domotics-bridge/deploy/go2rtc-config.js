#!/usr/bin/env node
/**
 * Writes go2rtc.yaml from the camera list the bridge has cached
 * (media-cache.json, next to lib/), so the passwords are typed once, in
 * media-devices.json, and nowhere else. Run on the Pi after the bridge has
 * started once with the cameras configured, and again after any camera
 * change; then `sudo systemctl restart go2rtc`.
 *
 *   node deploy/go2rtc-config.js
 *
 * Two streams per camera, the names the bridge and the app expect
 * (src/media/tapo.ts, streamName): `cam_<id>` (stream1, full resolution) and
 * `cam_<id>_sd` (stream2, 640×360), which the app plays and snapshots come
 * from. The Pi 1 copes with the second; the first is there for a computer.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '..');
let cameras;
try {
  cameras = JSON.parse(readFileSync(join(dir, 'media-cache.json'), 'utf8')).cameras ?? [];
} catch {
  console.error('No media-cache.json next to lib/: start the bridge once with the cameras configured.');
  process.exit(1);
}
if (cameras.length === 0) { console.error('No cameras in media-cache.json.'); process.exit(1); }

const rtsp = (c, stream) =>
  `rtsp://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.ip}:554/${stream}`;
const q = s => JSON.stringify(s);

const yaml = [
  '# Written by deploy/go2rtc-config.js from media-cache.json. Holds the cameras\' passwords: 0600, not in git.',
  'api:',
  '  listen: ":1984"',
  '  # Anyone on the house network can watch the cameras through this port, as with the cameras themselves.',
  '  # To ask for a password, add username/password here (the browser will prompt once).',
  'rtsp:',
  '  listen: ""   # go2rtc does not re-serve RTSP; nothing needs it',
  'webrtc:',
  '  listen: ":8555"',
  'log:',
  '  level: warn',
  'streams:',
  ...cameras.flatMap(c => [
    `  cam_${c.id}: ${q(rtsp(c, 'stream1'))}`,
    `  cam_${c.id}_sd: ${q(rtsp(c, 'stream2'))}`,
  ]),
  '',
].join('\n');

const out = join(dir, 'go2rtc.yaml');
writeFileSync(out, yaml, { mode: 0o600 });
console.log(`Wrote ${out}: ${cameras.map(c => c.id).join(', ')}`);
