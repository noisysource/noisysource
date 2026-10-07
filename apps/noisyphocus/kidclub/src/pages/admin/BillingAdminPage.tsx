import React, { useState, useEffect, useMemo } from 'react';
import { getDocs, query, orderBy, where, Timestamp } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { callable } from '../../lib/callable';
import { col } from '../../lib/db';
import { BillingRecord, BillingStatus, BillingPaymentMethod, BillingLineItem } from '@shared/models';

const STATUS_META: Record<BillingStatus, { label: string; className: string }> = {
  pending:    { label: 'Pendente',   className: 'bg-yellow-100 text-yellow-800' },
  processing: { label: 'Em curso',   className: 'bg-blue-100 text-blue-700' },
  paid:       { label: 'Pago',       className: 'bg-green-100 text-green-800' },
  invoiced:   { label: 'Faturado',   className: 'bg-purple-100 text-purple-800' },
  failed:     { label: 'Falhado',    className: 'bg-red-100 text-red-800' },
  cancelled:  { label: 'Cancelado',  className: 'bg-gray-100 text-gray-500' },
  'dry-run':  { label: 'Simulação',  className: 'bg-gray-100 text-gray-600' },
};

const METHOD_LABEL: Record<BillingPaymentMethod, string> = {
  mbway:        'MB WAY',
  multibanco:   'Multibanco',
  card:         'Cartão',
  subscription: 'Subscrição',
  bank_transfer: 'Transferência',
};

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }
function fmtDate(ts?: Timestamp) { return ts ? ts.toDate().toLocaleDateString('pt-PT') : '—'; }
function fmtDateTime(ts?: Timestamp) {
  if (!ts) return '—';
  return ts.toDate().toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
}
// Local calendar date, not toISOString()'s UTC one — a Date built from local
// year/month/day (as every call site here does) shifts to the previous day
// under toISOString() whenever the browser's timezone is ahead of UTC (e.g.
// Portugal in WEST/UTC+1), silently saving the wrong exclusion date.
function toIsoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthGroupKey(r: BillingRecord): string {
  return r.periodStart ? toIsoDate(r.periodStart.toDate()).slice(0, 7) : r.periodLabel;
}

function subtotals(records: BillingRecord[]) {
  const sum = (statuses: string[]) => records.filter(r => statuses.includes(r.status)).reduce((s, r) => s + r.total, 0);
  return {
    count: records.length,
    total: records.reduce((s, r) => s + r.total, 0),
    pending: sum(['pending']),
    processing: sum(['processing']),
    paid: sum(['paid', 'invoiced']),
  };
}

function formatExclusionEntry(entry: string): string {
  const [iso, direction] = entry.split(':');
  const dateLabel = new Date(`${iso}T12:00:00`).toLocaleDateString('pt-PT');
  if (direction === 'pickup') return `${dateLabel} (manhã)`;
  if (direction === 'dropoff') return `${dateLabel} (tarde)`;
  return dateLabel;
}

const SERVICE_META = {
  study:      { label: 'Sala de Estudo',       icon: '📚', accent: 'indigo' as const },
  transport:  { label: 'Transporte Escolar',   icon: '🚐', accent: 'violet' as const },
  enrollment: { label: 'Taxa de Inscrição e Seguro', icon: '🧾', accent: 'indigo' as const },
};

// Read-only summary of a line item, including the discount/absence
// breakdown — every step of the pipeline (multi-trip, sibling, school/
// returning-student, absence credit) is shown separately rather than
// collapsed into one opaque percentage, per the "visible and transparent to
// both sides" requirement. Marking a day absent now happens in
// ReservationEventModal (opened via the "Dias" button), which edits the
// same ReservationEvents the client calendar and absence threshold read.
function LineItemRow({ lineItem }: { lineItem: BillingLineItem }) {
  const meta = lineItem.type ? SERVICE_META[lineItem.type] : null;
  const hasBreakdown = !!(lineItem.multiTripDiscountAmount || lineItem.siblingDiscountAmount || lineItem.institutionalDiscountAmount || lineItem.absenceCreditAmount);
  return (
    <div className="py-1">
      <div className="flex justify-between text-xs text-gray-600">
        <span>{meta && <span className="mr-1">{meta.icon}</span>}{lineItem.title}</span>
        <span className="font-medium">
          {hasBreakdown ? <span className="text-gray-400 line-through mr-1.5">{fmtEur(lineItem.grossAmount ?? lineItem.amount)}</span> : null}
          {fmtEur(lineItem.amount)}
        </span>
      </div>
      {hasBreakdown && (
        <div className="mt-1 pl-2 space-y-0.5 text-[11px] text-gray-500">
          {!!lineItem.multiTripDiscountAmount && <p>Desconto multi-viagem (só a 2ª+ viagem/dia): −{fmtEur(lineItem.multiTripDiscountAmount)}</p>}
          {!!lineItem.siblingDiscountAmount && <p>Desconto de irmãos: −{fmtEur(lineItem.siblingDiscountAmount)}</p>}
          {!!lineItem.institutionalDiscountAmount && (
            <p>{lineItem.legacyPricing ? 'Tarifário antigo (descontos somados)' : 'Desconto escola/aluno repetente'}{lineItem.institutionalDiscountPct ? ` (${Math.round(lineItem.institutionalDiscountPct * 100)}%)` : ''}: −{fmtEur(lineItem.institutionalDiscountAmount)}</p>
          )}
        </div>
      )}
      {/* Absences are shown from absenceCount, NOT from absenceCreditDates.
          absenceCreditDates is only populated once the >=3 threshold is met
          (reconciliation.ts), so gating the whole block on it made 1 or 2
          recorded absences completely invisible here: a parent cancelled a day
          and staff had no way to tell that apart from "nothing was cancelled".
          The credit line below stays conditional — that part really is about
          money — but the count is always visible. */}
      {!!lineItem.absenceCount && (
        <div className="mt-1 pl-2">
          <p className="text-[11px] text-gray-500">
            {lineItem.absenceCreditDates?.length
              ? <>Crédito de {lineItem.absenceCount} falta{lineItem.absenceCount === 1 ? '' : 's'} (limite de 3 atingido este mês): −{fmtEur(lineItem.absenceCreditAmount ?? 0)}</>
              : <>{lineItem.absenceCount} falta{lineItem.absenceCount === 1 ? '' : 's'} registada{lineItem.absenceCount === 1 ? '' : 's'} — sem crédito (mínimo 3 por mês)</>}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            {(lineItem.absenceCreditDates ?? lineItem.absenceDates ?? []).map((d: string) => (
              <span key={d} className="text-[11px] bg-blue-50 text-blue-800 border border-blue-200 rounded-full px-2 py-0.5">
                {formatExclusionEntry(d)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ACCENT_CLASSES = {
  indigo: { header: 'bg-indigo-50 text-indigo-700 border-indigo-100', marked: 'bg-indigo-500 text-white font-semibold hover:bg-indigo-600', idle: 'bg-gray-50 text-gray-700 hover:bg-indigo-100 border border-gray-200' },
  violet: { header: 'bg-violet-50 text-violet-700 border-violet-100', marked: 'bg-violet-500 text-white font-semibold hover:bg-violet-600', idle: 'bg-gray-50 text-gray-700 hover:bg-violet-100 border border-gray-200' },
};

interface ReservationEventDoc {
  id: string;
  date: string;
  direction?: 'pickup' | 'dropoff' | 'both';
  status: 'EXPECTED' | 'CANCELLED' | 'VOIDED';
}

// One line item's calendar, built directly from its real ReservationEvent
// docs for the period — not from schedule metadata — so a single pickup-only
// or dropoff-only trip toggles correctly instead of assuming every
// non-split day is a bare, direction-less occurrence. Clicking a day flips
// that exact event's status immediately via setReservationEventStatus, the
// same call the client calendar uses — no local staging, no separate
// "save" step, since this is now just one more front-end onto the same
// facts the client and the absence threshold already read.
/**
 * The child's name out of a line-item title. billing.ts builds these as
 * "Sala de Estudo — Ana Teste (3ª, 5ª) — Outubro 2026", so the name is the
 * second segment with any schedule parenthetical dropped. Returns null rather
 * than guessing if the shape is not what we expect, and the caller falls back
 * to the service label.
 */
function childNameOf(li: BillingLineItem): string | null {
  const parts = (li.title ?? '').split(' — ');
  if (parts.length < 2) return null;
  const name = parts[1].replace(/\s*\(.*$/, '').trim();
  return name || null;
}

function ServiceCalendar({ li, events, onToggle, savingId, locked }: {
  li: BillingLineItem;
  events: ReservationEventDoc[];
  onToggle: (ev: ReservationEventDoc) => void;
  savingId: string | null;
  locked: boolean;
}) {
  const meta = SERVICE_META[li.type!];
  const accent = ACCENT_CLASSES[meta.accent];
  const byDate = new Map<string, ReservationEventDoc[]>();
  for (const ev of events) {
    if (ev.status === 'VOIDED') continue; // subscription ended before this date — nothing to toggle
    (byDate.get(ev.date) ?? byDate.set(ev.date, []).get(ev.date)!).push(ev);
  }
  const sortedDates = [...byDate.keys()].sort();
  const markedCount = events.filter(e => e.status === 'CANCELLED').length;

  return (
    <div className={`rounded-lg border ${accent.header.split(' ').pop()} overflow-hidden`}>
      <div className={`flex items-baseline justify-between px-3 py-2 ${accent.header}`}>
        {/* The child's name, not just the service. With several subscriptions
            in one record every calendar read "Sala de Estudo" / "Transporte"
            and there was no way to tell whose days you were about to change —
            on a screen whose whole purpose is changing them. */}
        <p className="text-sm font-semibold flex items-center gap-1.5">
          {meta.icon} {childNameOf(li) ?? meta.label}
          <span className="font-normal opacity-70">· {meta.label}</span>
        </p>
        <p className="text-xs opacity-80">{markedCount > 0 ? `${markedCount} marcado(s)` : 'nenhum dia marcado'}</p>
      </div>
      {sortedDates.length === 0 ? (
        <p className="text-xs text-gray-400 px-3 py-3">Sem ocorrências geradas para este período.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 p-3">
          {sortedDates.map(date => {
            const dayEvents = byDate.get(date)!;
            const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
            return (
              <div key={date} className="flex flex-col rounded-md overflow-hidden border border-gray-200 min-w-[3.25rem]">
                {dayEvents.map(ev => {
                  const isMarked = ev.status === 'CANCELLED';
                  const legLabel = ev.direction === 'pickup' ? ' (manhã)' : ev.direction === 'dropoff' ? ' (tarde)' : '';
                  return (
                    <button
                      key={ev.id}
                      type="button"
                      disabled={locked || savingId === ev.id}
                      onClick={() => onToggle(ev)}
                      title={`${dateLabel}${legLabel} — ${isMarked ? 'marcado como falta, clicar para restaurar' : 'clicar para marcar falta'}`}
                      className={`text-[11px] px-2 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isMarked ? accent.marked : accent.idle}`}
                    >
                      {dateLabel}{ev.direction === 'pickup' ? ' M' : ev.direction === 'dropoff' ? ' T' : ''}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Marking a day absent on the billing page — every service (study /
// transport) is fully independent, and each toggle writes straight to the
// same ReservationEvents the client calendar and the absence threshold
// read, via setReservationEventStatus (staff role, same callable parents
// use). No local staging: one click, one save, immediate feedback — the
// billing record itself then updates the next time onReservationEventBillingSync
// fires (a status change on any of these events triggers a recompute).
/**
 * The day editor, rendered INLINE in the expanded billing row rather than in a
 * modal. Marking a day is the most common thing done on this screen, and
 * behind a dialog it cost a click to open, a click to close, and a reload to
 * see the effect — while the line items it changes sat hidden underneath.
 * Inline, the calendar and the amount it moves are visible together.
 */
function DayEditor({ record, onRefreshNeeded }: {
  record: BillingRecord;
  onRefreshNeeded: () => void;
}) {
  const editableItems = record.lineItems
    .map((li, index) => ({ li, index }))
    .filter(({ li }) => !!li.subscriptionId && (li.type === 'study' || li.type === 'transport'));

  const [eventsBySub, setEventsBySub] = useState<Map<string, ReservationEventDoc[]> | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  // Paid / being paid / invoiced: the month is closed (the server refuses too).
  const locked = ['paid', 'invoiced', 'processing'].includes(record.status);
  const periodStart = toIsoDate(record.periodStart.toDate());
  const periodEnd = toIsoDate(record.periodEnd.toDate());

  useEffect(() => {
    const subIds = editableItems.map(({ li }) => li.subscriptionId!);
    if (!subIds.length) { setEventsBySub(new Map()); return; }
    (async () => {
      try {
        const snap = await getDocs(query(
          col('reservationEvents'),
          where('subscriptionId', 'in', subIds.slice(0, 30)),
          where('date', '>=', periodStart),
          where('date', '<=', periodEnd),
        ));
        const map = new Map<string, ReservationEventDoc[]>();
        snap.docs.forEach(d => {
          const data = d.data();
          const list = map.get(data.subscriptionId) ?? [];
          list.push({ id: d.id, date: data.date, direction: data.direction, status: data.status });
          map.set(data.subscriptionId, list);
        });
        setEventsBySub(map);
      } catch (err: any) {
        // Without this the modal sat on "A carregar…" forever and said
        // nothing — a failed query looked identical to a slow one.
        console.error('[DayExclusionModal] failed to load reservationEvents', err);
        setError(`Não foi possível carregar as ocorrências: ${err?.message ?? err}`);
        setEventsBySub(new Map());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id]);

  const handleToggle = async (ev: ReservationEventDoc) => {
    setSavingId(ev.id);
    setError(null);
    try {
      const fn = callable<{ eventId: string; status: 'EXPECTED' | 'CANCELLED' }, { ok: boolean }>('setReservationEventStatus');
      const nextStatus = ev.status === 'CANCELLED' ? 'EXPECTED' : 'CANCELLED';
      await fn({ eventId: ev.id, status: nextStatus });
      setEventsBySub(prev => {
        if (!prev) return prev;
        const next = new Map(prev);
        for (const [subId, list] of next) {
          next.set(subId, list.map(e => e.id === ev.id ? { ...e, status: nextStatus } : e));
        }
        return next;
      });
      setChanged(true);
    } catch (err: any) {
      setError(err.message ?? 'Falha ao guardar');
    } finally {
      setSavingId(null);
    }
  };

  const monthName = record.periodStart.toDate().toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });


  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/40 overflow-hidden">
      <div className="px-3 py-2 border-b border-amber-200/70 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-gray-800">📅 Dias sem serviço</h3>
        <span className="text-[11px] text-gray-500 capitalize">{monthName}</span>
      </div>
      <div className="px-3 py-3 space-y-3">
        {editableItems.length === 0 && (
          <p className="text-sm text-gray-400">
              Este registo não tem parcelas de sala de estudo nem de transporte — só taxas
              (inscrição/seguro), que não têm dias para marcar.
            </p>
          )}
          {eventsBySub !== null && editableItems.length > 0 && (
            <p className="text-[11px] text-gray-400">
              {editableItems.map(({ li }) =>
                `${li.type === 'study' ? 'Estudo' : 'Transporte'}: ${(eventsBySub.get(li.subscriptionId!) ?? []).length} ocorrência(s)`
              ).join(' · ')}
            </p>
          )}
          {eventsBySub === null ? (
            <p className="text-sm text-gray-400">A carregar…</p>
          ) : editableItems.map(({ li, index }) => (
            <ServiceCalendar
              key={index}
              li={li}
              events={eventsBySub.get(li.subscriptionId!) ?? []}
              onToggle={handleToggle}
              savingId={savingId}
              locked={locked}
            />
          ))}
        {locked && <p className="text-xs text-gray-600">Este mês já está pago — os dias não podem ser alterados.</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-[11px] text-gray-500">
            Cada serviço é independente e visível para a família de imediato. O valor da fatura
            demora alguns segundos a recalcular.
          </p>
          {changed && (
            <button onClick={onRefreshNeeded}
              className="px-3 py-1 bg-gray-700 text-white text-xs font-medium rounded hover:bg-gray-800 shrink-0">
              Atualizar valores
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MonthSection({ monthKey, records, expanded, onToggle, expandedId, onExpandRecord, sendingId, sendResult, onSendNotice, onRefreshNeeded }: {
  monthKey: string;
  records: BillingRecord[];
  expanded: boolean;
  onToggle: () => void;
  expandedId: string | null;
  onExpandRecord: (id: string) => void;
  sendingId: string | null;
  sendResult: Record<string, string>;
  onSendNotice: (r: BillingRecord) => void;
  onRefreshNeeded: () => void;
}) {
  const sub = subtotals(records);
  const label = records[0]?.periodLabel ?? monthKey;

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-4 px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left">
        <div className="flex items-center gap-3">
          <span className={`transition-transform text-gray-400 text-xs ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span className="font-semibold text-gray-800 capitalize">{label}</span>
          <span className="text-xs text-gray-400">{sub.count} registo(s)</span>
        </div>
        <div className="flex items-center gap-3 text-xs flex-wrap justify-end">
          {sub.pending > 0 && <span className="text-yellow-700 font-medium">{fmtEur(sub.pending)} por pagar</span>}
          {sub.processing > 0 && <span className="text-blue-700 font-medium">{fmtEur(sub.processing)} em curso</span>}
          {sub.paid > 0 && <span className="text-green-700 font-medium">{fmtEur(sub.paid)} recebido</span>}
          <span className="font-semibold text-gray-800">{fmtEur(sub.total)} total</span>
        </div>
      </button>

      {expanded && (
        <table className="w-full text-sm">
          <thead className="bg-gray-50/60 border-t border-b border-gray-100">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Família</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Método</th>
              <th className="text-right px-4 py-2 font-medium text-gray-500 text-xs">Total</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Vencimento</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Estado</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {records.map(r => (
              <React.Fragment key={r.id}>
                <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => onExpandRecord(r.id)}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-gray-800">{r.billingName}</p>
                    <p className="text-xs text-gray-400">{r.billingEmail}</p>
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">{METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-gray-800">{fmtEur(r.total)}</td>
                  <td className="px-4 py-2.5 text-gray-600">{fmtDate(r.dueDate)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_META[r.status]?.className ?? 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_META[r.status]?.label ?? r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-2 flex-wrap">
                      {r.status === 'pending' && r.lineItems?.some(li => li.subscriptionId && (li.type === 'study' || li.type === 'transport')) && (
                        <button
                          onClick={() => onExpandRecord(r.id)}
                          className="px-3 py-1 bg-white border border-amber-300 text-amber-700 text-xs font-medium rounded hover:bg-amber-50 whitespace-nowrap">
                          {expandedId === r.id ? '📅 Fechar dias' : '📅 Dias'}
                        </button>
                      )}
                      {['pending', 'failed'].includes(r.status) && (
                        <button
                          onClick={() => onSendNotice(r)}
                          disabled={sendingId === r.id}
                          className="px-3 py-1 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap">
                          {sendingId === r.id ? 'A enviar...' : 'Enviar aviso'}
                        </button>
                      )}
                      {sendResult[r.id] && <span className="text-xs text-gray-600">{sendResult[r.id]}</span>}
                    </div>
                  </td>
                </tr>
                {expandedId === r.id && (
                  <tr>
                    <td colSpan={6} className="px-6 py-3 bg-gray-50 border-t border-gray-100 space-y-1">
                      {r.lineItems?.map((li, i) => (
                        <LineItemRow key={i} lineItem={li} />
                      ))}
                      {r.multibancoEntity && (
                        <p className="text-xs text-gray-500 mt-1">Multibanco: Entidade <strong>{r.multibancoEntity}</strong> · Referência <strong>{r.multibancoReference}</strong></p>
                      )}
                      {r.noticeSentAt && (
                        <p className="text-xs text-indigo-600 mt-1">Aviso enviado em {fmtDateTime(r.noticeSentAt)}</p>
                      )}
                      {r.paidAt && <p className="text-xs text-green-700 mt-1">Pago em {fmtDate(r.paidAt)}</p>}
                      {r.invoiceNumber && <p className="text-xs text-purple-700 mt-1">Fatura: {r.invoiceNumber}</p>}
                      {/* Only a pending record is editable. An invoiced one backs
                          an issued fiscal document and is frozen (decision 5). */}
                      {r.status === 'pending' && r.lineItems?.some(li => li.subscriptionId && (li.type === 'study' || li.type === 'transport')) && (
                        <DayEditor record={r} onRefreshNeeded={onRefreshNeeded} />
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function BillingAdminPage() {
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<Record<string, string>>({});
  const [expandedMonths, setExpandedMonths] = useState<Set<string> | null>(null);

  const [filterStatus, setFilterStatus] = useState('pending');
  const [filterPeriod, setFilterPeriod] = useState('all');

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(query(col('billing'), orderBy('createdAt', 'desc')));
      setRecords(snap.docs.map(d => ({ id: d.id, ...d.data() } as BillingRecord)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchRecords(); }, []);

  const handleSendNotice = async (record: BillingRecord) => {
    if (!confirm(`Enviar aviso de pagamento a ${record.billingName} (${record.billingEmail}) — ${record.periodLabel}?`)) return;
    setSendingId(record.id!);
    try {
      const fn = callable<object, { ok: boolean }>('sendBillingNotice');
      await fn({ billingId: record.id });
      setSendResult(prev => ({ ...prev, [record.id!]: '✅ Enviado' }));
      await fetchRecords();
    } catch (err: any) {
      setSendResult(prev => ({ ...prev, [record.id!]: `❌ ${err.message}` }));
    } finally {
      setSendingId(null);
    }
  };

  const periods = [...new Set(records.map(r => r.periodLabel))].sort().reverse();

  const filtered = records.filter(r => {
    if (filterStatus !== 'all' && r.status !== filterStatus) return false;
    if (filterPeriod !== 'all' && r.periodLabel !== filterPeriod) return false;
    return true;
  });

  const uniqueFamilies = (statuses: string[]) =>
    new Set(records.filter(r => statuses.includes(r.status)).map(r => r.familyId)).size;

  const totals = {
    pending: records.filter(r => r.status === 'pending').reduce((s, r) => s + r.total, 0),
    paid: records.filter(r => ['paid', 'invoiced'].includes(r.status)).reduce((s, r) => s + r.total, 0),
    processing: records.filter(r => r.status === 'processing').reduce((s, r) => s + r.total, 0),
  };

  // Chronological (soonest month first) — this is a forward-looking billing
  // schedule spanning the rest of the school year, so "what's coming up" is
  // the useful default rather than "most recently created."
  const grouped = useMemo(() => {
    const map = new Map<string, BillingRecord[]>();
    for (const r of filtered) {
      const key = monthGroupKey(r);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  // Default: expand only the earliest month with something to show. Once the
  // admin has toggled anything, respect their choices instead.
  const isExpanded = (key: string, idx: number) => {
    if (expandedMonths) return expandedMonths.has(key);
    return idx === 0;
  };
  const toggleMonth = (key: string) => {
    setExpandedMonths(prev => {
      const next = new Set(prev ?? grouped.map(([k], i) => (i === 0 ? k : null)).filter((k): k is string => !!k));
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-gray-800">Cobranças</h1>
        <Link to="/admin/data-management" className="text-xs text-gray-400 hover:text-gray-600 hover:underline">
          Recalcular tudo / gerar ocorrências → Gestão de Dados
        </Link>
      </div>

      {/* Summary — grand total across the whole generated schedule */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm font-medium text-yellow-700">Por pagar (até final do ano letivo)</p>
          <p className="text-2xl font-bold text-yellow-800">{fmtEur(totals.pending)}</p>
          <p className="text-xs text-yellow-600">{uniqueFamilies(['pending'])} família(s)</p>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm font-medium text-blue-700">Em processamento</p>
          <p className="text-2xl font-bold text-blue-800">{fmtEur(totals.processing)}</p>
          <p className="text-xs text-blue-600">{uniqueFamilies(['processing'])} família(s)</p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-sm font-medium text-green-700">Recebido</p>
          <p className="text-2xl font-bold text-green-800">{fmtEur(totals.paid)}</p>
          <p className="text-xs text-green-600">{uniqueFamilies(['paid', 'invoiced'])} família(s)</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)} className="border rounded px-3 py-2 text-sm">
          <option value="all">Todos os períodos</option>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border rounded px-3 py-2 text-sm">
          <option value="all">Todos os estados</option>
          {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <span className="text-sm text-gray-400">{filtered.length} resultado(s)</span>
      </div>

      {/* Months */}
      {loading ? (
        <p className="text-sm text-gray-400">A carregar...</p>
      ) : grouped.length === 0 ? (
        <p className="text-sm text-gray-400">Nenhum registo encontrado.</p>
      ) : (
        <div className="space-y-3">
          {grouped.map(([key, monthRecords], idx) => (
            <MonthSection
              key={key}
              monthKey={key}
              records={monthRecords}
              expanded={isExpanded(key, idx)}
              onToggle={() => toggleMonth(key)}
              expandedId={expandedId}
              onExpandRecord={id => setExpandedId(expandedId === id ? null : id)}
              sendingId={sendingId}
              sendResult={sendResult}
              onSendNotice={handleSendNotice}
              onRefreshNeeded={fetchRecords}
            />
          ))}
        </div>
      )}

    </div>
  );
}
