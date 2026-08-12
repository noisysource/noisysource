import { createServer } from 'node:http';
import type { DeviceState } from './tuya';

/**
 * Minimal LAN HTTP API.
 *
 * While the app runs on the same network as the devices, the browser can talk
 * to the bridge directly — no cloud relay, no round-trip to a datacentre, and
 * nothing exposed to the internet, so no sign-in is needed to keep the heating
 * private. A Firestore relay only becomes necessary for reaching the house from
 * outside it (and, separately, once the app is served over HTTPS, since browsers
 * refuse http:// calls from an https:// page).
 *
 * No framework on purpose: two endpoints do not justify a dependency.
 */

export interface HttpDeps {
  getState: () => { devices: DeviceState[]; inverter?: unknown; updatedAt: number };
  sendCommand: (deviceId: string, commands: Array<{ code: string; value: unknown }>) => Promise<void>;
  refresh: () => Promise<void>;
}

function cors(res: import('node:http').ServerResponse) {
  // The app is served from a Vite dev port that changes; the bridge is
  // LAN-only, so a permissive origin here costs nothing.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res: import('node:http').ServerResponse, code: number, body: unknown) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startHttp(port: number, deps: HttpDeps) {
  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://bridge');

    if (req.method === 'GET' && url.pathname === '/state') {
      return json(res, 200, deps.getState());
    }

    if (req.method === 'POST' && url.pathname === '/command') {
      try {
        const body = await readBody(req) as {
          deviceId?: string;
          commands?: Array<{ code: string; value: unknown }>;
        };
        if (!body.deviceId || !body.commands?.length) {
          return json(res, 400, { error: 'deviceId and a non-empty commands array are required' });
        }
        await deps.sendCommand(body.deviceId, body.commands);
        // Read back before answering, so the caller's next /state reflects
        // reality rather than its own optimistic guess.
        await deps.refresh();
        return json(res, 200, { ok: true, ...deps.getState() });
      } catch (err) {
        return json(res, 500, { error: (err as Error).message });
      }
    }

    json(res, 404, { error: 'not found' });
  });

  server.listen(port, () => {
    console.log(`[http] listening on http://0.0.0.0:${port}  (GET /state, POST /command)`);
  });

  return server;
}
