import { DAYS, VEHICLES, dropOf, toMin, warnings, type Part, type TransportRun } from './logic';

// A pick-up is filled with its vehicle's colour, a drop-off only outlined, so the two read apart at a glance.
const COLOURS = {
  van: { pick: 'bg-blue-100 text-blue-900 border-blue-500', drop: 'bg-white text-blue-900 border-blue-500' },
  car: { pick: 'bg-orange-100 text-orange-900 border-orange-500', drop: 'bg-white text-orange-900 border-orange-500' },
};

export default function RunCard({ run, part, dimmed, readOnly }: { run: TransportRun; part: Part; dimmed: boolean; readOnly: boolean }) {
  const pick = part === 'pick';
  const drop = dropOf(run);
  const time = pick ? run.time : drop.time;
  const tilde = !pick && drop.guess ? '~' : '';
  const place = (pick ? run.from : run.to) || '?';
  const warn = warnings(run, part);
  const border = warn.length || run.flag
    ? 'border-2 border-dashed border-amber-600 px-1 py-px'
    : `border ${tilde ? 'border-dotted' : 'border-solid'} px-[5px] py-[2px]`;
  const label = [
    pick ? 'Recolha' : 'Entrega', run.isNew ? 'novo' : '', run.name, `${DAYS[run.day]} ${time}`,
    VEHICLES[run.vehicle].label, place, pick ? run.note ?? '' : '', ...warn,
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
        {pick && run.isNew && <span className="rounded-sm bg-gray-900 px-1 text-[0.62rem] font-bold tracking-wide text-white">NOVO</span>}
      </span>
      <span className="[overflow-wrap:anywhere]">{place}</span>
      {!pick && (
        <span className="text-[0.7rem] opacity-80">
          <span data-role="drive">{tilde}{toMin(time) - toMin(run.time)} min</span>{run.by ? ` · até às ${run.by}` : ''}
        </span>
      )}
      {pick && run.note && <span className={`text-[0.7rem] [overflow-wrap:anywhere] ${run.flag ? 'font-bold text-amber-800' : 'opacity-80'}`}>{run.note}</span>}
      {warn.map(w => <span key={w} className="text-[0.7rem] font-bold text-amber-800">{w}</span>)}
    </button>
  );
}
