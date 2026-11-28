import { useState, type ReactNode } from 'react';
import { Fan, Lightbulb, Lock, LockOpen, Megaphone, Minus, Plug, Plus, Power, Sun } from 'lucide-react';
import { teslaCommandFn, type TeslaAction, type TeslaCar } from '../../lib/firebase';
import { DEMO } from '../../data/demoData';

const card = 'rounded-2xl bg-zinc-900 border border-zinc-800';

interface Props {
  car: TeslaCar;
  notify: (text: string) => void;
  /** What the command changed, applied on screen at once (the next read confirms it). */
  onPatch: (patch: Partial<TeslaCar>) => void;
}

/** Cars that only take signed commands (the Vehicle Command Protocol): everything but the older S and X. */
const needsSigning = (car: TeslaCar) => /model\s*(3|y)|cybertruck/i.test(`${car.model ?? ''}`);

/**
 * Lock, climate, charging, charge port, lights and horn. Each tap is one Tesla
 * call (counted in the daily cap). Charging commands are limited to 5 per car
 * per day (Tesla's limit), and waking a car — the dearest call — is its own
 * button, never done behind a command's back.
 */
export default function CarControls({ car, notify, onPatch }: Props) {
  const [busy, setBusy] = useState<TeslaAction | null>(null);
  const [temp, setTemp] = useState(21);
  const [limit, setLimit] = useState<number>(car.chargeLimit ?? 80);
  const [amps, setAmps] = useState<number>(Math.min(13, car.chargeAmps ?? 10));

  async function send(action: TeslaAction, value?: number, patch?: Partial<TeslaCar>, done?: string) {
    if (DEMO) { notify('Demonstração: nada foi enviado.'); return; }
    setBusy(action);
    try {
      const r = (await teslaCommandFn({ vin: car.vin, action, value })).data;
      if (patch) onPatch(patch);
      notify(r.message ?? done ?? 'Feito.');
    } catch (err) {
      notify(`Tesla: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (needsSigning(car)) {
    return (
      <section className={`${card} p-5 text-sm text-zinc-400`}>
        O {car.model} só aceita comandos assinados (Vehicle Command Protocol). Precisa do proxy de assinatura, o próximo passo; por agora só se lê.
      </section>
    );
  }

  const asleep = car.state !== 'online';
  const charging = car.chargingState === 'Charging';
  const plugged = car.chargingState !== undefined && car.chargingState !== 'Disconnected';
  const off = asleep || busy !== null;

  return (
    <section className={`${card} p-5 flex flex-col gap-4`}>
      {asleep && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
          <span className="flex-1 min-w-[12rem]">O carro está a dormir: os comandos precisam dele acordado.</span>
          <Btn
            onClick={() => { if (window.confirm('Acordar o carro? Custa cerca de 20 comandos e gasta um pouco de bateria. Limite: 5 por dia.')) void send('wake'); }}
            disabled={busy !== null} icon={<Power size={16} />} primary
          >Acordar</Btn>
        </div>
      )}

      <Row label="Carro">
        {car.locked === false
          ? <Btn onClick={() => void send('lock', undefined, { locked: true }, 'Trancado.')} disabled={off} icon={<Lock size={16} />} primary>Trancar</Btn>
          : <Btn onClick={() => { if (window.confirm('Destrancar o carro?')) void send('unlock', undefined, { locked: false }, 'Destrancado.'); }} disabled={off} icon={<LockOpen size={16} />}>Destrancar</Btn>}
        <Btn onClick={() => void send('flash', undefined, undefined, 'Luzes a piscar.')} disabled={off} icon={<Lightbulb size={16} />}>Piscar</Btn>
        <Btn onClick={() => { if (window.confirm('Tocar a buzina?')) void send('honk', undefined, undefined, 'Buzina.'); }} disabled={off} icon={<Megaphone size={16} />}>Buzina</Btn>
      </Row>

      <Row label="Clima">
        {car.climateOn
          ? <Btn onClick={() => void send('climate_off', undefined, { climateOn: false }, 'Clima desligado.')} disabled={off} icon={<Fan size={16} />}>Desligar</Btn>
          : <Btn onClick={() => void send('climate_on', undefined, { climateOn: true }, 'Clima ligado.')} disabled={off} icon={<Fan size={16} />} primary>Ligar</Btn>}
        <Stepper value={`${temp.toFixed(1)}°`} onMinus={() => setTemp(t => Math.max(15, t - 0.5))} onPlus={() => setTemp(t => Math.min(28, t + 0.5))} disabled={off} />
        <Btn onClick={() => void send('set_temp', temp, undefined, `Temperatura ${temp.toFixed(1)}°.`)} disabled={off}>Definir</Btn>
      </Row>

      <Row label="Carregamento" note="Até 5 comandos de carregamento por carro por dia (limite da Tesla).">
        {charging
          ? <Btn onClick={() => void send('charge_stop', undefined, undefined, 'Carregamento parado.')} disabled={off} icon={<Plug size={16} />}>Parar</Btn>
          : <Btn onClick={() => void send('charge_start', undefined, undefined, 'A carregar.')} disabled={off || !plugged} icon={<Plug size={16} />} primary>Carregar</Btn>}
        <span className="text-sm text-zinc-400">Limite</span>
        <Stepper value={`${limit}%`} onMinus={() => setLimit(l => Math.max(50, l - 5))} onPlus={() => setLimit(l => Math.min(100, l + 5))} disabled={off} />
        <Btn onClick={() => void send('charge_limit', limit, { chargeLimit: limit }, `Limite ${limit}%.`)} disabled={off || limit === car.chargeLimit}>Definir</Btn>
      </Row>

      <Row label="Em casa" note="Corrente do Mobile Connector na Schuko: 5 a 13 A (cerca de 1 a 3 kW).">
        <Stepper value={`${amps} A`} onMinus={() => setAmps(a => Math.max(5, a - 1))} onPlus={() => setAmps(a => Math.min(13, a + 1))} disabled={off} />
        <Btn onClick={() => void send('charging_amps', amps, undefined, `Corrente ${amps} A.`)} disabled={off} icon={<Sun size={16} />}>Definir corrente</Btn>
        <Btn onClick={() => void send(plugged ? 'port_close' : 'port_open', undefined, undefined, plugged ? 'Porta fechada.' : 'Porta aberta.')} disabled={off}>
          {plugged ? 'Fechar porta' : 'Abrir porta'}
        </Btn>
      </Row>
    </section>
  );
}

function Row({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {note && <span className="text-xs text-zinc-500">{note}</span>}
    </div>
  );
}

function Btn({ children, onClick, disabled, icon, primary }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; icon?: ReactNode; primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-[44px] px-4 rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-40 ${
        primary ? 'bg-amber-400 hover:bg-amber-300 text-amber-950 font-semibold' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100'
      }`}
    >
      {icon}{children}
    </button>
  );
}

function Stepper({ value, onMinus, onPlus, disabled }: { value: string; onMinus: () => void; onPlus: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={onMinus} disabled={disabled} aria-label="Menos" className="min-h-[44px] min-w-[44px] rounded-xl bg-zinc-800 text-zinc-100 flex items-center justify-center disabled:opacity-40"><Minus size={16} /></button>
      <span className="w-16 text-center text-sm text-zinc-100 tabular-nums">{value}</span>
      <button type="button" onClick={onPlus} disabled={disabled} aria-label="Mais" className="min-h-[44px] min-w-[44px] rounded-xl bg-zinc-800 text-zinc-100 flex items-center justify-center disabled:opacity-40"><Plus size={16} /></button>
    </div>
  );
}
