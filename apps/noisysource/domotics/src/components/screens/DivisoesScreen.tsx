import { ChevronLeft, Flame, Lightbulb, Thermometer } from 'lucide-react';
import type {
  BlindCommand, BlindDevice, Device, HeatPumpCommand, LightCommand, LightDevice, ThermostatCommand,
} from '@shared/models/Device';
import type { FloorPlan } from '@shared/models/Room';
import { roomStats } from '../../data/placement';
import RoomPanel from '../RoomPanel';

interface Props {
  plan: FloorPlan;
  devices: Device[];
  /** The room open on the right (browser) or full width (phone); null = the list. */
  roomId: string | null;
  onRoom: (roomId: string | null) => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onLightsSet: (deviceIds: string[], on: boolean) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
  onBlindsSet: (deviceIds: string[], position: number) => void;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
}

const pill = 'min-h-[40px] px-4 rounded-full text-sm transition-colors';

function deg(v: number) {
  return `${v.toLocaleString('pt-PT', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}°`;
}

/**
 * Lights, blinds and thermostats, room by room, without the 3D picture in the
 * way. The controls are the same RoomPanel the 3D view opens, so a room
 * behaves the same wherever it is reached from. Whole-house actions go in one
 * call each (see App's handleLightsSet / handleBlindsSet).
 */
export default function DivisoesScreen({
  plan, devices, roomId, onRoom,
  onLightCommand, onLightsSet, onBlindCommand, onBlindsSet, onThermostatCommand, onHeatPumpCommand,
}: Props) {
  const withDevices = new Set(devices.map(d => d.roomId));
  const rooms = plan.rooms.filter(r => r.controllable || withDevices.has(r.id));
  const room = rooms.find(r => r.id === roomId) ?? null;
  const lit = devices.filter((d): d is LightDevice => d.type === 'light' && d.state.on);
  const blinds = devices.filter((d): d is BlindDevice => d.type === 'blind');

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 pt-4 pb-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <h1 className="text-2xl font-bold text-zinc-50 mr-3">Divisões</h1>
        <button
          onClick={() => onLightsSet(lit.map(l => l.id), false)}
          disabled={lit.length === 0}
          className={`${pill} bg-amber-400 hover:bg-amber-300 text-amber-950 font-semibold disabled:bg-zinc-800 disabled:text-zinc-500 disabled:font-normal`}
        >
          {lit.length ? `Apagar ${lit.length === 1 ? 'a luz acesa' : `as ${lit.length} luzes`}` : 'Luzes apagadas'}
        </button>
        {blinds.length > 0 && (
          <>
            <button onClick={() => onBlindsSet(blinds.map(b => b.id), 0)} className={`${pill} bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700`}>
              Fechar estores
            </button>
            <button onClick={() => onBlindsSet(blinds.map(b => b.id), 100)} className={`${pill} bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700`}>
              Abrir estores
            </button>
          </>
        )}
      </div>

      <div className="flex gap-5 items-start">
        <nav
          aria-label="Divisão"
          className={`${room ? 'hidden md:flex' : 'flex'} flex-col gap-2 w-full md:w-72 md:shrink-0`}
        >
          {rooms.map(r => {
            const s = roomStats(devices, r.id);
            const sel = r.id === room?.id;
            return (
              <button
                key={r.id}
                onClick={() => onRoom(r.id)}
                aria-current={sel ? 'true' : undefined}
                className={`min-h-[56px] px-4 py-3 rounded-2xl border flex items-center gap-3 text-left transition-colors ${
                  sel ? 'bg-amber-400/10 border-amber-500/60' : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <span aria-hidden="true">{r.icon}</span>
                <span className="flex-1 min-w-0 truncate text-[15px] text-zinc-100">{r.name}</span>
                <span className="flex items-center gap-2 text-sm text-zinc-400 tabular-nums">
                  {s.temp !== undefined && <span className="flex items-center gap-1"><Thermometer size={13} />{deg(s.temp)}</span>}
                  {s.heating && <Flame size={13} className="text-orange-400" aria-label="a aquecer" />}
                  {s.lit > 0 && <span className="flex items-center gap-0.5 text-amber-300"><Lightbulb size={13} />{s.lit}</span>}
                </span>
              </button>
            );
          })}
        </nav>

        <section className={`${room ? 'block' : 'hidden md:block'} flex-1 min-w-0`}>
          {room ? (
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
              <button onClick={() => onRoom(null)} className="md:hidden flex items-center gap-1 text-sm text-zinc-300 mb-2 min-h-[40px]">
                <ChevronLeft size={16} /> Todas as divisões
              </button>
              <RoomPanel
                room={room}
                rooms={plan.rooms}
                devices={devices.filter(d => d.roomId === room.id)}
                focusDeviceId={null}
                onLightCommand={onLightCommand}
                onLightsSet={onLightsSet}
                onBlindCommand={onBlindCommand}
                onBlindsSet={onBlindsSet}
                onThermostatCommand={onThermostatCommand}
                onHeatPumpCommand={onHeatPumpCommand}
              />
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-400">
              Escolha uma divisão para ver as luzes, os estores e o termóstato.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
