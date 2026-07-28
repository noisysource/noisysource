import React, { useState, useEffect } from 'react';
import { getDocs, query, orderBy, Timestamp } from 'firebase/firestore';
import { callable } from '../../lib/callable';
import { col } from '../../lib/db';
import { BillingRecord, BillingStatus, BillingPaymentMethod } from '@shared/models';

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

export default function BillingAdminPage() {
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<Record<string, string>>({});

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
      const fn = callable<object, { created: number; updated: number; skipped: number; failed: number; families: number }>('backfillBillingSchedules');
      const res = await fn({});
      const { created, updated, skipped, families } = res.data;
      setBackfillResult(`✅ ${families} famílias · ${created} criados · ${updated} atualizados · ${skipped} ignorados`);
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

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Cobranças</h1>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm font-medium text-yellow-700">Por pagar</p>
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

      {/* Table */}
      {loading ? (
        <p className="text-sm text-gray-400">A carregar...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-400">Nenhum registo encontrado.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Família</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Período</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Método</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Total</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Vencimento</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Estado</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(r => (
                <React.Fragment key={r.id}>
                  <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{r.billingName}</p>
                      <p className="text-xs text-gray-400">{r.billingEmail}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.periodLabel}</td>
                    <td className="px-4 py-3 text-gray-600">{METHOD_LABEL[r.paymentMethod] ?? r.paymentMethod}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmtEur(r.total)}</td>
                    <td className="px-4 py-3 text-gray-600">{fmtDate(r.dueDate)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_META[r.status]?.className ?? 'bg-gray-100 text-gray-600'}`}>
                        {STATUS_META[r.status]?.label ?? r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      {['pending', 'failed'].includes(r.status) && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleSendNotice(r)}
                            disabled={sendingId === r.id}
                            className="px-3 py-1 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap">
                            {sendingId === r.id ? 'A enviar...' : 'Enviar aviso'}
                          </button>
                          {sendResult[r.id!] && (
                            <span className="text-xs text-gray-600">{sendResult[r.id!]}</span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr>
                      <td colSpan={7} className="px-6 py-3 bg-gray-50 border-t border-gray-100 space-y-1">
                        {r.lineItems?.map((li, i) => (
                          <div key={i} className="flex justify-between text-xs text-gray-600">
                            <span>{li.title}</span>
                            <span className="font-medium">{fmtEur(li.amount)}</span>
                          </div>
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
        </div>
      )}
    </div>
  );
}
