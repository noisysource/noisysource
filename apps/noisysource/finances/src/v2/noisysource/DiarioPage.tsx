import { Fragment, useMemo, useState } from 'react';
import { CALENDAR_KIND_LABEL, NS_EVENT_TYPES, type NsEvent, type NsEventType } from '@shared/finhub/noisysource/events';
import { categoryLabel } from '@shared/finhub/noisysource/reconcile';
import { auth } from '../../lib/firebase';
import { useNs } from './NoisySourceModule';
import { eur, fmtDate, fmtMonth } from './format';
import { Badge } from './ui';

const TYPE_LABEL: Record<NsEventType, string> = {
  'ec.contract.signed': 'Contrato EC',
  'ec.contract.ended': 'Fim de contrato EC',
  'employment.terms.set': 'Termos de emprego',
  'employment.ended': 'Fim de emprego',
  'calendar.entry.set': 'Calendário',
  'holidays.set': 'Feriados',
  'payment.rule.set': 'Regra de pagamento',
  'cost.plan.set': 'Custo planeado',
  'ec.timesheet.submitted': 'Folha de horas',
  'ec.invoice.issued': 'Fatura EC',
  'payroll.payslip.recorded': 'Recibo de vencimento',
  'bank.movement.imported': 'Linha do banco',
  'bank.movement.matched': 'Linha ligada ao plano',
  'bank.movement.classified': 'Linha ocasional',
  'plan.item.explained': 'Razão de um previsto',
  reversal: 'Anulação',
};

const PAGE = 150;

/** Every event, newest first: who, when, what, and what was reversed (HANDOFF § Screens, Diário). */
export default function DiarioPage() {
  const { events } = useNs();
  const [type, setType] = useState<'' | NsEventType>('');
  const [who, setWho] = useState<'' | 'app' | 'importador'>('');
  const [month, setMonth] = useState('');
  const [text, setText] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const me = auth.currentUser?.uid;

  const reversedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (e.type === 'reversal' && e.reverses) m.set(e.reverses, e.id);
    return m;
  }, [events]);
  const lineText = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) if (e.type === 'bank.movement.imported') m.set(e.id, `${fmtDate(e.payload.date)} ${e.payload.description} ${eur(e.payload.amountCents)}`);
    return m;
  }, [events]);
  const months = useMemo(() => [...new Set(events.map(e => e.effectiveDate.slice(0, 7)))].sort().reverse(), [events]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of events) c.set(e.type, (c.get(e.type) ?? 0) + 1);
    return c;
  }, [events]);

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    return [...events]
      .filter(e => !type || e.type === type)
      .filter(e => !who || (who === 'importador') === e.recordedBy.startsWith('importer:'))
      .filter(e => !month || e.effectiveDate.startsWith(month))
      .filter(e => !q || `${e.id} ${e.note ?? ''} ${summary(e, lineText)} ${JSON.stringify(e.payload)}`.toLowerCase().includes(q))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
  }, [events, type, who, month, text, lineText]);

  const whoLabel = (e: NsEvent) => e.recordedBy.startsWith('importer:') ? 'importador' : e.recordedBy === me ? 'tu' : `${e.recordedBy.slice(0, 8)}…`;

  return (
    <div className="max-w-6xl space-y-4">
      <header>
        <h1 className="text-xl font-bold">Diário — NoisySource</h1>
        <p className="text-sm text-zinc-400">
          Tudo o que a NoisySource sabe, pela ordem em que ficou registado. Nada se apaga nem se altera: uma correção é uma anulação
          seguida de um evento novo. {events.length} eventos.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 text-sm">
        <select value={type} onChange={e => { setType(e.target.value as NsEventType | ''); setLimit(PAGE); }} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1">
          <option value="">Todos os tipos</option>
          {NS_EVENT_TYPES.filter(t => counts.has(t)).map(t => <option key={t} value={t}>{TYPE_LABEL[t]} ({counts.get(t)})</option>)}
        </select>
        <select value={who} onChange={e => { setWho(e.target.value as '' | 'app' | 'importador'); setLimit(PAGE); }} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1">
          <option value="">Registado por todos</option>
          <option value="app">Na app</option>
          <option value="importador">Pelo importador</option>
        </select>
        <select value={month} onChange={e => { setMonth(e.target.value); setLimit(PAGE); }} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1">
          <option value="">Qualquer data efetiva</option>
          {months.map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}
        </select>
        <input value={text} onChange={e => { setText(e.target.value); setLimit(PAGE); }} placeholder="procurar (id, descrição, valor…)"
          className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1" />
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-3 py-2">Registado</th>
              <th className="px-3 py-2">Por</th>
              <th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2">Data efetiva</th>
              <th className="px-3 py-2">O quê</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map(e => {
              const rev = reversedBy.get(e.id);
              return (
                <Fragment key={e.id}>
                  <tr className={`cursor-pointer border-t border-zinc-800/70 align-top hover:bg-zinc-900/60 ${rev ? 'opacity-60' : ''}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">{fmtStamp(e.recordedAt)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">{whoLabel(e)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">
                      <Badge tone={e.type === 'reversal' ? 'amber' : e.source === 'manual' ? 'sky' : 'zinc'}>{TYPE_LABEL[e.type]}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">{fmtDate(e.effectiveDate)}</td>
                    <td className="px-3 py-1.5">
                      <span className={rev ? 'line-through' : ''}>{summary(e, lineText)}</span>
                      {rev && <span className="ml-2 text-xs text-amber-300">anulado por {rev}</span>}
                      {e.note && <div className="text-xs text-zinc-500">{e.note}</div>}
                    </td>
                  </tr>
                  {open === e.id && (
                    <tr>
                      <td colSpan={5} className="bg-zinc-900/40 px-4 py-2">
                        <div className="mb-1 text-xs text-zinc-400">id <span className="font-mono">{e.id}</span> · origem {e.source} · registado {e.recordedAt} por {e.recordedBy}</div>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs text-zinc-300">{JSON.stringify(e.payload, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <button onClick={() => setLimit(limit + PAGE)} className="rounded-md bg-zinc-800 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700">
          Mostrar mais ({shown.length - limit} por mostrar)
        </button>
      )}
    </div>
  );
}

function fmtStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(d);
  const time = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit' }).format(d);
  return `${fmtDate(day)} ${time}`;
}

const days = (n: number) => `${n} dia${n === 1 ? '' : 's'}`;

function summary(e: NsEvent, lineText: Map<string, string>): string {
  switch (e.type) {
    case 'ec.contract.signed': return `Contrato ${e.payload.number} (${e.payload.client}): ${days(e.payload.totalDays)} × ${eur(e.payload.dailyRateCents)}, início ${fmtDate(e.payload.startDate)}`;
    case 'ec.contract.ended': return `Contrato ${e.payload.number} acaba a ${fmtDate(e.payload.lastDay)}${e.payload.reason ? `: ${e.payload.reason}` : ''}`;
    case 'employment.terms.set': return `${e.payload.personName}: termos desde ${fmtDate(e.payload.from)}, bruto ${eur(e.payload.grossMonthlyCents)}`;
    case 'employment.ended': return `${e.payload.personId}: último dia ${fmtDate(e.payload.lastDay)}`;
    case 'calendar.entry.set': return `${e.payload.personId}: ${CALENDAR_KIND_LABEL[e.payload.kind]}, ${days(e.payload.dates.length)} desde ${fmtDate([...e.payload.dates].sort()[0])}${e.payload.datesToConfirm ? ' (datas a confirmar)' : ''}`;
    case 'holidays.set': return `${e.payload.calendarId} ${e.payload.year}: ${e.payload.dates.length} feriados${e.payload.toConfirm ? ' (a confirmar)' : ''}`;
    case 'payment.rule.set': return `${e.payload.label}: dia ${e.payload.day}${e.payload.monthOffset ? ` do mês +${e.payload.monthOffset}` : ''}${e.payload.fee ? `, ${e.payload.fee.label} ${e.payload.fee.pct}% + IVA ${e.payload.fee.vatPct}%` : ''}`;
    case 'cost.plan.set': return `${e.payload.description}: ${e.payload.loan ? 'empréstimo' : eur(e.payload.amountCents)} (${e.payload.frequency === 'monthly' ? 'mensal' : e.payload.frequency === 'annual' ? 'anual' : 'uma vez'}) desde ${fmtDate(e.payload.from)}`;
    case 'ec.timesheet.submitted': return `Contrato ${e.payload.contractNumber}, ${fmtMonth(e.payload.month)}: ${days(e.payload.days)}`;
    case 'ec.invoice.issued': return `Fatura ${e.payload.invoiceNumber} (contrato ${e.payload.contractNumber}, ${fmtMonth(e.payload.month)}): ${eur(e.payload.amountCents)}`;
    case 'payroll.payslip.recorded': return `${e.payload.personId}, ${fmtMonth(e.payload.month)}: líquido ${eur(e.payload.netCents)}`;
    case 'bank.movement.imported': return `${e.payload.description} ${eur(e.payload.amountCents)}`;
    case 'bank.movement.matched': return `${lineText.get(e.payload.movementId) ?? e.payload.movementId} → ${e.payload.items.map(i => `${i.to} ${i.ref} ${i.month}`).join(' + ')}`;
    case 'bank.movement.classified': return `${lineText.get(e.payload.movementId) ?? e.payload.movementId} → ${categoryLabel(e.payload.category)}: ${e.payload.description}`;
    case 'plan.item.explained': return `${e.payload.itemId}: ${e.payload.reason}`;
    case 'reversal': return `Anula ${e.reverses}`;
  }
}
