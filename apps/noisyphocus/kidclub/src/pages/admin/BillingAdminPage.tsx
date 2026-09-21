import React, { useState, useEffect, useMemo } from 'react';
import { getDocs, query, orderBy, Timestamp } from 'firebase/firestore';
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
};

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }
function fmtDate(ts?: Timestamp) { return ts ? ts.toDate().toLocaleDateString('pt-PT') : '—'; }
function fmtDateTime(ts?: Timestamp) {
  if (!ts) return '—';
  return ts.toDate().toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
}
function toIsoDate(d: Date) { return d.toISOString().split('T')[0]; }

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

// Read-only summary of a line item inside the expanded row detail. Editing
// now happens in DayExclusionModal, opened directly from the row via the
// "Dias" button — no need to expand the row first to reach it.
function LineItemRow({ lineItem }: { lineItem: BillingLineItem }) {
  const meta = lineItem.type ? SERVICE_META[lineItem.type] : null;
  return (
    <div className="py-1">
      <div className="flex justify-between text-xs text-gray-600">
        <span>{meta && <span className="mr-1">{meta.icon}</span>}{lineItem.title}</span>
        <span className="font-medium">
          {lineItem.excludedDates?.length ? <span className="text-gray-400 line-through mr-1.5">{fmtEur(lineItem.grossAmount ?? lineItem.amount)}</span> : null}
          {fmtEur(lineItem.amount)}
        </span>
      </div>
      {!!lineItem.excludedDates?.length && (
        <div className="flex items-center gap-1.5 flex-wrap mt-1 pl-2">
          {lineItem.excludedDates.map(d => (
            <span key={d} className="text-[11px] bg-amber-50 text-amber-800 border border-amber-200 rounded-full px-2 py-0.5">
              {formatExclusionEntry(d)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEK_HEADER = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

function monthGrid(year: number, month: number): (number | null)[] {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const ACCENT_CLASSES = {
  indigo: {
    header: 'bg-indigo-50 text-indigo-700 border-indigo-100',
    marked: 'bg-indigo-500 text-white font-semibold hover:bg-indigo-600',
    idle: 'bg-gray-50 text-gray-700 hover:bg-indigo-100 border border-gray-200',
    half: 'bg-indigo-500 text-white',
  },
  violet: {
    header: 'bg-violet-50 text-violet-700 border-violet-100',
    marked: 'bg-violet-500 text-white font-semibold hover:bg-violet-600',
    idle: 'bg-gray-50 text-gray-700 hover:bg-violet-100 border border-gray-200',
    half: 'bg-violet-500 text-white',
  },
};

// One line item's calendar. Transport days with two distinct trips (a
// morning pickup and an afternoon dropoff) render as a split cell so each
// leg can be excluded independently — e.g. a parent drives to a doctor's
// appointment in the morning but the child still rides home in the
// afternoon, and still attends study room as normal either way.
// True if an excludedDates entry falls on a weekday this line item actually
// has service scheduled — i.e. the calendar below has a clickable control
// for it. An entry can fail this (and become "orphaned") if it was marked
// before a schedule change, or via some other stale-data path — see billing.ts
// computeLineItems's carry-forward comment for how that can happen.
function isEntrySchedulable(li: BillingLineItem, entry: string): boolean {
  const [iso] = entry.split(':');
  const weekday = WEEKDAY_NAMES[new Date(`${iso}T12:00:00`).getDay()];
  if (li.type === 'transport') return (li.tripsByDay?.[weekday]?.length ?? 0) > 0;
  return (li.scheduleDays ?? []).includes(weekday);
}

function ServiceCalendar({ li, year, month, grid, markedSet, onToggle, saving }: {
  li: BillingLineItem;
  year: number; month: number;
  grid: (number | null)[];
  markedSet: Set<string>;
  onToggle: (entry: string) => void;
  saving: boolean;
}) {
  const meta = SERVICE_META[li.type!];
  const accent = ACCENT_CLASSES[meta.accent];
  const scheduleSet = new Set(li.scheduleDays ?? []);
  const orphanedEntries = [...markedSet].filter(entry => !isEntrySchedulable(li, entry)).sort();

  return (
    <div className={`rounded-lg border ${accent.header.split(' ').pop()} overflow-hidden`}>
      <div className={`flex items-baseline justify-between px-3 py-2 ${accent.header}`}>
        <p className="text-sm font-semibold flex items-center gap-1.5">{meta.icon} {meta.label}</p>
        <p className="text-xs opacity-80">{markedSet.size > 0 ? `${markedSet.size} marcado(s)` : 'nenhum dia marcado'}</p>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center p-3">
        {WEEK_HEADER.map(w => <div key={w} className="text-[10px] font-medium text-gray-400 py-1">{w}</div>)}
        {grid.map((day, i) => {
          if (day == null) return <div key={i} />;
          const iso = toIsoDate(new Date(year, month, day));
          const weekday = WEEKDAY_NAMES[new Date(year, month, day).getDay()];
          const trips = li.type === 'transport' ? (li.tripsByDay?.[weekday] ?? []) : (scheduleSet.has(weekday) ? ['both'] : []);
          const isSplit = trips.includes('pickup') && trips.includes('dropoff');
          const isSchedulable = trips.length > 0;

          if (!isSchedulable) {
            return <div key={i} className="aspect-square rounded-md text-xs flex items-center justify-center text-gray-300">{day}</div>;
          }

          if (isSplit) {
            const pickupMarked = markedSet.has(`${iso}:pickup`) || markedSet.has(iso);
            const dropoffMarked = markedSet.has(`${iso}:dropoff`) || markedSet.has(iso);
            return (
              <div key={i} className="aspect-square rounded-md overflow-hidden flex flex-col border border-gray-200" title={`${day} — manhã / tarde`}>
                <button type="button" disabled={saving} onClick={() => onToggle(`${iso}:pickup`)}
                  title="Viagem da manhã — clicar para marcar/desmarcar"
                  className={`flex-1 text-[9px] leading-none ${pickupMarked ? accent.half : 'bg-gray-50 hover:bg-gray-100 text-gray-500'}`}>
                  M
                </button>
                <button type="button" disabled={saving} onClick={() => onToggle(`${iso}:dropoff`)}
                  title="Viagem da tarde — clicar para marcar/desmarcar"
                  className={`flex-1 text-[9px] leading-none border-t border-white/40 ${dropoffMarked ? accent.half : 'bg-gray-50 hover:bg-gray-100 text-gray-500'}`}>
                  T
                </button>
                <span className="sr-only">{day}</span>
              </div>
            );
          }

          const isMarked = markedSet.has(iso);
          return (
            <button
              key={i}
              type="button"
              disabled={saving}
              onClick={() => onToggle(iso)}
              title={isMarked ? 'Marcado como sem serviço — clicar para desmarcar' : 'Marcar como sem serviço'}
              className={`aspect-square rounded-md text-xs flex items-center justify-center transition-colors ${isMarked ? accent.marked : accent.idle}`}
            >
              {day}
            </button>
          );
        })}
      </div>
      {orphanedEntries.length > 0 && (
        <div className="px-3 pb-3 -mt-1">
          <p className="text-[11px] text-amber-700 mb-1">
            Dias marcados fora do horário atual — sem controlo no calendário acima, remova aqui:
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {orphanedEntries.map(entry => (
              <button
                key={entry}
                type="button"
                disabled={saving}
                onClick={() => onToggle(entry)}
                title="Remover esta marcação órfã"
                className="text-[11px] bg-amber-50 text-amber-800 border border-amber-200 rounded-full pl-2 pr-1.5 py-0.5 flex items-center gap-1 hover:bg-amber-100 disabled:opacity-50"
              >
                {formatExclusionEntry(entry)}
                <span className="font-bold leading-none">×</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Calendar picker for marking "no service" days on one billing record. Every
// line item (study / transport) gets its own visually distinct calendar —
// indigo for study, violet for transport — since a family can have both, and
// they're billed and excluded completely independently: skipping the ride
// doesn't mean skipping study room, and vice versa. Changes are staged
// locally and sent in one call per line item on "Guardar", instead of
// round-tripping the server on every single click.
function DayExclusionModal({ record, onClose, onUpdated }: {
  record: BillingRecord;
  onClose: () => void;
  onUpdated: (recordId: string, lineItemIndex: number, patch: { amount: number; excludedDates?: string[] }, newTotal: number) => void;
}) {
  const editableItems = record.lineItems
    .map((li, index) => ({ li, index }))
    .filter(({ li }) => !!li.subscriptionId && (li.type === 'study' || li.type === 'transport'));

  const [staged, setStaged] = useState<Map<number, Set<string>>>(
    () => new Map(editableItems.map(({ li, index }) => [index, new Set(li.excludedDates ?? [])]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const year = record.periodStart.toDate().getFullYear();
  const month = record.periodStart.toDate().getMonth();
  const grid = monthGrid(year, month);

  const toggleEntry = (lineItemIndex: number, entry: string) => {
    setStaged(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(lineItemIndex));
      if (set.has(entry)) set.delete(entry); else set.add(entry);
      next.set(lineItemIndex, set);
      return next;
    });
  };

  const isChanged = (li: BillingLineItem, index: number) => {
    const original = new Set(li.excludedDates ?? []);
    const now = staged.get(index) ?? new Set();
    return original.size !== now.size || [...original].some(d => !now.has(d));
  };

  const hasChanges = editableItems.some(({ li, index }) => isChanged(li, index));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const fn = callable<{ billingId: string; subscriptionId: string; excludedDates: string[] }, { amount: number; total: number }>(
        'setBillingLineItemExcludedDays'
      );
      for (const { li, index } of editableItems) {
        if (!isChanged(li, index)) continue;
        const dates = [...(staged.get(index) ?? new Set())].sort();
        const res = await fn({ billingId: record.id, subscriptionId: li.subscriptionId!, excludedDates: dates });
        onUpdated(record.id, index, { amount: res.data.amount, excludedDates: dates.length ? dates : undefined }, res.data.total);
      }
      onClose();
    } catch (err: any) {
      setError(err.message ?? 'Falha ao guardar');
    } finally {
      setSaving(false);
    }
  };

  const monthName = record.periodStart.toDate().toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-gray-800">Dias sem serviço</h3>
            <p className="text-xs text-gray-400">{record.billingName} · <span className="capitalize">{monthName}</span></p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {editableItems.length === 0 && (
            <p className="text-sm text-gray-400">Este registo não tem parcelas editáveis.</p>
          )}
          {editableItems.map(({ li, index }) => (
            <ServiceCalendar
              key={index}
              li={li}
              year={year}
              month={month}
              grid={grid}
              markedSet={staged.get(index) ?? new Set()}
              onToggle={entry => toggleEntry(index, entry)}
              saving={saving}
            />
          ))}
          {editableItems.some(({ li }) => li.type === 'transport' && Object.values(li.tripsByDay ?? {}).some(t => t.includes('pickup') && t.includes('dropoff'))) && (
            <p className="text-[11px] text-gray-400">Dias de transporte com viagem de manhã e de tarde mostram duas metades — <strong>M</strong> (manhã) e <strong>T</strong> (tarde) — que pode marcar em separado.</p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-400">Cada serviço é independente — marcar um dia num não afeta o outro.</p>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} disabled={saving} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 disabled:opacity-50">Cancelar</button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="px-4 py-1.5 bg-amber-600 text-white text-sm font-medium rounded hover:bg-amber-700 disabled:opacity-50">
              {saving ? 'A guardar…' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MonthSection({ monthKey, records, expanded, onToggle, expandedId, onExpandRecord, sendingId, sendResult, onSendNotice, onOpenDayEditor }: {
  monthKey: string;
  records: BillingRecord[];
  expanded: boolean;
  onToggle: () => void;
  expandedId: string | null;
  onExpandRecord: (id: string) => void;
  sendingId: string | null;
  sendResult: Record<string, string>;
  onSendNotice: (r: BillingRecord) => void;
  onOpenDayEditor: (r: BillingRecord) => void;
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
                          onClick={() => onOpenDayEditor(r)}
                          className="px-3 py-1 bg-white border border-amber-300 text-amber-700 text-xs font-medium rounded hover:bg-amber-50 whitespace-nowrap">
                          📅 Dias
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
  const [dayEditorRecordId, setDayEditorRecordId] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState('pending');
  const [filterPeriod, setFilterPeriod] = useState('all');

  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

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

  const handleBackfill = async () => {
    if (!confirm('Gerar calendário de cobranças para todas as famílias com inscrições ativas?')) return;
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const fn = callable<object, { created: number; updated: number; skipped: number; cancelled: number; failed: number; families: number }>('backfillBillingSchedules');
      const res = await fn({});
      const { created, updated, skipped, cancelled, families } = res.data;
      const parts = [`${families} famílias`, `${created} criados`, `${updated} atualizados`, `${skipped} ignorados`];
      if (cancelled) parts.push(`${cancelled} cancelados`);
      setBackfillResult(`✅ ${parts.join(' · ')}`);
      await fetchRecords();
    } catch (err: any) {
      setBackfillResult(`❌ ${err.message}`);
    } finally {
      setBackfilling(false);
    }
  };

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

  const handleLineItemUpdated = (
    recordId: string,
    lineItemIndex: number,
    patch: { amount: number; excludedDates?: string[] },
    newTotal: number,
  ) => {
    setRecords(prev => prev.map(r => {
      if (r.id !== recordId) return r;
      const lineItems = [...r.lineItems];
      lineItems[lineItemIndex] = { ...lineItems[lineItemIndex], amount: patch.amount, excludedDates: patch.excludedDates };
      return { ...r, lineItems, total: newTotal };
    }));
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
      <h1 className="text-2xl font-bold text-gray-800">Cobranças</h1>

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

      {/* Backfill */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-700">Calendário de cobranças</p>
          <p className="text-xs text-gray-400">Gera automaticamente todos os registos de pagamento do ano letivo para inscrições ativas.</p>
        </div>
        <button onClick={handleBackfill} disabled={backfilling}
          className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded hover:bg-emerald-700 disabled:opacity-50 shrink-0">
          {backfilling ? 'A gerar...' : '📅 Gerar calendário'}
        </button>
        {backfillResult && <span className="text-sm text-gray-700 w-full">{backfillResult}</span>}
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
              onOpenDayEditor={r => setDayEditorRecordId(r.id)}
            />
          ))}
        </div>
      )}

      {dayEditorRecordId && (() => {
        const record = records.find(r => r.id === dayEditorRecordId);
        if (!record) return null;
        return (
          <DayExclusionModal
            record={record}
            onClose={() => setDayEditorRecordId(null)}
            onUpdated={handleLineItemUpdated}
          />
        );
      })()}
    </div>
  );
}
