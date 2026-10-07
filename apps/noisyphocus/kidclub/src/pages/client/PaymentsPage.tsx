import { useState, useEffect, useMemo } from 'react';
import { query, where, getDocs, getDoc, limit } from 'firebase/firestore';
import { callable } from '../../lib/callable';
import { col, docRef } from '../../lib/db';
import { useUser } from '@shared/hooks';
import { BillingRecord, Family } from '@shared/models';
import { useImpersonation } from '../../contexts/ImpersonationContext';
import { familyPaymentMethod } from '../../lib/paymentMethod';
import { useBankTransferConfig, formatIban, transferDescription, BankTransferConfig } from '../../lib/bankTransfer';
import { PaymentProofList, PaymentProofUpload } from '../../components/billing/PaymentProofs';
import { PAYMENT_PROOFS_ENABLED } from '../../lib/paymentProof';

const STATUS_META: Record<string, { label: string; className: string; icon: string }> = {
  pending:    { label: 'Por pagar',             className: 'bg-yellow-50 border-yellow-200 text-yellow-800', icon: '⏳' },
  processing: { label: 'A aguardar pagamento',  className: 'bg-blue-50 border-blue-200 text-blue-800',   icon: '🔄' },
  paid:       { label: 'Pago',                  className: 'bg-green-50 border-green-200 text-green-800',    icon: '✅' },
  invoiced:   { label: 'Pago',                  className: 'bg-green-50 border-green-200 text-green-800',    icon: '✅' },
  failed:     { label: 'Falhado',               className: 'bg-red-50 border-red-200 text-red-800',          icon: '❌' },
};
const SHOWN_STATUSES = Object.keys(STATUS_META);

/** Proof sent, not confirmed yet: the bill stays unpaid until an admin confirms the transfer. */
const awaitingConfirmation = (r: BillingRecord) =>
  !!r.paymentProofs?.length && ['pending', 'processing', 'failed'].includes(r.status);

/** Small status pill. A proof awaiting confirmation wins, then overdue, then the record's own status. */
function StatusTag({ record }: { record: BillingRecord }) {
  if (awaitingConfirmation(record)) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-teal-50 text-teal-800 border-teal-200">
        📎 A aguardar confirmação
      </span>
    );
  }
  const overdue = isOverdue(record);
  const meta = STATUS_META[record.status];
  const cls = overdue ? 'bg-red-100 text-red-700 border-red-200' : meta?.className ?? 'bg-gray-50 text-gray-600 border-gray-200';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {overdue ? '⚠️ Em atraso' : `${meta?.icon ?? ''} ${meta?.label ?? record.status}`}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button"
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {})}
      className="text-xs text-indigo-600 hover:underline shrink-0">
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}

/** What a parent paying by bank transfer needs: IBAN, amount and the description to use. */
function BankTransferBox({ record, bank }: { record: BillingRecord; bank: BankTransferConfig | null }) {
  const description = transferDescription(record.billingName, record.periodLabel);
  return (
    <div className="bg-white rounded-lg p-3 border border-gray-200 space-y-2">
      <p className="text-sm font-semibold text-gray-800">🏦 Pagar por transferência bancária</p>
      {bank === null ? (
        <p className="text-xs text-gray-400">A carregar...</p>
      ) : !bank.iban ? (
        <p className="text-xs text-gray-500">Os dados para transferência ainda não estão disponíveis. Contacte-nos ou pague por MB WAY.</p>
      ) : (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-gray-500 text-xs">IBAN</span>
            <span className="font-mono text-gray-800 text-right break-all">{formatIban(bank.iban)}</span>
            <CopyButton text={bank.iban.replace(/\s+/g, '')} />
          </div>
          {bank.accountHolder && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-gray-500 text-xs">Titular</span>
              <span className="text-gray-800 text-right flex-1">{bank.accountHolder}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-gray-500 text-xs">Valor</span>
            <span className="font-semibold text-gray-800 text-right flex-1">{fmtEur(record.total)}</span>
            <CopyButton text={record.total.toFixed(2)} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-gray-500 text-xs shrink-0">Descritivo</span>
            <span className="text-gray-800 text-right flex-1">{description}</span>
            <CopyButton text={description} />
          </div>
          <p className="text-[11px] text-gray-400 pt-1">
            {PAYMENT_PROOFS_ENABLED && 'Depois de transferir, envie o comprovativo abaixo para confirmarmos mais depressa. '}
            A fatura é emitida quando confirmarmos a transferência.
          </p>
        </div>
      )}
    </div>
  );
}

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }

/** Save a base64 PDF via a blob link: a real download on desktop and Android,
 *  the PDF viewer (with share/save) on iOS Safari. */
function saveBase64Pdf(base64: string, filename: string) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start reading the blob before revoking it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function isOverdue(record: BillingRecord) {
  if (!['pending', 'processing', 'failed'].includes(record.status)) return false;
  const due = record.dueDate?.toDate?.();
  return due ? due < new Date() : false;
}

// Can be paid now: `pending`, or `failed` (an attempt that didn't complete, e.g.
// an MB WAY request not approved in time — the parent tries again). Mirrors
// UNPAID_STATUSES in functions/src/kidclub/billing.ts.
const isPayable = (r: BillingRecord) => r.status === 'pending' || r.status === 'failed';

// Months are paid in order: a monthly record (id `<familyId>_YYYY-MM`) waits
// while an earlier monthly record is still `pending`. Party/camp records are
// exempt. Mirrors assertEarlierMonthsPaid in functions/src/kidclub/billing.ts,
// which enforces it — this only explains it before the parent tries.
const isMonthly = (r: BillingRecord) => /_\d{4}-\d{2}$/.test(r.id);
const monthMs = (r: BillingRecord) => r.periodStart?.toMillis?.() ?? 0;
function earlierUnpaid(records: BillingRecord[], record: BillingRecord): BillingRecord[] {
  if (!isMonthly(record)) return [];
  return records.filter(r => r.id !== record.id && isMonthly(r) && isPayable(r) && monthMs(r) < monthMs(record));
}

export default function PaymentsPage() {
  const user = useUser();
  const { impersonation } = useImpersonation();
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [family, setFamily] = useState<Family | null>(null);
  const { config: bank } = useBankTransferConfig();

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

  // Invoice PDF download (getInvoicePdf): one in flight at a time.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      // Only the first load blanks the page; a reload after a proof upload
      // refreshes in place.
      if (reloadKey === 0) setLoading(true);
      try {
        // While impersonating, the admin's own uid would never match the
        // family's billing records (see familyService.ts) — query by the
        // impersonated familyId instead, same as every other client page.
        const snap = await getDocs(
          impersonation
            ? query(col('billing'), where('familyId', '==', impersonation.familyId))
            : query(col('billing'), where('userId', '==', user.uid))
        );
        const data = snap.docs
          .map(d => ({ id: d.id, ...d.data() } as BillingRecord))
          // Chronological by the month billed, earliest first — createdAt is
          // when the record was (re)built, so a recompute would float later
          // months above the one due now.
          .sort((a, b) => (a.periodStart?.toMillis?.() ?? 0) - (b.periodStart?.toMillis?.() ?? 0));
        setRecords(data);
      } catch (err) {
        console.error('[PaymentsPage] query failed:', err);
      } finally {
        setLoading(false);
      }
      // The family's chosen payment method (Conta → "Método de pagamento").
      // Unpaid bills follow the current choice even before the next billing
      // recompute copies it onto them.
      try {
        if (impersonation) {
          const snap = await getDoc(docRef('families', impersonation.familyId));
          setFamily(snap.exists() ? ({ id: snap.id, ...snap.data() } as Family) : null);
        } else {
          const snap = await getDocs(query(col('families'), where('primaryContact.userId', '==', user.uid), limit(1)));
          setFamily(snap.empty ? null : ({ id: snap.docs[0].id, ...snap.docs[0].data() } as Family));
        }
      } catch (err) {
        console.error('[PaymentsPage] family load failed:', err);
      }
    };
    load();
  }, [user, impersonation, reloadKey]);

  const familyMethod = familyPaymentMethod(family);
  /** How this bill is meant to be paid: the family's current choice while unpaid, else what the bill recorded. */
  const methodFor = (r: BillingRecord) => (isPayable(r) && familyMethod) ? familyMethod : r.paymentMethod;
  const reload = () => setReloadKey(k => k + 1);

  // One list, month order (records is sorted), cancelled/dry-run left out.
  const shown = useMemo(() => records.filter(r => SHOWN_STATUSES.includes(r.status)), [records]);
  const unpaid = shown.filter(isPayable);
  const overdueCount = unpaid.filter(isOverdue).length;
  const unpaidTotal = unpaid.reduce((s, r) => s + r.total, 0);

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

    const targets = records.filter(r => selected.has(r.id) && isPayable(r));
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

  const downloadInvoice = async (record: BillingRecord) => {
    if (downloadingId) return;
    setDownloadingId(record.id);
    setDownloadError(prev => ({ ...prev, [record.id]: '' }));
    try {
      const res = await callable<{ billingId: string }, { filename: string; base64: string }>('getInvoicePdf')({ billingId: record.id });
      saveBase64Pdf(res.data.base64, res.data.filename);
    } catch (err: any) {
      console.error('[PaymentsPage] getInvoicePdf failed:', err);
      setDownloadError(prev => ({ ...prev, [record.id]: err?.message || 'Não foi possível descarregar a fatura.' }));
    } finally {
      setDownloadingId(null);
    }
  };

  // Selecting a month also selects every earlier unpaid month; unselecting one
  // also unselects the later months that depend on it. The batch then pays
  // them oldest first (records is sorted by month), which the backend accepts.
  const toggleSelect = (id: string) => {
    const record = records.find(r => r.id === id);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (record && isMonthly(record)) {
          for (const r of records) if (isMonthly(r) && monthMs(r) > monthMs(record)) next.delete(r.id);
        }
      } else {
        next.add(id);
        if (record) for (const r of earlierUnpaid(records, record)) next.add(r.id);
      }
      return next;
    });
    setBatchPanel(false);
    setBatchResults([]);
  };

  const selectedTotal = records
    .filter(r => selected.has(r.id))
    .reduce((s, r) => s + r.total, 0);

  if (loading) return <div className="p-6 text-gray-400 text-sm">A carregar...</div>;


  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <h1 className="text-2xl font-bold text-gray-800">Pagamentos</h1>

      {/* Summary */}
      {unpaid.length > 0 && (
        <p className="text-sm text-gray-600">
          {unpaid.length} mensalidade{unpaid.length === 1 ? '' : 's'} por pagar · {fmtEur(unpaidTotal)}
          {overdueCount > 0 && <span className="ml-2 text-red-600 font-medium">· {overdueCount} em atraso</span>}
        </p>
      )}

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
              <button onClick={() => { setBatchPanel(p => !p); setBatchMethod('mbway'); setBatchResults([]); }}
                className="bg-indigo-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-indigo-700">
                Pagar selecionados
              </button>
            </div>
          </div>

          {batchPanel && !batchActing && batchResults.length === 0 && (
            <div className="space-y-2">
              {/* MB WAY only for now: card has no Easypay POS configured, and
                  Multibanco is off until that's sorted too. */}
              <p className="text-sm font-medium text-gray-700">📱 Pagar com MB WAY</p>
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
      {shown.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-4xl mb-3">🧾</p>
          <p>Ainda não tem mensalidades.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map(record => {
            const overdueBadge = isOverdue(record);
            const isPending = isPayable(record);
            const isSelected = selected.has(record.id);
            const isDone = ['paid', 'invoiced'].includes(record.status);

            if (isDone) {
              return (
                <div key={record.id} className="border border-gray-100 rounded-xl p-4 bg-white">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="font-medium text-gray-700">{record.periodLabel}</p>
                      <p className="text-xs text-gray-400">
                        {record.invoiceNumber ? `Fatura ${record.invoiceNumber}` : 'Pago'}
                        {record.paidAt && ` · ${record.paidAt.toDate().toLocaleDateString('pt-PT')}`}
                        {record.manualPayment && ' · por transferência'}
                      </p>
                    </div>
                    <div className="text-right space-y-1">
                      <p className="font-bold text-gray-800">{fmtEur(record.total)}</p>
                      <StatusTag record={record} />
                    </div>
                  </div>
                  {record.status === 'invoiced' && record.vendusId && (
                    <div className="mt-3 pt-3 border-t border-gray-100">
                      <button
                        type="button"
                        onClick={() => downloadInvoice(record)}
                        disabled={downloadingId !== null}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-800 hover:underline disabled:opacity-50 disabled:no-underline"
                      >
                        <span aria-hidden>⬇️</span>
                        {downloadingId === record.id ? 'A descarregar...' : 'Descarregar fatura'}
                      </button>
                      {downloadError[record.id] && (
                        <p className="mt-1 text-xs text-red-600">{downloadError[record.id]}</p>
                      )}
                    </div>
                  )}
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
                        <div className="flex items-center gap-2 flex-wrap mt-1">
                          <StatusTag record={record} />
                          {record.dueDate && (
                            <span className="text-xs text-gray-500">
                              {overdueBadge ? 'Venceu' : 'Vence'} em {record.dueDate.toDate().toLocaleDateString('pt-PT')}
                            </span>
                          )}
                        </div>
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

                    {awaitingConfirmation(record) && (
                      <p className="mt-3 text-sm text-teal-800 bg-white rounded-lg px-3 py-2 border border-teal-200">
                        Recebemos o seu comprovativo. A aguardar confirmação da transferência.
                      </p>
                    )}

                    {record.status === 'failed' && !awaitingConfirmation(record) && (
                      <p className="mt-3 text-sm text-red-800 bg-white rounded-lg px-3 py-2 border border-red-200">
                        O pagamento anterior não foi concluído. Pode tentar de novo.
                      </p>
                    )}

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

                    {/* Single-item pay panel. Bank transfer: IBAN + description, with
                        MB WAY still one click away. Months-in-order is enforced
                        server-side for Easypay only; a transfer can cover several. */}
                    {isPending && !isSelected && methodFor(record) === 'bank_transfer' && activeId !== record.id && (
                      <div className="mt-4 space-y-2">
                        <BankTransferBox record={record} bank={bank} />
                        <button onClick={() => { setActiveId(record.id); setSelected(new Set()); }}
                          className="w-full text-xs text-indigo-600 hover:underline py-1">
                          Prefere pagar agora por MB WAY?
                        </button>
                      </div>
                    )}
                    {isPending && !isSelected && (methodFor(record) !== 'bank_transfer' || activeId === record.id) && (
                      <div className="mt-4">
                        {earlierUnpaid(records, record).length > 0 ? (
                          <p className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-center">
                            As mensalidades são pagas por ordem. Poderá pagar este mês assim que {earlierUnpaid(records, record)[0].periodLabel} estiver pago.
                          </p>
                        ) : activeId !== record.id ? (
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

                            <button onClick={() => setActiveId(null)} className="w-full text-xs text-gray-400 py-1">Cancelar</button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Proof of payment — optional, any method. Never marks the bill paid by itself. */}
                    {(isPending || record.status === 'processing') && (PAYMENT_PROOFS_ENABLED || !!record.paymentProofs?.length) && (
                      <div className="mt-3 pt-3 border-t border-black/5 space-y-1.5">
                        <PaymentProofList proofs={record.paymentProofs} />
                        <PaymentProofUpload billingId={record.id} onUploaded={reload}
                          label={record.paymentProofs?.length ? 'Enviar outro comprovativo' : 'Enviar comprovativo'} />
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
