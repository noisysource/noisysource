// The TV, the Roomba and the cameras (src/media/), without any of them in the
// room: config validation, command parsing, the TV's and the robot's answers,
// the ONVIF envelope, and the bridge's own endpoints and snapshot limits
// against a stand-in go2rtc. Run: pnpm --filter domotics-bridge test.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parseMediaConfig } = require('../lib/media/config.js');
const { parseTvCommands, readVolume, readInputs, readApps, readPower } = require('../lib/media/lgtv-logic.js');
const { parseRoombaCommands, commandPayload, mergeReported, readRoomba, isComplete } = require('../lib/media/roomba-logic.js');
const { usernameToken, envelope, continuousMoveBody, stopBody, firstProfileToken, faultReason } = require('../lib/media/onvif.js');
const { parsePtz, streamName } = require('../lib/media/tapo.js');
const { isMediaId } = require('../lib/media/types.js');
const { createMedia, snapshotDoc } = require('../lib/media/index.js');
const { startHttp } = require('../lib/http.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── Config ──────────────────────────────────────────────────────────────────
test('config keeps good entries and says why it drops the rest', () => {
  const warnings = [];
  const c = parseMediaConfig({
    tvs: [{ id: 'sala', name: 'TV da sala', ip: '192.168.1.140', mac: 'AA-BB-CC-DD-EE-FF' }, { id: 'x', ip: '300.1.1.1' }],
    roombas: [{ id: 'r1', ip: '192.168.1.141', blid: 'ABC', password: ':1:abc' }, { id: 'r2', ip: '192.168.1.142', blid: 'X' }],
    cameras: [
      { id: 'entrada', name: 'Entrada', ip: '192.168.1.150', username: 'cam', password: 'pw', ptz: true },
      { id: 'entrada', ip: '192.168.1.151', username: 'cam', password: 'pw' },
      { id: 'Bad Id', ip: '192.168.1.152', username: 'cam', password: 'pw' },
    ],
  }, m => warnings.push(m));
  assert.deepEqual(c.tvs, [{ id: 'sala', name: 'TV da sala', ip: '192.168.1.140', mac: 'aa:bb:cc:dd:ee:ff' }]);
  assert.equal(c.roombas.length, 1);
  assert.equal(c.cameras.length, 1);
  assert.equal(c.cameras[0].ptz, true);
  assert.equal(warnings.length, 4, warnings.join('\n'));
  assert.ok(warnings.some(w => w.includes('missing password')));
  assert.ok(warnings.some(w => w.includes('duplicate')));
});

test('an empty or broken config is an empty house, not a crash', () => {
  assert.deepEqual(parseMediaConfig(null), { tvs: [], roombas: [], cameras: [] });
  assert.deepEqual(parseMediaConfig({ tvs: 'nope' }), { tvs: [], roombas: [], cameras: [] });
});

test('media ids never collide with Tuya ids', () => {
  assert.ok(isMediaId('tv:sala') && isMediaId('roomba:r1') && isMediaId('cam:entrada'));
  assert.ok(!isMediaId('bf1234567890abcdef') && !isMediaId('television'));
});

// ── TV ──────────────────────────────────────────────────────────────────────
test('TV commands: only what the app may send gets through', () => {
  const a = parseTvCommands([
    { code: 'volume', value: 140 }, { code: 'volume', value: 'loud' }, { code: 'mute', value: true },
    { code: 'input', value: 'HDMI_1' }, { code: 'input', value: 'x; rm -rf /' }, { code: 'app', value: 'netflix' },
    { code: 'button', value: 'HOME' }, { code: 'button', value: 'POWER' }, { code: 'media', value: 'pause' },
    { code: 'power', value: false }, { code: 'pair', value: true }, { code: 'turnOff', value: true },
  ]);
  assert.deepEqual(a.map(x => x.kind), ['volume', 'mute', 'input', 'app', 'button', 'media', 'power', 'pair']);
  assert.equal(a[0].level, 100);
});

test('TV volume in both shapes webOS has used', () => {
  assert.deepEqual(readVolume({ volume: 12, muted: false }), { volume: 12, muted: false });
  assert.deepEqual(readVolume({ volumeStatus: { volume: 20, muteStatus: true } }), { volume: 20, muted: true });
  assert.deepEqual(readVolume(undefined), { volume: undefined, muted: undefined });
});

test('TV inputs, apps and power', () => {
  assert.deepEqual(readInputs({ devices: [{ id: 'HDMI_1', label: 'PlayStation' }, { label: 'no id' }] }),
    [{ id: 'HDMI_1', label: 'PlayStation' }]);
  assert.deepEqual(readApps({ launchPoints: [{ id: 'netflix', title: 'Netflix' }, { id: 'hidden', visible: false }] }),
    [{ id: 'netflix', title: 'Netflix' }]);
  assert.equal(readApps({ launchPoints: Array.from({ length: 40 }, (_, i) => ({ id: `a${i}` })) }).length, 24);
  assert.equal(readPower('Active', true), 'on');
  assert.equal(readPower('Active Standby', true), 'standby');
  assert.equal(readPower('screen_off', true), 'screen_off');
  assert.equal(readPower(undefined, true), 'on');
  assert.equal(readPower(undefined, false), 'off');
});

// ── Roomba ──────────────────────────────────────────────────────────────────
test('Roomba commands and the message the robot expects', () => {
  assert.deepEqual(parseRoombaCommands([{ code: 'action', value: 'dock' }, { code: 'action', value: 'reboot' }, { code: 'x', value: 'start' }]), ['dock']);
  assert.deepEqual(JSON.parse(commandPayload('start', 1_764_000_000_123)),
    { command: 'start', time: 1_764_000_000, initiator: 'localApp' });
});

test('Roomba state is the merge of the shadow pieces it sends', () => {
  const r = {};
  mergeReported(r, Buffer.from(JSON.stringify({ state: { reported: { batPct: 87, name: 'Roomba' } } })));
  assert.equal(isComplete(r), false);
  mergeReported(r, JSON.stringify({ state: { reported: { cleanMissionStatus: { cycle: 'clean', phase: 'run', mssnM: 12, error: 0, notReady: 0 }, bin: { present: true, full: false } } } }));
  mergeReported(r, 'not json');
  assert.equal(isComplete(r), true);
  const s = readRoomba({ id: 'roomba:r1', name: 'Roomba' }, r);
  assert.equal(s.battery, 87); assert.equal(s.phase, 'run'); assert.equal(s.cycle, 'clean');
  assert.equal(s.missionMinutes, 12); assert.equal(s.binFull, false); assert.equal(s.online, true);
  assert.equal(readRoomba({ id: 'roomba:r1', name: 'R' }, { cleanMissionStatus: { phase: 'weird' } }).phase, 'unknown');
});

// ── Cameras ─────────────────────────────────────────────────────────────────
test('ONVIF digest is SHA1(nonce + created + password), base64', () => {
  const nonce = Buffer.from('0123456789abcdef');
  const created = new Date('2026-11-27T15:00:00.000Z');
  const t = usernameToken('cam', 's3cr&t', nonce, created);
  const expected = createHash('sha1').update(Buffer.concat([nonce, Buffer.from('2026-11-27T15:00:00.000Z'), Buffer.from('s3cr&t')])).digest('base64');
  assert.equal(t.digest, expected);
  assert.equal(t.nonce, nonce.toString('base64'));
  const xml = envelope(continuousMoveBody('profile_1', 'left'), 'c<a>m', 's3cr&t', nonce, created);
  assert.ok(xml.includes('<Username>c&lt;a&gt;m</Username>'));
  assert.ok(xml.includes(`>${expected}</Password>`));
  assert.ok(xml.includes('<PanTilt x="-0.5" y="0"'));
  assert.ok(!xml.includes('s3cr&t'), 'the password itself never travels');
  assert.ok(stopBody('p"1').includes('<ProfileToken>p&quot;1</ProfileToken>'));
});

test('ONVIF answers: profile token and faults, whatever the namespace prefix', () => {
  assert.equal(firstProfileToken('<trt:GetProfilesResponse><trt:Profiles fixed="true" token="profile_1"><tt:Name>main</tt:Name></trt:Profiles><trt:Profiles token="profile_2"/>'), 'profile_1');
  assert.equal(firstProfileToken('<Envelope/>'), undefined);
  assert.equal(faultReason('<env:Fault><env:Reason><env:Text xml:lang="en">Sender not authorized</env:Text></env:Reason></env:Fault>'), 'Sender not authorized');
  assert.equal(faultReason('<ok/>'), undefined);
  assert.deepEqual(parsePtz([{ code: 'ptz', value: 'up' }, { code: 'ptz', value: 'spin' }]), ['up']);
  assert.equal(streamName('entrada', true), 'cam_entrada_sd');
});

// ── The bridge's endpoints and limits, against a stand-in go2rtc ────────────
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('snapshots and the relay: caps hold, state is published to its own document', async () => {
  let frames = 0;
  const go2rtc = createServer((req, res) => {
    if (req.url.startsWith('/api/streams')) { res.end(JSON.stringify({ cam_entrada: {}, cam_entrada_sd: {} })); return; }
    if (req.url.startsWith('/api/frame.jpeg?src=cam_entrada_sd')) { frames++; res.end(JPEG); return; }
    res.statusCode = 404; res.end();
  });
  const port = await listen(go2rtc);
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  writeFileSync(join(dir, 'media-cache.json'), JSON.stringify({
    cameras: [{ id: 'entrada', name: 'Entrada', ip: '127.0.0.1', username: 'cam', password: 'pw' }],
  }));
  const writes = [];
  const db = { getDoc: async () => { throw new Error('offline'); }, setDoc: async (p, d) => { writes.push([p, d]); } };
  const media = createMedia({ db, relay: true, dir, go2rtcLocal: `http://127.0.0.1:${port}`, liveBase: 'http://192.168.1.125:1984' });
  await media.start();
  assert.ok(media.owns('cam:entrada'));
  assert.ok(!media.owns('cam:quintal'));

  await media.relaySnapshot('cam:entrada');
  const [path, doc] = writes.find(([p]) => p.startsWith('domotics_state/snap_'));
  assert.equal(path, snapshotDoc('entrada'));
  assert.equal(Buffer.from(doc.image, 'base64').length, JPEG.length);
  await assert.rejects(media.relaySnapshot('cam:entrada'), /every 10 seconds/);
  await assert.rejects(media.relaySnapshot('cam:quintal'), /unknown camera/);
  assert.equal(frames, 1, 'a refused snapshot never reaches the camera');

  // Watching triggers a poll, which publishes to domotics_state/media and nowhere near domotics_state/tuya.
  media.watch();
  for (let i = 0; i < 40 && !writes.some(([p]) => p === 'domotics_state/media'); i++) await new Promise(r => setTimeout(r, 100));
  const published = writes.find(([p]) => p === 'domotics_state/media');
  assert.ok(published, 'media state published');
  assert.equal(published[1].watchable, true);
  assert.equal(published[1].cameras[0].live, true);
  assert.equal(published[1].liveBase, 'http://192.168.1.125:1984');
  assert.ok(!JSON.stringify(published[1]).includes('pw'), 'no password in the published state');
  assert.ok(!writes.some(([p]) => p === 'domotics_state/tuya'));
  go2rtc.close();
});

test('HTTP: /media, snapshots, and media ids routed away from the Tuya path', async () => {
  const tuyaCalls = [];
  const mediaCalls = [];
  const fakeMedia = {
    state: () => ({ tvs: [], roombas: [], cameras: [], liveBase: null, updatedAt: 1 }),
    watch: () => mediaCalls.push('watch'),
    command: async (id, cmds) => { mediaCalls.push(`${id}:${cmds[0].code}`); },
    snapshot: async id => { if (id !== 'cam:entrada') throw new Error('unknown camera'); return JPEG; },
  };
  const server = startHttp(0, {
    getState: () => ({ devices: [], updatedAt: 0 }),
    sendCommand: async id => { tuyaCalls.push(id); },
    refresh: async () => {},
    media: fakeMedia,
  });
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const m = await fetch(`${base}/media`);
  assert.equal(m.status, 200);
  assert.equal((await m.json()).updatedAt, 1);
  const r = await post({ deviceId: 'tv:sala', commands: [{ code: 'mute', value: true }] });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).media);
  await post({ deviceId: 'bf123', commands: [{ code: 'temp_set', value: 210 }] });
  assert.deepEqual(mediaCalls, ['watch', 'tv:sala:mute']);
  assert.deepEqual(tuyaCalls, ['bf123']);

  const img = await fetch(`${base}/media/snapshot?id=cam:entrada`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, JPEG.length);
  assert.equal((await fetch(`${base}/media/snapshot?id=cam:nope`)).status, 502);
  server.close();
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n${err.stack}`); }
  }
  if (failed) { console.error(`${failed} media test(s) failed`); process.exit(1); }
  console.log(`media: ${tests.length} tests passed`);
  process.exit(0);
})();
