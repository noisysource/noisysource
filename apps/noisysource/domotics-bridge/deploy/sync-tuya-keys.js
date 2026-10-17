#!/usr/bin/env node
/**
 * Re-syncs the Tuya device list after a device has been re-paired.
 *
 * Run this whenever a device is removed and added again in SmartLife. Pairing
 * issues a new device id and a new local_key, and the bridge cannot talk to a
 * device whose key it does not hold — the failure looks like `ECONNRESET` on
 * every local connection while the device works perfectly in the app, because
 * the app goes through Tuya's cloud and never uses the local key at all.
 *
 * Two sources, because neither alone is enough:
 *   - the Tuya cloud has the id, name and local_key, but reports the router's
 *     WAN address rather than the device's LAN one
 *   - the devices announce their real LAN address and protocol version over UDP
 *
 * Usage, from the repo root:
 *   node apps/noisysource/domotics-bridge/deploy/sync-tuya-keys.js          # preview
 *   node apps/noisysource/domotics-bridge/deploy/sync-tuya-keys.js --write  # apply
 *
 * Needs `gcloud auth login` to be current. Prints no secrets — local keys
 * appear only as short hashes.
 */
const { createHash, createHmac, createDecipheriv } = require('node:crypto');
const { execSync } = require('node:child_process');
const dgram = require('node:dgram');

const PROJECT = process.env.GCLOUD_PROJECT ?? 'kidclub-dev';
const WRITE = process.argv.includes('--write');
const HOSTS = {
  eu: 'https://openapi.tuyaeu.com', us: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuyacn.com', in: 'https://openapi.tuyain.com',
};
const EMPTY_BODY_SHA = createHash('sha256').update('').digest('hex');
const hash = s => (s ? createHash('sha256').update(s).digest('hex').slice(0, 10) : '(none)');

let TOKEN;
try {
  TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
} catch {
  console.error('gcloud is not authenticated. Run: gcloud auth login');
  process.exit(1);
}
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FS_HEAD = { Authorization: `Bearer ${TOKEN}`, 'x-goog-user-project': PROJECT,
  'Content-Type': 'application/json' };

// ── Firestore value codec (only the shapes this document uses) ───────────────
const encode = v => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v)
    ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: encodeFields(v) } };
};
const encodeFields = o => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)]));
const decode = v => {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decode);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
};
const decodeFields = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decode(v)]));

async function getDoc(path) {
  const r = await fetch(`${FS_BASE}/${path}`, { headers: FS_HEAD });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`firestore GET ${path}: ${r.status} ${await r.text()}`);
  return decodeFields((await r.json()).fields ?? {});
}
async function setDoc(path, data) {
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fetch(`${FS_BASE}/${path}?${mask}`, {
    method: 'PATCH', headers: FS_HEAD, body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!r.ok) throw new Error(`firestore PATCH ${path}: ${r.status} ${await r.text()}`);
}

// ── Tuya cloud ──────────────────────────────────────────────────────────────
function sign(cfg, method, path, t, nonce, accessToken) {
  const stringToSign = `${method}\n${EMPTY_BODY_SHA}\n\n${path}`;
  const payload = cfg.accessId + (accessToken ?? '') + t + nonce + stringToSign;
  return createHmac('sha256', cfg.accessSecret).update(payload).digest('hex').toUpperCase();
}
async function tuya(cfg, method, path, accessToken) {
  const t = String(Date.now());
  const headers = { client_id: cfg.accessId, sign: sign(cfg, method, path, t, '', accessToken),
    t, sign_method: 'HMAC-SHA256', nonce: '' };
  if (accessToken) headers.access_token = accessToken;
  const j = await (await fetch(`${cfg.host}${path}`, { method, headers })).json();
  if (!j.success) throw new Error(`Tuya ${j.code}: ${j.msg}`);
  return j.result;
}

// ── LAN discovery, for the address and protocol version ─────────────────────
const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest();
function discover(ms = 25000) {
  const seen = new Map();
  const socks = [6666, 6667].map(port => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', msg => {
      let buf = msg;
      if (buf.length > 20 && buf.readUInt32BE(0) === 0x000055aa) buf = buf.subarray(20, buf.length - 8);
      let j = null;
      try { j = JSON.parse(buf.toString('utf8')); } catch { /* encrypted */ }
      if (!j) {
        try {
          const d = createDecipheriv('aes-128-ecb', UDP_KEY, null);
          j = JSON.parse(Buffer.concat([d.update(buf), d.final()]).toString('utf8'));
        } catch { return; }
      }
      const id = j.gwId || j.devId || j.id;
      if (id) seen.set(id, { ip: j.ip, version: j.version });
    });
    s.bind(port);
    return s;
  });
  return new Promise(resolve => setTimeout(() => {
    for (const s of socks) { try { s.close(); } catch { /* already closed */ } }
    resolve(seen);
  }, ms));
}

(async () => {
  const cfgDoc = await getDoc('domotics_config/tuya');
  if (!cfgDoc) throw new Error('domotics_config/tuya missing');
  const cfg = { accessId: cfgDoc.accessId, accessSecret: cfgDoc.accessSecret,
    host: HOSTS[cfgDoc.region ?? 'eu'] };

  const existing = (await getDoc('domotics_config/tuya_devices'))?.devices ?? [];
  const prev = Object.fromEntries(existing.map(d => [d.id, d]));

  console.log('Fetching from the Tuya cloud...');
  const tok = await tuya(cfg, 'GET', '/v1.0/token?grant_type=1');
  const cloud = (await tuya(cfg, 'GET',
    '/v1.0/iot-01/associated-users/devices?page_size=100', tok.access_token)).devices ?? [];
  console.log(`  ${cloud.length} devices\n`);

  console.log('Listening for LAN announcements (25s)...');
  const lan = await discover();
  console.log(`  heard ${lan.size}\n`);

  const merged = cloud.map(d => {
    const seen = lan.get(d.id);
    const old = prev[d.id];
    return {
      id: d.id,
      name: d.name,
      category: d.category,
      localKey: d.local_key,
      // The cloud only knows the WAN address, so prefer what the device itself
      // announced; fall back to whatever we had before.
      ip: seen?.ip ?? old?.ip,
      version: seen?.version ?? old?.version ?? '3.3',
    };
  });

  console.log('name                             id                       key         ip               ver  state');
  for (const d of merged) {
    const old = prev[d.id];
    const state = !old ? 'NEW' : old.localKey !== d.localKey ? 'KEY CHANGED' : 'unchanged';
    console.log(`${d.name.slice(0,32).padEnd(33)}${d.id.padEnd(25)}${hash(d.localKey)}  ${String(d.ip ?? '?').padEnd(16)} ${String(d.version).padEnd(4)} ${state}`);
  }
  const gone = existing.filter(e => !merged.some(m => m.id === e.id));
  for (const g of gone) console.log(`${g.name.slice(0,32).padEnd(33)}${g.id.padEnd(25)}${' '.repeat(12)}${String(g.ip ?? '?').padEnd(16)} ${String(g.version).padEnd(4)} REMOVED`);
  const missing = merged.filter(d => !d.ip);
  if (missing.length) {
    console.log(`\n${missing.length} device(s) never announced themselves — they may be asleep or on another network.`);
  }

  if (!WRITE) {
    console.log('\nPreview only. Re-run with --write to apply.');
    return;
  }
  await setDoc('domotics_config/tuya_devices', { devices: merged });
  console.log('\nWritten to domotics_config/tuya_devices.');
  // The restart makes the bridge reload this document and rewrite its local
  // cache. The ARP pins are computed from that cache *before* the bridge
  // starts, so on a restart they still reflect the old IPs — hence a second
  // pin pass once the bridge has written the new list. No second restart is
  // needed: the bridge's backoff retries any device that was unreachable.
  console.log('Now refresh the Pi:');
  console.log('  ssh pi@192.168.1.125 "sudo systemctl restart domotics-bridge && sleep 45 && sudo ~/domotics-bridge/deploy/pin-device-arp.sh"');
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
