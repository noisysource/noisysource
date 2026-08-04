import { ChevronUp, ChevronDown, Square } from 'lucide-react';
import type { BlindDevice, BlindCommand } from '@shared/models/Device';

interface Props {
  device: BlindDevice;
  onCommand: (command: BlindCommand) => void;
}

export default function BlindControl({ device, onCommand }: Props) {
  const { state, name } = device;
  // openPct: 100 = fully open, 0 = fully closed
  const openPct = 100 - state.position;

  const positionLabel =
    openPct === 100
      ? 'Aberto'
      : openPct === 0
        ? 'Fechado'
        : `${openPct}% aberto`;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="font-medium text-zinc-100 text-sm">{name}</span>
        <div className="flex items-center gap-2">
          {state.isMoving && (
            <span className="text-xs text-blue-400 animate-pulse font-medium">
              {state.movingDirection === 'up' ? '↑ A subir' : '↓ A descer'}
            </span>
          )}
          <span className="text-xs text-zinc-500">{positionLabel}</span>
        </div>
      </div>

      {/* Position bar — fill represents openness */}
      <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden mb-4">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
          style={{
            width: `${openPct}%`,
            background: openPct > 0
              ? 'linear-gradient(90deg, #3b82f6, #60a5fa)'
              : 'transparent',
          }}
        />
      </div>

      {/* Controls */}
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => onCommand({ action: 'moveUp' })}
          disabled={state.position === 0}
          className="flex flex-col items-center gap-1 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed transition-all duration-150 min-h-[56px]"
          aria-label="Subir estore"
        >
          <ChevronUp size={18} strokeWidth={2} />
          <span className="text-xs text-zinc-400">Subir</span>
        </button>

        <button
          onClick={() => onCommand({ action: 'stop' })}
          disabled={!state.isMoving}
          className="flex flex-col items-center gap-1 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed transition-all duration-150 min-h-[56px]"
          aria-label="Parar estore"
        >
          <Square size={16} strokeWidth={2} />
          <span className="text-xs text-zinc-400">Parar</span>
        </button>

        <button
          onClick={() => onCommand({ action: 'moveDown' })}
          disabled={state.position === 100}
          className="flex flex-col items-center gap-1 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed transition-all duration-150 min-h-[56px]"
          aria-label="Descer estore"
        >
          <ChevronDown size={18} strokeWidth={2} />
          <span className="text-xs text-zinc-400">Descer</span>
        </button>
      </div>
    </div>
  );
}
