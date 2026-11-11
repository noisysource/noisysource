import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BLUEPRINT_GROUPS, blueprints, yearGrid, type GridRow } from '@shared/finhub/noisysource/blueprints';
import { monthLabelPt, PLAN_KIND_LABEL } from '@shared/finhub/noisysource/plan';
import { useNs } from './NoisySourceModule';
import { amountClass, eur, fmtDate, fmtDay } from './format';
import { confirmBlueprints } from './planActions';
import { Badge } from './ui';

const whole = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 });
const short = (cents: number) => whole.format(Math.round(cents / 100));
const CELL = 'px-2 py-1 text-right tabular-nums whitespace-nowrap';
const STICKY = 'sticky left-0 z-10 bg-zinc-950';

function rowCents(row: GridRow, month: string): number | null {
  const items = row.items[month];
  return items ? items.reduce((s, i) => s + i.amountCents, 0) : null;
}

/** Month by month, what the blueprints generate: click a value to see how it was calculated. */
export default function AnoPage() {
  const { state, today, accountId, rec, eventIds, reload } = useNs();
  const s = state!;
  const grid = useMemo(() => (accountId ? yearGrid(s, { accountId, today, rec }) : null), [s, accountId, today, rec]);
  const list = useMemo(() => blueprints(s, { today }), [s, today]);
  const [open, setOpen] = useState<{ row: string; month: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!grid) return <p className="text-zinc-400">Sem extratos importados: não há saldo real de partida.</p>;
  const active = list.filter(b => b.active);
  const confirmed = active.filter(b => b.confirmed).length;
  const lastMonth = grid.months[grid.months.length - 1]?.month;
  const toggle = (row: string, month: string) => setOpen(open?.row === row && open.month === month ? null : { row, month });
  const confirm = async (row: GridRow) => {
    setBusy(true);
    setError(null);
    try { await confirmBlueprints([row.blueprint!], today, eventIds); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const groups = BLUEPRINT_GROUPS.map(g => ({ ...g, rows: grid.rows.filter(r => r.group === g.id) })).filter(g => g.rows.length);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">Ano — até {lastMonth ? monthLabelPt(lastMonth) : ''}</h1>
        <p className="max-w-4xl text-sm text-zinc-400">
          O que o <Link to="/v2/noisysource/plano" className="text-sky-300 hover:underline">Plano</Link> gera, no mês em que o dinheiro se move, a partir do
          saldo real de {fmtDate(grid.start.date)} ({eur(grid.start.balanceCents)}). Clica num valor para ver como foi calculado; se estiver errado, altera-o no Plano.
        </p>
        <p className="mt-1 text-sm"><b>{confirmed}</b> de <b>{active.length}</b> planos confirmados.</p>
      </header>

      {grid.warnings.length > 0 && (
        <ul className="max-w-4xl space-y-1 rounded-md border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-100">
          {grid.warnings.map(w => <li key={w.text}>{w.text}</li>)}
        </ul>
      )}
      {error && <p className="rounded-md border border-red-800 bg-red-950/50 p-2 text-sm text-red-200">{error}</p>}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="min-w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className={`${STICKY} min-w-56 px-2 py-2 text-left font-medium`}>Plano</th>
              {grid.months.map(m => (
                <th key={m.month} className={`${CELL} font-medium ${m.month < today.slice(0, 7) ? 'text-zinc-600' : ''}`}
                  title={m.month <= today.slice(0, 7) ? 'Ainda sem extrato deste mês: é o plano' : undefined}>
                  {monthLabelPt(m.month).replace(' 20', ' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <Fragment key={g.id}>
                <tr className="border-t border-zinc-800 bg-zinc-900/60">
                  <td className={`sticky left-0 z-10 bg-zinc-900 px-2 py-1 font-semibold text-zinc-300`} colSpan={1}>{g.label}</td>
                  <td colSpan={grid.months.length} />
                </tr>
                {g.rows.map(r => {
                  const openHere = open?.row === r.key ? r.items[open.month] : null;
                  return (
                    <Fragment key={r.key}>
                      <tr className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
                        <td className={`${STICKY} px-2 py-1`}>
                          <div className="flex items-center justify-between gap-2">
                            {r.blueprint
                              ? <Link to={`/v2/noisysource/plano?b=${encodeURIComponent(r.blueprint.id)}`} className="truncate hover:underline" title={r.label}>{r.label}</Link>
                              : <span className="text-zinc-400" title="Vem dos salários de todos">{r.label}</span>}
                            {r.blueprint && (r.blueprint.confirmed
                              ? <Badge tone="emerald">✓</Badge>
                              : <button disabled={busy} onClick={() => confirm(r)} className="rounded bg-sky-900 px-1.5 text-[11px] leading-5 text-white hover:bg-sky-800 disabled:opacity-40">Confirmar</button>)}
                          </div>
                        </td>
                        {grid.months.map(m => {
                          const c = rowCents(r, m.month);
                          const selected = open?.row === r.key && open.month === m.month;
                          return (
                            <td key={m.month} className={`${CELL} ${selected ? 'bg-sky-950/60' : ''}`}>
                              {c == null ? <span className="text-zinc-700">·</span>
                                : <button onClick={() => toggle(r.key, m.month)} title={eur(c)} className={`hover:underline ${amountClass(c)}`}>{short(c)}</button>}
                            </td>
                          );
                        })}
                      </tr>
                      {openHere && (
                        <tr className="border-t border-zinc-800/60 bg-zinc-900/60">
                          <td className={`sticky left-0 z-10 bg-zinc-900 px-2 py-2 text-zinc-500`}>{monthLabelPt(open!.month)}</td>
                          <td colSpan={grid.months.length} className="px-2 py-2">
                            <ul className="max-w-3xl space-y-1">
                              {openHere.map(i => (
                                <li key={i.id} className="flex flex-wrap items-baseline gap-x-2">
                                  <span className="w-20 text-zinc-500">{fmtDay(i.date)}</span>
                                  <span className={`w-20 text-right tabular-nums ${amountClass(i.amountCents)}`}>{eur(i.amountCents)}</span>
                                  <span className="text-zinc-200">{i.label}</span>
                                  <Badge>{PLAN_KIND_LABEL[i.kind]}</Badge>
                                  {i.toConfirm && <Badge tone="amber">a confirmar</Badge>}
                                  <span className="basis-full pl-[11rem] text-zinc-500">{i.inputs}</span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
            <tr className="border-t-2 border-zinc-700">
              <td className={`${STICKY} px-2 py-1 text-zinc-400`}>Entradas</td>
              {grid.months.map(m => <td key={m.month} className={`${CELL} text-emerald-300`} title={eur(m.inCents)}>{m.inCents ? short(m.inCents) : ''}</td>)}
            </tr>
            <tr className="border-t border-zinc-800/60">
              <td className={`${STICKY} px-2 py-1 text-zinc-400`}>Saídas</td>
              {grid.months.map(m => <td key={m.month} className={`${CELL} text-red-300`} title={eur(m.outCents)}>{m.outCents ? short(m.outCents) : ''}</td>)}
            </tr>
            <tr className="border-t border-zinc-700 font-semibold">
              <td className={`${STICKY} px-2 py-1`}>Saldo no fim do mês</td>
              {grid.months.map(m => <td key={m.month} className={`${CELL} ${m.endCents < 0 ? 'text-red-300' : ''}`} title={eur(m.endCents)}>{short(m.endCents)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
