// MCP server for the house (apps/noisysource/domotics), for Atlas.
//
// It signs in as Atlas's own Firebase Auth account (atlas@kidclub.pt,
// verified) and uses exactly what that account may already use: the house
// state and history in Firestore, the thermostat and heat-pump commands the
// rules allow it to queue (isAtlasCommand in firebase/noisysource/firestore.rules),
// and the callables that accept Atlas (requireOwnerOrAgent: legrandGetHome,
// legrandGetStatus, legrandSetState, domoticsWarmBy, domoticsEnergyBill).
// Nothing here widens what Atlas can do; the server's rules and functions
// still decide. Changes are marked as such (readOnlyHint false) so Atlas asks
// Renato before calling them.
//
// The house guide (GUIDE.md) ships with the server: as its instructions, as
// the resource house://guide, and as the house_guide tool for clients that
// don't read resources.
//
// Env:
//   HOUSE_PROJECT   noisysource-prod (the house) or noisysource-dev
//   HOUSE_PASSWORD  Atlas's password (your gitignored settings or your shell, never git)
//   HOUSE_EMAIL     optional, default atlas@kidclub.pt
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  STALE_MS, compactDay, dayId, decodeHouseState, decodeLegrand, legrandModules, thermostatCommands,
} from './logic.js';

// Public web configs (the same as the apps' .env.nsdev / .env.nsprod).
const CONFIGS = {
  'noisysource-prod': { apiKey: 'AIzaSyDhUNzgid_Lxu5X00TY76hD_ebdt215SLQ', authDomain: 'noisysource-prod.firebaseapp.com' },
  'noisysource-dev': { apiKey: 'AIzaSyBVVzcHuuB7UWKuiLwyp4cr8cjZc_DKH2U', authDomain: 'noisysource-dev.firebaseapp.com' },
};

const PROJECT = process.env.HOUSE_PROJECT;
const EMAIL = process.env.HOUSE_EMAIL || 'atlas@kidclub.pt';
const PASSWORD = process.env.HOUSE_PASSWORD;
if (!CONFIGS[PROJECT]) {
  process.stderr.write(`HOUSE_PROJECT must be one of: ${Object.keys(CONFIGS).join(', ')}\n`);
  process.exit(1);
}
if (!PASSWORD) {
  process.stderr.write('HOUSE_PASSWORD is required\n');
  process.exit(1);
}

const GUIDE = readFileSync(new URL('./GUIDE.md', import.meta.url), 'utf8');

const app = initializeApp({ ...CONFIGS[PROJECT], projectId: PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);
// The house's callables are in europe-west3, like the rest of the NoisySource functions.
const fns = getFunctions(app, 'europe-west3');
let signedIn;
const ensureSignedIn = () => (signedIn ??= signInWithEmailAndPassword(auth, EMAIL, PASSWORD).catch((e) => {
  signedIn = undefined;
  throw new Error(`sign-in as ${EMAIL} failed: ${e.code ?? e.message}`);
}));
const call = async (name, data) => (await httpsCallable(fns, name)(data)).data;

const READ = { readOnlyHint: true, openWorldHint: false };
const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'house_guide',
    description: 'The house guide: how the house is wired, the heating and its automation, energy, what Atlas may and may not do there. Read it once before acting on the house.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'house_status',
    description: 'Now: every room\'s temperature and target (thermostats), the heat pump, solar / battery / grid / house consumption, and what the heating automation is doing and why. Says if the state is stale (house offline to us).',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'house_lights_and_blinds',
    description: 'Every light (on/off, brightness on dimmers) and blind (position 0–100) by room, with the ids the change tools take. Live from Netatmo.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { ...READ, openWorldHint: true },
  },
  {
    name: 'house_energy_bill',
    description: 'Electricity for a range of days (inclusive, Lisbon dates): kWh bought, sold, solar, the cost by the tariff set in the app, and the savings. The same figures as the app\'s Energia page.',
    inputSchema: {
      type: 'object', required: ['from', 'to'],
      properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } },
    },
    annotations: READ,
  },
  {
    name: 'house_day',
    description: 'One day\'s history, made small: kWh per hour (pv = solar, load = house, imp = bought, exp = sold, chg/dis = battery) and each room / the pump at the start of each hour, plus people\'s interventions. Default today.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD (Lisbon)' } } },
    annotations: READ,
  },
  {
    name: 'house_media_status',
    description: 'The TV, Roomba and cameras: online, power, battery, what they are doing. Status only: Atlas cannot command them.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'house_set_lights_blinds',
    description: 'CHANGE (ask Renato first). Switch lights on/off, set a dimmer\'s brightness (0–100), or move blinds (position 0–100: 100 open, 0 closed). Ids from house_lights_and_blinds. Up to 30 changes in one go.',
    inputSchema: {
      type: 'object', required: ['changes'],
      properties: {
        changes: {
          type: 'array', minItems: 1, maxItems: 30,
          items: {
            type: 'object', required: ['id'],
            properties: {
              id: { type: 'string' },
              on: { type: 'boolean', description: 'Lights' },
              brightness: { type: 'integer', minimum: 0, maximum: 100, description: 'Dimmers' },
              position: { type: 'integer', minimum: 0, maximum: 100, description: 'Blinds: 100 open, 0 closed' },
            },
          },
        },
      },
    },
    annotations: CHANGE,
  },
  {
    name: 'house_set_thermostat',
    description: 'CHANGE (ask Renato first). A room thermostat\'s target (10–28 °C, half degrees) and/or mode (manual/auto). deviceId from house_status. The bridge picks it up within ~10 s; the reply says whether it was taken.',
    inputSchema: {
      type: 'object', required: ['deviceId'],
      properties: {
        deviceId: { type: 'string' },
        targetC: { type: 'number', minimum: 10, maximum: 28 },
        mode: { enum: ['manual', 'auto'] },
      },
    },
    annotations: CHANGE,
  },
  {
    name: 'house_set_heat_pump',
    description: 'CHANGE (ask Renato first). Switch the heat pump on or off. The automation switches it by its plan too, so this can be undone at its next step: prefer house_pause_automation or house_warm_by unless he asks for the pump itself.',
    inputSchema: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } },
    annotations: CHANGE,
  },
  {
    name: 'house_warm_by',
    description: 'CHANGE (ask Renato first). Have the house warm by a time: the automation works out when to start. Give time "HH:MM" (Lisbon, the next time it comes round) or at (ISO instant); target °C optional (default the comfort temperature). clear: true removes the request.',
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'HH:MM' },
        at: { type: 'string', description: 'ISO 8601' },
        target: { type: 'number' },
        clear: { type: 'boolean' },
      },
    },
    annotations: CHANGE,
  },
  {
    name: 'house_pause_automation',
    description: 'CHANGE (ask Renato first). Pause the heating automation until a time (it leaves the pump as it is), or resume it (until: null). The same as "Pausar" in the app.',
    inputSchema: {
      type: 'object', required: ['until'],
      properties: { until: { type: ['string', 'null'], description: 'ISO 8601 instant, or null to resume' } },
    },
    annotations: CHANGE,
  },
];

async function houseState() {
  return decodeHouseState((await getDoc(doc(db, 'domotics_state', 'tuya'))).data());
}

/** Queue a command for the bridge and wait (up to ~25 s) for it to be taken or refused. */
async function queueCommand(deviceId, commands) {
  const state = await houseState();
  if (!state.available || state.stale) {
    throw new Error(`The house isn't publishing (last state ${state.ageMinutes ?? '?'} min ago): the command would not be picked up. Not sent.`);
  }
  const ref = await addDoc(collection(db, 'domotics_commands'), { deviceId, commands, createdAt: serverTimestamp() });
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const snap = await getDoc(ref).catch(() => null);
    if (snap && !snap.exists()) return { taken: true, note: 'The bridge took the command. Check house_status for the result.' };
    const err = snap?.data()?.error;
    if (err) return { taken: false, error: err };
  }
  return { taken: false, note: 'Queued; the bridge has not taken it yet (it polls every ~10 s, and drops commands older than 2 min).' };
}

async function run(name, args = {}) {
  switch (name) {
    case 'house_guide':
      return GUIDE;
    case 'house_status':
      return houseState();
    case 'house_lights_and_blinds': {
      const [home, status] = await Promise.all([call('legrandGetHome', {}), call('legrandGetStatus', {})]);
      return decodeLegrand(home, status);
    }
    case 'house_energy_bill':
      return call('domoticsEnergyBill', { from: dayId(args.from), to: dayId(args.to) });
    case 'house_day': {
      const id = dayId(args.date);
      const [climate, energy, state] = await Promise.all([
        getDoc(doc(db, 'domotics_climate', id)).then((s) => s.data()),
        getDoc(doc(db, 'domotics_energy', id)).then((s) => s.data()),
        houseState(),
      ]);
      const names = Object.fromEntries((state.thermostats ?? []).map((t) => [t.deviceId, t.room]));
      return { date: id, ...compactDay(climate, energy, names) };
    }
    case 'house_media_status': {
      const d = (await getDoc(doc(db, 'domotics_state', 'media'))).data();
      if (!d) return { configured: false };
      const updatedAt = d.updatedAt?.toMillis?.();
      const { watchable: _w, liveBase: _l, ...rest } = d;
      return {
        ...rest,
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
        // Only read while someone has the app's Aparelhos screen open: old is normal.
        note: updatedAt && Date.now() - updatedAt > STALE_MS
          ? 'Old: the bridge reads these only while the app\'s Aparelhos screen is open.' : undefined,
      };
    }
    case 'house_set_lights_blinds': {
      const [home, status] = await Promise.all([call('legrandGetHome', {}), call('legrandGetStatus', {})]);
      const modules = legrandModules(args.changes, decodeLegrand(home, status));
      await call('legrandSetState', { modules });
      return { ok: true, sent: modules };
    }
    case 'house_set_thermostat': {
      const state = await houseState();
      const t = (state.thermostats ?? []).find((x) => x.deviceId === args.deviceId);
      if (!t) throw new Error('Unknown thermostat. Use house_status for the deviceIds.');
      return { room: t.room, ...(await queueCommand(t.deviceId, thermostatCommands(args))) };
    }
    case 'house_set_heat_pump': {
      if (typeof args.on !== 'boolean') throw new Error('on must be true or false.');
      const state = await houseState();
      if (!state.heatPump) throw new Error('No heat pump in the house state.');
      return queueCommand(state.heatPump.deviceId, [{ code: 'switch', value: args.on }]);
    }
    case 'house_warm_by':
      return call('domoticsWarmBy', {
        ...(args.time !== undefined ? { time: args.time } : {}),
        ...(args.at !== undefined ? { at: args.at } : {}),
        ...(args.target !== undefined ? { target: args.target } : {}),
        ...(args.clear === true ? { clear: true } : {}),
        source: 'chat',
      });
    case 'house_pause_automation': {
      let pauseUntil = null;
      if (args.until !== null) {
        const t = Date.parse(String(args.until));
        if (!Number.isFinite(t) || t <= Date.now()) throw new Error('until must be a future ISO 8601 instant, or null.');
        if (t - Date.now() > 14 * 24 * 3600_000) throw new Error('At most two weeks ahead.');
        pauseUntil = t;
      }
      await setDoc(doc(db, 'domotics_config', 'automation'), { pauseUntil }, { merge: true });
      return { ok: true, pausedUntil: pauseUntil ? new Date(pauseUntil).toISOString() : null, note: 'The bridge reads settings every ~2 min.' };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const server = new Server(
  { name: 'house', version: '1.0.0' },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      'The house (Domotics): heating, lights, blinds, solar, energy bills. Read house_guide (or the house://guide resource) ' +
      'once before acting on the house. Tools marked CHANGE alter the real house: say exactly what will change and get ' +
      'Renato\'s OK first. If house_status says stale, the house is offline to you: say so and change nothing.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    await ensureSignedIn();
    const out = await run(req.params.name, req.params.arguments ?? {});
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e?.message ?? String(e) }] };
  }
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'house://guide', name: 'The house — a guide for Atlas', mimeType: 'text/markdown' },
    { uri: 'house://status', name: 'The house now (rooms, pump, solar, automation)', mimeType: 'application/json' },
  ],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'house://guide') {
    return { contents: [{ uri: 'house://guide', mimeType: 'text/markdown', text: GUIDE }] };
  }
  if (req.params.uri === 'house://status') {
    await ensureSignedIn();
    return { contents: [{ uri: 'house://status', mimeType: 'application/json', text: JSON.stringify(await houseState(), null, 2) }] };
  }
  throw new Error(`unknown resource ${req.params.uri}`);
});

await server.connect(new StdioServerTransport());
