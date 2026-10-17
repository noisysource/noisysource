import { useEffect, useRef, useState } from 'react';
import { Flame, Minus, Plus, Power, BatteryLow, CheckCircle2, AlertTriangle, WifiOff } from 'lucide-react';
import type {
  Device, HeatPumpDevice, ThermostatDevice, ThermostatCommand, HeatPumpCommand,
} from '@shared/models/Device';
import type { PlanRoom } from '@shared/models/Room';
import { heatPumpModeLabel } from '../data/tuyaData';
import { faultMeaning } from '../data/heatpumpFaults';

/** Same bounds and step as the plan's thermostat slider. */
const TEMP_MIN = 5;
const TEMP_MAX = 35;
const TEMP_STEP = 0.5;

/**
 * How long +/- waits for the next tap before sending. Each send is a write to
 * a battery-powered valve over the bridge, so five quick taps should be one
 * command for the final value, not five.
 */
const NUDGE_SETTLE_MS = 700;

/** Two-tap confirm window for switching the heat pump off. */
const CONFIRM_MS = 3000;

const LOW_BATTERY = 20;

interface Props {
  devices: Device[];
  rooms: PlanRoom[];
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
}

function deg(v: number | undefined, digits = 1) {
  return v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}°`;
}

/**
 * Everything climate-related in one list, next to the plan.
 *
 * The plan is the right place to find *where* something is, but a poor place
 * to answer "is the house warm and is the heat pump healthy" — that takes
 * clicking into every marker. This answers it at a glance and keeps the
 * controls one tap away.
 */
export default function ClimatePanel({
  devices, rooms, onThermostatCommand, onHeatPumpCommand,
}: Props) {
  const pumps = devices.filter((d): d is HeatPumpDevice => d.type === 'heatpump');
  const thermostats = devices
    .filter((d): d is ThermostatDevice => d.type === 'thermostat')
    // Unreachable ones sink to the bottom; the rest read in a stable order.
    .sort((a, b) =>
      Number(a.online === false) - Number(b.online === false) || a.name.localeCompare(b.name, 'pt'));

  const roomName = (id: string) => rooms.find(r => r.id === id)?.name;

  return (
    <div className="flex flex-col gap-5">
      {pumps.map(p => (
        <HeatPumpCard key={p.id} device={p} onCommand={onHeatPumpCommand} />
      ))}

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500 px-0.5">
          Termóstatos · {thermostats.filter(t => t.online !== false).length}/{thermostats.length} ligados
        </h2>
        {thermostats.map(t => (
          <ThermostatRow
            key={t.id}
            device={t}
            room={roomName(t.roomId)}
            onCommand={onThermostatCommand}
          />
        ))}
        {thermostats.length === 0 && (
          <p className="text-sm text-zinc-600 px-0.5">Sem termóstatos — a ponte ainda não respondeu.</p>
        )}
      </section>
    </div>
  );
}

function HeatPumpCard({
  device, onCommand,
}: { device: HeatPumpDevice; onCommand: Props['onHeatPumpCommand'] }) {
  const p = device.state;
  const offline = device.online === false;
  const running = !offline && p.on && (p.compressorHz ?? 0) > 0;
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    if (!confirmOff) return;
    const id = setTimeout(() => setConfirmOff(false), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [confirmOff]);

  const status = offline ? { label: 'Sem ligação', cls: 'bg-zinc-800 text-zinc-400' }
    : !p.on ? { label: 'Desligada', cls: 'bg-zinc-800 text-zinc-300' }
    : running ? { label: `A trabalhar · ${p.compressorHz} Hz`, cls: 'bg-orange-950 text-orange-300' }
    : { label: 'Em espera', cls: 'bg-zinc-800 text-zinc-300' };

  function togglePower() {
    if (p.on && !confirmOff) {
      setConfirmOff(true);
      return;
    }
    setConfirmOff(false);
    onCommand(device.id, { action: 'setOn', on: !p.on });
  }

  const cell = 'flex flex-col gap-0.5';
  const label = 'text-[10px] uppercase tracking-widest text-zinc-500';
  const value = 'text-sm text-zinc-100 tabular-nums';

  return (
    <section
      className={`rounded-xl border p-3.5 flex flex-col gap-3 ${
        p.faults.length > 0 ? 'border-red-700 bg-red-950/30' : 'border-zinc-800 bg-zinc-900'
      } ${offline ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-2">
        <Flame size={16} className={`shrink-0 mt-px ${running ? 'text-orange-400' : 'text-zinc-500'}`} />
        <h2 className="flex-1 min-w-0 text-sm font-semibold leading-snug text-zinc-100">{device.name}</h2>
        <span className={`text-[11px] px-2 py-0.5 rounded-md whitespace-nowrap ${status.cls}`}>
          {status.label}
        </span>
      </div>

      {p.faults.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {p.faults.map(code => (
            <li key={code} className="flex gap-2 text-xs text-red-200 leading-snug">
              <AlertTriangle size={14} className="text-red-400 shrink-0 mt-px" />
              <span><b className="text-red-300">{code}</b> — {faultMeaning(code)}</span>
            </li>
          ))}
        </ul>
      ) : !offline && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 size={14} /> Sem avarias
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <div className={cell}>
          <span className={label}>Modo</span>
          <span className={value}>{heatPumpModeLabel(p.mode) ?? '—'}</span>
        </div>
        <div className={cell}>
          <span className={label}>Exterior</span>
          <span className={value}>{deg(p.outdoor)}</span>
        </div>
        <div className={cell}>
          <span className={label}>Água entrada</span>
          <span className={value}>{deg(p.waterIn)}</span>
        </div>
        <div className={cell}>
          <span className={label}>Água saída</span>
          <span className={value}>
            {deg(p.waterOut)}
            <span className="text-zinc-500"> / {deg(p.heatingSetpoint, 0)}</span>
          </span>
        </div>
        <div className={cell}>
          <span className={label}>Águas quentes</span>
          <span className={value}>
            {deg(p.dhwTank)}
            <span className="text-zinc-500"> / {deg(p.dhwSetpoint, 0)}</span>
          </span>
        </div>
      </div>

      <button
        onClick={togglePower}
        disabled={offline}
        className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm transition-colors disabled:opacity-40 ${
          confirmOff
            ? 'bg-red-700 hover:bg-red-600 text-white font-semibold'
            : p.on
            ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
            : 'bg-emerald-800 hover:bg-emerald-700 text-white font-semibold'
        }`}
      >
        <Power size={14} />
        {confirmOff ? 'Tocar de novo para desligar' : p.on ? 'Desligar' : 'Ligar'}
      </button>
    </section>
  );
}

function ThermostatRow({
  device, room, onCommand,
}: { device: ThermostatDevice; room?: string; onCommand: Props['onThermostatCommand'] }) {
  const t = device.state;
  const offline = device.online === false;
  /** Target shown while taps are still settling; null once sent. */
  const [pending, setPending] = useState<number | null>(null);
  /** Mirrors `pending` synchronously — taps faster than a render must still add up. */
  const pendingRef = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const target = pending ?? t.target;
  const canSet = !offline && Number.isFinite(target);

  function nudge(delta: number) {
    if (!canSet) return;
    const base = pendingRef.current ?? t.target;
    const next = Math.min(TEMP_MAX, Math.max(TEMP_MIN,
      Math.round((base + delta) / TEMP_STEP) * TEMP_STEP));
    pendingRef.current = next;
    setPending(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onCommand(device.id, { action: 'setTarget', target: next });
      pendingRef.current = null;
      setPending(null);
    }, NUDGE_SETTLE_MS);
  }

  const btn = 'flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-30 disabled:hover:bg-zinc-800';

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 flex flex-col gap-1.5 ${
      offline ? 'opacity-50' : ''
    }`}>
      <div className="flex items-baseline gap-2">
        <span className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className="truncate text-sm text-zinc-100" title={device.name}>{device.name}</span>
          {t.heating && !offline && (
            <Flame size={13} className="text-orange-400 shrink-0" aria-label="a aquecer" />
          )}
        </span>
        <span className="text-xl leading-none text-zinc-50 tabular-nums">{deg(t.current)}</span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11px] text-zinc-500">
          {offline ? (
            <span className="flex items-center gap-1"><WifiOff size={11} /> sem ligação</span>
          ) : (
            <>
              <span className={`truncate ${room ? '' : 'text-zinc-600'}`}>
                {room ?? 'sem divisão'}
                {t.humidity !== undefined && ` · ${t.humidity}% hum.`}
                {t.mode === 'auto' && ' · programa'}
              </span>
              {t.battery !== undefined && t.battery <= LOW_BATTERY && (
                <span className="flex items-center gap-0.5 text-amber-400 shrink-0">
                  <BatteryLow size={12} /> {t.battery}%
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button className={btn} onClick={() => nudge(-TEMP_STEP)} disabled={!canSet} aria-label="Baixar">
            <Minus size={14} />
          </button>
          <span
            className={`w-11 text-center text-sm tabular-nums ${
              pending !== null ? 'text-sky-300' : t.heating ? 'text-orange-300' : 'text-zinc-300'
            }`}
            title="Temperatura pretendida"
          >
            {deg(target)}
          </span>
          <button className={btn} onClick={() => nudge(TEMP_STEP)} disabled={!canSet} aria-label="Subir">
            <Plus size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
