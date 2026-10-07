import { useState } from 'react';
import type { BillingRecord } from '@shared/models';
import { callable } from '../../../lib/callable';
import { PaymentProofList, PaymentProofUpload } from '../../../components/billing/PaymentProofs';

function localIsoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Result = { ok: boolean; status: string; invoiceNumber: string | null; invoiceError: string | null };

/**
 * "Marcar como pago": the admin saw the bank transfer arrive and records it.
 * markBillingPaid then issues the Vendus invoice (real fiscal document in
 * prod — it cannot be deleted) and emails it to the parent. The confirm button
 * is single-shot; the server is also safe against a double submit.
 */
export default function MarkPaidModal({ record, onClose, onChanged }: {
  record: BillingRecord;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const today = localIsoDate(new Date());
  const [paidAt, setPaidAt] = useState(today);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const submit = async () => {
    if (submitting || result) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await callable<{ billingId: string; paidAt: string; method: 'bank_transfer'; note?: string }, Result>('markBillingPaid')({
        billingId: record.id, paidAt, method: 'bank_transfer', ...(note.trim() ? { note: note.trim() } : {}),
      });
      setResult(res.data);
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? 'Não foi possível marcar como pago.');
      await onChanged();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !submitting && onClose()}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-bold text-gray-800">Marcar como pago</h2>
          <p className="text-sm text-gray-500">{record.billingName} · {record.periodLabel}</p>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex items-baseline justify-between">
          <span className="text-sm text-gray-600">Transferência bancária de</span>
          <span className="text-2xl font-bold text-gray-800">€{record.total.toFixed(2)}</span>
        </div>

        {record.status === 'processing' && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Esta mensalidade tem um pagamento Easypay em curso{record.easypayId ? ` (${record.easypayId})` : ''}. Se esse
            pagamento também entrar, fica assinalado como pagamento em duplicado para devolver.
          </p>
        )}

        {!result && (
          <>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Data em que a transferência entrou</span>
              <input type="date" value={paidAt} max={today} onChange={e => setPaidAt(e.target.value)}
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Nota <span className="font-normal text-gray-400">(opcional)</span></span>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={500}
                placeholder="Ex.: transferência de Maria Silva, ref. extrato"
                className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" />
            </label>
          </>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700">Comprovativos</p>
          {record.paymentProofs?.length
            ? <PaymentProofList proofs={record.paymentProofs} showUploader />
            : <p className="text-xs text-gray-400">Nenhum comprovativo enviado.</p>}
          <PaymentProofUpload billingId={record.id} onUploaded={() => onChanged()} label="Adicionar comprovativo (opcional)" />
        </div>

        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

        {result && (
          result.invoiceNumber ? (
            <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              Pagamento registado. Fatura {result.invoiceNumber} emitida e enviada ao encarregado.
            </p>
          ) : result.invoiceError ? (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 break-words">
              Pagamento registado, mas a fatura não foi emitida: {result.invoiceError}. Corrija o problema (ex.: NIF) e use
              "Tentar faturar novamente" em Famílias e inscrições.
            </p>
          ) : (
            <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              Pagamento registado (estado: {result.status}).
            </p>
          )
        )}

        <div className="flex justify-end gap-3 pt-1">
          <button onClick={onClose} disabled={submitting} className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200 disabled:opacity-50">
            {result ? 'Fechar' : 'Cancelar'}
          </button>
          {!result && (
            <button onClick={submit} disabled={submitting || !paidAt || paidAt > today}
              className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
              {submitting ? 'A registar...' : `Confirmar €${record.total.toFixed(2)} recebidos`}
            </button>
          )}
        </div>
        {!result && (
          <p className="text-[11px] text-gray-400">
            Ao confirmar, a fatura-recibo é emitida no Vendus e enviada ao encarregado. Não pode ser apagada.
          </p>
        )}
      </div>
    </div>
  );
}
