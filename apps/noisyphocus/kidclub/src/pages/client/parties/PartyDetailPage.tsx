import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Booking, extraQty, partyVatBreakdown, PARTY_VAT_RATE } from '@shared/models';
import { partyService } from '../../../services/partyService';
import { callable } from '../../../lib/callable';

function fmtDate(dateStr: string) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }

const STATUS = {
  pending:   { label: 'Aguarda confirmação', cls: 'bg-yellow-100 text-yellow-800', icon: '⏳' },
  confirmed: { label: 'Confirmada',          cls: 'bg-green-100 text-green-800',   icon: '✅' },
  rejected:  { label: 'Não disponível',      cls: 'bg-gray-100 text-gray-600',     icon: '❌' },
};

type PayMethod = 'mbway' | 'multibanco' | 'card';

export default function PartyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useUser();
  const navigate = useNavigate();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Payment state
  const [billingId, setBillingId] = useState<string | null>(null);
  const [creatingDeposit, setCreatingDeposit] = useState(false);
  const [payMethod, setPayMethod] = useState<PayMethod | null>(null);
  const [mbwayPhone, setMbwayPhone] = useState('');
  const [paying, setPaying] = useState(false);
  const [payResult, setPayResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [mbwayRef, setMbwayRef] = useState('');
  const [multibancoRef, setMultibancoRef] = useState<{ entity: string; reference: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    partyService.getBookingById(id).then(b => {
      if (!b) { setNotFound(true); setLoading(false); return; }
      setBooking(b);
      setLoading(false);
    });
  }, [id]);

  const handleGetDeposit = async () => {
    if (!id) return;
    setCreatingDeposit(true);
    try {
      const res = await callable<{ bookingId: string }, { billingId: string }>('createPartyDeposit')({ bookingId: id });
      setBillingId(res.data.billingId);
    } catch (err: any) {
      setPayResult({ ok: false, msg: err?.message || 'Erro ao iniciar pagamento.' });
    } finally {
      setCreatingDeposit(false);
    }
  };

  const handlePay = async () => {
    if (!billingId || !payMethod) return;
    if (payMethod === 'mbway' && !mbwayPhone.trim()) { alert('Introduza o número de telemóvel.'); return; }
    setPaying(true);
    setPayResult(null);
    try {
      if (payMethod === 'mbway') {
        await callable('initiateMbwayPayment')({ billingId, phone: mbwayPhone.trim() });
        setPayResult({ ok: true, msg: 'Notificação MB WAY enviada. Confirme na app MB WAY.' });
      } else if (payMethod === 'multibanco') {
        const res = await callable<object, { entity: string; reference: string }>('initiateMultibancoPayment')({ billingId });
        setMultibancoRef({ entity: res.data.entity, reference: res.data.reference });
        setPayResult({ ok: true, msg: '' });
      } else {
        const res = await callable<object, { paymentLink: string }>('initiateCardPayment')({ billingId });
        window.open(res.data.paymentLink, '_blank');
        setPayResult({ ok: true, msg: 'Redireccionado para pagamento por cartão.' });
      }
    } catch (err: any) {
      setPayResult({ ok: false, msg: err?.message || 'Erro no pagamento.' });
    } finally {
      setPaying(false);
    }
  };

  if (loading) return <div className="p-6 text-gray-400 text-sm">A carregar...</div>;
  if (notFound || !booking) return (
    <div className="p-6 text-center text-gray-500">
      <p>Reserva não encontrada.</p>
      <button onClick={() => navigate('/client/parties')} className="mt-3 text-pink-600 underline text-sm">Voltar</button>
    </div>
  );

  const s = STATUS[booking.status] ?? STATUS.pending;
  const price = partyVatBreakdown(booking.total);
  const deposit = price.deposit;
  const isConfirmed = booking.status === 'confirmed';

  return (
    <div className="p-6 max-w-xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/client/parties')} className="text-gray-400 hover:text-gray-600">←</button>
        <h1 className="text-2xl font-bold text-gray-800">🎈 Detalhes da festa</h1>
      </div>

      {/* Status */}
      <div className={`rounded-xl px-4 py-3 flex items-center gap-2 font-medium text-sm ${s.cls}`}>
        <span>{s.icon}</span> {s.label}
      </div>

      {/* Booking info */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Tipo de festa</span>
          <span className="font-medium text-gray-800">{booking.partyType || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Criança</span>
          <span className="font-medium text-gray-800">{booking.childName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Data</span>
          <span className="font-medium text-gray-800">{fmtDate(booking.date)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Hora</span>
          <span className="font-medium text-gray-800">{booking.time || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Crianças</span>
          <span className="font-medium text-gray-800">{booking.numKids}</span>
        </div>
        {booking.extras && booking.extras.length > 0 && (
          <div className="flex justify-between">
            <span className="text-gray-500">Extras</span>
            <span className="font-medium text-gray-800 text-right">
              {booking.extras.map(name => {
                const q = extraQty(booking, name);
                return q > 1 ? `${q} × ${name}` : name;
              }).join(', ')}
            </span>
          </div>
        )}
        <div className="border-t pt-3 flex justify-between">
          <span className="text-gray-500">Subtotal (sem IVA)</span>
          <span className="font-medium text-gray-800">{fmtEur(price.subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">IVA ({Math.round(PARTY_VAT_RATE * 100)}%)</span>
          <span className="font-medium text-gray-800">{fmtEur(price.vat)}</span>
        </div>
        <div className="flex justify-between">
          <span className="font-semibold text-gray-700">Total</span>
          <span className="font-bold text-gray-900">{fmtEur(price.total)}</span>
        </div>
      </div>

      {/* Pending message */}
      {booking.status === 'pending' && (
        <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4 text-sm text-yellow-800">
          A sua reserva está a ser analisada pela nossa equipa. Assim que for confirmada, poderá efetuar o pagamento do sinal aqui.
        </div>
      )}

      {/* Rejected message */}
      {booking.status === 'rejected' && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-600">
          <p className="font-medium">Data não disponível</p>
          {booking.statusReason && <p className="mt-1">{booking.statusReason}</p>}
          <button
            onClick={() => navigate('/client/parties/new')}
            className="mt-3 text-pink-600 underline text-sm"
          >
            Fazer nova reserva
          </button>
        </div>
      )}

      {/* Payment section — only when confirmed */}
      {isConfirmed && !payResult?.ok && (
        <div className="bg-white border border-green-200 rounded-xl p-5 space-y-4">
          <div>
            <p className="font-semibold text-gray-800 mb-1">Pagamento do sinal</p>
            <p className="text-sm text-gray-500">
              Para confirmar a sua reserva, é necessário pagar o sinal de 50% ({fmtEur(deposit)}).
              O valor restante é liquidado no dia da festa.
            </p>
          </div>

          {!billingId ? (
            <button
              onClick={handleGetDeposit}
              disabled={creatingDeposit}
              className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl hover:bg-green-700 transition disabled:opacity-50"
            >
              {creatingDeposit ? 'A preparar pagamento...' : `Pagar sinal — ${fmtEur(deposit)}`}
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium text-gray-700">Como pretende pagar?</p>
              <div className="grid grid-cols-3 gap-2">
                {(['mbway', 'multibanco', 'card'] as PayMethod[]).map(m => (
                  <button key={m} onClick={() => { setPayMethod(m); setPayResult(null); setMultibancoRef(null); }}
                    className={`py-2.5 rounded-xl border text-sm font-medium transition ${payMethod === m ? 'border-green-600 bg-green-50 text-green-700' : 'border-gray-200 hover:bg-gray-50 text-gray-700'}`}>
                    {m === 'mbway' ? '📱 MB WAY' : m === 'multibanco' ? '🏧 Multibanco' : '💳 Cartão'}
                  </button>
                ))}
              </div>

              {payMethod === 'mbway' && (
                <input type="tel" placeholder="9XXXXXXXX" value={mbwayPhone}
                  onChange={e => setMbwayPhone(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-400 focus:outline-none" />
              )}

              {payMethod && (
                <button onClick={handlePay} disabled={paying}
                  className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl hover:bg-green-700 transition disabled:opacity-50">
                  {paying ? 'A processar...' : `Pagar ${fmtEur(deposit)}`}
                </button>
              )}
            </div>
          )}

          {payResult && !payResult.ok && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{payResult.msg}</p>
          )}
        </div>
      )}

      {/* MB WAY result */}
      {payResult?.ok && payResult.msg && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800">
          ✅ {payResult.msg}
        </div>
      )}

      {/* Multibanco reference */}
      {multibancoRef && (
        <div className="bg-white border border-green-200 rounded-xl p-5 space-y-2 text-sm">
          <p className="font-semibold text-gray-800">Referência Multibanco</p>
          <div className="bg-gray-50 rounded-lg p-4 font-mono space-y-1">
            <p>Entidade: <strong>{multibancoRef.entity}</strong></p>
            <p>Referência: <strong>{multibancoRef.reference}</strong></p>
            <p>Valor: <strong>{fmtEur(deposit)}</strong></p>
          </div>
          <p className="text-xs text-gray-500">Esta referência é válida por 7 dias.</p>
        </div>
      )}
    </div>
  );
}
