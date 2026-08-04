import type { Device, LightDevice, BlindDevice } from '@shared/models/Device';
import type { Room } from '@shared/models/Room';

interface Props {
  room: Room;
  devices: Device[];
  onClick: () => void;
}

export default function RoomCard({ room, devices, onClick }: Props) {
  const lights = devices.filter((d): d is LightDevice => d.type === 'light');
  const blinds = devices.filter((d): d is BlindDevice => d.type === 'blind');
  const lightsOn = lights.filter(l => l.state.on).length;

  const lightsLabel = lights.length === 0
    ? null
    : lightsOn === 0
      ? 'Apagadas'
      : lightsOn === 1
        ? '1 luz acesa'
        : `${lightsOn}/${lights.length} luzes acesas`;

  const blindsLabel = blinds.length === 0
    ? null
    : blinds.length === 1
      ? '1 estore'
      : `${blinds.length} estores`;

  return (
    <button
      onClick={onClick}
      className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 text-left hover:bg-zinc-800/80 active:scale-[0.96] transition-all duration-150 min-h-[140px] flex flex-col"
    >
      <span className="text-4xl mb-3 select-none leading-none" aria-hidden="true">
        {room.icon}
      </span>
      <h2 className="text-base font-semibold text-zinc-100 mb-2 leading-tight">
        {room.name}
      </h2>
      <div className="mt-auto space-y-1">
        {lightsLabel && (
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${lightsOn > 0 ? 'bg-amber-400' : 'bg-zinc-700'}`} />
            <span className="text-xs text-zinc-400">{lightsLabel}</span>
          </div>
        )}
        {blindsLabel && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500/60 flex-shrink-0" />
            <span className="text-xs text-zinc-400">{blindsLabel}</span>
          </div>
        )}
      </div>
    </button>
  );
}
