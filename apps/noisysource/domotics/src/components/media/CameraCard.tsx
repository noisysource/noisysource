import { useEffect, useState } from 'react';
import { Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RefreshCw, Video } from 'lucide-react';
import type { CameraState } from '../../data/mediaData';
import { Btn, CardHeader, card } from './parts';

interface Props {
  camera: CameraState;
  /** go2rtc's player for this camera, when the browser can reach it (LAN, http). */
  live: string | null;
  /** Fetches a fresh JPEG and returns something an <img> can show. */
  snapshot: () => Promise<string>;
  /** Away from home each snapshot is a relayed write; don't take one until asked. */
  autoSnapshot: boolean;
  send: (commands: Array<{ code: string; value: unknown }>) => void;
  busy: boolean;
}

export default function CameraCard({ camera, live, snapshot, autoSnapshot, send, busy }: Props) {
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);

  async function take() {
    setLoading(true);
    setError(null);
    try {
      setImage(await snapshot());
    } catch (err) {
      setError((err as Error).message || 'Sem imagem.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (autoSnapshot && camera.online && camera.live) void take();
    // Once per camera when the screen opens; after that, on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, autoSnapshot, camera.online, camera.live]);

  const status = !camera.online ? 'Sem resposta' : camera.live ? 'Ligada' : 'Ligada, sem vídeo na ponte';
  return (
    <div className={card}>
      <CardHeader icon={<Camera size={22} />} title={camera.name} status={status} tone={camera.online ? 'green' : 'zinc'} />
      <div className="relative aspect-video rounded-xl overflow-hidden bg-zinc-950 border border-zinc-800 flex items-center justify-center">
        {watching && live ? (
          <iframe title={`${camera.name} ao vivo`} src={live} className="w-full h-full border-0" allow="autoplay; fullscreen" />
        ) : image ? (
          <img src={image} alt={camera.name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm text-zinc-500 px-4 text-center">
            {loading ? 'A pedir imagem…'
              : !camera.online ? 'A câmara não responde na rede.'
              : !camera.live ? 'O vídeo precisa do go2rtc na ponte (ver deploy/README.md).'
              : 'Carregue em Imagem para ver a câmara.'}
          </span>
        )}
        {loading && image && <span className="absolute top-2 right-2 text-xs bg-zinc-900/80 px-2 py-1 rounded">A atualizar…</span>}
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {live && (
          <Btn wide active={watching} disabled={!camera.online} onClick={() => setWatching(w => !w)}>
            <Video size={16} /> {watching ? 'Parar' : 'Ao vivo'}
          </Btn>
        )}
        <Btn wide disabled={loading || !camera.online || !camera.live} onClick={() => { setWatching(false); void take(); }}>
          <RefreshCw size={16} /> Imagem
        </Btn>
        {camera.ptz && (
          <div className="flex gap-1.5 ml-auto">
            <Btn label="Rodar para a esquerda" disabled={busy || !camera.online} onClick={() => send([{ code: 'ptz', value: 'left' }])}><ChevronLeft size={18} /></Btn>
            <Btn label="Inclinar para cima" disabled={busy || !camera.online} onClick={() => send([{ code: 'ptz', value: 'up' }])}><ChevronUp size={18} /></Btn>
            <Btn label="Inclinar para baixo" disabled={busy || !camera.online} onClick={() => send([{ code: 'ptz', value: 'down' }])}><ChevronDown size={18} /></Btn>
            <Btn label="Rodar para a direita" disabled={busy || !camera.online} onClick={() => send([{ code: 'ptz', value: 'right' }])}><ChevronRight size={18} /></Btn>
          </div>
        )}
      </div>
    </div>
  );
}
