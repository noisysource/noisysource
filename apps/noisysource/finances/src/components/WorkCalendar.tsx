import { useState, useEffect, useMemo } from 'react';

interface WorkCalendarProps {
  contractStart?: string;
  contractEnd?: string;
  nonWorkingDays: string[];
  halfDays: string[];
  onChangeNwd: (days: string[]) => void;
  onChangeHalf: (days: string[]) => void;
}

// Cycle: working → half → off → working
export function WorkCalendar({
  contractStart, contractEnd,
  nonWorkingDays, halfDays,
  onChangeNwd, onChangeHalf,
}: WorkCalendarProps) {
  const [viewMonth, setViewMonth] = useState<string>(() => {
    if (contractStart) return contractStart.slice(0, 7);
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  useEffect(() => {
    if (contractStart) setViewMonth(contractStart.slice(0, 7));
  }, [contractStart]);

  const nwdSet = useMemo(() => new Set(nonWorkingDays), [nonWorkingDays]);
  const halfSet = useMemo(() => new Set(halfDays), [halfDays]);

  function cycle(iso: string) {
    if (halfSet.has(iso)) {
      // half → off
      onChangeHalf(halfDays.filter(d => d !== iso));
      onChangeNwd([...nonWorkingDays, iso].sort());
    } else if (nwdSet.has(iso)) {
      // off → working
      onChangeNwd(nonWorkingDays.filter(d => d !== iso));
    } else {
      // working → half
      onChangeHalf([...halfDays, iso].sort());
    }
  }

  const [viewYear, viewMonthIdx] = viewMonth.split('-').map(Number) as [number, number];
  const firstOfMonth = new Date(viewYear, viewMonthIdx - 1, 1);
  const daysInMonth = new Date(viewYear, viewMonthIdx, 0).getDate();

  let startDow = firstOfMonth.getDay();
  startDow = startDow === 0 ? 6 : startDow - 1;

  const cells: (string | null)[] = Array(startDow).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${viewYear}-${String(viewMonthIdx).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const minMonth = contractStart?.slice(0, 7);
  const maxMonth = contractEnd?.slice(0, 7);

  const prevMonth = () => {
    const prev = viewMonthIdx === 1
      ? `${viewYear - 1}-12`
      : `${viewYear}-${String(viewMonthIdx - 1).padStart(2, '0')}`;
    setViewMonth(prev);
  };
  const nextMonth = () => {
    const next = viewMonthIdx === 12
      ? `${viewYear + 1}-01`
      : `${viewYear}-${String(viewMonthIdx + 1).padStart(2, '0')}`;
    setViewMonth(next);
  };

  const monthLabel = firstOfMonth.toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });
  const totalOff = nonWorkingDays.length + halfDays.length * 0.5;

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={prevMonth}
          disabled={!!minMonth && viewMonth <= minMonth}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 disabled:opacity-30 text-zinc-300 text-base"
        >
          ‹
        </button>
        <span className="text-sm font-medium text-zinc-200 capitalize">{monthLabel}</span>
        <button
          type="button"
          onClick={nextMonth}
          disabled={!!maxMonth && viewMonth >= maxMonth}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 disabled:opacity-30 text-zinc-300 text-base"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 mb-0.5">
        {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(d => (
          <div key={d} className="text-center text-[10px] text-zinc-600 py-0.5">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((iso, i) => {
          if (!iso) return <div key={i} className="aspect-square" />;

          const dow = new Date(iso + 'T12:00:00').getDay();
          const isWeekend = dow === 0 || dow === 6;
          const inContract =
            (!contractStart || iso >= contractStart) &&
            (!contractEnd || iso <= contractEnd);
          const isOff = nwdSet.has(iso);
          const isHalf = halfSet.has(iso);
          const clickable = !isWeekend && inContract;

          const title = isHalf ? '½ dia → folga (clique)' :
                        isOff  ? 'Folga → dia útil (clique)' :
                        clickable ? 'Dia útil → ½ dia (clique)' : undefined;

          const cls = isWeekend || !inContract
            ? 'text-zinc-700 cursor-default'
            : isOff
            ? 'bg-red-900/80 text-red-300 hover:bg-red-800 cursor-pointer'
            : isHalf
            ? 'bg-amber-900/80 text-amber-300 hover:bg-amber-800 cursor-pointer'
            : 'bg-zinc-800 text-zinc-300 hover:bg-emerald-900/60 cursor-pointer';

          return (
            <button
              key={iso}
              type="button"
              disabled={!clickable}
              onClick={() => cycle(iso)}
              title={title}
              className={`aspect-square flex items-center justify-center text-[11px] rounded transition-colors ${cls}`}
            >
              {isHalf ? <span className="leading-none">½</span> : parseInt(iso.slice(-2), 10)}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mt-2 text-[10px] text-zinc-500 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-zinc-800 inline-block border border-zinc-700" />
          Dia útil
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-amber-900/80 inline-block" />
          ½ dia
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-red-900/80 inline-block" />
          Folga
        </span>
        {totalOff > 0 && (
          <span className="ml-auto text-zinc-400">
            {totalOff} dia{totalOff !== 1 ? 's' : ''} de folga
          </span>
        )}
      </div>
    </div>
  );
}
