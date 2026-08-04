import type { Device } from '@shared/models/Device';
import type { Room } from '@shared/models/Room';

interface Props {
  device: Device;
  allRooms: Room[];
  onNameChange: (name: string) => void;
  onRoomChange: (roomId: string) => void;
}

export default function DeviceEditRow({ device, allRooms, onNameChange, onRoomChange }: Props) {
  const icon = device.type === 'light' ? '💡' : '🪟';

  return (
    <div className="flex items-center gap-3 py-3 border-b border-zinc-800/60 last:border-0">
      <span className="text-xl w-7 text-center shrink-0 select-none" aria-hidden="true">
        {icon}
      </span>
      <input
        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 transition-colors min-w-0"
        value={device.name}
        onChange={e => onNameChange(e.target.value)}
      />
      <select
        className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-zinc-500 transition-colors shrink-0 max-w-[150px]"
        value={device.roomId}
        onChange={e => onRoomChange(e.target.value)}
      >
        {allRooms.map(r => (
          <option key={r.id} value={r.id}>{r.icon} {r.name}</option>
        ))}
      </select>
    </div>
  );
}
