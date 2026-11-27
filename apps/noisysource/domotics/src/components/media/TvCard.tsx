import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, House, Link2, Minus, Pause, Play, Plus, Power, Tv, Undo2, Volume2, VolumeX,
} from 'lucide-react';
import { isTvOn, tvPowerLabel, type TvState } from '../../data/mediaData';
import { Btn, CardHeader, Chips, card } from './parts';

type Send = (commands: Array<{ code: string; value: unknown }>) => void;

export default function TvCard({ tv, send, busy }: { tv: TvState; send: Send; busy: boolean }) {
  const on = isTvOn(tv);
  const c = (code: string, value: unknown) => send([{ code, value }]);

  if (!tv.paired) {
    return (
      <div className={card}>
        <CardHeader icon={<Tv size={24} />} title={tv.name} status={tv.online ? 'Por emparelhar' : 'Desligado'} tone="amber" />
        {tv.prompting ? (
          <p className="text-[15px] text-amber-200">Aceite o pedido no televisor, com o comando.</p>
        ) : (
          <>
            <p className="text-sm text-zinc-400">
              Uma vez só: ligue o televisor, carregue em Emparelhar e aceite o pedido que aparece no ecrã.
              {!tv.online && ' Agora o televisor não responde: ligue-o primeiro.'}
            </p>
            <Btn wide onClick={() => c('pair', true)} disabled={busy || !tv.online}><Link2 size={16} /> Emparelhar</Btn>
          </>
        )}
        {tv.error && <p className="text-sm text-red-300">{tv.error}</p>}
      </div>
    );
  }

  return (
    <div className={card}>
      <div className="flex items-start gap-3">
        <div className="flex-1"><CardHeader icon={<Tv size={24} />} title={tv.name} status={tvPowerLabel(tv)} tone={on ? 'green' : 'zinc'} /></div>
        <Btn
          label={on ? 'Desligar' : 'Ligar'}
          active={on}
          disabled={busy || (!on && !tv.canWake)}
          onClick={() => c('power', !on)}
        >
          <Power size={18} />
        </Btn>
      </div>
      {!on && !tv.canWake && (
        <p className="text-sm text-zinc-400">
          Para o ligar daqui, a ponte precisa do endereço MAC do televisor e de “Ligar via Wi-Fi” ativo nas definições do televisor.
        </p>
      )}

      {on && (
        <>
          <div className="flex items-center gap-2">
            <Btn label="Baixar o volume" disabled={busy} onClick={() => c('volume_step', 'down')}><Minus size={16} /></Btn>
            <div className="flex-1 text-center text-sm text-zinc-300 tabular-nums">
              {tv.muted ? 'Sem som' : tv.volume != null ? `Volume ${tv.volume}` : 'Volume'}
            </div>
            <Btn label="Subir o volume" disabled={busy} onClick={() => c('volume_step', 'up')}><Plus size={16} /></Btn>
            <Btn label={tv.muted ? 'Repor o som' : 'Tirar o som'} active={tv.muted} disabled={busy} onClick={() => c('mute', !tv.muted)}>
              {tv.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </Btn>
          </div>

          <div className="grid grid-cols-3 gap-1.5 max-w-[220px] self-center">
            <span />
            <Btn label="Cima" disabled={busy} onClick={() => c('button', 'UP')}><ChevronUp size={18} /></Btn>
            <span />
            <Btn label="Esquerda" disabled={busy} onClick={() => c('button', 'LEFT')}><ChevronLeft size={18} /></Btn>
            <Btn label="OK" disabled={busy} onClick={() => c('button', 'ENTER')}>OK</Btn>
            <Btn label="Direita" disabled={busy} onClick={() => c('button', 'RIGHT')}><ChevronRight size={18} /></Btn>
            <Btn label="Voltar" disabled={busy} onClick={() => c('button', 'BACK')}><Undo2 size={16} /></Btn>
            <Btn label="Baixo" disabled={busy} onClick={() => c('button', 'DOWN')}><ChevronDown size={18} /></Btn>
            <Btn label="Início" disabled={busy} onClick={() => c('button', 'HOME')}><House size={16} /></Btn>
          </div>

          <div className="flex items-center gap-2 justify-center">
            <Btn label="Reproduzir" disabled={busy} onClick={() => c('media', 'play')}><Play size={16} /></Btn>
            <Btn label="Pausa" disabled={busy} onClick={() => c('media', 'pause')}><Pause size={16} /></Btn>
            <Btn label="Canal anterior" disabled={busy} onClick={() => c('channel_step', 'down')}>CH −</Btn>
            <Btn label="Canal seguinte" disabled={busy} onClick={() => c('channel_step', 'up')}>CH +</Btn>
          </div>

          {tv.inputs.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Entradas</div>
              <Chips items={tv.inputs} current={tv.appId} label={i => i.label} disabled={busy} onPick={i => c('input', i.id)} />
            </div>
          )}
          {tv.apps.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Aplicações</div>
              <Chips items={tv.apps.slice(0, 12)} current={tv.appId} label={a => a.title} disabled={busy} onPick={a => c('app', a.id)} />
            </div>
          )}
        </>
      )}
      {tv.error && <p className="text-sm text-red-300">{tv.error}</p>}
    </div>
  );
}
