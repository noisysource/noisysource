import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronUp, Flame, Lightbulb, LightbulbOff, Square } from 'lucide-react';
import type {
  BlindCommand, BlindDevice, Device, HeatPumpCommand, HeatPumpDevice, LightCommand,
  LightDevice, ThermostatCommand, ThermostatDevice,
} from '@shared/models/Device';
import type { PlanRoom } from '@shared/models/Room';
import { HeatPumpCard, ThermostatRow } from './ClimatePanel';
import { roomStats } from '../data/placement';

interface Props {
  room: PlanRoom;
  rooms: PlanRoom[];
  /** Only this room's devices. */
  devices: Device[];
  /** Device tapped in the 3D view — scrolled to and highlighted here. */
  focusDeviceId: string | null;
  /** Absent: no back button (Divisões has its own room list beside it). */
  onBack?: () => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onLightsSet: (deviceIds: string[], on: boolean) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
  onBlindsSet: (deviceIds: string[], position: number) => void;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
}

const sectionTitle = 'text-[11px] font-semibold uppercase tracking-widest text-zinc-500';
const smallBtn = 'text-xs px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-300 transition';

/** Everything controllable in one room, for the panel beside (or under) the 3D house. */
export default function RoomPanel({
  room, rooms, devices, focusDeviceId, onBack,
  onLightCommand, onLightsSet, onBlindCommand, onBlindsSet, onThermostatCommand, onHeatPumpCommand,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lights = devices.filter((d): d is LightDevice => d.type === 'light');
  const blinds = devices.filter((d): d is BlindDevice => d.type === 'blind');
  const thermostats = devices.filter((d): d is ThermostatDevice => d.type === 'thermostat');
  const pumps = devices.filter((d): d is HeatPumpDevice => d.type === 'heatpump');
  const stats = roomStats(devices, room.id);
  const lit = lights.filter(l => l.state.on);

  useEffect(() => {
    if (!focusDeviceId) return;
    const el = rootRef.current?.querySelector(`[data-device-id="${CSS.escape(focusDeviceId)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusDeviceId]);

  const ring = (id: string) => (id === focusDeviceId ? 'ring-2 ring-sky-400/70 rounded-xl' : '');

  return (
    <div ref={rootRef} className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        {onBack && <button
          onClick={onBack}
          className="flex items-center gap-0.5 pl-1.5 pr-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
        >
          <ChevronLeft size={16} /> Casa
        </button>}
        <h2 className="flex-1 min-w-0 flex items-center gap-2 text-lg font-semibold text-zinc-50">
          <span aria-hidden="true">{room.icon}</span>
          <span className="truncate">{room.name}</span>
        </h2>
        {stats.temp !== undefined && (
          <span className="flex items-center gap-1 text-2xl font-light tabular-nums text-zinc-100">
            {stats.heating && <Flame size={16} className="text-orange-400" />}
            {stats.temp.toFixed(1)}°
          </span>
        )}
      </div>

      {lights.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className={sectionTitle}>Luzes · {lit.length}/{lights.length} acesas</h3>
            {lights.length > 1 && (
              lit.length > 0 ? (
                <button className={smallBtn} onClick={() => onLightsSet(lit.map(l => l.id), false)}>
                  Apagar todas
                </button>
              ) : (
                <button className={smallBtn} onClick={() => onLightsSet(lights.map(l => l.id), true)}>
                  Acender todas
                </button>
              )
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {lights.map(l => (
              <LightTile
                key={l.id}
                light={l}
                className={ring(l.id)}
                onCommand={cmd => onLightCommand(l.id, cmd)}
              />
            ))}
          </div>
        </section>
      )}

      {blinds.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className={sectionTitle}>Estores</h3>
            {blinds.length > 1 && (
              <div className="flex gap-1.5">
                <button className={smallBtn} onClick={() => onBlindsSet(blinds.map(b => b.id), 100)}>
                  Abrir todos
                </button>
                <button className={smallBtn} onClick={() => onBlindsSet(blinds.map(b => b.id), 0)}>
                  Fechar todos
                </button>
              </div>
            )}
          </div>
          {blinds.map(b => (
            <div key={b.id} data-device-id={b.id} className={ring(b.id)}>
              <BlindRow device={b} onCommand={cmd => onBlindCommand(b.id, cmd)} />
            </div>
          ))}
        </section>
      )}

      {(thermostats.length > 0 || pumps.length > 0) && (
        <section className="flex flex-col gap-2">
          <h3 className={sectionTitle}>Clima</h3>
          {pumps.map(p => (
            <div key={p.id} data-device-id={p.id} className={ring(p.id)}>
              <HeatPumpCard device={p} onCommand={onHeatPumpCommand} />
            </div>
          ))}
          {thermostats.map(t => (
            <div key={t.id} data-device-id={t.id} className={ring(t.id)}>
              <ThermostatRow
                device={t}
                room={rooms.find(r => r.id === t.roomId)?.name}
                onCommand={onThermostatCommand}
              />
            </div>
          ))}
        </section>
      )}

      {devices.length === 0 && (
        <p className="text-sm text-zinc-500">Sem dispositivos nesta divisão.</p>
      )}
    </div>
  );
}

/** A light's tile: tap to switch; dimmers also get their level, like a blind. */
function LightTile({ light, className, onCommand }: {
  light: LightDevice;
  className: string;
  onCommand: (c: LightCommand) => void;
}) {
  // Local while dragging; one command on release, not one per pixel.
  const [drag, setDrag] = useState<number | null>(null);
  const on = light.state.on;
  const level = drag ?? (on ? light.state.brightness : 0);

  function commit() {
    if (drag === null) return;
    onCommand({ action: 'setBrightness', brightness: drag });
    setDrag(null);
  }

  return (
    <div
      data-device-id={light.id}
      className={`rounded-xl border transition ${
        on ? 'bg-amber-400/15 border-amber-400/50' : 'bg-zinc-900 border-zinc-800'
      } ${light.online === false ? 'opacity-40' : ''} ${className}`}
    >
      <button
        onClick={() => onCommand({ action: 'toggle' })}
        aria-pressed={on}
        disabled={light.online === false}
        className={`w-full flex items-center gap-2.5 px-3 py-3 text-left active:scale-[0.97] transition ${
          on ? 'text-amber-100' : 'text-zinc-300'
        }`}
      >
        {on
          ? <Lightbulb size={20} className="shrink-0 text-amber-300" fill="#fbbf24" />
          : <LightbulbOff size={20} className="shrink-0 text-zinc-500" />}
        <span className="min-w-0 flex flex-col">
          <span className="truncate text-sm">{light.name}</span>
          <span className="text-[11px] text-zinc-500 tabular-nums">
            {!on ? 'Apagada' : light.state.dimmable ? `Acesa · ${level}%` : 'Acesa'}
          </span>
        </span>
      </button>
      {light.state.dimmable && (
        <div className="px-3 pb-2.5 -mt-1">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={level}
            aria-label={`Intensidade de ${light.name}`}
            onChange={e => setDrag(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="w-full cursor-pointer touch-none"
          />
        </div>
      )}
    </div>
  );
}

export function BlindRow({ device, onCommand }: { device: BlindDevice; onCommand: (c: BlindCommand) => void }) {
  const { state } = device;
  /**
   * While the thumb is held we show the local value and send nothing — a range
   * input fires on every step, and one Netatmo call per pixel would hammer the
   * gateway. The command goes out once, on release.
   */
  const [dragValue, setDragValue] = useState<number | null>(null);
  const openPct = dragValue ?? state.position;
  const label = openPct === 100 ? 'Aberto' : openPct === 0 ? 'Fechado' : `${openPct}% aberto`;

  function commit() {
    if (dragValue === null) return;
    onCommand({ action: 'setPosition', position: dragValue });
    setDragValue(null);
  }

  const btn = 'flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-zinc-200 transition disabled:opacity-35';

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 flex flex-col gap-1.5 ${
      device.online === false ? 'opacity-50' : ''
    }`}>
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-sm text-zinc-100">{device.name}</span>
        {state.isMoving && (
          <span className="text-xs text-blue-400 animate-pulse">
            {state.movingDirection === 'up' ? '↑ A subir' : '↓ A descer'}
          </span>
        )}
        <span className="text-xs text-zinc-500 tabular-nums">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <button className={btn} onClick={() => onCommand({ action: 'moveDown' })} aria-label="Fechar">
          <ChevronDown size={18} />
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={openPct}
          aria-label={`Posição do estore ${device.name}`}
          onChange={e => setDragValue(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="slider-blind flex-1 min-w-0 cursor-pointer touch-none"
        />
        <button className={btn} onClick={() => onCommand({ action: 'moveUp' })} aria-label="Abrir">
          <ChevronUp size={18} />
        </button>
        {/* A slider sets a destination; this halts mid-travel. */}
        <button
          className={btn}
          onClick={() => onCommand({ action: 'stop' })}
          disabled={!state.isMoving}
          aria-label="Parar"
        >
          <Square size={14} />
        </button>
      </div>
    </div>
  );
}
