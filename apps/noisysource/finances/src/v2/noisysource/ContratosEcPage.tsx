import { Fragment, useMemo, useState } from 'react';
import { addDays, daysBetween } from '@shared/finhub/dates';
import { contractGaps, ecRunway, type EcRunway } from '@shared/finhub/noisysource/ec';
import { CALENDAR_KIND_LABEL } from '@shared/finhub/noisysource/events';
import { plannedItems, type PlannedItem } from '@shared/finhub/noisysource/plan';
import { calendarOf, type NsState } from '@shared/finhub/noisysource/state';
import { useNs } from './NoisySourceModule';
import { eur, fmtDate, fmtDays, fmtMonth } from './format';
import { Badge } from './ui';

export default function ContratosEcPage() {
  const { state, today, accounts } = useNs();
  const s = state!;
  const runways = useMemo(() => s.contracts.map(c => ecRunway(s, c, today)), [s, today]);
  const gaps = useMemo(() => contractGaps(s, runways), [s, runways]);
  const ecItems = useMemo(() => {
    if (!runways.length) return [];
    const from = runways.map(r => r.contract.startDate).sort()[0];
    const to = addDays(runways.map(r => r.lastDay ?? today).sort().pop()!, 75);
    return plannedItems(s, { from, to, mainAccount: accounts[0] ?? '' }).filter(i => i.kind === 'ec');
  }, [s, runways, accounts, today]);

  const clients = [...new Set(runways.map(r => r.contract.client))];
  if (!runways.length) return <p className="text-zinc-400">Ainda não há contratos EC.</p>;

  return (
    <div className="max-w-6xl space-y-6">
      <header>
        <h1 className="text-xl font-bold">Contratos EC — NoisySource</h1>
        <p className="text-sm text-zinc-400">
          Cada contrato tem um número, uma taxa diária e um total de dias. Os dias de cada mês são os da folha de horas quando
          existe; até lá, os planeados (calendário do cliente − ausências; viagens contam como trabalhadas). Aviso 3 meses antes do
          último dia.
        </p>
      </header>

      {clients.map(client => {
        const list = runways.filter(r => r.contract.client === client);
        const last = list[list.length - 1];
        return (
          <section key={client} className="space-y-3">
            <h2 className="text-lg font-semibold">
              {client}{list[0].contract.endClient ? <span className="text-zinc-400 font-normal"> → {list[0].contract.endClient}</span> : null}
            </h2>
            {list.map((r, i) => {
              const gap = i > 0 ? gaps.find(g => g.before === r.contract.number && g.after === list[i - 1].contract.number) : undefined;
              return (
                <Fragment key={r.contract.number}>
                  {gap && (
                    <div className={`rounded-md border px-3 py-1.5 text-sm ${gap.workingDays === 0 ? 'border-zinc-800 text-zinc-400' : 'border-amber-800 bg-amber-950/30 text-amber-200'}`}>
                      {gap.workingDays === 0
                        ? 'Segue-se diretamente ao anterior (nenhum dia útil sem contrato).'
                        : `Intervalo: ${fmtDays(gap.workingDays)} úteis sem contrato (${fmtDate(gap.from)} a ${fmtDate(gap.to)}) — sem receita EC.`}
                    </div>
                  )}
                  <ContractCard r={r} today={today} items={ecItems.filter(x => x.contractNumber === r.contract.number)} state={s} />
                </Fragment>
              );
            })}
            {last.lastDay && (
              <div className="rounded-md border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                Sem contrato seguinte: depois de {fmtDate(last.lastDay)} não há receita EC prevista
                {last.lastDay >= today ? ` (faltam ${daysBetween(today, last.lastDay)} dias)` : ''}. A Tesouraria mostra essa falha tal como é.
              </div>
            )}
          </section>
        );
      })}

      <Calendars state={s} />
    </div>
  );
}

function ContractCard({ r, today, items, state }: { r: EcRunway; today: string; items: PlannedItem[]; state: NsState }) {
  const [open, setOpen] = useState(!r.finished);
  const c = r.contract;
  const pct = Math.min(100, Math.round((r.usedDays / c.totalDays) * 100));
  const status = r.finished
    ? <Badge>terminado</Badge>
    : r.warningActive
      ? <Badge tone="amber">aviso ativo: preparar o próximo contrato</Badge>
      : today < c.startDate ? <Badge tone="sky">ainda não começou</Badge> : <Badge tone="emerald">em curso</Badge>;
  const received = (i: PlannedItem) => state.movements.find(m =>
    m.amountCents === i.amountCents && Math.abs(daysBetween(i.date, m.date)) <= 10);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">Contrato {c.number}</span>
            {status}
          </div>
          {c.title && <div className="text-sm text-zinc-400">{c.title}</div>}
          <div className="mt-1 text-sm text-zinc-300">
            {eur(c.dailyRateCents)}/dia · início {fmtDate(c.startDate)} · {c.vatCode === 'isento' ? 'sem IVA (isento)' : `IVA ${c.vatCode}`} ·
            recebe {c.daysToPayment} dias após a fatura
          </div>
        </div>
        <div className="text-right text-sm">
          <div>Último dia previsto: <span className="font-semibold">{fmtDate(r.lastDay)}</span></div>
          {c.clientEstimatedEnd && (
            <div className="text-xs text-zinc-400">
              estimativa do cliente: {fmtDate(c.clientEstimatedEnd)}
              {r.lastDay && r.lastDay !== c.clientEstimatedEnd ? ' (difere: o cliente estima, o FinHub conta os dias)' : ' ✓'}
            </div>
          )}
          <div className={`text-xs ${r.warningActive ? 'text-amber-300' : 'text-zinc-400'}`}>Aviso (3 meses antes): {fmtDate(r.warningDate)}</div>
          {r.endedEarly && <div className="text-xs text-amber-300">Terminado antes do previsto: {fmtDays(r.unusedDays)} por usar</div>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-t border-zinc-800 bg-zinc-800 text-center sm:grid-cols-4">
        <Stat label="Dias no contrato" value={fmtDays(c.totalDays)} />
        <Stat label="Usados" value={fmtDays(r.usedDays)} sub={r.openingDays ? `${r.openingDays} antes de ${fmtDate(addDays(c.opening!.asOf, 1))}` : 'folhas de horas + dias já passados'} />
        <Stat label="Planeados" value={fmtDays(r.plannedDays)} sub="de hoje ao último dia" />
        <Stat label="Por usar" value={fmtDays(r.leftDays)} />
      </div>
      <div className="h-1.5 bg-zinc-800"><div className="h-1.5 bg-emerald-600" style={{ width: `${pct}%` }} /></div>

      <button onClick={() => setOpen(!open)} className="w-full px-4 py-2 text-left text-xs uppercase tracking-wider text-zinc-400 hover:text-white">
        {open ? '▾' : '▸'} Dias e faturas por mês
      </button>
      {open && (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1">Mês</th>
                <th className="py-1 text-right">Dias</th>
                <th className="py-1">Fonte</th>
                <th className="py-1 text-right">Valor</th>
                <th className="py-1 text-right">Recebimento previsto</th>
                <th className="py-1 text-right">No banco</th>
              </tr>
            </thead>
            <tbody>
              {r.months.map(m => {
                const item = items.find(i => i.month === m.month);
                const bank = item ? received(item) : undefined;
                return (
                  <tr key={m.month} className="border-t border-zinc-800/70">
                    <td className="py-1">{fmtMonth(m.month)}</td>
                    <td className="py-1 text-right">{m.days}</td>
                    <td className="py-1">{m.source === 'folha' ? <Badge tone="emerald">folha de horas</Badge> : <Badge>planeado</Badge>}</td>
                    <td className="py-1 text-right">{eur(m.amountCents)}</td>
                    <td className="py-1 text-right text-zinc-300">{item ? fmtDate(item.date) : '—'}</td>
                    <td className="py-1 text-right text-xs">{bank ? <span className="text-emerald-300">✓ {fmtDate(bank.date)}</span> : <span className="text-zinc-500">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-500">
            "No banco": um crédito com o mesmo valor a ±10 dias do recebimento previsto (pista; a correspondência confirmada vem no ecrã Mês).
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-zinc-900 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub && <div className="text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

/** The calendars the days come from: the client's holidays and each person's entries. */
function Calendars({ state }: { state: NsState }) {
  const calendarIds = [...new Set(state.contracts.map(c => c.holidayCalendar))];
  const people = [...new Set(state.contracts.map(c => c.personId))];
  const name = (id: string) => state.people.find(p => p.id === id)?.name ?? id;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Calendários usados</h2>
      {calendarIds.map(id => (
        <div key={id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="mb-1 text-sm font-medium">Feriados do cliente ({id})</div>
          {Object.entries(state.extraHolidays[id] ?? {}).map(([year, dates]) => {
            const meta = state.holidayMeta[`${id}:${year}`];
            return (
              <div key={year} className="mb-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-300">{year}</span>
                  {meta?.toConfirm && <Badge tone="amber">a confirmar</Badge>}
                </div>
                <div className="text-xs text-zinc-400">{dates.map(d => `${fmtDate(d)}${meta?.names[d] ? ` (${meta.names[d]})` : ''}`).join(' · ')}</div>
                {meta?.note && <div className="text-xs text-zinc-500">{meta.note}</div>}
              </div>
            );
          })}
        </div>
      ))}
      {people.map(p => (
        <div key={p} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="mb-1 text-sm font-medium">Ausências e viagens de {name(p)}</div>
          <ul className="space-y-0.5 text-xs text-zinc-400">
            {calendarOf(state, p).sort((a, b) => a.dates[0].localeCompare(b.dates[0])).map(e => (
              <li key={e.eventId} className="flex flex-wrap items-center gap-1.5">
                <span className="w-44 shrink-0 text-zinc-300">{CALENDAR_KIND_LABEL[e.kind]}</span>
                <span>{e.dates.length === 1 ? fmtDate(e.dates[0]) : `${fmtDate(e.dates[0])} → ${fmtDate(e.dates[e.dates.length - 1])} (${e.dates.length} dias)`}</span>
                {e.label && <span className="text-zinc-500">— {e.label}</span>}
                {e.datesToConfirm && <Badge tone="amber">datas a confirmar</Badge>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
