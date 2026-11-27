import { createServer } from 'node:http';
import type { DeviceState } from './tuya';
import type { MediaState } from './media/types';
import { isMediaId } from './media/types';

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
  /** The TV, the Roomba and the cameras (media/index.ts). Absent leaves the endpoints answering 404. */
  media?: {
    state: () => MediaState;
    watch: () => void;
    command: (deviceId: string, commands: Array<{ code: string; value: unknown }>) => Promise<void>;
    snapshot: (deviceId: string) => Promise<Buffer>;
  };
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

    // Media devices: read while someone has the Aparelhos screen open, never otherwise.
    if (req.method === 'GET' && url.pathname === '/media' && deps.media) {
      deps.media.watch();
      return json(res, 200, deps.media.state());
    }

    // A camera's JPEG, straight from go2rtc. LAN only; away from home the relay carries it.
    if (req.method === 'GET' && url.pathname === '/media/snapshot' && deps.media) {
      try {
        const jpeg = await deps.media.snapshot(url.searchParams.get('id') ?? '');
        cors(res);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        return res.end(jpeg);
      } catch (err) {
        return json(res, 502, { error: (err as Error).message });
      }
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
        if (isMediaId(body.deviceId)) {
          if (!deps.media) return json(res, 404, { error: 'media devices are not enabled' });
          await deps.media.command(body.deviceId, body.commands);
          return json(res, 200, { ok: true, media: deps.media.state() });
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
    console.log(`[http] listening on http://0.0.0.0:${port}  (GET /state, GET /media, POST /command)`);
  });

  return server;
}
