import { useState } from 'react';
import { Link } from 'react-router-dom';
import { callable } from '../../../lib/callable';
import { BillRow, isUnpaid, isOverdue } from './model';

const STATUS_TAG: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Por pagar', cls: 'bg-yellow-100 text-yellow-800' },
  processing: { label: 'Em processamento', cls: 'bg-blue-100 text-blue-800' },
  paid: { label: 'Paga', cls: 'bg-green-100 text-green-800' },
  invoiced: { label: 'Faturada', cls: 'bg-green-100 text-green-800' },
  failed: { label: 'Falhou', cls: 'bg-red-100 text-red-800' },
  cancelled: { label: 'Cancelada', cls: 'bg-gray-100 text-gray-500' },
  'dry-run': { label: 'Teste', cls: 'bg-gray-100 text-gray-500' },
};

/**
 * A family's bills, newest first, with any Vendus invoice error up top.
 *
 * Months are paid in order (#47), so one stuck month blocks every later one —
 * which is why the error and its retry live here, next to the NIF that
 * usually caused it, rather than only on Cobranças.
 */
export default function FamilyBills({ bills, onChanged }: {
  bills: BillRow[];
  /** Called after a retry, so the page re-reads billing. */
  onChanged: () => Promise<void> | void;
}) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);

  const [resetting, setResetting] = useState<string | null>(null);
  const [resetError, setResetError] = useState<Record<string, string>>({});

  const errors = bills.filter(b => b.invoiceError);
  const duplicates = bills.filter(b => b.duplicatePaymentEasypayIds);
  const newestFirst = bills.slice().sort((a, b) => b.periodKey.localeCompare(a.periodKey));
  // Bills exist ahead of time for the whole school year. By default show what
  // matters now: overdue months, invoice errors, and the next month to pay.
  const nextDue = bills
    .filter(b => isUnpaid(b) && !isOverdue(b))
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey))[0];
  const visible = showAll ? newestFirst : newestFirst.filter(b =>
    isOverdue(b) || b.invoiceError || b.status === 'processing' || b.duplicatePaymentEasypayIds || b === nextDue);

  // One call per click, button disabled while it runs: this creates a real
  // invoice in the live Vendus account (prod) and emails it to the parent.
  const retry = async (b: BillRow) => {
    if (!window.confirm(
      `Tentar faturar novamente ${b.periodLabel} (€${b.total.toFixed(2)})?\n\n`
      + 'Cria a fatura no Vendus (conta real, em produção) e envia-a ao encarregado. '
      + 'Corrija primeiro o NIF ou a morada, se foi isso que falhou.'
    )) return;
    setRetrying(b.id);
    setRetryError(prev => { const n = { ...prev }; delete n[b.id]; return n; });
    try {
      await callable<{ billingId: string }, { ok: boolean }>('retryVendusInvoice')({ billingId: b.id });
      await onChanged();
    } catch (err: any) {
      setRetryError(prev => ({ ...prev, [b.id]: err?.message ?? 'erro desconhecido' }));
      await onChanged();
    } finally {
      setRetrying(null);
    }
  };

  // A bill stuck in `processing` (a card link or Multibanco reference that won't
  // be used) blocks the parent. Back to `pending` so they can pay again — only
  // after checking Easypay that the old payment wasn't made. If it lands anyway,
  // the webhook still records it, or flags a duplicate here.
  const resetPayment = async (b: BillRow) => {
    if (!window.confirm(
      `Repor ${b.periodLabel} (€${b.total.toFixed(2)}) para "Por pagar"?\n\n`
      + `Confirme primeiro no backoffice Easypay que o pagamento ${b.easypayId ?? '(sem id)'} NÃO foi pago. `
      + 'Depois disto o encarregado pode pagar de novo.'
    )) return;
    setResetting(b.id);
    setResetError(prev => { const n = { ...prev }; delete n[b.id]; return n; });
    try {
      await callable<{ billingId: string }, { ok: boolean }>('resetStuckPayment')({ billingId: b.id });
    } catch (err: any) {
      setResetError(prev => ({ ...prev, [b.id]: err?.message ?? 'erro desconhecido' }));
    } finally {
      await onChanged();
      setResetting(null);
    }
  };

  return (
    <div className="space-y-2">
      {duplicates.map(b => (
        <div key={b.id} className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm font-semibold text-red-800">Pagamento em duplicado — {b.periodLabel}</p>
          <p className="text-xs text-red-700 mt-0.5 break-words">
            Já estava paga e entrou outro pagamento Easypay ({b.duplicatePaymentEasypayIds!.join(', ')}). Devolver ao encarregado.
          </p>
        </div>
      ))}

      {errors.map(b => (
        <div key={b.id} className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-red-800">Fatura por emitir — {b.periodLabel}</p>
              <p className="text-xs text-red-700 mt-0.5 break-words">{b.invoiceError}</p>
            </div>
            <button onClick={() => retry(b)} disabled={retrying !== null}
              className="shrink-0 bg-red-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-60 font-medium whitespace-nowrap">
              {retrying === b.id ? 'A faturar…' : 'Tentar faturar novamente'}
            </button>
          </div>
          {retryError[b.id] && (
            <p className="text-xs text-red-800 bg-white border border-red-200 rounded px-2 py-1">Falhou outra vez: {retryError[b.id]}</p>
          )}
        </div>
      ))}

      {bills.length === 0 ? (
        <p className="text-xs text-gray-400">Sem cobranças.</p>
      ) : (
        <>
          {visible.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
              {visible.map(b => {
                const tag = STATUS_TAG[b.status] ?? { label: b.status, cls: 'bg-gray-100 text-gray-600' };
                const overdue = isOverdue(b);
                return (
                  <div key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <span className="text-gray-700 flex-1">{b.periodLabel}</span>
                    {b.invoiceNumber && <span className="text-xs text-gray-400">{b.invoiceNumber}</span>}
                    {overdue && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">em atraso</span>}
                    {!overdue && isUnpaid(b) && b.dueDate && (
                      <span className="text-xs text-gray-400">vence {b.dueDate.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' })}</span>
                    )}
                    {b.status === 'processing' && (
                      <button onClick={() => resetPayment(b)} disabled={resetting !== null}
                        title="O pagamento ficou em processamento e o encarregado não consegue pagar de novo"
                        className="text-xs text-blue-600 hover:underline disabled:opacity-60">
                        {resetting === b.id ? 'A repor…' : 'Repor para pendente'}
                      </button>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${tag.cls}`}>{tag.label}</span>
                    <span className="text-gray-800 font-medium w-20 text-right">€{b.total.toFixed(2)}</span>
                    {resetError[b.id] && <span className="basis-full text-xs text-red-700">Não foi possível repor: {resetError[b.id]}</span>}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-3 text-xs">
            {visible.length === 0 && <span className="text-gray-400">Nada em atraso.</span>}
            {newestFirst.length > visible.length || showAll ? (
              <button onClick={() => setShowAll(v => !v)} className="text-blue-600 hover:underline">
                {showAll ? 'Mostrar só o que importa agora' : `Ver todas (${newestFirst.length})`}
              </button>
            ) : null}
            <Link to="/admin/billing" className="text-blue-600 hover:underline ml-auto">Abrir Cobranças ↗</Link>
          </div>
        </>
      )}
    </div>
  );
}
