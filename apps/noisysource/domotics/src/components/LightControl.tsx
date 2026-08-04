import { Lightbulb, LightbulbOff } from 'lucide-react';
import type { LightDevice, LightCommand } from '@shared/models/Device';

interface Props {
  device: LightDevice;
  onCommand: (command: LightCommand) => void;
}

export default function LightControl({ device, onCommand }: Props) {
  const { state, name } = device;

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Toggle button */}
      <button
        onClick={() => onCommand({ action: 'toggle' })}
        className="relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        style={
          state.on
            ? {
                background: 'rgba(251, 191, 36, 0.12)',
                border: '2px solid rgba(251, 191, 36, 0.45)',
                boxShadow: '0 0 28px 6px rgba(251, 191, 36, 0.22)',
              }
            : {
                background: '#27272a',
                border: '2px solid #3f3f46',
              }
        }
        aria-label={`${name}: ${state.on ? 'acesa' : 'apagada'}`}
        aria-pressed={state.on}
      >
        {state.on ? (
          <Lightbulb
            size={32}
            fill="#fbbf24"
            stroke="#d97706"
            strokeWidth={1.5}
          />
        ) : (
          <LightbulbOff
            size={32}
            fill="none"
            stroke="#52525b"
            strokeWidth={1.5}
          />
        )}
      </button>

      {/* Label */}
      <span className="text-sm text-zinc-300 text-center leading-tight max-w-[80px] break-words">
        {name}
      </span>

      {/* Brightness slider — only when on + dimmable */}
      {state.on && state.dimmable && (
        <div className="flex flex-col items-center gap-1 w-20">
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={state.brightness}
            onChange={e =>
              onCommand({ action: 'setBrightness', brightness: Number(e.target.value) })
            }
            className="w-full"
            aria-label={`Brilho de ${name}: ${state.brightness}%`}
          />
          <span className="text-xs text-zinc-500">{state.brightness}%</span>
        </div>
      )}
    </div>
  );
}
