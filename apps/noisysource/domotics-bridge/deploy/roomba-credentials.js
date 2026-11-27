#!/usr/bin/env node
/**
 * Gets a Roomba's BLID and local password, the two things the bridge needs to
 * talk to it (dorita980's method, without dorita980).
 *
 * Run it on a computer on the house network (the Mac, or the Pi):
 *   node deploy/roomba-credentials.js              # find robots on the network
 *   node deploy/roomba-credentials.js 192.168.1.141
 *
 * With an IP: put the robot on its dock, powered on. Hold its HOME button
 * (DOCK+SPOT on some models) until it plays a series of tones, about two
 * seconds, and let go: the Wi-Fi light flashes. Then press Enter here within
 * a minute or so.
 *
 * Newer robots (j and some i series on recent firmware) no longer hand the
 * password out locally. If this ends with "the robot didn't give a password",
 * take it from the iRobot cloud instead, e.g. with dorita980's
 * `get-roomba-password-cloud`, and put it in media-devices.json by hand.
 *
 * Prints the password: run it where nobody is reading over your shoulder, and
 * don't paste the output anywhere but media-devices.json.
 */
const dgram = require('node:dgram');
const tls = require('node:tls');
const { constants } = require('node:crypto');

const ip = process.argv[2];

function discover(target, timeoutMs = 4000) {
  return new Promise(resolve => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', msg => {
      try {
        const m = JSON.parse(msg.toString());
        const [kind, blid] = String(m.hostname ?? '').split('-');
        if ((kind === 'Roomba' || kind === 'iRobot') && m.ip) found.set(m.ip, { ...m, blid });
      } catch { /* not a robot */ }
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      const probe = Buffer.from('irobotmcs');
      sock.send(probe, 5678, target ?? '255.255.255.255');
    });
    setTimeout(() => { sock.close(); resolve([...found.values()]); }, timeoutMs);
  });
}

function password(host) {
  return new Promise((resolve, reject) => {
    let sliceFrom = 13;
    const s = tls.connect(8883, host, {
      timeout: 10000, rejectUnauthorized: false,
      ciphers: process.env.ROOMBA_CIPHERS ?? 'AES128-SHA256:TLS_AES_256_GCM_SHA384:DEFAULT:@SECLEVEL=0',
      secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
    }, () => s.write(Buffer.from('f005efcc3b2900', 'hex')));
    s.on('data', data => {
      if (data.length === 2) { sliceFrom = 9; return; }
      s.end();
      if (data.length <= 7) reject(new Error("the robot didn't give a password (was HOME held until the tones?)"));
      else resolve(data.subarray(sliceFrom).toString().replace(/\0+$/, ''));
    });
    s.on('timeout', () => { s.destroy(); reject(new Error('no answer on 8883')); });
    s.on('error', reject);
  });
}

(async () => {
  if (!ip) {
    const robots = await discover();
    if (robots.length === 0) { console.log('No robot answered. Same network? Robot awake (not in deep sleep)?'); return; }
    for (const r of robots) console.log(`${r.robotname ?? r.hostname}  ip ${r.ip}  blid ${r.blid}  ${r.sku ?? ''}  firmware ${r.sw ?? '?'}`);
    console.log('\nThen: node deploy/roomba-credentials.js <ip>');
    return;
  }
  const [info] = await discover(ip);
  if (info) console.log(`Found ${info.robotname ?? info.hostname}: blid ${info.blid}, firmware ${info.sw ?? '?'}`);
  else console.log('The robot did not answer the discovery packet; carrying on, but check the IP.');
  console.log('\nHold HOME on the robot until it plays the tones, release it, then press Enter here.');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();
  try {
    const pw = await password(ip);
    console.log(`\n"blid": "${info?.blid ?? '(see above)'}",\n"password": "${pw}"`);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
})();
