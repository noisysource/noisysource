import { BatteryCharging, BatteryMedium, CircleDot } from 'lucide-react';
import { ROOMBA_PHASE, roombaActions, type RoombaState } from '../../data/mediaData';
import { Btn, CardHeader, card } from './parts';

type Send = (commands: Array<{ code: string; value: unknown }>) => void;

export default function RoombaCard({ roomba, send, busy }: { roomba: RoombaState; send: Send; busy: boolean }) {
  const r = roomba;
  const trouble = r.phase === 'stuck' || r.phase === 'chargingerror' || (r.errorCode ?? 0) > 0;
  const status = !r.online ? 'Sem resposta' : ROOMBA_PHASE[r.phase];
  return (
    <div className={card}>
      <CardHeader
        icon={<CircleDot size={24} />}
        title={r.name}
        status={status}
        tone={!r.online ? 'zinc' : trouble ? 'red' : r.phase === 'run' ? 'green' : 'zinc'}
      />
      {r.online && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-zinc-300">
          {r.battery != null && (
            <span className="flex items-center gap-1.5">
              {r.phase === 'charge' ? <BatteryCharging size={16} className="text-emerald-300" /> : <BatteryMedium size={16} />}
              {r.battery}%
            </span>
          )}
          {r.phase === 'run' && r.missionMinutes != null && <span>{r.missionMinutes} min a aspirar</span>}
          {r.binFull && <span className="text-amber-300">Depósito cheio</span>}
        </div>
      )}
      {(r.errorCode ?? 0) > 0 && (
        <p className="text-sm text-red-300">Erro {r.errorCode}. O que significa e como resolver está na app iRobot.</p>
      )}
      {(r.notReady ?? 0) > 0 && (r.errorCode ?? 0) === 0 && (
        <p className="text-sm text-amber-300">Não pode começar agora (código {r.notReady}). Veja na app iRobot.</p>
      )}
      {!r.online && r.error && <p className="text-sm text-zinc-500">{r.error}</p>}
      <div className="flex flex-wrap gap-2">
        {roombaActions(r).map(a => (
          <Btn key={a.action} wide disabled={busy || !r.online} active={a.action === 'start'}
            onClick={() => send([{ code: 'action', value: a.action }])}>
            {a.label}
          </Btn>
        ))}
      </div>
    </div>
  );
}
