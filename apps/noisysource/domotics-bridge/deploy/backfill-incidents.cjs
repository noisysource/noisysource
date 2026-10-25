#!/usr/bin/env node
// Backfill `domotics_incidents` with the heat pump's E13 history, so the
// Reports page opens with the real record rather than empty.
//
// The hand-run logger's files (this folder) are replayed through the bridge's
// own recorder (lib/incidents.js), so a trip from the logs is recorded by the
// same rules as one the bridge sees live. Trips and switch-offs known only from
// STATUS.md (no readings) are added as `origin: 'notes'`, and what the notes
// say about who switched the pump is laid over the log's transitions (the
// logger saw the pump change, not who changed it).
//
// Ids are stable, so running it again overwrites rather than duplicates.
//
//   pnpm build                                     # lib/ is what is replayed
//   node deploy/backfill-incidents.cjs             # dry run: prints what it would write
//   node deploy/backfill-incidents.cjs --write     # writes to kidclub-dev, as you (gcloud)
//   ... --log ~/e13-2026-10-22.jsonl@2026-10-22    # a newer copy of the 20 s log from the Pi
//   ... --until 2026-10-25T10:00:00Z               # stop where the bridge started recording live
//   ... --guard-log ~/guard.log                    # the hand-run guard's log: its switches get attributed to it
//
// Writes go through the Firestore REST API with your gcloud token (admin,
// bypasses the rules), never the bridge's account.
const { readFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const { createRecorder } = require('../lib/incidents.js');
const { decodeFaults } = require('../lib/faults.js');
const { encodeFields } = require('../lib/firestore-rest.js');

const HERE = __dirname;
/** file @ local date of its first line. */
const DEFAULT_LOGS = [
  `${HERE}/e13-test-2026-10-21.jsonl@2026-10-21`,
  `${HERE}/e13-night-2026-10-21.jsonl@2026-10-21`,
  `${HERE}/e13-2026-10-22-to-24.jsonl.gz@2026-10-22`,
];
const PUMP_NAME = 'Bomba piso radiante Eiras';

// --- Lisbon wall time -> UTC -------------------------------------------------
// The logger wrote local time (Europe/Lisbon). The clocks go back on the last
// Sunday of October, so an hour repeats; `notBefore` (the previous line — the
// logger's lines only move forward) picks the second one once the first has passed.
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Lisbon', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function wallOf(utc) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
function lisbon(dateStr, timeStr, notBefore) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s = 0] = timeStr.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const found = [60, 0].map(off => wall - off * 60_000).filter(utc => wallOf(utc) === wall).sort((a, b) => a - b);
  if (found.length === 0) throw new Error(`no such Lisbon time ${dateStr} ${timeStr}`);
  return found.find(c => notBefore === undefined || c >= notBefore) ?? found[found.length - 1];
}
const secs = t => t.split(':').map(Number).reduce((a, v, i) => a + v * [3600, 60, 1][i], 0);
const addDays = (dateStr, n) => new Date(Date.parse(`${dateStr}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// --- Reading the logs --------------------------------------------------------

/**
 * One file -> pump samples, plus the times the pump had no reading (`gaps`).
 * Two shapes: per minute (21/10: `fault`/`raw_fault`, `valves_open`) and per
 * 20 s (22/10 on: `read`, `faults` map, `zones` = the valves open, `?` = a
 * stale thermostat reading).
 */
function readLog(path, startDate) {
  const raw = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  const samples = [];
  const gaps = [];
  let day = 0;
  let prevSec;
  let prevT;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue; // the 21/10 test log has two notes of its own at the end
    const r = JSON.parse(line);
    const sec = secs(r.t);
    if (prevSec !== undefined && sec < prevSec - 12 * 3600) day++;
    prevSec = sec;
    const date = addDays(startDate, day);
    const loggedAt = lisbon(date, r.t, prevT);
    prevT = loggedAt;
    if (r.on === undefined || r.pump_online === false) { gaps.push(loggedAt); continue; }
    let t = loggedAt;
    if (r.read !== undefined) {
      if (r.read === '01:00:00') { gaps.push(loggedAt); continue; } // bridge state from epoch 0: nothing read yet
      // When the bridge read it: seconds to minutes before the line was logged.
      t = loggedAt - (((sec - secs(r.read)) % 86_400) + 86_400) % 86_400 * 1000;
    }
    if (samples.length && samples[samples.length - 1].t >= t) continue; // same bridge reading logged twice
    const faults = r.faults !== undefined
      ? decodeFaults(code => r.faults[code])
      : decodeFaults(code => (code === 'fault' ? r.raw_fault ?? r.fault : 0));
    samples.push({
      t,
      on: r.on === true,
      hz: r.hz ?? 0,
      sp: r.sp ?? undefined,
      out: r.out ?? undefined,
      inn: r.inn ?? undefined,
      dis: r.dis ?? undefined,
      outdoor: r.outdoor ?? undefined,
      coil: r.coil ?? undefined,
      suct: r.suct ?? undefined,
      faults,
      valves: r.zones ? Object.keys(r.zones).filter(k => !k.endsWith('?')).length : r.valves_open,
    });
  }
  return { samples, gaps };
}

// --- What the notes add (STATUS.md, the technician report) -------------------

const L = (date, time) => lisbon(date, time);
/** Who switched the pump, where the notes know. Matched to a log transition within 3 min. */
const KNOWN_SWITCHES = [
  { at: L('2026-10-22', '00:55'), on: false, source: 'outside', note: 'Não foi pela ponte nem pelo cliente; talvez ação remota da assistência.' },
  { at: L('2026-10-22', '07:58'), on: true, source: 'app', note: 'Ligada pela ponte (sessão de diagnóstico), água a 35 °C.' },
  { at: L('2026-10-23', '00:54'), on: false, source: 'outside', note: 'Desligada ainda em E13. Não foi o cliente.' },
  { at: L('2026-10-23', '06:03'), on: true, source: 'outside', note: 'Ligada e setpoint para 44 °C às 06:04, ainda em E13. Não foi o cliente (técnicos?).' },
  { at: L('2026-10-23', '20:14'), on: false, source: 'app', note: 'Tentativa de rearme pela ponte (desligar 70 s e ligar): o E13 continuou.' },
  { at: L('2026-10-23', '20:15'), on: true, source: 'app', note: 'Tentativa de rearme pela ponte: o E13 continuou.' },
  { at: L('2026-10-23', '20:26'), on: false, source: 'app', note: 'Tentativa de rearme pela ponte (modo arrefecimento e de volta): o E13 continuou.' },
  { at: L('2026-10-23', '20:27'), on: true, source: 'app', note: 'Tentativa de rearme pela ponte: o E13 continuou.' },
  { at: L('2026-10-24', '00:54'), on: false, source: 'outside', note: 'A trabalhar a 70 Hz sem avaria. Mesma hora que na noite anterior: temporizador? Não foi a ponte nem a proteção.' },
  { at: L('2026-10-24', '04:21'), on: true, source: 'app', note: 'Ligada de novo pela ponte.' },
  { at: L('2026-10-24', '08:10'), on: false, source: 'guard', note: 'Proteção E13 (script manual): no setpoint a 44 Hz, água a 43 °C — descanso de 60 min.' },
  { at: L('2026-10-24', '09:10'), on: true, source: 'guard', note: 'Proteção E13 (script manual): fim do descanso.' },
  { at: L('2026-10-24', '11:06'), on: false, source: 'guard', note: 'Proteção E13 (script manual): no setpoint a 44 Hz, água a 43 °C — descanso de 60 min.' },
  { at: L('2026-10-24', '12:06'), on: true, source: 'guard', note: 'Proteção E13 (script manual): fim do descanso.' },
  { at: L('2026-10-24', '12:27'), on: false, source: 'outside', note: 'Desligada a 70 Hz, sem avaria. Não foi a proteção nem a ponte.' },
];
/** What the notes add to trips the logs saw. */
const KNOWN_FAULTS = [
  {
    at: L('2026-10-21', '11:45'),
    note: 'Teste com a água a 39 °C; só 1 das 4 válvulas legíveis aberta. O registo terminou com o disparo; às 16:18 a avaria já estava limpa (não pela ponte) e a bomba a trabalhar a 34 °C.',
  },
  { at: L('2026-10-22', '00:25'), note: '3–4 zonas abertas e diferença saída–entrada normal: não parece ser só falta de caudal. Setpoint para 38 °C às 00:28, na bomba/SmartLife.' },
  { at: L('2026-10-22', '12:53'), note: 'Rearmada às 19:11, não pelo cliente (técnicos?).' },
  { at: L('2026-10-22', '23:25'), note: 'Sem aquecimento a noite toda. Rearme remoto pela ponte não funciona; limpou com o disjuntor às 20:33 de 23/10 (Renato).' },
];

/** Trips and events with no readings, from STATUS.md and the technician report (v4, 23/10). */
function notesOnly(device) {
  const base = { device: device.id, deviceName: device.name, origin: 'notes', updatedAt: new Date() };
  const fault = (id, at, extra) => [id, {
    ...base, kind: 'fault', code: 'E13', codes: ['E13'], at: new Date(at), status: 'unknown',
    lockout: false, lockoutAt: null, lockoutWhy: null, endedAt: null, endedHow: null, restartedAt: null,
    offlineDuring: false, previousId: null, minutesSincePrevious: null, before: [], after: [], actions: [], ...extra,
  }];
  return [
    fault('fault-notes-2026-10-02-E13', L('2026-10-02', '12:09'), {
      note: 'Visto às ~12:09 com a água a 42 °C: compressor parado, exterior 22,3 °C, água entrada/saída 33,0/33,0 °C. Sem registo contínuo.',
    }),
    ['note-2026-10-16-intervencao', {
      ...base, kind: 'note', at: new Date(L('2026-10-16', '12:00')),
      note: 'Intervenção na máquina; E13 dado como resolvido.',
    }],
    fault('fault-notes-2026-10-17-E13', L('2026-10-17', '14:18'), {
      note: 'Visto às 14:18 com a água a 42 °C: máquina parada e desligada, exterior 24,7 °C, água 25,5/26,3 °C. Sem registo contínuo.',
    }),
    ['switch-notes-2026-10-20-off', {
      ...base, kind: 'switch', at: new Date(L('2026-10-20', '07:00')), on: false, source: 'unknown', reason: null,
      faults: [], before: [], note: 'Encontrada desligada às 07:00 (água a 33–35 °C); causa desconhecida, não havia registo contínuo.',
    }],
    fault('fault-notes-2026-10-21-night-E13', L('2026-10-21', '08:09'), {
      note: 'Noite de 20 para 21/10, água a 40 °C. Hora do disparo desconhecida: encontrada em E13 às 08:09.',
    }),
    fault('fault-notes-2026-10-21-afternoon-E13', L('2026-10-21', '18:45'), {
      note: 'Depois de um rearme às ~16:20, com a água a 34 °C. Hora exata desconhecida (entre as 16:20 e as 18:45).',
    }),
    ['note-2026-10-23-guard', {
      ...base, kind: 'note', at: new Date(L('2026-10-23', '21:07')),
      note: 'Começa a proteção E13 (script manual no Pi): desliga a bomba 60 min quando fica parada no setpoint e 120 min depois de um disparo.',
    }],
    ['note-2026-10-24-timers', {
      ...base, kind: 'note', at: new Date(L('2026-10-24', '14:00')),
      note: 'O ecrã de temporizadores do controlador mostra valores impossíveis (horas 97:60, 83:33, 31:78; setpoints de arrefecimento −98/−49 °C; linha 2 com aquecimento marcado). Parece memória corrompida: pedir aos técnicos que limpem os temporizadores e verifiquem os outros parâmetros. Pode explicar as paragens às 00:54.',
    }],
  ];
}

/**
 * The hand-run guard's own record of what it switched (`~/e13-watch/guard.log`
 * on the Pi): "YYYY-MM-DD HH:MM:SS <what>", local time.
 */
function readGuardLog(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (.*)$/.exec(line);
    if (!m) continue;
    const on = /switching ON|switched the pump back ON/.test(m[3]) ? true : /switching OFF/.test(m[3]) ? false : undefined;
    if (on === undefined) continue;
    out.push({ at: lisbon(m[1], m[2]), on, source: 'guard', note: `Proteção E13 (script manual): ${m[3]}` });
  }
  return out;
}

// --- Replay ----------------------------------------------------------------

function replay(logs, device, until, guardSwitches = []) {
  const known = [...KNOWN_SWITCHES, ...guardSwitches];
  const docs = new Map();
  for (const spec of logs) {
    const at = spec.lastIndexOf('@');
    const path = resolve(spec.slice(0, at));
    const { samples, gaps } = readLog(path, spec.slice(at + 1));
    // One recorder per file: each was its own recording session, with hours
    // between them, and a trip open at the end of one must not be "closed" by
    // the first line of the next.
    const rec = createRecorder((id, doc) => docs.set(id, structuredClone(doc)), { origin: 'log' });
    const events = [
      ...samples.filter(s => !until || s.t < until).map(s => ({ t: s.t, s })),
      ...gaps.filter(t => !until || t < until).map(t => ({ t })),
    ].sort((a, b) => a.t - b.t);
    for (const e of events) {
      if (e.s) rec.observe(device, e.s);
      else rec.gap();
    }
    const open = rec.snapshot().open;
    if (open) {
      open.doc.status = 'unknown';
      open.doc.note = 'O registo termina antes do fim da avaria.';
      docs.set(open.id, structuredClone(open.doc));
    }
    console.error(`${path}: ${samples.length} readings`);
  }
  // Lay the notes over what the logs saw.
  for (const [, doc] of docs) {
    const t = doc.at.getTime();
    if (doc.kind === 'switch') {
      const k = known.find(x => x.on === doc.on && Math.abs(x.at - t) <= 3 * 60_000);
      if (k) { doc.source = k.source; doc.note = k.note; }
    } else {
      const k = KNOWN_FAULTS.find(x => Math.abs(x.at - t) <= 3 * 60_000);
      if (k) doc.note = [k.note, doc.note].filter(Boolean).join(' ');
      for (const a of doc.actions) {
        const ks = known.find(x => (x.on ? 'on' : 'off') === a.what && Math.abs(x.at - a.at) <= 3 * 60_000);
        if (ks) a.by = ks.source;
      }
    }
  }
  for (const [id, doc] of notesOnly(device)) docs.set(id, doc);
  return docs;
}

// --- Writing ----------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const write = args.includes('--write');
  const project = opt('--project') ?? 'kidclub-dev';
  const until = opt('--until') ? Date.parse(opt('--until')) : undefined;
  const extra = args.flatMap((a, i) => (a === '--log' ? [args[i + 1]] : []));
  // A newer copy of a log (same start date) replaces the one in the repo.
  const logs = [...DEFAULT_LOGS.filter(l => !extra.some(e => e.endsWith(l.slice(l.lastIndexOf('@'))))), ...extra];

  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  let token;
  let device = { id: 'heatpump', name: PUMP_NAME };
  if (write) {
    token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
    // The pump's Tuya id, from the published state (no keys in that document).
    const res = await fetch(`${base}/domotics_state/tuya`, { headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': project } });
    if (res.ok) {
      const devices = (await res.json()).fields?.devices?.arrayValue?.values ?? [];
      const pump = devices.map(v => v.mapValue.fields).find(f => f.category?.stringValue === 'znrb');
      if (pump) device = { id: pump.id.stringValue, name: pump.name?.stringValue ?? PUMP_NAME };
    }
  }

  const guardSwitches = opt('--guard-log') ? readGuardLog(resolve(opt('--guard-log'))) : [];
  const docs = replay(logs, device, until, guardSwitches);
  const rows = [...docs].sort((a, b) => a[1].at - b[1].at);
  for (const [id, d] of rows) {
    const when = d.at.toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon' });
    const what = d.kind === 'fault'
      ? `${d.codes.join(',')} ${d.status}${d.lockout ? ' BLOQUEIO' : ''}${d.endedHow ? ` (${d.endedHow})` : ''} antes=${d.before.length} depois=${d.after.length}`
      : d.kind === 'switch' ? `${d.on ? 'ligada' : 'desligada'} por ${d.source}` : 'nota';
    console.log(`${when.padEnd(20)} ${d.origin.padEnd(5)} ${what.padEnd(52)} ${id}`);
  }
  console.log(`${rows.length} documents${write ? '' : ' (dry run — add --write to send them)'}`);
  if (!write) return;

  for (const [id, doc] of rows) {
    const fields = encodeFields(doc);
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const res = await fetch(`${base}/domotics_incidents/${id}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': project, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
  }
  console.log(`written to ${project}/domotics_incidents`);
}

module.exports = { DEFAULT_LOGS, readLog, replay, lisbon };
if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
