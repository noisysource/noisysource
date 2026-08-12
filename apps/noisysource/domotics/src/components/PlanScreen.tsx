import { useMemo, useState } from 'react';
import { Pencil, Check, X, Plus, Trash2, GripVertical, Ruler } from 'lucide-react';
import type {
  Device, DevicePlacement, LightCommand, BlindCommand,
  ThermostatCommand, HeatPumpCommand,
} from '@shared/models/Device';
import type { FloorPlan, InfraItem, PlanRoom, Wall } from '@shared/models/Room';
import { wallsFromRooms, wallLength } from '../data/walls';
import type { DeviceStatus } from '../App';
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
  plan, devices, placements, deviceStatus, bridgeStatus, editMode, editTarget, selectedId,
  onEditTargetChange, onSelect, onOpenRoom, onChangeRooms, onChangeInfra, onChangeWalls, onPlaceDevice,
  onDeviceNameChange, onLightCommand, onBlindCommand,
  onThermostatCommand, onHeatPumpCommand,
  onStartEdit, onCancelEdit, onSaveEdit,
}: Props) {
  /** Device being dragged from the sidebar onto the plan. */
  const [externalDragId, setExternalDragId] = useState<string | null>(null);
  /** Wall length labels — off by default, they are dense enough to obscure the plan. */
  const [showMeasures, setShowMeasures] = useState(false);

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

  function addInfra(kind: InfraItem['kind']) {
    // Dropped in the middle of the plan; it gets dragged to its real spot.
    const xs = plan.rooms.map(r => r.x + r.w / 2);
    const ys = plan.rooms.map(r => r.y + r.h / 2);
    const item: InfraItem = {
      id: `infra-${Date.now()}`,
      kind,
      name: kind === 'router' ? 'Router MEO' : 'Repetidor Xiaomi',
      band: kind === 'router' ? '2.4/5 GHz' : '2.4 GHz',
      x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 5,
      y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 5,
    };
    onChangeInfra([...infra, item]);
    onSelect(item.id);
  }

  function updateInfra(patch: Partial<InfraItem>) {
    if (!selectedInfra) return;
    onChangeInfra(infra.map(i => (i.id === selectedInfra.id ? { ...i, ...patch } : i)));
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
                <>
                  <button
                    onClick={() => addInfra('router')}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-950 hover:bg-sky-900 text-sky-300 text-sm transition-colors"
                  >
                    <Plus size={15} strokeWidth={2} />
                    Router
                  </button>
                  <button
                    onClick={() => addInfra('repeater')}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-violet-950 hover:bg-violet-900 text-violet-300 text-sm transition-colors"
                  >
                    <Plus size={15} strokeWidth={2} />
                    Repetidor
                  </button>
                </>
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
            walls={walls}
            onChangeWalls={onChangeWalls}
            showMeasures={showMeasures}
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
              <label className="flex flex-col gap-1.5 w-32">
                <span className="text-xs uppercase tracking-widest text-zinc-500">Banda</span>
                <input
                  className="bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-400 transition-colors"
                  value={selectedInfra.band ?? ''}
                  onChange={e => updateInfra({ band: e.target.value })}
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
