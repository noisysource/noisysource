import type { Device } from '@shared/models/Device';
import type { Room } from '@shared/models/Room';
import Clock from './Clock';
import RoomCard from './RoomCard';

interface Props {
  rooms: Room[];
  devices: Device[];
  onSelectRoom: (roomId: string) => void;
}

export default function HomeScreen({ rooms, devices, onSelectRoom }: Props) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-5 border-b border-zinc-800/60 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-2xl select-none" aria-hidden="true">🏠</span>
          <h1 className="text-lg font-semibold tracking-wide text-zinc-100">Domotics</h1>
        </div>
        <Clock />
      </header>

      {/* Room grid */}
      <main className="flex-1 p-6">
        <div className="grid grid-cols-2 gap-4 max-w-xl">
          {rooms.map(room => (
            <RoomCard
              key={room.id}
              room={room}
              devices={devices.filter(d => d.roomId === room.id)}
              onClick={() => onSelectRoom(room.id)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
