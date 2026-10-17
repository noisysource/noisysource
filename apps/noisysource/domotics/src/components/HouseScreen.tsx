import { Component, Suspense, lazy, useState, type ReactNode } from 'react';
import { Flame, Lightbulb, Map as MapIcon, Pencil, Server, Thermometer, Home, Maximize2 } from 'lucide-react';
import type {
  BlindCommand, Device, DevicePlacement, HeatPumpCommand, LightCommand, LightDevice,
  ThermostatCommand,
} from '@shared/models/Device';
import type { FloorPlan } from '@shared/models/Room';
import type { User } from 'firebase/auth';
import type { DeviceStatus } from '../App';
import type { EnergyReading } from '../data/energy';
import { batteryFlow, formatWatts, gridFlow, solarShare } from '../data/energy';
import { roomStats } from '../data/placement';
import type { HouseMode } from './house3d/House3D';
import ClimatePanel from './ClimatePanel';
import Clock from './Clock';
import HealthChips, { FaultBanner } from './HealthChips';
import RoomPanel from './RoomPanel';

/**
 * Loaded on its own: three.js is most of the app's weight, and the header,
 * panel and controls should be usable before it arrives — on a phone over
 * mobile data that can be a couple of seconds.
 */
const House3D = lazy(() => import('./house3d/House3D'));

interface Props {
  plan: FloorPlan;
  devices: Device[];
  placements: Record<string, DevicePlacement>;
  deviceStatus: DeviceStatus;
  bridgeStatus: DeviceStatus;
  bridgeUpdatedAt?: number;
  energy: EnergyReading | null;
  user: User | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onOpenAdmin: () => void;
  onShow2D: () => void;
  onStartEdit: () => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onLightsSet: (deviceIds: string[], on: boolean) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
  onBlindsSet: (deviceIds: string[], position: number) => void;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
}

/**
 * WebGL can be missing or lost (an old tablet, a GPU reset after hours on a
 * wall). The rest of the screen still works without the picture, so a failure
 * there costs the 3D view, not the house.
 */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('3D view failed:', err);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const iconBtn = 'flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors';
const sectionTitle = 'text-[11px] font-semibold uppercase tracking-widest text-zinc-500 px-0.5';

/**
 * The everyday screen: the house in 3D, with a panel for whatever is selected.
 *
 * Landscape tablet: 3D on the left, panel on the right. Phone (and portrait
 * tablet): 3D on top, panel scrolling underneath — thumbs reach the controls,
 * and the picture stays in view while they're used.
 */
export default function HouseScreen({
  plan, devices, placements, deviceStatus, bridgeStatus, bridgeUpdatedAt, energy, user,
  onSignIn, onSignOut, onOpenAdmin, onShow2D, onStartEdit,
  onLightCommand, onLightsSet, onBlindCommand, onBlindsSet, onThermostatCommand, onHeatPumpCommand,
}: Props) {
  const [mode, setMode] = useState<HouseMode>('casa');
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [focusDeviceId, setFocusDeviceId] = useState<string | null>(null);

  const selectedRoom = plan.rooms.find(r => r.id === selectedRoomId) ?? null;

  function selectRoom(id: string | null) {
    setSelectedRoomId(id);
    setFocusDeviceId(null);
  }

  /** From a chip in the 3D view: open its room and bring the device's controls up. */
  function openDevice(deviceId: string) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) return;
    setSelectedRoomId(device.roomId);
    setFocusDeviceId(deviceId);
  }

  return (
    <div className="h-[100dvh] bg-zinc-950 text-zinc-50 flex flex-col overflow-hidden">
      <header
        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-6 pb-3 border-b border-zinc-800/60 shrink-0"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2 mr-auto">
          <span className="text-xl select-none" aria-hidden="true">🏠</span>
          <h1 className="text-base font-semibold tracking-wide text-zinc-100">Casa</h1>
        </div>

        {/* Second row on a phone, inline from sm up. */}
        <div className="order-last w-full sm:order-none sm:w-auto flex items-center gap-2">
          <HealthChips
            devices={devices}
            deviceStatus={deviceStatus}
            bridgeStatus={bridgeStatus}
            bridgeUpdatedAt={bridgeUpdatedAt}
            onSignIn={onSignIn}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <div className="hidden md:block mr-2"><Clock /></div>
          <button onClick={onShow2D} className={iconBtn} aria-label="Planta 2D" title="Planta 2D">
            <MapIcon size={16} />
          </button>
          <button onClick={onStartEdit} className={iconBtn} aria-label="Editar planta" title="Editar planta">
            <Pencil size={15} />
          </button>
          {user && (
            <button onClick={onOpenAdmin} className={iconBtn} aria-label="Estado da ponte" title="Estado da ponte (Raspberry Pi)">
              <Server size={15} />
            </button>
          )}
          <button
            onClick={() => (user ? onSignOut() : onSignIn())}
            className="text-xs px-2.5 h-9 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors max-w-[7rem] truncate"
            title={user ? `Sessão: ${user.email}` : 'Entrar para aceder fora de casa'}
          >
            {user ? (user.email?.split('@')[0] ?? 'sessão') : 'Entrar'}
          </button>
        </div>
      </header>

      <FaultBanner devices={devices} />

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <section className="relative basis-[52%] shrink-0 grow-0 min-h-0 lg:basis-auto lg:grow lg:shrink">
          <SceneBoundary
            fallback={
              <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-zinc-400 p-6 text-center">
                Este ecrã não conseguiu mostrar a casa em 3D.
                <button onClick={onShow2D} className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
                  Ver planta 2D
                </button>
              </div>
            }
          >
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center text-sm text-zinc-500">
                  A carregar a casa…
                </div>
              }
            >
              <House3D
                plan={plan}
                devices={devices}
                placements={placements}
                mode={mode}
                selectedRoomId={selectedRoomId}
                onSelectRoom={selectRoom}
                onLightToggle={id => onLightCommand(id, { action: 'toggle' })}
                onDeviceOpen={openDevice}
              />
            </Suspense>
          </SceneBoundary>

          <div className="absolute z-[60] top-3 left-3 flex rounded-xl bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 p-0.5">
            {([['casa', 'Casa', Home], ['clima', 'Clima', Thermometer]] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  mode === key ? 'bg-zinc-100 text-zinc-900 font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          {selectedRoom && (
            <button
              onClick={() => selectRoom(null)}
              className="absolute z-[60] top-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 text-xs text-zinc-300 hover:text-white"
            >
              <Maximize2 size={13} /> Casa toda
            </button>
          )}

          {mode === 'clima' && <TempLegend />}
        </section>

        <aside
          className="flex-1 min-h-0 lg:flex-none lg:w-[24rem] xl:w-[26rem] overflow-y-auto overscroll-contain border-t lg:border-t-0 lg:border-l border-zinc-800/60 p-4"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        >
          {selectedRoom ? (
            <RoomPanel
              room={selectedRoom}
              rooms={plan.rooms}
              devices={devices.filter(d => d.roomId === selectedRoom.id)}
              focusDeviceId={focusDeviceId}
              onBack={() => selectRoom(null)}
              onLightCommand={onLightCommand}
              onLightsSet={onLightsSet}
              onBlindCommand={onBlindCommand}
              onBlindsSet={onBlindsSet}
              onThermostatCommand={onThermostatCommand}
              onHeatPumpCommand={onHeatPumpCommand}
            />
          ) : (
            <Overview
              plan={plan}
              devices={devices}
              energy={energy}
              onSelectRoom={selectRoom}
              onLightsSet={onLightsSet}
              onThermostatCommand={onThermostatCommand}
              onHeatPumpCommand={onHeatPumpCommand}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function TempLegend() {
  return (
    <div className="absolute z-[60] bottom-3 left-3 flex items-center gap-2 rounded-xl bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-400 tabular-nums">
      16°
      <span
        className="w-28 h-1.5 rounded-full"
        style={{ background: 'linear-gradient(to right, #1d4ed8, #0891b2, #059669, #d97706, #dc2626)' }}
      />
      25°
    </div>
  );
}

/** The panel when no room is selected: what's on, every room, climate, energy. */
function Overview({
  plan, devices, energy, onSelectRoom, onLightsSet, onThermostatCommand, onHeatPumpCommand,
}: {
  plan: FloorPlan;
  devices: Device[];
  energy: EnergyReading | null;
  onSelectRoom: (id: string) => void;
  onLightsSet: Props['onLightsSet'];
  onThermostatCommand: Props['onThermostatCommand'];
  onHeatPumpCommand: Props['onHeatPumpCommand'];
}) {
  const lit = devices.filter((d): d is LightDevice => d.type === 'light' && d.state.on);
  const roomName = (id: string) => plan.rooms.find(r => r.id === id)?.name ?? '—';
  const withDevices = new Set(devices.map(d => d.roomId));
  const rooms = plan.rooms.filter(r => r.controllable || withDevices.has(r.id));

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}>
            {lit.length === 0 ? 'Luzes · todas apagadas' : `Luzes · ${lit.length} acesa${lit.length > 1 ? 's' : ''}`}
          </h2>
          {lit.length > 0 && (
            <button
              onClick={() => onLightsSet(lit.map(l => l.id), false)}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 active:scale-95 text-amber-950 font-semibold transition"
            >
              Apagar todas
            </button>
          )}
        </div>
        {lit.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {lit.map(l => (
              <button
                key={l.id}
                onClick={() => onLightsSet([l.id], false)}
                className="flex items-center gap-1.5 rounded-lg bg-amber-400/10 border border-amber-400/30 px-2 py-1 text-xs text-amber-100 hover:bg-amber-400/20"
                title="Apagar"
              >
                <Lightbulb size={12} className="text-amber-300" />
                <span className="text-amber-300/70">{roomName(l.roomId)} ·</span> {l.name}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <h2 className={sectionTitle}>Divisões</h2>
        <div className="grid grid-cols-2 gap-1.5">
          {rooms.map(r => {
            const s = roomStats(devices, r.id);
            return (
              <button
                key={r.id}
                onClick={() => onSelectRoom(r.id)}
                className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-2 text-left transition-colors"
              >
                <span aria-hidden="true">{r.icon}</span>
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="truncate text-sm text-zinc-200">{r.name}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 tabular-nums">
                    {s.temp !== undefined && <span className="text-zinc-300">{s.temp.toFixed(1)}°</span>}
                    {s.heating && <Flame size={10} className="text-orange-400" />}
                    {s.lit > 0 && (
                      <span className="flex items-center gap-0.5 text-amber-300">
                        <Lightbulb size={10} />{s.lit}
                      </span>
                    )}
                    {s.temp === undefined && s.lit === 0 && `${s.count} disp.`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {energy?.online && <EnergyCard energy={energy} />}

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>Clima</h2>
        <ClimatePanel
          devices={devices}
          rooms={plan.rooms}
          onThermostatCommand={onThermostatCommand}
          onHeatPumpCommand={onHeatPumpCommand}
        />
      </section>
    </div>
  );
}

function EnergyCard({ energy }: { energy: EnergyReading }) {
  const battery = batteryFlow(energy);
  const grid = gridFlow(energy);
  const share = solarShare(energy);
  const label = 'text-[10px] uppercase tracking-widest text-zinc-500';
  return (
    <section className="flex flex-col gap-2">
      <h2 className={sectionTitle}>Energia</h2>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3.5 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <div className="flex flex-col">
            <span className={label}>Solar</span>
            <span className="text-base text-amber-300 tabular-nums">{formatWatts(energy.pvPowerW)}</span>
          </div>
          <div className="flex flex-col">
            <span className={label}>Casa</span>
            <span className="text-base text-zinc-100 tabular-nums">{formatWatts(energy.consumptionW)}</span>
          </div>
          <div className="flex flex-col">
            <span className={label}>
              Bateria{battery === 'in' ? ' · a carregar' : battery === 'out' ? ' · a descarregar' : ''}
            </span>
            <span className={`text-base tabular-nums ${
              battery === 'in' ? 'text-lime-300' : battery === 'out' ? 'text-orange-300' : 'text-zinc-400'
            }`}>
              {formatWatts(energy.batteryPowerW === undefined ? undefined : Math.abs(energy.batteryPowerW))}
              <span className="text-sm text-zinc-500"> · {energy.soc ?? '—'}%</span>
            </span>
          </div>
          <div className="flex flex-col">
            <span className={label}>
              Rede{grid === 'out' ? ' · a exportar' : grid === 'in' ? ' · a importar' : ''}
            </span>
            <span className={`text-base tabular-nums ${
              grid === 'out' ? 'text-sky-300' : grid === 'in' ? 'text-red-300' : 'text-zinc-400'
            }`}>
              {formatWatts(energy.gridPowerW === undefined ? undefined : Math.abs(energy.gridPowerW))}
            </span>
          </div>
        </div>
        {share !== undefined && (
          <div className="flex flex-col gap-1.5">
            <span className={label}>{Math.round(share * 100)}% do consumo vem do sol</span>
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div className="h-full rounded-full bg-amber-400 transition-all duration-700" style={{ width: `${share * 100}%` }} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
