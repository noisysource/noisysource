import { useMemo, useState } from 'react';
import { Pencil, Check, X, Plus, Trash2, GripVertical, Ruler } from 'lucide-react';
import type {
  Device, DevicePlacement, LightCommand, BlindCommand,
  ThermostatCommand, HeatPumpCommand,
} from '@shared/models/Device';
import type { FloorPlan, InfraItem, InfraKind, InfraLayer, PlanRoom, Wall } from '@shared/models/Room';
import { DEFAULT_LAYER } from '@shared/models/Room';
import { wallsFromRooms, wallLength } from '../data/walls';
import type { DeviceStatus } from '../App';
import type { EnergyReading } from '../data/energy';
import { batteryFlow, gridFlow, solarShare, formatWatts } from '../data/energy';
import type { User } from 'firebase/auth';
import Clock from './Clock';
import FloorPlanSvg, { type EditTarget } from './FloorPlan';

const DEVICE_ICON: Record<Device['type'], string> = {
  light: '💡', blind: '🪟', thermostat: '🌡️', heatpump: '🔥',
};

const STATUS_LABEL: Record<Exclude<DeviceStatus, 'ok'>, string> = {
  loading: 'A ligar…',
  offline: 'Gateway offline',
};

const BRIDGE_LABEL: Record<Exclude<DeviceStatus, 'ok'>, string> = {
  loading: 'Bridge…',
  offline: 'Bridge offline',
};

interface Props {
  plan: FloorPlan;
  devices: Device[];
  placements: Record<string, DevicePlacement>;
  deviceStatus: DeviceStatus;
  /** Local LAN bridge serving the Tuya climate devices. */
  bridgeStatus: DeviceStatus;
  /** Live photovoltaic figures; null when the inverter is unreachable. */
  energy: EnergyReading | null;
  user: User | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  editMode: boolean;
  editTarget: EditTarget;
  selectedId: string | null;
  onEditTargetChange: (target: EditTarget) => void;
  onSelect: (id: string | null) => void;
  onOpenRoom: (id: string) => void;
  onChangeRooms: (rooms: PlanRoom[]) => void;
  onChangeInfra: (items: InfraItem[]) => void;
  onChangeWalls: (walls: Wall[]) => void;
  onPlaceDevice: (deviceId: string, roomId: string, rx: number, ry: number) => void;
  onDeviceNameChange: (deviceId: string, name: string) => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => Promise<void>;
}

export default function PlanScreen({
  plan, devices, placements, deviceStatus, bridgeStatus, energy, user, onSignIn, onSignOut,
  editMode, editTarget, selectedId,
  onEditTargetChange, onSelect, onOpenRoom, onChangeRooms, onChangeInfra, onChangeWalls, onPlaceDevice,
  onDeviceNameChange, onLightCommand, onBlindCommand,
  onThermostatCommand, onHeatPumpCommand,
  onStartEdit, onCancelEdit, onSaveEdit,
}: Props) {
  /** Device being dragged from the sidebar onto the plan. */
  const [externalDragId, setExternalDragId] = useState<string | null>(null);
  /** Wall length labels — off by default, they are dense enough to obscure the plan. */
  const [showMeasures, setShowMeasures] = useState(false);
  /**
   * Which layer is in focus. 'all' shows everything at once, which is fine for
   * a glance; picking one fades the rest so roof or outdoor equipment can be
   * read without the floor plan competing with it.
   */
  const [viewLayer, setViewLayer] = useState<InfraLayer | 'all'>('all');

  const selectedRoom = plan.rooms.find(r => r.id === selectedId) ?? null;
  const infra = plan.infrastructure ?? [];
  const walls = plan.walls ?? [];
  const selectedWall = walls.find(w => w.id === selectedId) ?? null;

  /** Seed the wall layer from the room blocks, then delete what isn't real. */
  function generateWalls() {
    onChangeWalls(wallsFromRooms(plan.rooms));
    onSelect(null);
  }

  function addWall() {
    const xs = plan.rooms.map(r => r.x + r.w / 2);
    const cx = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 5;
    const ys = plan.rooms.map(r => r.y + r.h / 2);
    const cy = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 5;
    const wall: Wall = {
      id: `wall-${Date.now()}`,
      x1: cx - 1, y1: cy, x2: cx + 1, y2: cy, kind: 'interior',
    };
    onChangeWalls([...walls, wall]);
    onSelect(wall.id);
  }

  function updateWall(patch: Partial<Wall>) {
    if (!selectedWall) return;
    onChangeWalls(walls.map(w => (w.id === selectedWall.id ? { ...w, ...patch } : w)));
  }

  function deleteWall() {
    if (!selectedWall) return;
    onChangeWalls(walls.filter(w => w.id !== selectedWall.id));
    onSelect(null);
  }
  const selectedInfra = infra.find(i => i.id === selectedId) ?? null;

  const INFRA_LABEL: Record<InfraKind, string> = {
    router: 'Router', repeater: 'Repetidor', gateway: 'Gateway',
    inverter: 'Inversor', battery: 'Bateria', panels: 'Painéis',
  };

  function addInfra(kind: InfraItem['kind']) {
    // Dropped in the middle of the plan; it gets dragged to its real spot.
    const xs = plan.rooms.map(r => r.x + r.w / 2);
    const ys = plan.rooms.map(r => r.y + r.h / 2);
    const item: InfraItem = {
      id: `infra-${Date.now()}`,
      kind,
      name: INFRA_LABEL[kind],
      ...(kind === 'router' ? { band: '2.4/5 GHz' } : {}),
      ...(kind === 'repeater' ? { band: '2.4 GHz' } : {}),
      x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 5,
      y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 5,
    };
    onChangeInfra([...infra, item]);
    onSelect(item.id);
  }

  function updateInfra(patch: Partial<InfraItem>) {
    if (!selectedInfra) return;
    const next = { ...selectedInfra, ...patch };
    // Changing the kind should rename it too — but only while the name is still
    // an untouched default. Otherwise every item added here ends up called
    // "Inversor" regardless of what it actually is, which is exactly what
    // happened before this existed.
    if (patch.kind && patch.kind !== selectedInfra.kind) {
      const wasDefault = Object.values(INFRA_LABEL).includes(selectedInfra.name);
      if (wasDefault) next.name = INFRA_LABEL[patch.kind];
      if (!patch.layer) next.layer = DEFAULT_LAYER[patch.kind];
    }
    onChangeInfra(infra.map(i => (i.id === selectedInfra.id ? next : i)));
  }

  function deleteInfra() {
    if (!selectedInfra) return;
    onChangeInfra(infra.filter(i => i.id !== selectedInfra.id));
    onSelect(null);
  }
  const showSidebar = editMode && editTarget === 'devices';

  const groups = useMemo(() => {
    const placed = new Set(plan.rooms.map(r => r.id));
    return {
      unplaced: devices.filter(d => !placed.has(d.roomId)),
      byRoom: plan.rooms
        .map(room => ({ room, items: devices.filter(d => d.roomId === room.id) }))
        .filter(g => g.items.length > 0),
    };
  }, [devices, plan.rooms]);

  function addRoom() {
    const maxY = plan.rooms.reduce((m, r) => Math.max(m, r.y + r.h), 0);
    const room: PlanRoom = {
      id: `plan-${Date.now()}`,
      name: 'Nova Divisão',
      icon: '⬜',
      x: 0, y: maxY + 0.5, w: 3, h: 3,
    };
    onChangeRooms([...plan.rooms, room]);
    onSelect(room.id);
  }

  function updateRoom(patch: Partial<PlanRoom>) {
    if (!selectedRoom) return;
    onChangeRooms(plan.rooms.map(r => (r.id === selectedRoom.id ? { ...r, ...patch } : r)));
  }

  function deleteRoom() {
    if (!selectedRoom) return;
    onChangeRooms(plan.rooms.filter(r => r.id !== selectedRoom.id));
    onSelect(null);
  }

  function deviceRow(device: Device) {
    const isDragging = externalDragId === device.id;
    const isSelected = selectedId === device.id;
    return (
      <li
        key={device.id}
        className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors ${
          isSelected ? 'bg-zinc-800' : 'hover:bg-zinc-900'
        } ${isDragging ? 'opacity-40' : ''}`}
      >
        {/* Drag lives on the handle, not the row, so the name stays clickable. */}
        <button
          className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing touch-none shrink-0"
          aria-label={`Arrastar ${device.name}`}
          onPointerDown={() => {
            onSelect(device.id);
            setExternalDragId(device.id);
          }}
        >
          <GripVertical size={14} strokeWidth={2} />
        </button>
        <span className="text-sm shrink-0" aria-hidden="true">
          {DEVICE_ICON[device.type]}
        </span>
        <input
          className="flex-1 min-w-0 bg-transparent border border-transparent hover:border-zinc-700 focus:border-zinc-500 rounded px-1.5 py-0.5 text-sm text-zinc-200 outline-none transition-colors"
          value={device.name}
          onFocus={() => onSelect(device.id)}
          onChange={e => onDeviceNameChange(device.id, e.target.value)}
        />
      </li>
    );
  }

  return (
    <div className="h-screen bg-zinc-950 text-zinc-50 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 py-5 border-b border-zinc-800/60 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-2xl select-none" aria-hidden="true">🏠</span>
          <h1 className="text-lg font-semibold tracking-wide text-zinc-100">Domotics</h1>
          {deviceStatus !== 'ok' && (
            <span
              className={`text-xs px-2 py-1 rounded-lg ${
                deviceStatus === 'offline'
                  ? 'bg-red-950 text-red-300'
                  : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {STATUS_LABEL[deviceStatus]}
            </span>
          )}
          {bridgeStatus !== 'ok' && (
            <span
              className={`text-xs px-2 py-1 rounded-lg ${
                bridgeStatus === 'offline'
                  ? 'bg-red-950 text-red-300'
                  : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {BRIDGE_LABEL[bridgeStatus]}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {editMode ? (
            <>
              {/* Rooms and devices are separate drag layers — editing both at
                  once means every gesture is ambiguous. */}
              <div className="flex rounded-xl bg-zinc-900 border border-zinc-800 p-0.5 mr-1">
                {(['rooms', 'walls', 'devices'] as const).map(target => (
                  <button
                    key={target}
                    onClick={() => { onEditTargetChange(target); onSelect(null); }}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      editTarget === target
                        ? 'bg-zinc-100 text-zinc-900 font-semibold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {target === 'rooms' ? 'Divisões' : target === 'walls' ? 'Paredes' : 'Dispositivos'}
                  </button>
                ))}
              </div>

              {editTarget === 'rooms' && (
                <button
                  onClick={addRoom}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
                >
                  <Plus size={15} strokeWidth={2} />
                  Divisão
                </button>
              )}
              {editTarget === 'walls' && (
                <>
                  <button
                    onClick={generateWalls}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
                    title="Cria paredes a partir das divisões; apague as que não existem"
                  >
                    Gerar das divisões
                  </button>
                  <button
                    onClick={addWall}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
                  >
                    <Plus size={15} strokeWidth={2} />
                    Parede
                  </button>
                </>
              )}
              {editTarget === 'rooms' && (
                <button
                  onClick={() => addInfra('inverter')}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-950 hover:bg-emerald-900 text-emerald-300 text-sm transition-colors"
                  title="Adiciona equipamento; escolha o tipo em baixo"
                >
                  <Plus size={15} strokeWidth={2} />
                  Equipamento
                </button>
              )}
              <button
                onClick={onCancelEdit}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
              >
                <X size={15} strokeWidth={2} />
                Cancelar
              </button>
              <button
                onClick={onSaveEdit}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-100 hover:bg-white text-zinc-900 text-sm font-semibold transition-colors"
              >
                <Check size={15} strokeWidth={2.5} />
                Guardar
              </button>
            </>
          ) : (
            <>
              <div className="flex rounded-xl bg-zinc-900 border border-zinc-800 p-0.5 mr-1">
                {([
                  ['all', 'Tudo'],
                  ['interior', 'Casa'],
                  ['roof', 'Cobertura'],
                  ['exterior', 'Exterior'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setViewLayer(key)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                      viewLayer === key
                        ? 'bg-zinc-100 text-zinc-900 font-semibold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowMeasures(v => !v)}
                className={`flex items-center justify-center w-10 h-10 rounded-xl transition-colors mr-1 ${
                  showMeasures
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
                aria-label="Mostrar medidas"
                title="Medidas das paredes"
              >
                <Ruler size={16} strokeWidth={2} />
              </button>
              {/* Only meaningful away from home, so it stays understated. */}
              <button
                onClick={() => (user ? onSignOut() : onSignIn())}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors mr-1"
                title={user ? `Sessão: ${user.email}` : 'Entrar para aceder fora de casa'}
              >
                {user ? (user.email?.split('@')[0] ?? 'sessão') : 'Entrar'}
              </button>
              <Clock />
              <button
                onClick={onStartEdit}
                className="flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors ml-2"
                aria-label="Editar planta"
              >
                <Pencil size={16} strokeWidth={2} />
              </button>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-w-0 p-4 overflow-hidden">
          <FloorPlanSvg
            rooms={plan.rooms}
            devices={devices}
            placements={placements}
            grid={plan.grid}
            editMode={editMode}
            editTarget={editTarget}
            selectedId={selectedId}
            externalDragId={externalDragId}
            onSelect={onSelect}
            onOpenRoom={onOpenRoom}
            onChange={onChangeRooms}
            infrastructure={plan.infrastructure ?? []}
            onChangeInfra={onChangeInfra}
            energy={energy}
            walls={walls}
            onChangeWalls={onChangeWalls}
            showMeasures={showMeasures}
            viewLayer={viewLayer}
            onPlaceDevice={onPlaceDevice}
            onExternalDragEnd={() => setExternalDragId(null)}
            onLightCommand={onLightCommand}
            onBlindCommand={onBlindCommand}
            onThermostatCommand={onThermostatCommand}
            onHeatPumpCommand={onHeatPumpCommand}
          />
        </main>

        {showSidebar && (
          <aside className="w-72 shrink-0 border-l border-zinc-800/60 overflow-y-auto px-3 py-4">
            <p className="text-xs text-zinc-500 px-1.5 pb-3 leading-relaxed">
              Arraste pelo <GripVertical size={11} className="inline -mt-0.5" /> para
              colocar na planta. Escreva para renomear.
            </p>

            {groups.unplaced.length > 0 && (
              <section className="mb-4">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-500/80 px-1.5 mb-1.5">
                  Sem divisão · {groups.unplaced.length}
                </h2>
                <ul>{groups.unplaced.map(deviceRow)}</ul>
              </section>
            )}

            {groups.byRoom.map(({ room, items }) => (
              <section key={room.id} className="mb-4">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 px-1.5 mb-1.5">
                  {room.icon} {room.name} · {items.length}
                </h2>
                <ul>{items.map(deviceRow)}</ul>
              </section>
            ))}

            {devices.length === 0 && (
              <p className="text-sm text-zinc-600 px-1.5">Nenhum dispositivo.</p>
            )}
          </aside>
        )}
      </div>

      {!editMode && energy?.online && (() => {
        const battery = batteryFlow(energy);
        const grid = gridFlow(energy);
        const share = solarShare(energy);
        const cell = 'flex flex-col gap-0.5 min-w-[104px]';
        const label = 'text-[10px] uppercase tracking-widest text-zinc-500';
        return (
          <footer className="border-t border-zinc-800/60 px-6 py-3 shrink-0 flex items-center gap-7 flex-wrap">
            <div className={cell}>
              <span className={label}>Solar</span>
              <span className="text-lg text-amber-300 tabular-nums">
                {formatWatts(energy.pvPowerW)}
              </span>
            </div>

            <div className={cell}>
              <span className={label}>Casa</span>
              <span className="text-lg text-zinc-100 tabular-nums">
                {formatWatts(energy.consumptionW)}
              </span>
            </div>

            <div className={cell}>
              <span className={label}>
                Bateria {battery === 'in' ? '· a carregar' : battery === 'out' ? '· a descarregar' : ''}
              </span>
              <span className={`text-lg tabular-nums ${
                battery === 'in' ? 'text-lime-300' : battery === 'out' ? 'text-orange-300' : 'text-zinc-400'
              }`}>
                {formatWatts(energy.batteryPowerW === undefined ? undefined : Math.abs(energy.batteryPowerW))}
                <span className="text-sm text-zinc-500"> · {energy.soc ?? '—'}%</span>
              </span>
            </div>

            <div className={cell}>
              <span className={label}>
                Rede {grid === 'out' ? '· a exportar' : grid === 'in' ? '· a importar' : ''}
              </span>
              <span className={`text-lg tabular-nums ${
                grid === 'out' ? 'text-sky-300' : grid === 'in' ? 'text-red-300' : 'text-zinc-400'
              }`}>
                {formatWatts(energy.gridPowerW === undefined ? undefined : Math.abs(energy.gridPowerW))}
              </span>
            </div>

            {share !== undefined && (
              <div className="flex-1 min-w-[160px] flex flex-col gap-1.5">
                <span className={label}>{Math.round(share * 100)}% do consumo vem do sol</span>
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-amber-400 transition-all duration-700"
                    style={{ width: `${share * 100}%` }}
                  />
                </div>
              </div>
            )}
          </footer>
        );
      })()}

      {editMode && (
        <footer className="border-t border-zinc-800/60 px-6 py-4 shrink-0">
          {editTarget === 'rooms' && selectedRoom ? (
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Nome</span>
                <input
                  className="bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-400 transition-colors"
                  value={selectedRoom.name}
                  onChange={e => updateRoom({ name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1.5 w-20">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Ícone</span>
                <input
                  className="bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-100 text-center outline-none focus:border-zinc-400 transition-colors"
                  value={selectedRoom.icon}
                  onChange={e => updateRoom({ icon: e.target.value })}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Tamanho</span>
                <span className="text-sm text-zinc-300 py-1.5 tabular-nums">
                  {selectedRoom.w.toFixed(2)} × {selectedRoom.h.toFixed(2)} m
                  <span className="text-zinc-500"> · {(selectedRoom.w * selectedRoom.h).toFixed(1)} m²</span>
                </span>
              </div>
              <div className="flex-1" />
              <button
                onClick={deleteRoom}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-950 hover:bg-red-900 text-red-300 text-sm transition-colors"
              >
                <Trash2 size={15} strokeWidth={2} />
                Apagar
              </button>
            </div>
          ) : selectedWall ? (
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Comprimento</span>
                <span className="text-sm text-zinc-300 py-1.5 tabular-nums">
                  {wallLength(selectedWall).toFixed(2)} m
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Tipo</span>
                <div className="flex rounded-lg bg-zinc-900 border border-zinc-700 p-0.5">
                  {(['exterior', 'interior', 'glass'] as const).map(k => (
                    <button
                      key={k}
                      onClick={() => updateWall({ kind: k })}
                      className={`px-2.5 py-1 rounded text-xs transition-colors ${
                        (selectedWall.kind ?? 'interior') === k
                          ? 'bg-zinc-100 text-zinc-900 font-semibold'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {k === 'exterior' ? 'Exterior' : k === 'interior' ? 'Interior' : 'Vidro'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1" />
              <span className="text-xs text-zinc-500 py-2">
                Arraste as pontas. Apague as paredes que não existem — como entre a cozinha e as salas.
              </span>
              <button
                onClick={deleteWall}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-950 hover:bg-red-900 text-red-300 text-sm transition-colors"
              >
                <Trash2 size={15} strokeWidth={2} />
                Apagar
              </button>
            </div>
          ) : selectedInfra ? (
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Equipamento</span>
                <input
                  className="bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-400 transition-colors"
                  value={selectedInfra.name}
                  onChange={e => updateInfra({ name: e.target.value })}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Tipo</span>
                <div className="flex flex-wrap rounded-lg bg-zinc-900 border border-zinc-700 p-0.5">
                  {(Object.keys(INFRA_LABEL) as InfraKind[]).map(k => (
                    <button
                      key={k}
                      onClick={() => updateInfra({ kind: k })}
                      className={`px-2 py-1 rounded text-xs transition-colors ${
                        selectedInfra.kind === k
                          ? 'bg-zinc-100 text-zinc-900 font-semibold'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {INFRA_LABEL[k]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex flex-col gap-1.5 w-28">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Banda</span>
                <input
                  className="bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-400 transition-colors"
                  value={selectedInfra.band ?? ''}
                  onChange={e => updateInfra({ band: e.target.value })}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Camada</span>
                <div className="flex rounded-lg bg-zinc-900 border border-zinc-700 p-0.5">
                  {([
                    ['interior', 'Casa'],
                    ['roof', 'Cobertura'],
                    ['exterior', 'Exterior'],
                  ] as const).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => updateInfra({ layer: k })}
                      className={`px-2 py-1 rounded text-xs transition-colors ${
                        (selectedInfra.layer ?? DEFAULT_LAYER[selectedInfra.kind]) === k
                          ? 'bg-zinc-100 text-zinc-900 font-semibold'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex flex-col gap-1.5 w-36">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Endereço</span>
                <input
                  className="bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-400 transition-colors"
                  placeholder="192.168.1.117"
                  value={selectedInfra.host ?? ''}
                  onChange={e => updateInfra({ host: e.target.value })}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Posição</span>
                <span className="text-sm text-zinc-300 py-1.5 tabular-nums">
                  {selectedInfra.x.toFixed(2)}, {selectedInfra.y.toFixed(2)} m
                </span>
              </div>
              <div className="flex-1" />
              <span className="text-xs text-zinc-500 py-2">Arraste para o sítio real.</span>
              <button
                onClick={deleteInfra}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-950 hover:bg-red-900 text-red-300 text-sm transition-colors"
              >
                <Trash2 size={15} strokeWidth={2} />
                Apagar
              </button>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              {editTarget === 'rooms'
                ? 'Toque numa divisão ou equipamento de rede para o mover ou renomear.'
                : editTarget === 'walls'
                ? `${walls.length} paredes. Toque numa para a editar, ou gere-as a partir das divisões.`
                : `Arraste da lista para a planta, ou mova os marcadores já colocados.${
                    groups.unplaced.length ? ` ${groups.unplaced.length} sem divisão.` : ''
                  }`}
            </p>
          )}
        </footer>
      )}
    </div>
  );
}
