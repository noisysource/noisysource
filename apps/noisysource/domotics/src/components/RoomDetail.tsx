import { ChevronLeft } from 'lucide-react';
import type { Device, LightDevice, BlindDevice, LightCommand, BlindCommand } from '@shared/models/Device';
import type { Room } from '@shared/models/Room';
import LightControl from './LightControl';
import BlindControl from './BlindControl';

interface Props {
  room: Room;
  devices: Device[];
  onBack: () => void;
  onLightCommand: (deviceId: string, command: LightCommand) => void;
  onBlindCommand: (deviceId: string, command: BlindCommand) => void;
}

export default function RoomDetail({ room, devices, onBack, onLightCommand, onBlindCommand }: Props) {
  const lights = devices.filter((d): d is LightDevice => d.type === 'light');
  const blinds = devices.filter((d): d is BlindDevice => d.type === 'blind');

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 py-4 border-b border-zinc-800/60 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-11 h-11 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 transition-all duration-150 shrink-0"
          aria-label="Voltar"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <span className="text-2xl select-none leading-none" aria-hidden="true">
          {room.icon}
        </span>
        <h1 className="text-lg font-semibold text-zinc-100">{room.name}</h1>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-6 space-y-10">
        {/* Lights section */}
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

        {/* Blinds section */}
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
      </main>
    </div>
  );
}
