import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { addMonths, daysBetween, firstDay, isYearMonth, monthOf, monthsBetween } from '@shared/finhub/dates';
import { acceptanceReport, CRITERIA_TITLES } from '@shared/finhub/noisysource/acceptance';
import { ecRunway } from '@shared/finhub/noisysource/ec';
import { PLAN_KIND_LABEL, type PlannedItem } from '@shared/finhub/noisysource/plan';
import {
  ADHOC_CATEGORIES, bucketsTotal, categoryLabel, monthRecon, type ItemStatus, type LineStatus, type Reconciliation,
} from '@shared/finhub/noisysource/reconcile';
import { termsAt, type NsState } from '@shared/finhub/noisysource/state';
import { useNs } from './NoisySourceModule';
import { classify, confirmLines, explainItem, matchByHand, undo } from './actions';
import { amountClass, eur, fmtDate, fmtDay, fmtMonth } from './format';
import { CheckBadge, ITEM_STATE, LINE_STATE } from './status';
import { Badge } from './ui';

type Filter = 'todas' | 'abertas';

export default function MesPage() {
  const { state, today, accountId, rec, eventIds, reload } = useNs();
  const params = useParams();
  const navigate = useNavigate();
  const s = state!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('todas');

  const lastLineMonth = rec?.lastLineDate ? monthOf(rec.lastLineDate) : monthOf(today);
  const month = params.month && isYearMonth(params.month) ? params.month : lastLineMonth;
  const firstMonth = s.movements.length ? monthOf(s.movements[0].date) : month;
  const months = monthsBetween(firstMonth < month ? firstMonth : month, addMonths(monthOf(today), 3));

  const recon = useMemo(() => (rec ? monthRecon(s, rec, month) : null), [s, rec, month]);
  const acceptance = useMemo(
    () => (rec && accountId && recon ? acceptanceReport(s, { accountId, today, months: [month], rec }).months[0] ?? null : null),
    [s, rec, accountId, recon, today, month],
  );

  if (!rec || !accountId) return <p className="text-zinc-400">Sem extratos importados.</p>;

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const go = (m: string) => navigate(`/v2/noisysource/mes/${m}`);
  const planned = [...rec.items.values()].filter(i => monthOf(i.item.date) === month).sort((a, b) => a.item.date.localeCompare(b.item.date));
  const lines = recon?.lines ?? [];
  const exact = lines.filter(l => l.state === 'sugerido' && l.exact);
  const classSugg = lines.filter(l => l.state === 'classificacao-sugerida');
  const shownLines = filter === 'todas' ? lines : lines.filter(l => l.state !== 'confirmado' && l.state !== 'classificado');

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Mês — {fmtMonth(month)}</h1>
          <p className="text-sm text-zinc-400">
            Cada linha do banco ligada ao plano ou classificada como ocasional; cada previsto com a sua linha ou uma razão.
            As sugestões são calculadas; só ficam registadas quando as confirmas.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-md bg-zinc-900 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800" onClick={() => go(addMonths(month, -1))}>◀</button>
          <select value={month} onChange={e => go(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm">
            {months.map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}
          </select>
          <button className="rounded-md bg-zinc-900 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800" onClick={() => go(addMonths(month, 1))}>▶</button>
          <Link to="/v2/noisysource/aceitacao" className="ml-2 text-sm text-sky-300 hover:underline">Relatório de aceitação</Link>
        </div>
      </header>

      {error && <p className="rounded-md border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">{error}</p>}

      <Checklist state={s} rec={rec} month={month} today={today} />

      {acceptance && (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">Aceitação <CheckBadge status={acceptance.overall} /></h2>
          <ul className="space-y-1 text-sm">
            {acceptance.criteria.map(c => (
              <li key={c.n} className="flex flex-wrap items-baseline gap-2">
                <span className="w-60 shrink-0 text-zinc-300">{c.n}. {CRITERIA_TITLES[c.n]}</span>
                <CheckBadge status={c.status} />
                <span className="text-zinc-400">{c.summary}</span>
                {c.n >= 4 && c.details.length > 0 && <span className="w-full text-xs text-zinc-500 sm:pl-64">{c.details.join(' · ')}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {recon ? (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <h2 className="mb-2 text-lg font-semibold">Previsto vs real</h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
                <tr><th /><th className="text-right">Previsto</th><th className="text-right">Real</th></tr>
              </thead>
              <tbody>
                <Row label="Saldo inicial (real)" a={recon.openingCents} b={recon.openingCents} />
                <Row label="Entradas" a={recon.plannedInCents} b={recon.realInCents} />
                <Row label="Saídas" a={recon.plannedOutCents} b={recon.realOutCents} />
                <Row label="Saldo final" a={recon.plannedEndCents} b={recon.realEndCents} strong />
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <h2 className="mb-2 text-lg font-semibold">Real − previsto: {eur(recon.diffCents)}</h2>
            <ul className="space-y-1 text-sm">
              <Bucket label="Linhas ocasionais (classificadas)" cents={recon.buckets.adhocCents} />
              <Bucket label="Diferenças de valor (estimativas, comissões, arredondamentos)" cents={recon.buckets.amountDiffCents} />
              <Bucket label="Pagos noutro mês (adiantados ou em atraso)" cents={recon.buckets.otherMonthCents} />
              <Bucket label="Previstos sem movimento, com razão" cents={recon.buckets.explainedMissingCents} />
              <Bucket label="Previstos sem movimento, sem razão" cents={recon.buckets.missingCents} bad />
              <Bucket label="Linhas por explicar" cents={recon.buckets.unexplainedCents} bad />
              <li className="flex justify-between border-t border-zinc-800 pt-1 font-semibold">
                <span>Total</span>
                <span className={bucketsTotal(recon.buckets) === recon.diffCents ? '' : 'text-red-300'}>{eur(bucketsTotal(recon.buckets))}</span>
              </li>
            </ul>
            {recon.diffGroups.length > 0 && (
              <details className="mt-3 text-xs text-zinc-400">
                <summary className="cursor-pointer">Diferenças de valor ({recon.diffGroups.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {recon.diffGroups.map(g => (
                    <li key={g.itemIds.join()} className="flex justify-between gap-2">
                      <span>{g.itemIds.map(id => rec.items.get(id)!.item.label).join(', ')} · {g.lineIds.length} linha(s){g.confirmed ? '' : ' (sugerido)'}</span>
                      <span className={amountClass(g.diffCents)}>{eur(g.diffCents)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </section>
      ) : (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
          Ainda não há extrato deste mês: só o plano.
        </p>
      )}

      {recon && (
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Linhas do banco ({lines.length})</h2>
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={busy || !exact.length} onClick={() => run(() => confirmLines(exact, rec.items, eventIds))}
                className="rounded-md bg-sky-800 px-3 py-1 text-sm text-white hover:bg-sky-700 disabled:opacity-40">
                Confirmar {exact.length} correspondência{exact.length === 1 ? '' : 's'} exata{exact.length === 1 ? '' : 's'}
              </button>
              <button disabled={busy || !classSugg.length} onClick={() => run(() => confirmLines(classSugg, rec.items, eventIds))}
                className="rounded-md bg-zinc-700 px-3 py-1 text-sm text-white hover:bg-zinc-600 disabled:opacity-40">
                Classificar {classSugg.length} como sugerido
              </button>
              <select value={filter} onChange={e => setFilter(e.target.value as Filter)} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm">
                <option value="todas">Todas</option>
                <option value="abertas">Por confirmar</option>
              </select>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-500">
                <tr><th className="px-3 py-2">Dia</th><th className="px-3 py-2">Linha do banco</th><th className="px-3 py-2 text-right">Valor</th><th className="px-3 py-2">Explicação</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody>
                {shownLines.map(l => (
                  <LineRow key={l.movement.id} l={l} rec={rec} busy={busy}
                    onConfirm={() => run(() => confirmLines([l], rec.items, eventIds))}
                    onMatch={items => run(() => matchByHand(l.movement, items, eventIds))}
                    onClassify={(cat, desc) => run(() => classify(l.movement, cat, desc, eventIds))}
                    onUndo={() => run(() => undo(l.eventId!, eventIds))} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold">Previsto em {fmtMonth(month)} ({planned.length})</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr><th className="px-3 py-2">Dia</th><th className="px-3 py-2">Previsto</th><th className="px-3 py-2 text-right">Valor</th><th className="px-3 py-2">No banco</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody>
              {planned.map(i => (
                <ItemRow key={i.item.id} i={i} rec={rec} busy={busy}
                  onExplain={reason => run(() => explainItem(i.item, reason, eventIds))}
                  onUndo={() => run(() => undo(i.reasonEventId!, eventIds))} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Row({ label, a, b, strong }: { label: string; a: number; b: number; strong?: boolean }) {
  return (
    <tr className={`border-t border-zinc-800 ${strong ? 'font-semibold' : ''}`}>
      <td className="py-1 text-zinc-300">{label}</td>
      <td className="py-1 text-right">{eur(a)}</td>
      <td className="py-1 text-right">{eur(b)}</td>
    </tr>
  );
}

function Bucket({ label, cents, bad }: { label: string; cents: number; bad?: boolean }) {
  return (
    <li className={`flex justify-between gap-2 ${cents === 0 ? 'text-zinc-500' : bad ? 'text-red-300' : 'text-zinc-300'}`}>
      <span>{label}</span><span>{eur(cents)}</span>
    </li>
  );
}

function itemsText(rec: Reconciliation, ids: string[]): ReactNode {
  return ids.map(id => rec.items.get(id)?.item.label ?? id).join(' + ');
}

function LineRow({ l, rec, busy, onConfirm, onMatch, onClassify, onUndo }: {
  l: LineStatus;
  rec: Reconciliation;
  busy: boolean;
  onConfirm: () => void;
  onMatch: (items: PlannedItem[]) => void;
  onClassify: (category: string, description: string) => void;
  onUndo: () => void;
}) {
  const [mode, setMode] = useState<'none' | 'item' | 'categoria'>('none');
  const [category, setCategory] = useState<string>(l.category ?? 'outro');
  const [description, setDescription] = useState(l.description ?? l.movement.description);
  const [itemId, setItemId] = useState('');
  const m = l.movement;
  const st = LINE_STATE[l.state];
  const confirmed = l.state === 'confirmado' || l.state === 'classificado';

  const candidates = useMemo(() => mode !== 'item' ? [] : [...rec.items.values()]
    .filter(i => Math.sign(i.item.amountCents) === Math.sign(m.amountCents) && Math.abs(daysBetween(i.item.date, m.date)) <= 75)
    .sort((a, b) => Math.abs(Math.abs(a.item.amountCents) - Math.abs(m.amountCents)) - Math.abs(Math.abs(b.item.amountCents) - Math.abs(m.amountCents))),
  [mode, rec, m]);

  return (
    <tr className="border-t border-zinc-800/70 align-top">
      <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">{fmtDay(m.date)}</td>
      <td className="px-3 py-1.5">{m.description}</td>
      <td className={`whitespace-nowrap px-3 py-1.5 text-right ${amountClass(m.amountCents)}`}>{eur(m.amountCents)}</td>
      <td className="px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={st.tone}>{st.label}</Badge>
          {l.itemIds.length > 0 && <span>{itemsText(rec, l.itemIds)}</span>}
          {l.category && !l.itemIds.length && <span>{categoryLabel(l.category)}</span>}
          {l.state === 'sugerido' && !l.exact && <Badge tone="amber">valor diferente</Badge>}
        </div>
        {l.basis && <div className="text-xs text-zinc-500">{l.basis}</div>}
        {l.missingItemIds && <div className="text-xs text-amber-300">já não está no plano: {l.missingItemIds.join(', ')}</div>}
        {mode === 'item' && (
          <div className="mt-1 flex flex-wrap gap-1">
            <select value={itemId} onChange={e => setItemId(e.target.value)} className="max-w-md rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-xs">
              <option value="">— previsto —</option>
              {candidates.map(i => (
                <option key={i.item.id} value={i.item.id}>
                  {fmtDate(i.item.date)} · {i.item.label} · {eur(i.item.amountCents)} · {ITEM_STATE[i.state].label}
                </option>
              ))}
            </select>
            <button disabled={busy || !itemId} onClick={() => { onMatch([rec.items.get(itemId)!.item]); setMode('none'); }}
              className="rounded bg-sky-800 px-2 py-0.5 text-xs text-white disabled:opacity-40">Ligar</button>
          </div>
        )}
        {mode === 'categoria' && (
          <div className="mt-1 flex flex-wrap gap-1">
            <select value={category} onChange={e => setCategory(e.target.value)} className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-xs">
              {ADHOC_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="o que é"
              className="min-w-48 flex-1 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-xs" />
            <button disabled={busy || !description.trim()} onClick={() => { onClassify(category, description); setMode('none'); }}
              className="rounded bg-zinc-600 px-2 py-0.5 text-xs text-white disabled:opacity-40">Classificar</button>
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right">
        {confirmed ? (
          <button disabled={busy || !l.eventId} onClick={onUndo} className="text-xs text-zinc-400 hover:text-white disabled:opacity-40">Desfazer</button>
        ) : (
          <div className="flex justify-end gap-2 text-xs">
            {(l.state === 'sugerido' || l.state === 'classificacao-sugerida') && (
              <button disabled={busy} onClick={onConfirm} className="rounded bg-sky-800 px-2 py-0.5 text-white hover:bg-sky-700 disabled:opacity-40">Confirmar</button>
            )}
            <button disabled={busy} onClick={() => setMode(mode === 'item' ? 'none' : 'item')} className="text-zinc-400 hover:text-white">Ligar a…</button>
            <button disabled={busy} onClick={() => setMode(mode === 'categoria' ? 'none' : 'categoria')} className="text-zinc-400 hover:text-white">Ocasional…</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function ItemRow({ i, rec, busy, onExplain, onUndo }: {
  i: ItemStatus;
  rec: Reconciliation;
  busy: boolean;
  onExplain: (reason: string) => void;
  onUndo: () => void;
}) {
  const [reason, setReason] = useState('');
  const st = ITEM_STATE[i.state];
  const g = rec.groupOfItem.get(i.item.id);
  const group = g === undefined ? null : rec.groups[g];
  return (
    <tr className="border-t border-zinc-800/70 align-top">
      <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">{fmtDay(i.item.date)}</td>
      <td className="px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{i.item.label}</span>
          <Badge>{PLAN_KIND_LABEL[i.item.kind]}</Badge>
          {i.item.toConfirm && <Badge tone="amber">a confirmar</Badge>}
        </div>
        <div className="text-xs text-zinc-500">{i.item.inputs}</div>
      </td>
      <td className={`whitespace-nowrap px-3 py-1.5 text-right ${amountClass(i.item.amountCents)}`}>{eur(i.item.amountCents)}</td>
      <td className="px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={st.tone}>{st.label}</Badge>
          {i.lineIds.length > 0 && (
            <span className="text-xs text-zinc-400">
              {i.lineIds.map(id => fmtDate(rec.lines.get(id)!.movement.date)).join(', ')}
              {group && group.diffCents !== 0 && <> · diferença do grupo <span className={amountClass(group.diffCents)}>{eur(group.diffCents)}</span></>}
            </span>
          )}
        </div>
        {i.reason && <div className="text-xs text-amber-200">{i.reason}</div>}
        {i.state === 'sem-movimento' && (
          <div className="mt-1 flex gap-1">
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="porque não há linha no banco?"
              className="min-w-56 flex-1 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-xs" />
            <button disabled={busy || !reason.trim()} onClick={() => onExplain(reason)}
              className="rounded bg-zinc-600 px-2 py-0.5 text-xs text-white disabled:opacity-40">Guardar razão</button>
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right">
        {i.state === 'explicado' && (
          <button disabled={busy || !i.reasonEventId} onClick={onUndo} className="text-xs text-zinc-400 hover:text-white disabled:opacity-40">Desfazer</button>
        )}
      </td>
    </tr>
  );
}

/** The month's documents and payments, as a checklist (HANDOFF § Screens, Mês). */
function Checklist({ state, rec, month, today }: { state: NsState; rec: Reconciliation; month: string; today: string }) {
  const rows: { label: string; status: 'ok' | 'falta' | 'na'; text: string }[] = [];
  for (const c of state.contracts) {
    const m = ecRunway(state, c, today).months.find(x => x.month === month);
    if (!m) continue;
    const ts = state.timesheets[`${c.number}|${month}`];
    rows.push({ label: `Folha de horas · contrato ${c.number}`, status: ts ? 'ok' : 'falta', text: ts ? `submetida: ${ts.days} dias` : `por registar (calendário: ${m.days} dias)` });
    const inv = state.invoices.find(i => i.contractNumber === c.number && i.month === month);
    rows.push({ label: `Fatura · contrato ${c.number}`, status: inv ? 'ok' : 'falta', text: inv ? `fatura ${inv.invoiceNumber}` : 'por registar' });
  }
  for (const p of state.people) {
    if (!termsAt(state, p.id, firstDay(month))) continue;
    const ps = state.payslips[`${p.id}|${month}`];
    rows.push({ label: `Recibo · ${p.name}`, status: ps ? 'ok' : 'falta', text: ps ? 'registado' : 'por registar' });
  }
  for (const [kind, label] of [['ss', 'Segurança Social do mês'], ['irs', 'IRS retido do mês']] as const) {
    const it = rec.items.get(`${kind}:all:${month}`);
    if (!it) continue;
    const paid = it.state === 'confirmado' || it.state === 'sugerido';
    rows.push({
      label, status: paid ? 'ok' : it.state === 'futuro' ? 'na' : 'falta',
      text: `${fmtDate(it.item.date)}: ${ITEM_STATE[it.state].label}${it.state === 'sugerido' ? ' (sugestão)' : ''}`,
    });
  }
  if (!rows.length) return null;
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <h2 className="mb-2 text-lg font-semibold">Lista do mês</h2>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
        {rows.map(r => (
          <li key={r.label} className="flex items-baseline gap-2">
            <span className={r.status === 'ok' ? 'text-emerald-300' : r.status === 'falta' ? 'text-amber-300' : 'text-zinc-500'}>
              {r.status === 'ok' ? '✓' : r.status === 'falta' ? '○' : '·'}
            </span>
            <span className="text-zinc-300">{r.label}</span>
            <span className="text-xs text-zinc-500">{r.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
