import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import PublicShell from './PublicShell';
import { adhocEventService, fmtDay, fmtTime, fmtEur, callableMessage, type RegistrationView } from '../../services/adhocEventService';

// While an MB WAY request is out the page asks every few seconds; EasyPay
// gives the parent ~5 minutes to approve it, so this is ~75 calls at most.
const POLL_MS = 4000;

function saveBase64Pdf(base64: string, filename: string) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function useCountdown(until: number | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return '';
  const s = Math.max(0, Math.floor((until - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * /eventos/inscricao/:registrationId?t=token — a registration's own page: pay
 * the held seats by MB WAY, follow the payment, download the invoice. The link
 * token is the only key (guests have no account); it's in the confirmation email.
 */
export default function RegistrationPage() {
  const { registrationId = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';

  const [view, setView] = useState<RegistrationView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [phone, setPhone] = useState('');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const phoneTouched = useRef(false);

  const load = useCallback(async () => {
    try {
      const v = await adhocEventService.getRegistration(registrationId, token);
      setView(v);
      if (!phoneTouched.current) setPhone(v.guardianPhone);
    } catch (err) {
      setLoadError(callableMessage(err, 'Não foi possível carregar a inscrição.'));
    }
  }, [registrationId, token]);

  useEffect(() => { load(); }, [load]);

  // Also once the bill is paid: the registration turns confirmed a moment later (onAdhocBillingPaid).
  const waiting = view?.status === 'held' && ['processing', 'paid', 'invoiced'].includes(view.bill?.status ?? '');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [waiting, load]);

  const countdown = useCountdown(view?.status === 'held' ? view.holdExpiresAt : null);
  // The hold just ran out on screen: ask the server once (it gives the seats
  // back). Once per expiry time: if the server keeps the hold (an MB WAY still
  // out), the reply is still `held` with the same time, and must not re-trigger.
  const reloadedForExpiry = useRef<number | null>(null);
  useEffect(() => {
    if (view?.status !== 'held' || !view.holdExpiresAt || countdown !== '0:00') return;
    if (reloadedForExpiry.current === view.holdExpiresAt) return;
    reloadedForExpiry.current = view.holdExpiresAt;
    load();
  }, [countdown, view, load]);

  const pay = async () => {
    if (phone.replace(/\D/g, '').length < 9) { setPayError('Introduza o número de telemóvel MB WAY.'); return; }
    setPaying(true);
    setPayError('');
    try {
      await adhocEventService.pay(registrationId, token, phone);
      await load();
    } catch (err) {
      setPayError(callableMessage(err, 'Não foi possível iniciar o pagamento. Tente novamente.'));
      await load();
    } finally {
      setPaying(false);
    }
  };

  const downloadInvoice = async () => {
    if (!view?.bill) return;
    setPdfLoading(true);
    setPdfError('');
    try {
      const pdf = await adhocEventService.invoicePdf(view.bill.id, registrationId, token);
      saveBase64Pdf(pdf.base64, pdf.filename);
    } catch (err) {
      setPdfError(callableMessage(err, 'Não foi possível obter a fatura neste momento.'));
    } finally {
      setPdfLoading(false);
    }
  };

  if (!token || loadError) {
    return (
      <PublicShell back={{ to: '/eventos', label: 'Eventos' }}>
        <p className="text-gray-600">{loadError || 'Link inválido.'}</p>
      </PublicShell>
    );
  }
  if (!view) return <PublicShell><p className="text-gray-400">A carregar...</p></PublicShell>;

  const billFailed = view.bill?.status === 'failed';

  return (
    <PublicShell back={{ to: '/eventos', label: 'Eventos' }}>
      <h1 className="text-3xl font-bold text-pink-600">{view.eventName}</h1>
      {view.location && <p className="text-gray-500 mt-1">📍 {view.location}</p>}

      {/* Status */}
      {view.status === 'confirmed' && (
        <div className="mt-5 bg-green-50 border border-green-200 rounded-2xl p-5">
          <p className="text-lg font-semibold text-green-800">✅ Inscrição confirmada</p>
          <p className="text-sm text-green-800 mt-1">
            {view.total === 0 ? 'Até lá!' : view.payment === 'monthly'
              ? `O valor entra na mensalidade de ${view.billingPeriodLabel}.`
              : 'Pagamento recebido. Enviámos a confirmação por email.'}
          </p>
          {view.bill?.hasInvoice && (
            <button onClick={downloadInvoice} disabled={pdfLoading} className="mt-3 text-sm font-medium text-green-800 underline disabled:opacity-60">
              {pdfLoading ? 'A obter fatura...' : `Descarregar fatura${view.bill.invoiceNumber ? ` ${view.bill.invoiceNumber}` : ''}`}
            </button>
          )}
          {pdfError && <p className="text-sm text-red-600 mt-1">{pdfError}</p>}
        </div>
      )}

      {view.status === 'held' && (
        <div className="mt-5 bg-white border border-pink-200 rounded-2xl p-5 shadow-sm">
          {waiting ? (
            <div className="text-center py-2">
              <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-pink-500 mx-auto mb-3" />
              {view.bill?.status === 'processing' ? (
                <>
                  <p className="font-semibold text-gray-800">Confirme o pagamento na app MB WAY</p>
                  <p className="text-sm text-gray-500 mt-1">Tem cerca de 5 minutos. Esta página atualiza sozinha.</p>
                </>
              ) : (
                <p className="font-semibold text-gray-800">Pagamento recebido — a confirmar a inscrição...</p>
              )}
            </div>
          ) : (
            <>
              <p className="font-semibold text-gray-800">Falta pagar {fmtEur(view.total)}</p>
              {countdown && <p className="text-sm text-gray-500 mt-1">A vaga fica reservada durante mais <span className="font-mono font-semibold text-pink-600">{countdown}</span>.</p>}
              {billFailed && <p className="text-sm text-red-600 mt-2">O pagamento MB WAY não foi concluído. Pode tentar de novo.</p>}
              {view.mbwayAttemptsLeft > 0 ? (
                <div className="mt-4 space-y-2">
                  <label className="block text-sm text-gray-600">Telemóvel MB WAY
                    <input type="tel" value={phone} onChange={e => { phoneTouched.current = true; setPhone(e.target.value); }}
                      className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="9XXXXXXXX" />
                  </label>
                  {payError && <p className="text-sm text-red-600">{payError}</p>}
                  <button onClick={pay} disabled={paying}
                    className="w-full bg-pink-600 text-white font-semibold py-3 rounded-xl hover:bg-pink-700 disabled:opacity-60 transition">
                    {paying ? 'A enviar pedido...' : `Pagar ${fmtEur(view.total)} com MB WAY`}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-red-600 mt-3">Atingiu o limite de tentativas de pagamento. Contacte-nos para concluir a inscrição.</p>
              )}
            </>
          )}
        </div>
      )}

      {view.status === 'expired' && (
        <div className="mt-5 bg-amber-50 border border-amber-200 rounded-2xl p-5">
          <p className="font-semibold text-amber-800">A reserva expirou</p>
          <p className="text-sm text-amber-800 mt-1">O pagamento não chegou a tempo e a vaga foi libertada.</p>
          <Link to={`/eventos/${view.eventId}`} className="inline-block mt-3 text-sm font-medium text-amber-900 underline">Inscrever de novo</Link>
        </div>
      )}

      {view.status === 'cancelled' && (
        <div className="mt-5 bg-gray-50 border border-gray-200 rounded-2xl p-5">
          <p className="font-semibold text-gray-800">Inscrição cancelada</p>
          {view.cancelReason && <p className="text-sm text-gray-600 mt-1">{view.cancelReason}</p>}
          {view.refundPending && <p className="text-sm text-gray-600 mt-1">O valor pago será devolvido. Entraremos em contacto.</p>}
        </div>
      )}

      {/* Summary */}
      <section className="mt-5 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 text-sm">
        <h2 className="font-semibold text-gray-800 mb-2">Resumo</h2>
        <p className="text-gray-500 text-xs mb-1">Dias</p>
        <ul className="mb-3 space-y-0.5">
          {view.days.map(d => <li key={d.date}>📅 {fmtDay(d.date)}{fmtTime(d) ? ` · ${fmtTime(d)}` : ''}</li>)}
        </ul>
        <p className="text-gray-500 text-xs mb-1">Crianças</p>
        <ul className="mb-3">{view.children.map(c => <li key={c}>{c}</li>)}</ul>
        <div className="border-t border-gray-100 pt-2 space-y-1">
          {view.lines.map((l, i) => (
            <div key={i} className="flex justify-between gap-3 text-gray-600"><span className="min-w-0">{l.title}</span><span className="shrink-0">{fmtEur(l.amount)}</span></div>
          ))}
          <div className="flex justify-between font-semibold pt-1"><span>Total (IVA incluído)</span><span>{fmtEur(view.total)}</span></div>
        </div>
      </section>

      {view.status === 'held' && (
        <p className="mt-4 text-xs text-gray-500">Guarde esta página: o link é a forma de voltar a ela. A confirmação segue por email assim que o pagamento for recebido.</p>
      )}
    </PublicShell>
  );
}
