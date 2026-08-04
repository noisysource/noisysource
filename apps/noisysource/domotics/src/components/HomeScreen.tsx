import { Pencil, Check, X } from 'lucide-react';
import type { Device } from '@shared/models/Device';
import type { Room } from '@shared/models/Room';
import type { EditProps } from '../App';
import Clock from './Clock';
import RoomCard from './RoomCard';

interface Props extends EditProps {
  rooms: Room[];
  devices: Device[];
  onSelectRoom: (roomId: string) => void;
}

export default function HomeScreen({
  rooms, devices, onSelectRoom,
  editMode, onStartEdit, onCancelEdit, onSaveEdit, onRoomNameChange,
}: Props) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col">
      <header className="flex items-center justify-between px-6 py-5 border-b border-zinc-800/60 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-2xl select-none" aria-hidden="true">🏠</span>
          <h1 className="text-lg font-semibold tracking-wide text-zinc-100">Domotics</h1>
        </div>
        <div className="flex items-center gap-2">
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
            <>
              <Clock />
              <button
                onClick={onStartEdit}
                className="flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors ml-2"
                aria-label="Editar"
              >
                <Pencil size={16} strokeWidth={2} />
              </button>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 p-6">
        <div className="grid grid-cols-2 gap-4 max-w-xl">
          {rooms.map(room => (
            <RoomCard
              key={room.id}
              room={room}
              devices={devices.filter(d => d.roomId === room.id)}
              onClick={() => onSelectRoom(room.id)}
              editMode={editMode}
              onRoomNameChange={onRoomNameChange}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
