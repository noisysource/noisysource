import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, monthOf, monthsBetween } from '@shared/finhub/dates';
import { PLAN_KIND_LABEL, type PlannedItem } from '@shared/finhub/noisysource/plan';
import { costPlanVersions, type NsState } from '@shared/finhub/noisysource/state';
import { pastMonthChecks, projectTreasury, type MonthCheck } from '@shared/finhub/noisysource/treasury';
import { useNs } from './NoisySourceModule';
import { amountClass, eur, fmtDate, fmtDay, fmtMonth } from './format';
import { Badge, Card } from './ui';

const HORIZONS = [
  { days: 90, label: '90 dias' },
  { days: 183, label: '6 meses' },
  { days: 365, label: '12 meses' },
];

const SOURCE_LABEL: Record<PlannedItem['source'], string> = { plano: 'estimativa', recibo: 'recibo', folha: 'folha de horas', fatura: 'fatura' };

export default function TesourariaPage() {
  const { state, today, accounts, events } = useNs();
  const [horizon, setHorizon] = useState(90);
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const accountId = accounts[0];
  const s = state!;

  const projection = useMemo(
    () => (accountId ? projectTreasury(s, { accountId, today, horizonDays: horizon }) : null),
    [s, accountId, today, horizon],
  );
  const checks = useMemo(() => {
    if (!accountId) return [];
    const ms = s.movements.filter(m => m.accountId === accountId);
    if (!ms.length) return [];
    return pastMonthChecks(s, { accountId, months: monthsBetween(monthOf(ms[0].date), monthOf(ms[ms.length - 1].date)) });
  }, [s, accountId]);

  if (!accountId || !projection) {
    return <p className="text-zinc-400">Sem extratos importados: não há saldo real de partida.</p>;
  }
  const endBalance = projection.days.length ? projection.days[projection.days.length - 1].balanceCents : projection.start.balanceCents;
  const staleDays = Math.round((Date.parse(today) - Date.parse(projection.start.date)) / 86_400_000);

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Tesouraria — NoisySource</h1>
          <p className="text-sm text-zinc-400">
            O saldo real é o do último extrato importado; tudo o resto é o plano a partir dele. {events.length} eventos.
          </p>
        </div>
        <div className="flex gap-1">
          {HORIZONS.map(h => (
            <button key={h.days} onClick={() => setHorizon(h.days)}
              className={`rounded-md px-3 py-1 text-sm ${horizon === h.days ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'}`}>
              {h.label}
            </button>
          ))}
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card title="Saldo real" value={eur(projection.start.balanceCents)} sub={`extrato até ${fmtDate(projection.start.date)} · ${accountId}`} />
        <Card title={`Saldo previsto a ${fmtDate(projection.end)}`} value={eur(endBalance)} sub="último saldo real + movimentos previstos" />
        <Card title="Saldo mais baixo previsto" value={eur(projection.lowest.balanceCents)} sub={fmtDate(projection.lowest.date)}
          tone={projection.lowest.balanceCents < 0 ? 'red' : undefined} />
      </section>

      {staleDays > 0 && (
        <p className="rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          Não há extrato depois de {fmtDate(projection.start.date)}: os movimentos previstos até ontem aparecem
          como <Badge tone="amber">sem extrato</Badge> e entram no saldo previsto. Importar o extrato de outubro substitui-os pelo real.
        </p>
      )}

      <PaymentDays state={s} today={today} />

      <section>
        <h2 className="mb-2 text-lg font-semibold">Próximos movimentos</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2">Dia</th>
                <th className="px-3 py-2">Movimento</th>
                <th className="px-3 py-2 text-right">Valor</th>
                <th className="px-3 py-2 text-right">Saldo previsto</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-800 bg-zinc-900/40">
                <td className="px-3 py-2 text-zinc-400">{fmtDay(projection.start.date)}</td>
                <td className="px-3 py-2 text-zinc-300">Saldo real (último extrato)</td>
                <td />
                <td className="px-3 py-2 text-right font-semibold">{eur(projection.start.balanceCents)}</td>
              </tr>
              {projection.days.map((d, di) => {
                const prevMonth = di > 0 ? monthOf(projection.days[di - 1].date) : monthOf(addDays(projection.start.date, 1));
                const monthEnd = projection.monthEnds.find(m => m.month === prevMonth);
                const newMonth = di > 0 && monthOf(d.date) !== prevMonth;
                return (
                  <Fragment key={d.date}>
                    {newMonth && monthEnd && (
                      <tr className="border-t border-zinc-700 bg-zinc-900">
                        <td colSpan={3} className="px-3 py-1.5 text-xs uppercase tracking-wider text-zinc-400">Fim de {fmtMonth(prevMonth)}</td>
                        <td className="px-3 py-1.5 text-right text-xs font-semibold text-zinc-300">{eur(monthEnd.balanceCents)}</td>
                      </tr>
                    )}
                    {d.items.map((i, ii) => (
                      <tr key={i.id} className={`border-t border-zinc-800/70 ${d.beforeToday ? 'opacity-60' : ''}`}>
                        <td className="px-3 py-1.5 align-top text-zinc-400 whitespace-nowrap">
                          {ii === 0 ? fmtDay(d.date) : ''}
                          {ii === 0 && d.date === today && <Badge tone="sky">hoje</Badge>}
                        </td>
                        <td className="px-3 py-1.5 align-top">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{i.label}</span>
                            <Badge>{PLAN_KIND_LABEL[i.kind]}</Badge>
                            <Badge tone={i.source === 'plano' ? 'zinc' : 'emerald'}>{SOURCE_LABEL[i.source]}</Badge>
                            {i.toConfirm && <Badge tone="amber">a confirmar</Badge>}
                            {d.beforeToday && <Badge tone="amber">sem extrato</Badge>}
                            {i.nominalDate !== i.date && <Badge title={`dia nominal: ${fmtDate(i.nominalDate)}`}>dia útil</Badge>}
                          </div>
                          <div className="text-xs text-zinc-500">{i.inputs}</div>
                        </td>
                        <td className={`px-3 py-1.5 text-right align-top whitespace-nowrap ${amountClass(i.amountCents)}`}>{eur(i.amountCents)}</td>
                        <td className="px-3 py-1.5 text-right align-top whitespace-nowrap">
                          {ii === d.items.length - 1 ? <span className={d.balanceCents < 0 ? 'text-red-300' : ''}>{eur(d.balanceCents)}</span> : ''}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Meses passados: saldo previsto vs real</h2>
        <p className="mb-2 text-sm text-zinc-400">
          Previsto = saldo real do fim do mês anterior + movimentos do plano no mês. A diferença explica-se linha a linha no ecrã
          Mês (abrir); o resumo de todos os meses está em Aceitação 2026.
          ✓ = há uma linha do banco com o mesmo valor a ±10 dias (só uma pista; a correspondência faz-se no Mês).
        </p>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2">Mês</th>
                <th className="px-3 py-2 text-right">Saldo inicial</th>
                <th className="px-3 py-2 text-right">Entradas previstas</th>
                <th className="px-3 py-2 text-right">Saídas previstas</th>
                <th className="px-3 py-2 text-right">Final previsto</th>
                <th className="px-3 py-2 text-right">Final real</th>
                <th className="px-3 py-2 text-right">Real − previsto</th>
                <th className="px-3 py-2 text-right">Pistas</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {checks.map(c => (
                <Fragment key={c.month}>
                  <tr className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/60" onClick={() => setOpenMonth(openMonth === c.month ? null : c.month)}>
                    <td className="px-3 py-1.5">{openMonth === c.month ? '▾' : '▸'} {fmtMonth(c.month)}</td>
                    <td className="px-3 py-1.5 text-right">{eur(c.openingCents)}</td>
                    <td className="px-3 py-1.5 text-right text-emerald-300">{eur(c.plannedInCents)}</td>
                    <td className="px-3 py-1.5 text-right text-red-300">{eur(c.plannedOutCents)}</td>
                    <td className="px-3 py-1.5 text-right">{eur(c.plannedEndCents)}</td>
                    <td className="px-3 py-1.5 text-right font-semibold">{eur(c.realEndCents)}</td>
                    <td className={`px-3 py-1.5 text-right ${amountClass(c.diffCents)}`}>{eur(c.diffCents)}</td>
                    <td className="px-3 py-1.5 text-right text-xs text-zinc-400">
                      {c.hints.filter(h => h.movementId).length}/{c.items.length} plano · {c.movements.length - c.unhintedMovementIds.length}/{c.movements.length} banco
                    </td>
                    <td className="px-3 py-1.5">
                      <Link to={`/v2/noisysource/mes/${c.month}`} onClick={e => e.stopPropagation()} className="text-sky-300 hover:underline">abrir</Link>
                    </td>
                  </tr>
                  {openMonth === c.month && <tr><td colSpan={9} className="bg-zinc-900/40 p-3"><MonthDetail check={c} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MonthDetail({ check }: { check: MonthCheck }) {
  const hinted = new Set(check.hints.filter(h => h.movementId).map(h => h.movementId!));
  const itemHint = new Map(check.hints.map(h => [h.itemId, h.movementId]));
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div>
        <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-zinc-400">Plano ({check.items.length})</h3>
        <ul className="space-y-0.5 text-xs">
          {check.items.map(i => (
            <li key={i.id} className="flex justify-between gap-2">
              <span className={itemHint.get(i.id) ? 'text-zinc-300' : 'text-amber-200'}>
                {itemHint.get(i.id) ? '✓' : '·'} {fmtDay(i.date)} — {i.label}{i.toConfirm ? ' (a confirmar)' : ''}
              </span>
              <span className={`whitespace-nowrap ${amountClass(i.amountCents)}`}>{eur(i.amountCents)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-zinc-400">Banco ({check.movements.length})</h3>
        <ul className="space-y-0.5 text-xs">
          {check.movements.map(m => (
            <li key={m.id} className="flex justify-between gap-2">
              <span className={hinted.has(m.id) ? 'text-zinc-300' : 'text-zinc-500'}>
                {hinted.has(m.id) ? '✓' : '·'} {fmtDay(m.date)} — {m.description}
              </span>
              <span className={`whitespace-nowrap ${amountClass(m.amountCents)}`}>{eur(m.amountCents)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** The payment days the plan uses: rules (pay, taxes, EC) and the fixed costs' days. */
function PaymentDays({ state, today }: { state: NsState; today: string }) {
  const rules = [...state.rules].sort((a, b) => a.monthOffset - b.monthOffset || a.day - b.day);
  const latestRules = rules.filter(r => !rules.some(o => o.what === r.what && o.from > r.from && o.from <= today));
  const costs = Object.values(costPlanVersions(state))
    .map(vs => vs.filter(v => v.from <= today).pop() ?? vs[0])
    .filter(v => !v.to || v.to >= today)
    .sort((a, b) => a.day - b.day);
  const ec = state.contracts[state.contracts.length - 1];
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4" open>
      <summary className="cursor-pointer text-lg font-semibold">
        Dias de pagamento <span className="text-sm font-normal text-zinc-400">(proposta tirada dos extratos de 2026; o Renato confirma)</span>
      </summary>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-zinc-400">Salários, impostos e faturas</h3>
          <ul className="space-y-1.5 text-sm">
            {latestRules.map(r => (
              <li key={r.eventId}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{r.label}</span>
                  <span className="text-zinc-300">
                    {r.what === 'ec-fatura'
                      ? `fatura ${r.day >= 28 ? 'no último dia' : `no dia ${r.day}`} do mês; recebimento ${ec ? `+${ec.daysToPayment} dias` : 'conforme o contrato'}`
                      : `dia ${r.day}${r.monthOffset === 1 ? ' do mês seguinte' : r.monthOffset > 1 ? ` (+${r.monthOffset} meses)` : ''}`}
                    {`; se não for dia útil: ${r.nonBusinessDay === 'before' ? 'dia útil anterior' : 'dia útil seguinte'}`}
                  </span>
                  {r.toConfirm ? <Badge tone="amber">a confirmar</Badge> : <Badge tone="emerald">confirmado</Badge>}
                </div>
                {r.evidence && <div className="text-xs text-zinc-500">{r.evidence}</div>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-zinc-400">Custos fixos</h3>
          <ul className="space-y-1 text-sm">
            {costs.map(c => (
              <li key={c.eventId} className="flex flex-wrap items-center gap-1.5">
                <span className="w-14 shrink-0 text-zinc-400">dia {c.day}</span>
                <span>{c.description}</span>
                <span className="text-xs text-zinc-500">
                  {c.frequency === 'monthly' ? 'mensal' : c.frequency === 'annual' ? (c.months ?? []).map(m => MONTH_NAMES[m - 1]).join(', ') : 'uma vez'}
                </span>
                {c.toConfirm && <Badge tone="amber">a confirmar</Badge>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}
