import { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, query, orderBy, Timestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../../lib/firebase';

interface AdminInvoice {
  id: string;
  familyId: string;
  invoiceNumber?: string;
  status: 'pending' | 'paid' | 'error' | 'overdue';
  periodLabel: string;
  periodStart: Timestamp;
  dueDate?: Timestamp;
  paidDate?: Timestamp;
  total: number;
  subtotal: number;
  billingName: string;
  billingEmail: string;
  lineItems: { title: string; amount: number }[];
  vendusId?: number;
  vendusError?: string;
  createdAt?: Timestamp;
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending:  { label: 'Pendente',  className: 'bg-yellow-100 text-yellow-800' },
  paid:     { label: 'Pago',      className: 'bg-green-100 text-green-800' },
  overdue:  { label: 'Vencido',   className: 'bg-red-100 text-red-800' },
  error:    { label: 'Erro',      className: 'bg-red-200 text-red-900' },
  'dry-run':{ label: 'Simulação', className: 'bg-blue-100 text-blue-700' },
};

function fmtDate(ts?: Timestamp) {
  if (!ts) return '—';
  return ts.toDate().toLocaleDateString('pt-PT');
}

function fmtEur(n: number) {
  return `€${n.toFixed(2)}`;
}

export default function InvoicesAdminPage() {
  const [invoices, setInvoices] = useState<AdminInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);

  const now = new Date();
  const [genYear, setGenYear] = useState(now.getFullYear());
  const [genMonth, setGenMonth] = useState(now.getMonth() + 1);
  const [dryRun, setDryRun] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterPeriod, setFilterPeriod] = useState<string>('all');
  const [genResult, setGenResult] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchInvoices = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(query(collection(db, 'invoices'), orderBy('createdAt', 'desc')));
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as AdminInvoice));
      setInvoices(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchInvoices(); }, []);

  const handleGenerate = async () => {
    const modeLabel = dryRun ? 'SIMULAÇÃO (sem emissão real)' : 'REAL (emite faturas em Vendus)';
    if (!confirm(`Gerar faturas para ${String(genMonth).padStart(2, '0')}/${genYear} — ${modeLabel}?`)) return;
    setGenerating(true);
    setGenResult(null);
    try {
      const fn = httpsCallable(getFunctions(undefined, 'europe-west3'), 'triggerInvoiceGeneration');
      const res = await fn({ year: genYear, month: genMonth, dryRun }) as { data: { generated: number; failed: number; period: string } };
      const { generated, failed, period } = res.data;
      const mode = dryRun ? ' (simulação)' : '';
      setGenResult(`✅ ${period}${mode}: ${generated} fatura(s) gerada(s)${failed ? `, ${failed} erro(s)` : ''}.`);
      await fetchInvoices();
    } catch (err: any) {
      setGenResult(`❌ Erro: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleMarkPaid = async (invoice: AdminInvoice) => {
    if (!confirm(`Marcar fatura ${invoice.invoiceNumber ?? invoice.id} como paga?`)) return;
    setMarkingPaid(invoice.id);
    try {
      await updateDoc(doc(db, 'invoices', invoice.id), {
        status: 'paid',
        paidDate: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      setInvoices(prev => prev.map(i => i.id === invoice.id
        ? { ...i, status: 'paid', paidDate: Timestamp.now() }
        : i
      ));
    } finally {
      setMarkingPaid(null);
    }
  };

  const periods = [...new Set(invoices.map(i => i.periodLabel))].sort().reverse();

  const filtered = invoices.filter(i => {
    if (filterStatus !== 'all' && i.status !== filterStatus) return false;
    if (filterPeriod !== 'all' && i.periodLabel !== filterPeriod) return false;
    return true;
  });

  const totalPending = invoices.filter(i => i.status === 'pending').reduce((s, i) => s + i.total, 0);
  const totalPaid = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + i.total, 0);
  const countError = invoices.filter(i => i.status === 'error').length;

  const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">Faturas</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm text-yellow-700 font-medium">Pendentes</p>
          <p className="text-2xl font-bold text-yellow-800">{fmtEur(totalPending)}</p>
          <p className="text-xs text-yellow-600">{invoices.filter(i => i.status === 'pending').length} faturas</p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-sm text-green-700 font-medium">Pagas</p>
          <p className="text-2xl font-bold text-green-800">{fmtEur(totalPaid)}</p>
          <p className="text-xs text-green-600">{invoices.filter(i => i.status === 'paid').length} faturas</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-700 font-medium">Erros</p>
          <p className="text-2xl font-bold text-red-800">{countError}</p>
          <p className="text-xs text-red-600">faturas com erro de emissão</p>
        </div>
      </div>

      {/* Generate panel */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <h2 className="font-semibold text-gray-700">Gerar Faturas</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={genMonth}
            onChange={e => setGenMonth(Number(e.target.value))}
            className="border rounded px-3 py-2 text-sm"
          >
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <input
            type="number"
            value={genYear}
            onChange={e => setGenYear(Number(e.target.value))}
            className="border rounded px-3 py-2 text-sm w-24"
            min={2024}
            max={2030}
          />
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={e => setDryRun(e.target.checked)}
              className="w-4 h-4"
            />
            <span className={dryRun ? 'text-blue-700 font-medium' : 'text-gray-500'}>
              Simulação (sem emissão real)
            </span>
          </label>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className={`px-4 py-2 rounded text-sm font-medium disabled:opacity-50 text-white ${dryRun ? 'bg-blue-600 hover:bg-blue-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
          >
            {generating ? 'A gerar...' : dryRun ? 'Simular' : 'Gerar Faturas'}
          </button>
          {genResult && <span className="text-sm text-gray-700">{genResult}</span>}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select
          value={filterPeriod}
          onChange={e => setFilterPeriod(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
        >
          <option value="all">Todos os períodos</option>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
        >
          <option value="all">Todos os estados</option>
          <option value="pending">Pendente</option>
          <option value="paid">Pago</option>
          <option value="overdue">Vencido</option>
          <option value="error">Erro</option>
        </select>
        <span className="text-sm text-gray-500 self-center">{filtered.length} resultado(s)</span>
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-gray-500 text-sm">A carregar...</p>
      ) : filtered.length === 0 ? (
        <p className="text-gray-500 text-sm">Nenhuma fatura encontrada.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Fatura</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Família</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Período</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Total</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Vencimento</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Estado</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(inv => (
                <>
                  <tr
                    key={inv.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      {inv.invoiceNumber ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{inv.billingName}</p>
                      <p className="text-xs text-gray-400">{inv.billingEmail}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{inv.periodLabel}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmtEur(inv.total)}</td>
                    <td className="px-4 py-3 text-gray-600">{fmtDate(inv.dueDate)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_LABELS[inv.status]?.className ?? 'bg-gray-100 text-gray-600'}`}>
                        {STATUS_LABELS[inv.status]?.label ?? inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      {inv.status !== 'paid' && (
                        <button
                          onClick={() => handleMarkPaid(inv)}
                          disabled={markingPaid === inv.id}
                          className="text-xs bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50"
                        >
                          {markingPaid === inv.id ? '...' : 'Marcar pago'}
                        </button>
                      )}
                      {inv.status === 'paid' && inv.paidDate && (
                        <span className="text-xs text-gray-400">Pago em {fmtDate(inv.paidDate)}</span>
                      )}
                    </td>
                  </tr>
                  {expandedId === inv.id && (
                    <tr key={`${inv.id}-detail`}>
                      <td colSpan={7} className="px-6 py-3 bg-gray-50 border-t border-gray-100">
                        <div className="space-y-1">
                          {inv.lineItems?.map((item, i) => (
                            <div key={i} className="flex justify-between text-xs text-gray-600">
                              <span>{item.title}</span>
                              <span className="font-medium">{fmtEur(item.amount)}</span>
                            </div>
                          ))}
                          {inv.vendusError && (
                            <p className="text-xs text-red-600 mt-2">Erro Vendus: {inv.vendusError}</p>
                          )}
                          {inv.vendusId && (
                            <p className="text-xs text-gray-400 mt-1">Vendus ID: {inv.vendusId}</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
