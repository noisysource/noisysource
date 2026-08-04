import { Pencil, Check, X, ChevronLeft } from 'lucide-react';
import type { Device, LightDevice, BlindDevice, LightCommand, BlindCommand } from '@shared/models/Device';
import type { Room } from '@shared/models/Room';
import type { EditProps } from '../App';
import LightControl from './LightControl';
import BlindControl from './BlindControl';
import DeviceEditRow from './DeviceEditRow';

interface Props extends EditProps {
  room: Room;
  devices: Device[];
  onBack: () => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
}

export default function RoomDetail({
  room, devices, onBack, onLightCommand, onBlindCommand,
  editMode, allRooms, onStartEdit, onCancelEdit, onSaveEdit,
  onRoomNameChange, onDeviceNameChange, onDeviceRoomChange,
}: Props) {
  const lights = devices.filter((d): d is LightDevice => d.type === 'light');
  const blinds = devices.filter((d): d is BlindDevice => d.type === 'blind');

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col">
      <header className="flex items-center gap-3 px-4 py-4 border-b border-zinc-800/60 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-11 h-11 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 transition-all duration-150 shrink-0"
          aria-label="Voltar"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <span className="text-2xl select-none leading-none shrink-0" aria-hidden="true">
          {room.icon}
        </span>
        {editMode ? (
          <input
            className="flex-1 bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-1.5 text-base font-semibold text-zinc-100 outline-none focus:border-zinc-400 transition-colors"
            value={room.name}
            onChange={e => onRoomNameChange(room.id, e.target.value)}
          />
        ) : (
          <h1 className="flex-1 text-lg font-semibold text-zinc-100">{room.name}</h1>
        )}
        <div className="flex items-center gap-2 shrink-0">
          {editMode ? (
            <>
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
            <button
              onClick={onStartEdit}
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              aria-label="Editar"
            >
              <Pencil size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 space-y-10">
        {editMode ? (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-4">
              Dispositivos
            </h2>
            <div className="bg-zinc-900 rounded-2xl border border-zinc-800 px-4">
              {devices.map(device => (
                <DeviceEditRow
                  key={device.id}
                  device={device}
                  allRooms={allRooms}
                  onNameChange={name => onDeviceNameChange(device.id, name)}
                  onRoomChange={roomId => onDeviceRoomChange(device.id, roomId)}
                />
              ))}
            </div>
          </section>
        ) : (
          <>
            {lights.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-5">
                  Luzes
                </h2>
                <div className="flex flex-wrap gap-8">
                  {lights.map(device => (
                    <LightControl
                      key={device.id}
                      device={device}
                      onCommand={cmd => onLightCommand(device.id, cmd)}
                    />
                  ))}
                </div>
              </section>
            )}

            {blinds.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-5">
                  Estores
                </h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {blinds.map(device => (
                    <BlindControl
                      key={device.id}
                      device={device}
                      onCommand={cmd => onBlindCommand(device.id, cmd)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
