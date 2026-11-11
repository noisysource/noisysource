import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { monthOf, monthsBetween } from '@shared/finhub/dates';
import { acceptanceReport, CRITERIA_TITLES } from '@shared/finhub/noisysource/acceptance';
import { useNs } from './NoisySourceModule';
import { amountClass, eur, fmtDate, fmtMonth } from './format';
import { CheckBadge } from './status';
import { Badge } from './ui';

/** The 2026 rebuild, month by month (HANDOFF-finhub-v2.md, § Acceptance 1–5). */
export default function AceitacaoPage() {
  const { state, today, accountId, rec } = useNs();
  const s = state!;
  const [open, setOpen] = useState<string | null>(null);

  const report = useMemo(() => {
    if (!rec || !accountId || !rec.lastLineDate || !s.movements.length) return null;
    const months = monthsBetween(monthOf(s.movements[0].date), monthOf(rec.lastLineDate));
    return acceptanceReport(s, { accountId, today, months, rec });
  }, [s, rec, accountId, today]);

  if (!report) return <p className="text-zinc-400">Sem extratos importados.</p>;
  const passing = report.months.filter(m => m.overall === 'ok').length;
  const withSuggestions = report.months.filter(m => m.overall === 'sugerido').length;

  return (
    <div className="max-w-6xl space-y-6">
      <header>
        <h1 className="text-xl font-bold">Aceitação — reconstrução de 2026</h1>
        <p className="text-sm text-zinc-400">
          O plano prevê o banco? Para cada mês com extrato: {passing} passa{passing === 1 ? '' : 'm'}, {withSuggestions} passa{withSuggestions === 1 ? '' : 'm'} quando as
          sugestões forem confirmadas, {report.months.length - passing - withSuggestions} não passa{report.months.length - passing - withSuggestions === 1 ? '' : 'm'}.
          Clica num mês para ver porquê; o ecrã Mês resolve.
        </p>
      </header>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h2 className="mb-2 text-lg font-semibold">Contratos EC: último dia previsto</h2>
        <ul className="space-y-1 text-sm">
          {report.chain.map(c => (
            <li key={c.contract} className="flex flex-wrap items-center gap-2">
              <CheckBadge status={c.pass ? 'ok' : 'falha'} />
              <span>Contrato {c.contract} (início {fmtDate(c.startDate)}): último dia {fmtDate(c.lastDay)}</span>
              <span className="text-zinc-400">— esperado {fmtDate(c.expected)} ({c.expectedWhy})</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2">Mês</th>
                {([1, 2, 3, 4, 5] as const).map(n => <th key={n} className="px-3 py-2" title={CRITERIA_TITLES[n]}>{n}. {CRITERIA_TITLES[n]}</th>)}
                <th className="px-3 py-2 text-right">Real − previsto</th>
                <th className="px-3 py-2">Mês</th>
              </tr>
            </thead>
            <tbody>
              {report.months.map(m => (
                <Fragment key={m.month}>
                  <tr className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/60" onClick={() => setOpen(open === m.month ? null : m.month)}>
                    <td className="whitespace-nowrap px-3 py-1.5">{open === m.month ? '▾' : '▸'} {fmtMonth(m.month)}</td>
                    {m.criteria.map(c => <td key={c.n} className="px-3 py-1.5"><CheckBadge status={c.status} title={c.summary} /></td>)}
                    <td className={`whitespace-nowrap px-3 py-1.5 text-right ${amountClass(m.recon.diffCents)}`}>{eur(m.recon.diffCents)}</td>
                    <td className="px-3 py-1.5"><Link to={`/v2/noisysource/mes/${m.month}`} onClick={e => e.stopPropagation()} className="text-sky-300 hover:underline">abrir</Link></td>
                  </tr>
                  {open === m.month && (
                    <tr>
                      <td colSpan={8} className="bg-zinc-900/40 px-4 py-3">
                        <ul className="space-y-2 text-sm">
                          {m.criteria.map(c => (
                            <li key={c.n}>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{c.n}. {CRITERIA_TITLES[c.n]}</span>
                                <CheckBadge status={c.status} />
                                <span className="text-zinc-400">{c.summary}</span>
                              </div>
                              {c.details.length > 0 && (
                                <ul className="ml-4 list-disc text-xs text-zinc-400">
                                  {c.details.map(d => <li key={d}>{d}</li>)}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          <Badge tone="emerald">passa</Badge> com o que já confirmaste · <Badge tone="sky">passa com sugestões</Badge> quando confirmares as
          sugestões do mês · <Badge tone="red">não passa</Badge> há linhas por explicar, previstos sem linha nem razão, recibos diferentes
          da estimativa ou dias EC diferentes. Critério 3: real − previsto tem de ficar todo em grupos com nome (ocasionais, diferenças de
          valor, pagos noutro mês, previstos com razão).
        </p>
      </section>
    </div>
  );
}
