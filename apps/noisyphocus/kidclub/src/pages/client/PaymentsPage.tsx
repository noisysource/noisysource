import { useState, useEffect, useMemo } from 'react';
import { query, where, getDocs } from 'firebase/firestore';
import { callable } from '../../lib/callable';
import { col } from '../../lib/db';
import { useUser } from '@shared/hooks';
import { BillingRecord } from '@shared/models';
import { useImpersonation } from '../../contexts/ImpersonationContext';

type FilterTab = 'pending' | 'overdue' | 'history';

const STATUS_META: Record<string, { label: string; className: string; icon: string }> = {
  pending:    { label: 'Por pagar',             className: 'bg-yellow-50 border-yellow-200 text-yellow-800', icon: '⏳' },
  processing: { label: 'A aguardar pagamento',  className: 'bg-blue-50 border-blue-200 text-blue-800',   icon: '🔄' },
  paid:       { label: 'Pago',                  className: 'bg-green-50 border-green-200 text-green-800',    icon: '✅' },
  invoiced:   { label: 'Faturado',              className: 'bg-purple-50 border-purple-200 text-purple-800', icon: '🧾' },
  failed:     { label: 'Falhado',               className: 'bg-red-50 border-red-200 text-red-800',          icon: '❌' },
};

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }

function isOverdue(record: BillingRecord) {
  if (!['pending', 'processing', 'failed'].includes(record.status)) return false;
  const due = record.dueDate?.toDate?.();
  return due ? due < new Date() : false;
}

export default function PaymentsPage() {
  const user = useUser();
  const { impersonation } = useImpersonation();
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<FilterTab>('pending');

  // Single-item payment panel
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mbwayPhone, setMbwayPhone] = useState('');
  const [acting, setActing] = useState(false);
  const [actionResult, setActionResult] = useState<Record<string, string>>({});

  // Multi-select
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchPanel, setBatchPanel] = useState(false);
  const [batchMethod, setBatchMethod] = useState<'mbway' | 'multibanco' | 'card' | null>(null);
  const [batchPhone, setBatchPhone] = useState('');
  const [batchActing, setBatchActing] = useState(false);
  const [batchResults, setBatchResults] = useState<{ id: string; ok: boolean; msg: string }[]>([]);
  const [mbwayPhoneError, setMbwayPhoneError] = useState('');
  const [batchPhoneError, setBatchPhoneError] = useState('');

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      try {
        // When admin is impersonating, the real signed-in uid is the admin's, not the
        // family's — query by familyId instead, mirroring familyService's impersonation handling.
        const snap = await getDocs(
          impersonation
            ? query(col('billing'), where('familyId', '==', impersonation.familyId))
            : query(col('billing'), where('userId', '==', user.uid))
        );
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() } as BillingRecord))
          .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        setRecords(data);
      } catch (err) {
        console.error('[PaymentsPage] query failed:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [user, impersonation]);

  const { pending, overdue, history } = useMemo(() => {
    const actionable = records.filter(r => ['pending', 'processing', 'failed'].includes(r.status));
    return {
      overdue:  actionable.filter(r => isOverdue(r)),
      pending:  actionable.filter(r => !isOverdue(r)),
      history:  records.filter(r => ['paid', 'invoiced'].includes(r.status)),
    };
  }, [records]);

  const tabRecords = activeTab === 'overdue' ? overdue : activeTab === 'history' ? history : pending;

  // Payment handlers
  const payMbway = async (record: BillingRecord, phone: string) => {
    await callable('initiateMbwayPayment')({ billingId: record.id, phone: phone.trim() });
    setRecords(prev => prev.map(r => r.id === record.id ? { ...r, status: 'processing' } : r));
    return 'A notificação MB WAY foi enviada. Confirme na app MB WAY.';
  };

  const payMultibanco = async (record: BillingRecord) => {
    const res = await callable<object, { entity: string; reference: string }>('initiateMultibancoPayment')({ billingId: record.id });
    const { entity, reference } = res.data;
    setRecords(prev => prev.map(r => r.id === record.id
      ? { ...r, status: 'processing', multibancoEntity: entity, multibancoReference: reference } : r));
    return `Multibanco — Entidade: ${entity} · Referência: ${reference}`;
  };

  const payCard = async (record: BillingRecord) => {
    const res = await callable<object, { paymentLink: string }>('initiateCardPayment')({ billingId: record.id });
    window.open(res.data.paymentLink, '_blank');
    setRecords(prev => prev.map(r => r.id === record.id ? { ...r, status: 'processing' } : r));
    return 'Redirecionado para pagamento por cartão.';
  };

  const handleSinglePay = async (record: BillingRecord, method: 'mbway' | 'multibanco' | 'card') => {
    if (method === 'mbway' && !mbwayPhone.trim()) { setMbwayPhoneError('Introduza o número de telemóvel MB WAY.'); return; }
    setMbwayPhoneError('');
    setActing(true);
    try {
      let msg = '';
      if (method === 'mbway') msg = await payMbway(record, mbwayPhone);
      else if (method === 'multibanco') msg = await payMultibanco(record);
      else msg = await payCard(record);
      setActionResult(prev => ({ ...prev, [record.id]: msg }));
      setActiveId(null);
    } catch (err: any) {
      setActionResult(prev => ({ ...prev, [record.id]: `Erro: ${err.message}` }));
    } finally {
      setActing(false);
    }
  };

  const handleBatchPay = async () => {
    if (!batchMethod) return;
    if (batchMethod === 'mbway' && !batchPhone.trim()) { setBatchPhoneError('Introduza o número de telemóvel MB WAY.'); return; }
    setBatchPhoneError('');

    const targets = records.filter(r => selected.has(r.id) && r.status === 'pending');
    setBatchActing(true);
    setBatchResults([]);

    for (const record of targets) {
      try {
        let msg = '';
        if (batchMethod === 'mbway') msg = await payMbway(record, batchPhone);
        else if (batchMethod === 'multibanco') msg = await payMultibanco(record);
        else msg = await payCard(record);
        setBatchResults(prev => [...prev, { id: record.id, ok: true, msg }]);
      } catch (err: any) {
        setBatchResults(prev => [...prev, { id: record.id, ok: false, msg: err.message }]);
      }
    }

    setBatchActing(false);
    setSelected(new Set());
    setBatchMethod(null);
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setBatchPanel(false);
    setBatchResults([]);
  };

  const selectedTotal = records
    .filter(r => selected.has(r.id))
    .reduce((s, r) => s + r.total, 0);

  if (loading) return <div className="p-6 text-gray-400 text-sm">A carregar...</div>;

  const tabClass = (tab: FilterTab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === tab
      ? 'bg-indigo-600 text-white'
      : 'text-gray-600 hover:bg-gray-100'}`;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <h1 className="text-2xl font-bold text-gray-800">Pagamentos</h1>

      {/* Tabs */}
      <div className="flex gap-2 flex-wrap">
        <button className={tabClass('pending')} onClick={() => setActiveTab('pending')}>
          A pagar {pending.length > 0 && <span className="ml-1 bg-indigo-500 text-white text-xs rounded-full px-1.5">{pending.length}</span>}
        </button>
        <button className={tabClass('overdue')} onClick={() => setActiveTab('overdue')}>
          Em atraso {overdue.length > 0 && <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5">{overdue.length}</span>}
        </button>
        <button className={tabClass('history')} onClick={() => setActiveTab('history')}>
          Histórico
        </button>
      </div>

      {/* Batch pay bar */}
      {selected.size > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-indigo-800">
              {selected.size} selecionado(s) · {fmtEur(selectedTotal)}
            </p>
            <div className="flex gap-2">
              <button onClick={() => { setSelected(new Set()); setBatchPanel(false); setBatchResults([]); }}
                className="text-xs text-indigo-500 hover:underline">Cancelar</button>
              <button onClick={() => { setBatchPanel(p => !p); setBatchMethod(null); setBatchResults([]); }}
                className="bg-indigo-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-indigo-700">
                Pagar selecionados
              </button>
            </div>
          </div>

          {batchPanel && !batchActing && batchResults.length === 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700">Método de pagamento:</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(['mbway', 'multibanco', 'card'] as const).map(m => (
                  <button key={m}
                    onClick={() => setBatchMethod(m)}
                    className={`py-2 rounded-lg border text-sm font-medium transition-colors ${batchMethod === m ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:bg-gray-50'}`}>
                    {m === 'mbway' ? '📱 MB WAY' : m === 'multibanco' ? '🏧 Multibanco' : '💳 Cartão'}
                  </button>
                ))}
              </div>
              {batchMethod === 'mbway' && (
                <>
                  <input type="tel" placeholder="9XXXXXXXX" value={batchPhone}
                    onChange={e => { setBatchPhone(e.target.value); setBatchPhoneError(''); }}
                    className={`w-full border rounded-lg px-3 py-2 text-sm ${batchPhoneError ? 'border-red-400' : ''}`} />
                  {batchPhoneError && <p className="text-xs text-red-500">{batchPhoneError}</p>}
                </>
              )}
              {batchMethod && (
                <button onClick={handleBatchPay}
                  className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-semibold text-sm hover:bg-indigo-700">
                  Confirmar pagamento de {fmtEur(selectedTotal)}
                </button>
              )}
            </div>
          )}

          {batchActing && <p className="text-sm text-indigo-600 animate-pulse">A processar pagamentos...</p>}

          {batchResults.length > 0 && (
            <div className="space-y-1">
              {batchResults.map(r => (
                <p key={r.id} className={`text-xs ${r.ok ? 'text-green-700' : 'text-red-600'}`}>
                  {r.ok ? '✅' : '❌'} {r.msg}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Record list */}
      {tabRecords.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-4xl mb-3">{activeTab === 'history' ? '🧾' : '✅'}</p>
          <p>{activeTab === 'history' ? 'Não tem pagamentos anteriores.' : 'Não tem pagamentos pendentes.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tabRecords.map(record => {
            const overdueBadge = isOverdue(record);
            const isPending = record.status === 'pending';
            const isSelected = selected.has(record.id);
            const isDone = ['paid', 'invoiced'].includes(record.status);

            if (isDone) {
              return (
                <div key={record.id} className="border border-gray-100 rounded-xl p-4 bg-white flex justify-between items-center">
                  <div>
                    <p className="font-medium text-gray-700">{record.periodLabel}</p>
                    <p className="text-xs text-gray-400">
                      {record.invoiceNumber ? `Fatura ${record.invoiceNumber}` : 'Pago'}
                      {record.paidAt && ` · ${record.paidAt.toDate().toLocaleDateString('pt-PT')}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-gray-800">{fmtEur(record.total)}</p>
                    <span className="text-xs text-green-600 font-medium">✅ Pago</span>
                  </div>
                </div>
              );
            }

            return (
              <div key={record.id}
                className={`border rounded-xl p-5 transition-all ${isSelected ? 'border-indigo-400 bg-indigo-50' : overdueBadge ? 'border-red-200 bg-red-50' : STATUS_META[record.status]?.className ?? 'border-gray-200'}`}>

                <div className="flex items-start gap-3">
                  {/* Checkbox (only for pending) */}
                  {isPending && (
                    <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(record.id)}
                      className="mt-1 w-4 h-4 rounded accent-indigo-600 cursor-pointer shrink-0" />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-semibold text-gray-800">{record.periodLabel}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {STATUS_META[record.status]?.icon} {STATUS_META[record.status]?.label}
                          {overdueBadge && <span className="ml-2 text-red-600 font-semibold">· Em atraso</span>}
                          {record.dueDate && !overdueBadge && ` · Vence em ${record.dueDate.toDate().toLocaleDateString('pt-PT')}`}
                          {record.dueDate && overdueBadge && ` · Venceu em ${record.dueDate.toDate().toLocaleDateString('pt-PT')}`}
                        </p>
                      </div>
                      <p className="text-2xl font-bold text-gray-800 ml-4 shrink-0">{fmtEur(record.total)}</p>
                    </div>

                    {/* Line items */}
                    <div className="mt-2 space-y-0.5">
                      {record.lineItems?.map((li, i) => (
                        <div key={i} className="flex justify-between text-xs text-gray-500">
                          <span>{li.title}</span>
                          <span>{fmtEur(li.amount)}</span>
                        </div>
                      ))}
                    </div>

                    {/* Multibanco reference */}
                    {record.status === 'processing' && record.multibancoEntity && (
                      <div className="mt-3 bg-white rounded-lg p-3 border border-green-200">
                        <p className="text-xs font-semibold text-green-800 mb-1">Referência Multibanco</p>
                        <p className="text-sm font-mono">Entidade: <strong>{record.multibancoEntity}</strong></p>
                        <p className="text-sm font-mono">Referência: <strong>{record.multibancoReference}</strong></p>
                      </div>
                    )}

                    {/* Action result */}
                    {actionResult[record.id] && (
                      <p className="mt-3 text-sm text-gray-700 bg-white rounded-lg px-3 py-2 border">{actionResult[record.id]}</p>
                    )}

                    {/* Single-item pay panel */}
                    {isPending && !isSelected && (
                      <div className="mt-4">
                        {activeId !== record.id ? (
                          <button onClick={() => { setActiveId(record.id); setSelected(new Set()); }}
                            className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-semibold hover:bg-indigo-700 transition-colors text-sm">
                            Pagar agora
                          </button>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-sm font-medium text-gray-700">Como quer pagar?</p>

                            <div className="border rounded-lg p-3 space-y-2">
                              <p className="text-sm font-semibold">📱 MB WAY</p>
                              <input type="tel" placeholder="9XXXXXXXX" value={mbwayPhone}
                                onChange={e => { setMbwayPhone(e.target.value); setMbwayPhoneError(''); }}
                                className={`w-full border rounded px-3 py-2 text-sm ${mbwayPhoneError ? 'border-red-400' : ''}`} />
                              {mbwayPhoneError && <p className="text-xs text-red-500">{mbwayPhoneError}</p>}
                              <button onClick={() => handleSinglePay(record, 'mbway')} disabled={acting}
                                className="w-full bg-green-600 text-white py-2 rounded font-medium text-sm hover:bg-green-700 disabled:opacity-50">
                                {acting ? 'A processar...' : 'Pagar com MB WAY'}
                              </button>
                            </div>

                            <button onClick={() => handleSinglePay(record, 'multibanco')} disabled={acting}
                              className="w-full border border-gray-300 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50">
                              🏧 Gerar referência Multibanco
                            </button>

                            <button onClick={() => handleSinglePay(record, 'card')} disabled={acting}
                              className="w-full border border-gray-300 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50">
                              💳 Pagar com Cartão
                            </button>

                            <button onClick={() => setActiveId(null)} className="w-full text-xs text-gray-400 py-1">Cancelar</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
