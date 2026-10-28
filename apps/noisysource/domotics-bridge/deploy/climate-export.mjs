#!/usr/bin/env node
// Read-only export of the comfort experiment's data from the dev project, for
// analysis (HANDOFF-comfort-experiment.md): every 15-min slot of
// `domotics_climate` joined with the same slot of `domotics_energy`, the
// interventions, and the pump's switches and faults from `domotics_incidents`.
//
//   node deploy/climate-export.mjs 2026-10-28 2026-10-31 > /tmp/climate.json
//
// Uses your own gcloud login (`gcloud auth login` first); writes nothing.
import { execSync } from 'node:child_process';

const [from, to] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
  console.error('usage: node deploy/climate-export.mjs <from yyyy-mm-dd> <to yyyy-mm-dd>');
  process.exit(1);
}
const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const BASE = 'https://firestore.googleapis.com/v1/projects/kidclub-dev/databases/(default)/documents';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const dec = v => v == null ? null
  : 'stringValue' in v ? v.stringValue
  : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue
  : 'nullValue' in v ? null
  : 'timestampValue' in v ? Date.parse(v.timestampValue)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, dec(x)]))
  : 'arrayValue' in v ? (v.arrayValue.values ?? []).map(dec)
  : v;

async function day(collection, id) {
  const r = await fetch(`${BASE}/${collection}/${id}`, { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${collection}/${id}: ${r.status} ${await r.text()}`);
  return dec({ mapValue: { fields: (await r.json()).fields } });
}

const dates = [];
for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
  dates.push(new Date(t).toISOString().slice(0, 10));
}

const slots = [];
const interventions = [];
let zones = {};
for (const date of dates) {
  const c = await day('domotics_climate', date);
  const e = await day('domotics_energy', date);
  if (!c && !e) continue;
  zones = { ...zones, ...(c?.zones ?? {}) };
  const start = c?.start ?? e?.start;
  const keys = new Set([...Object.keys(c ?? {}), ...Object.keys(e ?? {})].filter(k => /^q\d\d$/.test(k)));
  for (const q of [...keys].sort()) {
    const i = Number(q.slice(1));
    slots.push({ date, q, at: start + i * 15 * 60_000, climate: c?.[q] ?? null, energy: e?.[q] ?? null });
  }
  for (const [k, v] of Object.entries(c ?? {})) if (k.startsWith('x_')) interventions.push(v);
}

const body = {
  structuredQuery: {
    from: [{ collectionId: 'domotics_incidents' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'at' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: `${from}T00:00:00Z` } } },
          { fieldFilter: { field: { fieldPath: 'at' }, op: 'LESS_THAN', value: { timestampValue: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString() } } },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: 'at' } }],
    limit: 500,
  },
};
const res = await fetch(`${BASE}:runQuery`, { method: 'POST', headers: H, body: JSON.stringify(body) });
if (!res.ok) throw new Error(`incidents: ${res.status} ${await res.text()}`);
const incidents = (await res.json()).filter(x => x.document).map(x => {
  const d = dec({ mapValue: { fields: x.document.fields } });
  // The readings around each one are bulky; keep the summary.
  const { before: _b, after: _a, dps: _d, ...rest } = d;
  return { id: x.document.name.split('/').pop(), ...rest };
});

interventions.sort((a, b) => a.at - b.at);
process.stdout.write(JSON.stringify({ from, to, zones, slots, interventions, incidents }, null, 1));
console.error(`${slots.length} slots, ${interventions.length} interventions, ${incidents.length} incidents`);
