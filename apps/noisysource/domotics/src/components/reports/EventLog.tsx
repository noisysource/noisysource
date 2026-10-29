import { useMemo, useState } from 'react';
import {
  fmtDate, fmtTime, LOG_ORIGIN, logRows, repeatedOutside, type Incident, type LogOrigin,
} from '../../data/incidents';

/**
 * "Registo": every on/off and fault of the heat pump, newest first, with when
 * (to the second), who (origin) and what happened — the reason, what the pump
 * was doing, and whatever else in its datapoints changed with the switch. On
 * top, the outside switches that repeat at the same time of day by the pump's
 * own clock, which is how the nightly 23:54 off showed itself to be a timer.
 */

const PAGE = 40;
const FILTERS: Array<[LogOrigin | 'all', string]> = [
  ['all', 'Tudo'], ['outside', 'De fora'], ['guard', 'Proteção'], ['automation', 'Automação'], ['app', 'App'], ['pump', 'Avarias'],
];
const TONE: Record<LogOrigin, string> = {
  outside: 'bg-amber-950/70 text-amber-300',
  unknown: 'bg-amber-950/70 text-amber-300',
  guard: 'bg-sky-950/70 text-sky-300',
  automation: 'bg-sky-950/70 text-sky-300',
  app: 'bg-zinc-800 text-zinc-300',
  pump: 'bg-red-950/70 text-red-300',
  note: 'bg-zinc-800 text-zinc-400',
};

export default function EventLog({ incidents }: { incidents: Incident[] }) {
  const [filter, setFilter] = useState<LogOrigin | 'all'>('all');
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => logRows(incidents), [incidents]);
  const repeats = useMemo(() => repeatedOutside(incidents), [incidents]);
  const filtered = filter === 'all' ? rows
    : rows.filter(r => r.origin === filter || (filter === 'outside' && r.origin === 'unknown'));
  const filters = FILTERS.filter(([f]) => f === 'all' || rows.some(r => r.origin === f || (f === 'outside' && r.origin === 'unknown')));
  if (rows.length === 0) return null;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-zinc-100">Registo</h2>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Tudo o que aconteceu à bomba, do mais recente para o mais antigo: quando, quem e o quê. "De fora" é o que não
          passou pela ponte — o painel, a SmartLife, os técnicos ou um temporizador da máquina.
        </p>
      </div>

      {repeats.map(r => (
        <div key={`${r.on}-${r.from}`} className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2.5 flex flex-col gap-1">
          <p className="text-sm text-amber-200">
            {r.on ? 'Ligada' : 'Desligada'} de fora {r.times.length} vezes {r.from === r.to ? `às ${r.from}` : `entre as ${r.from} e as ${r.to}`} no
            relógio da bomba
          </p>
          <p className="text-xs text-amber-300/80 leading-relaxed">
            {r.times.map(t => `${fmtDate(t)} ${fmtTime(t, true)}`).join(' · ')} (hora de Lisboa). Sempre à mesma hora no relógio
            da própria bomba, que fica em UTC+1 e não muda para a hora de inverno: é a assinatura de um temporizador no
            comando da máquina, não de uma pessoa.
          </p>
        </div>
      ))}

      {filters.length > 2 && (
        <div className="flex flex-wrap gap-1.5">
          {filters.map(([f, text]) => (
            <button key={f} onClick={() => { setFilter(f); setShown(PAGE); }}
              className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${filter === f ? 'bg-zinc-100 text-zinc-900 font-semibold' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
              {text}
            </button>
          ))}
        </div>
      )}

      <ul className="flex flex-col">
        {filtered.slice(0, shown).map(r => (
          <li key={r.id} className="flex flex-wrap sm:flex-nowrap gap-x-3 gap-y-1 py-2 border-t border-zinc-800/70 first:border-t-0">
            <div className="w-28 shrink-0 flex flex-col tabular-nums">
              <span className="text-xs text-zinc-200">{fmtDate(r.at)} {fmtTime(r.at, true)}</span>
              {r.pumpClock && <span className="text-[10px] text-zinc-500">{r.pumpClock} na bomba</span>}
            </div>
            <div className="w-28 shrink-0">
              <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${TONE[r.origin]}`}>{LOG_ORIGIN[r.origin]}</span>
            </div>
            <div className="basis-full sm:basis-auto flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm text-zinc-100 leading-snug">{r.what}</span>
              {r.details.map((d, i) => <span key={i} className="text-xs text-zinc-400 leading-relaxed">{d}</span>)}
            </div>
          </li>
        ))}
      </ul>
      {filtered.length > shown && (
        <button onClick={() => setShown(n => n + PAGE)} className="self-start text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
          Mostrar mais ({filtered.length - shown})
        </button>
      )}
    </section>
  );
}
