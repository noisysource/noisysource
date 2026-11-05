import { Component, Suspense, lazy, useCallback, useState, type ReactNode } from 'react';
import {
  Battery, BatteryCharging, ChartColumn, ChevronRight, ClipboardList, Flame, Home, Lightbulb, Map as MapIcon, Maximize2,
  Pencil, Server, Sun, Thermometer, Zap,
} from 'lucide-react';
import type {
  BlindCommand, Device, DevicePlacement, HeatPumpCommand, LightCommand, LightDevice,
  ThermostatCommand,
} from '@shared/models/Device';
import type { FloorPlan } from '@shared/models/Room';
import type { User } from 'firebase/auth';
import type { DeviceStatus } from '../App';
import type { EnergyReading } from '../data/energy';
import { batteryFlow, formatWatts, gridFlow, liveSurplus, solarShare } from '../data/energy';
import { roomStats } from '../data/placement';
import type { HouseMode } from './house3d/House3D';
import ClimatePanel from './ClimatePanel';
import SurplusNow from './SurplusNow';
import Clock from './Clock';
import HealthChips, { FaultBanner } from './HealthChips';
import RoomPanel from './RoomPanel';
import AutomationCard from './AutomationCard';
import type { AutomationStatus } from '../data/automation';

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
  onOpenReports: () => void;
  /** kWh history and the bill; absent when it can't be read (signed out). */
  onOpenEnergy?: () => void;
  onShow2D: () => void;
  onStartEdit: () => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onLightsSet: (deviceIds: string[], on: boolean) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
  onBlindsSet: (deviceIds: string[], position: number) => void;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
  automation?: AutomationStatus;
  canEditAutomation: boolean;
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

const HOLD_PREF = 'domotics.holdLearned';
const LAYER_PREF = 'domotics.layer';
const LAYERS: HouseMode[] = ['luzes', 'clima', 'energia'];

function initialLayer(): HouseMode {
  try {
    const saved = localStorage.getItem(LAYER_PREF) as HouseMode | null;
    if (saved && LAYERS.includes(saved)) return saved;
  } catch { /* storage unavailable */ }
  return 'luzes';
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
  onSignIn, onSignOut, onOpenAdmin, onOpenReports, onOpenEnergy, onShow2D, onStartEdit,
  onLightCommand, onLightsSet, onBlindCommand, onBlindsSet, onThermostatCommand, onHeatPumpCommand,
  automation, canEditAutomation,
}: Props) {
  /**
   * Outdoor temperature from the heat pump's own sensor. Here it reads colder
   * than any weather service, and it is what the pump actually works against.
   */
  const outdoor = devices.find(
    (d): d is Extract<Device, { type: 'heatpump' }> => d.type === 'heatpump' && d.online !== false,
  )?.state.outdoor;
  const [mode, setModeState] = useState<HouseMode>(initialLayer);
  /** Remembered per device: the wall tablet may live on Energia, a phone on Luzes. */
  function setMode(next: HouseMode) {
    setModeState(next);
    try { localStorage.setItem(LAYER_PREF, next); } catch { /* not persisted */ }
  }
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [focusDeviceId, setFocusDeviceId] = useState<string | null>(null);
  /** The press-and-hold hint stays until it has been used once on this device. */
  const [holdLearned, setHoldLearned] = useState(() => {
    try { return localStorage.getItem(HOLD_PREF) === '1'; } catch { return false; }
  });
  const onHoldUsed = useCallback(() => {
    setHoldLearned(true);
    try { localStorage.setItem(HOLD_PREF, '1'); } catch { /* not persisted */ }
  }, []);

  /** Solar/battery equipment tapped: back to the house panel, scrolled to the energy figures. */
  const openEnergy = useCallback(() => {
    setSelectedRoomId(null);
    setFocusDeviceId(null);
    // After the panel has switched back to the overview.
    requestAnimationFrame(() => document.getElementById('energia')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);

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
          {outdoor !== undefined && (
            <span
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg whitespace-nowrap bg-zinc-800 text-zinc-200 tabular-nums"
              title="Temperatura exterior — sensor da bomba de calor"
            >
              <Thermometer size={12} className="text-sky-300" /> {outdoor.toFixed(1)}° exterior
            </span>
          )}
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
          {onOpenEnergy && (
            <button onClick={onOpenEnergy} className={iconBtn} aria-label="Energia" title="Energia — consumo, solar, bateria e fatura">
              <ChartColumn size={15} />
            </button>
          )}
          {/* Signed in only, like the bridge screen: both read owner-only data. */}
          {user && (
            <button onClick={onOpenReports} className={iconBtn} aria-label="Relatórios" title="Relatórios — avarias da bomba">
              <ClipboardList size={15} />
            </button>
          )}
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
                onLightCommand={onLightCommand}
                onBlindCommand={onBlindCommand}
                onThermostatCommand={onThermostatCommand}
                onDeviceOpen={openDevice}
                energy={energy}
                onEnergyOpen={openEnergy}
                onHoldUsed={onHoldUsed}
              />
            </Suspense>
          </SceneBoundary>

          <div className="absolute z-[60] top-3 left-3 flex rounded-xl bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 p-0.5">
            {([['luzes', 'Luzes', Lightbulb], ['clima', 'Clima', Thermometer], ['energia', 'Energia', Sun]] as const).map(([key, label, Icon]) => (
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

          {/* One column in the bottom-left corner, so nothing here can collide
              on a phone: the hint (until learned), the climate legend, energy. */}
          <div className="absolute z-[60] bottom-3 left-3 right-3 flex flex-col items-start gap-1.5 pointer-events-none">
            {mode === 'luzes' && !holdLearned && (
              // Holding is invisible until someone tells you; this is the telling.
              <p className="rounded-lg bg-zinc-950/70 px-2 py-1 text-[10px] text-zinc-400">
                Tocar: ligar/desligar · Manter premido: ajustar
              </p>
            )}
            {mode === 'clima' && <TempLegend outdoor={outdoor} />}
            {/* On the energy layer the same figures are in the scene itself. */}
            {mode !== 'energia' && energy?.online && <EnergyStrip energy={energy} onOpen={openEnergy} />}
          </div>
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
              automation={automation}
              canEditAutomation={canEditAutomation}
              mode={mode}
              plan={plan}
              devices={devices}
              energy={energy}
              onOpenEnergy={onOpenEnergy}
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

function TempLegend({ outdoor }: { outdoor?: number }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-400 tabular-nums">
      16°
      <span
        className="w-28 h-1.5 rounded-full"
        style={{ background: 'linear-gradient(to right, #1d4ed8, #0891b2, #059669, #d97706, #dc2626)' }}
      />
      25°
      {outdoor !== undefined && <span className="text-zinc-300">· exterior {outdoor.toFixed(1)}°</span>}
    </div>
  );
}

/**
 * Solar, house, battery and grid in one line over the 3D view, so the energy
 * picture is there without scrolling the panel — the part of it that changes
 * minute to minute. Tapping it opens the full figures.
 */
function EnergyStrip({ energy, onOpen }: { energy: EnergyReading; onOpen: () => void }) {
  const battery = batteryFlow(energy);
  const grid = gridFlow(energy);
  const surplus = liveSurplus(energy);
  const abs = (w?: number) => (w === undefined ? undefined : Math.abs(w));
  const item = 'flex items-center gap-1 whitespace-nowrap';
  return (
    <button
      onClick={onOpen}
      className="pointer-events-auto max-w-full flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 px-3 py-1.5 text-xs tabular-nums text-left"
      title="Energia: solar, consumo, bateria e rede"
    >
      <span className={`${item} text-amber-300`}><Sun size={13} />{formatWatts(energy.pvPowerW)}</span>
      <span className={`${item} text-zinc-100`}><Home size={13} className="text-zinc-400" />{formatWatts(energy.consumptionW)}</span>
      <span className={`${item} ${battery === 'in' ? 'text-lime-300' : battery === 'out' ? 'text-orange-300' : 'text-zinc-300'}`}>
        {battery === 'in' ? <BatteryCharging size={14} /> : <Battery size={14} />}
        {energy.soc ?? '—'}%
        {battery !== 'idle' && (
          <span className="text-[11px] opacity-80">{battery === 'in' ? '↑' : '↓'}{formatWatts(abs(energy.batteryPowerW))}</span>
        )}
      </span>
      <span className={`${item} ${grid === 'out' ? 'text-sky-300' : grid === 'in' ? 'text-red-300' : 'text-zinc-400'}`}>
        <Zap size={13} />
        {grid === 'out' ? '↑' : grid === 'in' ? '↓' : ''}{formatWatts(abs(energy.gridPowerW))}
      </span>
      {surplus && (
        <span className={`${item} rounded-md bg-amber-400/15 px-1.5 text-amber-200`} title="Excedente solar a ir para a rede, sem pagamento">
          excedente ~{formatWatts(surplus.exportW)}
        </span>
      )}
    </button>
  );
}

/** The panel when no room is selected: what's on, every room, climate, energy. */
function Overview({
  automation, canEditAutomation, mode, plan, devices, energy, onOpenEnergy, onSelectRoom, onLightsSet,
  onThermostatCommand, onHeatPumpCommand,
}: {
  automation?: AutomationStatus;
  canEditAutomation: boolean;
  mode: HouseMode;
  plan: FloorPlan;
  devices: Device[];
  energy: EnergyReading | null;
  onOpenEnergy?: () => void;
  onSelectRoom: (id: string) => void;
  onLightsSet: Props['onLightsSet'];
  onThermostatCommand: Props['onThermostatCommand'];
  onHeatPumpCommand: Props['onHeatPumpCommand'];
}) {
  const pump = devices.find((d): d is Extract<Device, { type: 'heatpump' }> => d.type === 'heatpump' && d.online !== false);
  const lit = devices.filter((d): d is LightDevice => d.type === 'light' && d.state.on);
  const roomName = (id: string) => plan.rooms.find(r => r.id === id)?.name ?? '—';
  const withDevices = new Set(devices.map(d => d.roomId));
  const rooms = plan.rooms.filter(r => r.controllable || withDevices.has(r.id));

  const sections = {
    lights: (
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
    ),
    rooms: (
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
    ),
    energy: energy?.online ? <EnergyCard energy={energy} onOpen={onOpenEnergy} /> : (
      <p id="energia" className="text-sm text-zinc-500">Inversor sem ligação — sem dados de energia.</p>
    ),
    automation: <AutomationCard status={automation} canEdit={canEditAutomation} pumpOn={pump?.state.on} />,
    climate: (
      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>Clima</h2>
        <ClimatePanel
          devices={devices}
          rooms={plan.rooms}
          onThermostatCommand={onThermostatCommand}
          onHeatPumpCommand={onHeatPumpCommand}
        />
      </section>
    ),
  };
  // The layer in view leads; the rest follow.
  const order: Array<keyof typeof sections> =
    mode === 'clima' ? ['automation', 'climate', 'rooms', 'lights', 'energy']
    : mode === 'energia' ? ['energy', 'automation', 'lights', 'rooms', 'climate']
    : ['lights', 'rooms', 'energy', 'climate', 'automation'];

  return (
    <div className="flex flex-col gap-6">
      {order.map(key => <div key={key}>{sections[key]}</div>)}
    </div>
  );
}

function EnergyCard({ energy, onOpen }: { energy: EnergyReading; onOpen?: () => void }) {
  const battery = batteryFlow(energy);
  const grid = gridFlow(energy);
  const share = solarShare(energy);
  const surplus = liveSurplus(energy);
  const label = 'text-[10px] uppercase tracking-widest text-zinc-500';
  return (
    <section id="energia" className="flex flex-col gap-2 scroll-mt-4">
      <div className="flex items-center justify-between">
        <h2 className={sectionTitle}>Energia</h2>
        {onOpen && (
          <button onClick={onOpen} className="flex items-center gap-0.5 text-xs text-zinc-400 hover:text-zinc-200">
            Histórico e fatura <ChevronRight size={13} />
          </button>
        )}
      </div>
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
              Rede{grid === 'out' ? ' · a enviar' : grid === 'in' ? ' · a comprar' : ''}
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
        {surplus && <SurplusNow surplus={surplus} />}
      </div>
    </section>
  );
}
