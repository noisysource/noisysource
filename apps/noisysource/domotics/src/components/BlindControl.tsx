import { useState } from 'react';
import { Square } from 'lucide-react';
import type { BlindDevice, BlindCommand } from '@shared/models/Device';

interface Props {
  device: BlindDevice;
  onCommand: (command: BlindCommand) => void;
}

export default function BlindControl({ device, onCommand }: Props) {
  const { state, name } = device;
  /**
   * While the thumb is held we show the local value and send nothing — a range
   * input fires on every step, and one Netatmo call per pixel would hammer the
   * gateway. The command goes out once, on release.
   */
  const [dragValue, setDragValue] = useState<number | null>(null);

  // `position` is already "% open" (Netatmo convention) — no inversion needed.
  const openPct = dragValue ?? state.position;

  const positionLabel =
    openPct === 100 ? 'Aberto'
      : openPct === 0 ? 'Fechado'
      : `${openPct}% aberto`;

  function commit() {
    if (dragValue === null) return;
    onCommand({ action: 'setPosition', position: dragValue });
    setDragValue(null);
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-medium text-zinc-100 text-sm">{name}</span>
        <div className="flex items-center gap-2">
          {state.isMoving && (
            <span className="text-xs text-blue-400 animate-pulse font-medium">
              {state.movingDirection === 'up' ? '↑ A subir' : '↓ A descer'}
            </span>
          )}
          <span className="text-xs text-zinc-500 tabular-nums">{positionLabel}</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-600 shrink-0">Fechado</span>

        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={openPct}
          aria-label={`Posição do estore ${name}`}
          onChange={e => setDragValue(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="slider-blind flex-1 cursor-pointer touch-none"
        />

        <span className="text-xs text-zinc-600 shrink-0">Aberto</span>

        {/* Still worth keeping: a slider sets a destination, this halts mid-travel. */}
        <button
          onClick={() => onCommand({ action: 'stop' })}
          disabled={!state.isMoving}
          className="flex items-center justify-center w-11 h-11 shrink-0 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed transition-all duration-150"
          aria-label="Parar estore"
        >
          <Square size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
