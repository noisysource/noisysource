import type { ReactNode } from 'react';

export const card = 'rounded-2xl bg-zinc-900 border border-zinc-800 p-4 flex flex-col gap-3';

export function CardHeader({ icon, title, status, tone = 'zinc' }: {
  icon: ReactNode; title: string; status: string; tone?: 'green' | 'amber' | 'zinc' | 'red';
}) {
  const dot = { green: 'bg-emerald-400', amber: 'bg-amber-400', zinc: 'bg-zinc-600', red: 'bg-red-400' }[tone];
  return (
    <div className="flex items-center gap-3">
      <span className="text-sky-300">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-zinc-100 truncate">{title}</div>
        <div className="flex items-center gap-1.5 text-sm text-zinc-400">
          <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />{status}
        </div>
      </div>
    </div>
  );
}

export function Btn({ children, onClick, disabled, active, label, wide }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; active?: boolean; label?: string; wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`min-h-[44px] ${wide ? 'px-4' : 'min-w-[44px] px-2'} rounded-xl text-sm flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 ${
        active ? 'bg-amber-400 text-zinc-950 font-semibold' : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'
      }`}
    >
      {children}
    </button>
  );
}

export function Chips<T extends { id: string }>({ items, current, label, onPick, disabled }: {
  items: T[]; current?: string; label: (t: T) => string; onPick: (t: T) => void; disabled?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(t => (
        <button
          key={t.id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(t)}
          className={`px-3 py-1.5 rounded-full text-[13px] transition-colors disabled:opacity-40 ${
            current === t.id ? 'bg-sky-400 text-zinc-950 font-medium' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
          }`}
        >
          {label(t)}
        </button>
      ))}
    </div>
  );
}
