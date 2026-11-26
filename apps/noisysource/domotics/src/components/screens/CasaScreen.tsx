import { Blinds, Car, ChevronRight, Flame, Lightbulb, Menu, Thermometer } from 'lucide-react';
import type { BlindDevice, Device, LightDevice, ThermostatDevice } from '@shared/models/Device';
import type { FloorPlan } from '@shared/models/Room';
import type { DeviceStatus } from '../../App';
import type { AutomationStatus } from '../../data/automation';
import type { EnergyReading } from '../../data/energy';
import { batteryFlow, formatWatts, gridFlow } from '../../data/energy';
import { roomStats } from '../../data/placement';
import { GRID_LIMIT_A, formatAmps, supplyNow } from '../../data/supply';
import HealthChips, { FaultBanner } from '../HealthChips';
import type { Tab } from '../shell/tabs';

interface Props {
  plan: FloorPlan;
  devices: Device[];
  deviceStatus: DeviceStatus;
  bridgeStatus: DeviceStatus;
  bridgeUpdatedAt?: number;
  energy: EnergyReading | null;
  automation?: AutomationStatus;
  onSignIn: () => Promise<void>;
  onTab: (tab: Tab) => void;
  onOpenRoom: (roomId: string) => void;
  onLightsSet: (deviceIds: string[], on: boolean) => void;
}

const card = 'rounded-2xl bg-zinc-900 border border-zinc-800';
const sectionTitle = 'text-xs font-semibold uppercase tracking-widest text-zinc-400 px-1';

function deg(v: number | undefined) {
  return v === undefined || !Number.isFinite(v) ? '—' : `${v.toLocaleString('pt-PT', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}°`;
}

/**
 * The everyday first screen: is the house warm, what will the heating do
 * next, where the power is coming from, and the main board's load — then
 * shortcuts and the rooms. Everything here is read from data the app already
 * has; nothing new is fetched for it.
 */
export default function CasaScreen({
  plan, devices, deviceStatus, bridgeStatus, bridgeUpdatedAt, energy, automation,
  onSignIn, onTab, onOpenRoom, onLightsSet,
}: Props) {
  const thermos = devices.filter((d): d is ThermostatDevice => d.type === 'thermostat' && d.online !== false);
  const inside = automation?.meanRoom ?? (thermos.length
    ? thermos.reduce((s, t) => s + t.state.current, 0) / thermos.length
    : undefined);
  const pump = devices.find((d): d is Extract<Device, { type: 'heatpump' }> => d.type === 'heatpump' && d.online !== false);
  const outdoor = pump?.state.outdoor ?? automation?.outdoor;
  const lit = devices.filter((d): d is LightDevice => d.type === 'light' && d.state.on);
  const blinds = devices.filter((d): d is BlindDevice => d.type === 'blind');
  const open = blinds.filter(b => b.state.position > 0).length;
  const supply = supplyNow(energy);
  const withDevices = new Set(devices.map(d => d.roomId));
  const rooms = plan.rooms.filter(r => r.controllable || withDevices.has(r.id));
  const battery = energy?.online ? batteryFlow(energy) : 'idle';
  const grid = energy?.online ? gridFlow(energy) : 'idle';

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 pt-4 pb-6 flex flex-col gap-4">
      <header className="flex items-center gap-2 md:hidden" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <h1 className="text-2xl font-bold text-zinc-50 mr-auto">Casa</h1>
        <button onClick={() => onTab('mais')} aria-label="Mais" className="w-11 h-11 flex items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300">
          <Menu size={20} />
        </button>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <HealthChips
          devices={devices}
          deviceStatus={deviceStatus}
          bridgeStatus={bridgeStatus}
          bridgeUpdatedAt={bridgeUpdatedAt}
          onSignIn={onSignIn}
        />
      </div>
      <FaultBanner devices={devices} />

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* The heating: the reason this screen is opened most mornings. */}
          <button onClick={() => onTab('clima')} className={`${card} p-5 text-left flex flex-col gap-3 hover:border-zinc-700 transition-colors`}>
            <div className="flex items-baseline gap-3">
              <span className="text-5xl font-semibold text-zinc-50 tabular-nums leading-none">{deg(inside)}</span>
              <span className="text-sm text-zinc-400">dentro{outdoor !== undefined ? ` · ${deg(outdoor)} fora` : ''}</span>
            </div>
            <p className="text-[15px] leading-relaxed text-zinc-300">
              {automation?.doing ?? (pump ? (pump.state.on ? 'Bomba de calor ligada.' : 'Bomba de calor desligada.') : 'Sem notícias do aquecimento.')}
            </p>
            <span className="flex items-center gap-1 text-sm text-amber-400">Aquecimento e plano <ChevronRight size={15} /></span>
          </button>

          {energy?.online && (
            <button onClick={() => onTab('energia')} className={`${card} p-4 text-left grid grid-cols-3 gap-2 hover:border-zinc-700 transition-colors`}>
              <Tile label="Solar" value={formatWatts(energy.pvPowerW)} tone="text-amber-300" />
              <Tile
                label={battery === 'in' ? 'Bateria ↑' : battery === 'out' ? 'Bateria ↓' : 'Bateria'}
                value={`${energy.soc ?? '—'} %`}
                tone={battery === 'out' ? 'text-orange-300' : 'text-lime-300'}
              />
              <Tile
                label={grid === 'out' ? 'Rede · a enviar' : grid === 'in' ? 'Rede · a comprar' : 'Rede'}
                value={formatWatts(energy.gridPowerW === undefined ? undefined : Math.abs(energy.gridPowerW))}
                tone={grid === 'in' ? 'text-red-300' : 'text-sky-300'}
              />
            </button>
          )}

          {supply && (
            <section className={`${card} px-4 py-3.5 flex flex-col gap-2`} aria-label="Quadro elétrico">
              <div className="flex justify-between text-sm">
                <span className="font-semibold text-zinc-200">Quadro agora</span>
                <span className="text-zinc-400 tabular-nums">{formatAmps(supply.gridA)} da rede · limite {GRID_LIMIT_A} A</span>
              </div>
              <div className="h-2.5 rounded-full bg-zinc-800 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={GRID_LIMIT_A} aria-valuenow={Number(supply.gridA.toFixed(1))} aria-label="Corrente da rede">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${supply.tone === 'high' ? 'bg-red-500' : supply.tone === 'warn' ? 'bg-amber-400' : 'bg-emerald-500'}`}
                  style={{ width: `${Math.min(100, supply.share * 100)}%` }}
                />
              </div>
              <span className="text-xs text-zinc-400">
                Casa {formatAmps(supply.houseA)} no total · 6,9 kVA da rede + o que o inversor der.
              </span>
            </section>
          )}
        </div>

        <div className="lg:col-span-7 flex flex-col gap-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Shortcut
              icon={<Lightbulb size={18} className="text-amber-300" />}
              title="Luzes"
              sub={lit.length ? `${lit.length} acesa${lit.length > 1 ? 's' : ''}` : 'Todas apagadas'}
              onClick={() => onTab('divisoes')}
              action={lit.length ? { label: 'Apagar todas', run: () => onLightsSet(lit.map(l => l.id), false) } : undefined}
            />
            <Shortcut
              icon={<Blinds size={18} className="text-sky-300" />}
              title="Estores"
              sub={blinds.length === 0 ? '—' : open === 0 ? 'Todos fechados' : open === blinds.length ? 'Todos abertos' : `${open} de ${blinds.length} abertos`}
              onClick={() => onTab('divisoes')}
            />
            <Shortcut
              icon={<Car size={18} className="text-sky-300" />}
              title="Carros"
              sub="Em breve"
              onClick={() => onTab('carros')}
            />
          </div>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className={sectionTitle}>Divisões</h2>
              <button onClick={() => onTab('planta')} className="text-sm text-amber-400 px-1 py-1">Planta 3D</button>
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              {rooms.map(r => {
                const s = roomStats(devices, r.id);
                return (
                  <button
                    key={r.id}
                    onClick={() => onOpenRoom(r.id)}
                    className={`${card} min-h-[52px] px-4 py-3 flex items-center gap-3 text-left hover:border-zinc-700 transition-colors`}
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
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-zinc-950/60 px-3 py-2.5 min-w-0">
      <span className="text-[11px] text-zinc-400 truncate">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

function Shortcut({ icon, title, sub, onClick, action }: {
  icon: React.ReactNode; title: string; sub: string; onClick: () => void;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className={`${card} relative min-h-[96px] flex flex-col`}>
      <button onClick={onClick} className="flex-1 p-4 text-left flex flex-col justify-between gap-2 rounded-2xl hover:bg-zinc-800/40 transition-colors">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-zinc-100">{icon}{title}</span>
        <span className="text-sm text-zinc-400">{sub}</span>
      </button>
      {action && (
        <button onClick={action.run} className="mx-3 mb-3 min-h-[36px] rounded-lg bg-amber-400 hover:bg-amber-300 text-amber-950 text-sm font-semibold">
          {action.label}
        </button>
      )}
    </div>
  );
}
