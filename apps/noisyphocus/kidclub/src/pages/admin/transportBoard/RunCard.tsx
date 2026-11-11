import { DAYS, VEHICLES, dropOf, legNotes, toMin, warnings, type Part, type TransportRun } from './logic';

// A pick-up is filled with its vehicle's colour, a drop-off only outlined, so the two read apart at a glance.
// The edge colour is chosen apart from the flag's amber edge: both on one element would let CSS order decide.
const COLOURS = {
  van: { pick: 'bg-blue-100 text-blue-900', drop: 'bg-white text-blue-900', edge: 'border-blue-500' },
  car: { pick: 'bg-orange-100 text-orange-900', drop: 'bg-white text-orange-900', edge: 'border-orange-500' },
};

/** PENDENTE: the subscription isn't approved yet. PLANO: only on the board, no subscription. */
export function badgeOf(run: TransportRun): { text: string; className: string } | null {
  if (run.source === 'plan') return { text: 'PLANO', className: 'bg-gray-900 text-white' };
  if (run.status === 'pending') return { text: 'PENDENTE', className: 'bg-amber-500 text-white' };
  return null;
}

export default function RunCard({ run, part, dimmed, readOnly }: { run: TransportRun; part: Part; dimmed: boolean; readOnly: boolean }) {
  const pick = part === 'pick';
  const drop = dropOf(run);
  const time = pick ? run.time : drop.time;
  const tilde = !pick && drop.guess ? '~' : '';
  const place = (pick ? run.from : run.to) || '?';
  const warn = warnings(run, part);
  const notes = pick ? [...legNotes(run), ...(run.note ? [run.note] : [])] : [];
  const badge = badgeOf(run);
  const border = warn.length || run.flag
    ? 'border-2 border-dashed border-amber-600 px-1 py-px'
    : `border ${COLOURS[run.vehicle].edge} ${tilde ? 'border-dotted' : 'border-solid'} px-[5px] py-[2px]`;
  const label = [
    pick ? 'Recolha' : 'Entrega', badge?.text.toLowerCase() ?? '', run.name, `${DAYS[run.day]} ${time}`,
    VEHICLES[run.vehicle].label, place, ...notes, ...warn,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      data-card
      data-id={run.id}
      data-part={part}
      aria-label={label}
      className={`grid w-full text-left rounded-[3px] select-none touch-manipulation text-[0.76rem] leading-tight ${COLOURS[run.vehicle][part]} ${border} ${readOnly ? 'cursor-default' : 'cursor-grab'} ${dimmed ? 'opacity-25' : ''}`}
    >
      <span className="flex flex-wrap items-baseline gap-x-1">
        <span data-role="time" className="font-mono text-[0.72rem] font-semibold tabular-nums">{tilde}{time}</span>
        <span className="font-bold">{run.name}</span>
        {pick && badge && <span className={`rounded-sm px-1 text-[0.62rem] font-bold tracking-wide ${badge.className}`}>{badge.text}</span>}
      </span>
      <span className="[overflow-wrap:anywhere]">{place}</span>
      {!pick && (
        <span className="text-[0.7rem] opacity-80">
          <span data-role="drive">{tilde}{toMin(time) - toMin(run.time)} min</span>{run.by ? ` · até às ${run.by}` : ''}
        </span>
      )}
      {notes.map(n => <span key={n} className={`text-[0.7rem] [overflow-wrap:anywhere] ${run.flag && n === run.note ? 'font-bold text-amber-800' : 'opacity-80'}`}>{n}</span>)}
      {warn.map(w => <span key={w} className="text-[0.7rem] font-bold text-amber-800">{w}</span>)}
    </button>
  );
}
