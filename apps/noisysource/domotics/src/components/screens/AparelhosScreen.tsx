import { useCallback, useEffect, useRef, useState } from 'react';
import { demoMedia, type MediaState } from '../../data/mediaData';
import {
  announceMediaWatching, fetchMediaState, lanSnapshotUrl, liveUrl, relaySnapshot, sendMediaCommand,
  type MediaSource,
} from '../../lib/media';
import TvCard from '../media/TvCard';
import RoombaCard from '../media/RoombaCard';
import CameraCard from '../media/CameraCard';

interface Props {
  demo: boolean;
  notify: (text: string) => void;
}

/** On the LAN the bridge answers in milliseconds; through the relay every read is billed. */
const DIRECT_EVERY_MS = 10_000;
const RELAY_EVERY_MS = 20_000;

/**
 * The TV, the Roomba and the cameras. The bridge reads them only while this
 * screen is open (it is what asks), so it polls while visible and stops when
 * the tab is hidden or the screen closes.
 */
export default function AparelhosScreen({ demo, notify }: Props) {
  const [state, setState] = useState<MediaState | null>(demo ? demoMedia() : null);
  const [source, setSource] = useState<MediaSource | null>(demo ? 'direct' : null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'offline'>(demo ? 'ok' : 'loading');
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    if (demo) return;
    const got = await fetchMediaState();
    if (got) {
      setState(got.state);
      setSource(got.source);
      setStatus('ok');
      if (got.source === 'relay') void announceMediaWatching();
    } else {
      setStatus('offline');
    }
    return got?.source;
  }, [demo]);

  useEffect(() => {
    if (demo) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const src = document.hidden ? source : await refresh();
      if (!stopped) timer.current = setTimeout(tick, src === 'relay' ? RELAY_EVERY_MS : DIRECT_EVERY_MS);
    };
    void tick();
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, refresh]);

  async function send(deviceId: string, commands: Array<{ code: string; value: unknown }>) {
    if (demo) { notify('Demonstração: nada foi enviado.'); return; }
    setBusy(deviceId);
    try {
      const fresh = await sendMediaCommand(deviceId, commands);
      if (fresh) setState(fresh);
      else {
        notify('Enviado. A casa responde em cerca de 10 segundos.');
        setTimeout(() => void refresh(), 12_000);
      }
    } catch (err) {
      notify(`Não foi possível: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function snapshot(cameraId: string): Promise<string> {
    if (demo) return DEMO_IMAGE;
    if (source === 'direct') {
      const resp = await fetch(lanSnapshotUrl(cameraId));
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `A ponte respondeu ${resp.status}`);
      }
      return URL.createObjectURL(await resp.blob());
    }
    return relaySnapshot(cameraId);
  }

  const empty = state && state.tvs.length + state.roombas.length + state.cameras.length === 0;

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 pt-4 pb-6 flex flex-col gap-4">
      <div className="flex items-baseline gap-3" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <h1 className="text-2xl font-bold text-zinc-50">Aparelhos</h1>
        {source === 'relay' && <span className="text-sm text-zinc-500">fora de casa: comandos demoram ~10 s</span>}
      </div>

      {status === 'loading' && <p className="text-sm text-zinc-500">A perguntar à ponte…</p>}
      {status === 'offline' && !state && (
        <p className="text-[15px] text-zinc-300 rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
          A ponte não respondeu. Em casa, confirme que está ligada; fora de casa, a ponte precisa de estar a publicar (Mais → Estado da ponte).
        </p>
      )}
      {empty && (
        <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 text-[15px] text-zinc-300 flex flex-col gap-2">
          <p>Ainda não há aparelhos configurados na ponte.</p>
          <p className="text-sm text-zinc-400">Televisor, Roomba e câmaras configuram-se no Mac: domotics-bridge/deploy/README.md, “Televisor, Roomba e câmaras”.</p>
        </div>
      )}

      {state && (
        <>
          {(state.tvs.length > 0 || state.roombas.length > 0) && (
            <div className="grid gap-4 md:grid-cols-2 items-start">
              {state.tvs.map(tv => <TvCard key={tv.id} tv={tv} busy={busy === tv.id} send={c => void send(tv.id, c)} />)}
              {state.roombas.map(r => <RoombaCard key={r.id} roomba={r} busy={busy === r.id} send={c => void send(r.id, c)} />)}
            </div>
          )}
          {state.cameras.length > 0 && (
            <>
              <h2 className="text-lg font-semibold text-zinc-100 mt-2">Câmaras</h2>
              <div className="grid gap-4 md:grid-cols-2 items-start">
                {state.cameras.map(cam => (
                  <CameraCard
                    key={cam.id}
                    camera={cam}
                    live={liveUrl(state, cam.id)}
                    autoSnapshot={source === 'direct'}
                    snapshot={() => snapshot(cam.id)}
                    busy={busy === cam.id}
                    send={c => void send(cam.id, c)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

const DEMO_IMAGE = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs>' +
  '<rect width="640" height="360" fill="url(#g)"/><rect x="0" y="250" width="640" height="110" fill="#1f2937"/>' +
  '<rect x="250" y="120" width="140" height="130" fill="#334155"/><rect x="295" y="170" width="50" height="80" fill="#0f172a"/>' +
  '<text x="20" y="30" fill="#94a3b8" font-family="monospace" font-size="16">DEMO  27-11-2026 15:30</text></svg>');
