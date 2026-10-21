import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { onSnapshot, query, where } from 'firebase/firestore';
import { useUser } from '@shared/hooks';
import { BillingRecord, Booking, extraQty, partyVatBreakdown, PARTY_VAT_RATE } from '@shared/models';
import { partyService } from '../../../services/partyService';
import { callable } from '../../../lib/callable';
import { col } from '../../../lib/db';
import { reportClientError } from '../../../lib/clientErrors';
import { useImpersonation } from '../../../contexts/ImpersonationContext';

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

const PAID_STATUSES = new Set(['paid', 'invoiced']);
const PAYABLE_STATUSES = new Set(['pending', 'failed']);

export default function PartyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const user = useUser();
  const { impersonation } = useImpersonation();
  const navigate = useNavigate();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Deposit bill: created when the admin confirms the booking
  // (onPartyBookingStatusNotify); "Pagar sinal" creates it only for bookings
  // confirmed before that existed.
  const [deposit, setDeposit] = useState<BillingRecord | null>(null);
  const [depositLoaded, setDepositLoaded] = useState(false);
  const [depositError, setDepositError] = useState('');
  const [creatingDeposit, setCreatingDeposit] = useState(false);
  const [createdBillingId, setCreatedBillingId] = useState<string | null>(null);

  // Payment state
  const [mbwayPhone, setMbwayPhone] = useState('');
  const [paying, setPaying] = useState(false);
  const [payResult, setPayResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setLoadError('');
    partyService.getBookingById(id)
      .then(b => {
        if (!b) setNotFound(true);
        else setBooking(b);
      })
      .catch(err => {
        reportClientError('[PartyDetailPage] load booking failed', err);
        setLoadError('Não foi possível carregar esta reserva. Tente novamente mais tarde.');
      })
      .finally(() => setLoading(false));
  }, [id]);

  const isConfirmed = booking?.status === 'confirmed';

  // Listened to, like Pagamentos: the payment's outcome arrives later, from the
  // Easypay webhook (processing → paid/invoiced, or → failed).
  // Rules: a parent may read a bill only if billing.userId is their uid, and a
  // query must say so (rules aren't filters). While an admin impersonates a
  // family, user.uid is the admin's: query by the impersonated family instead.
  useEffect(() => {
    if (!id || !user || !isConfirmed) return;
    setDepositLoaded(false);
    setDepositError('');
    const q = impersonation
      ? query(col('billing'), where('familyId', '==', impersonation.familyId), where('bookingId', '==', id))
      : query(col('billing'), where('userId', '==', user.uid), where('bookingId', '==', id));
    return onSnapshot(q, snap => {
      const bills = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as BillingRecord))
        .filter(b => b.type === 'party_deposit');
      setDeposit(bills.find(b => b.status !== 'cancelled') ?? bills[0] ?? null);
      setDepositLoaded(true);
    }, err => {
      reportClientError('[PartyDetailPage] deposit bill query failed', err, { bookingId: id });
      setDepositError('Não foi possível carregar o pagamento do sinal. Tente novamente mais tarde ou veja em Pagamentos.');
      setDepositLoaded(true);
    });
  }, [id, user, impersonation, isConfirmed]);

  // A payment that reached an outcome drops its old message ("Confirme na app
  // MB WAY" next to a paid or failed bill only confuses). Not on the move to
  // `processing`: initiateMbwayPayment writes that itself.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = deposit?.status ?? null;
    if (lastStatus.current && status && status !== lastStatus.current && status !== 'processing') setPayResult(null);
    lastStatus.current = status;
  }, [deposit?.status]);

  const handleCreateDeposit = async () => {
    if (!id) return;
    setCreatingDeposit(true);
    setPayResult(null);
    try {
      const res = await callable<{ bookingId: string }, { billingId: string }>('createPartyDeposit')({ bookingId: id });
      setCreatedBillingId(res.data.billingId); // the listener above picks the bill up
    } catch (err: any) {
      reportClientError('[PartyDetailPage] create deposit failed', err, { bookingId: id });
      setPayResult({ ok: false, msg: err?.message || 'Erro ao preparar o pagamento.' });
    } finally {
      setCreatingDeposit(false);
    }
  };

  const handlePayMbway = async () => {
    if (!deposit) return;
    if (!mbwayPhone.trim()) { setPayResult({ ok: false, msg: 'Introduza o número de telemóvel MB WAY.' }); return; }
    setPaying(true);
    setPayResult(null);
    try {
      await callable('initiateMbwayPayment')({ billingId: deposit.id, phone: mbwayPhone.trim() });
      setPayResult({ ok: true, msg: 'Notificação MB WAY enviada. Confirme o pagamento na app MB WAY.' });
    } catch (err: any) {
      reportClientError('[PartyDetailPage] pay failed', err, { billingId: deposit.id });
      setPayResult({ ok: false, msg: err?.message || 'Erro no pagamento.' });
    } finally {
      setPaying(false);
    }
  };

  if (loading) return <div className="p-6 text-gray-400 text-sm">A carregar...</div>;
  if (loadError) return (
    <div className="p-6 max-w-xl mx-auto">
      <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{loadError}</p>
    </div>
  );
  if (notFound || !booking) return (
    <div className="p-6 text-center text-gray-500">
      <p>Reserva não encontrada.</p>
      <button onClick={() => navigate('/client/parties')} className="mt-3 text-pink-600 underline text-sm">Voltar</button>
    </div>
  );

  const s = STATUS[booking.status] ?? STATUS.pending;
  const price = partyVatBreakdown(booking.total);
  // The bill's own amount once it exists (it doesn't follow later price edits).
  const depositAmount = deposit ? deposit.total : price.deposit;
  const payMessage = payResult && (
    <p className={`text-sm rounded-lg px-3 py-2 ${payResult.ok ? 'text-green-800 bg-green-50' : 'text-red-600 bg-red-50'}`}>
      {payResult.ok ? '✅ ' : ''}{payResult.msg}
    </p>
  );
  const paymentsLink = (
    <p className="text-xs text-gray-500">
      Também encontra este pagamento em <Link to="/client/payments" className="text-pink-600 underline">Pagamentos</Link>.
    </p>
  );

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
          A sua reserva está a ser analisada pela nossa equipa. Assim que for confirmada, receberá um email e o pagamento do sinal fica disponível aqui e em Pagamentos.
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

      {/* Deposit — only when confirmed */}
      {isConfirmed && (
        <div className="bg-white border border-green-200 rounded-xl p-5 space-y-4">
          <p className="font-semibold text-gray-800">Pagamento do sinal</p>

          {depositError ? (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{depositError}</p>
          ) : !depositLoaded ? (
            <p className="text-sm text-gray-400">A carregar o pagamento...</p>
          ) : deposit && PAID_STATUSES.has(deposit.status) ? (
            <div className="space-y-2">
              <p className="text-sm text-green-800 bg-green-50 rounded-lg px-3 py-2">
                ✅ Sinal pago — {fmtEur(depositAmount)}. O valor restante é liquidado no dia da festa.
              </p>
              {paymentsLink}
            </div>
          ) : deposit && deposit.status === 'processing' ? (
            <div className="space-y-3">
              <p className="text-sm text-blue-800 bg-blue-50 rounded-lg px-3 py-2">
                🔄 A aguardar a confirmação do pagamento de {fmtEur(depositAmount)}. Esta página atualiza assim que o pagamento for recebido.
              </p>
              {deposit.multibancoEntity && deposit.multibancoReference && (
                <div className="bg-gray-50 rounded-lg p-4 font-mono text-sm space-y-1">
                  <p>Entidade: <strong>{deposit.multibancoEntity}</strong></p>
                  <p>Referência: <strong>{deposit.multibancoReference}</strong></p>
                  <p>Valor: <strong>{fmtEur(depositAmount)}</strong></p>
                </div>
              )}
              {payMessage}
              {paymentsLink}
            </div>
          ) : deposit && PAYABLE_STATUSES.has(deposit.status) ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">
                Para garantir a data, falta pagar o sinal de 50%: <strong>{fmtEur(depositAmount)}</strong> (IVA incluído).
                O valor restante é liquidado no dia da festa.
              </p>
              {deposit.status === 'failed' && (
                <p className="text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
                  O último pagamento não foi concluído. Pode tentar de novo.
                </p>
              )}
              <label className="block text-sm font-medium text-gray-700">📱 MB WAY</label>
              <input type="tel" placeholder="9XXXXXXXX" value={mbwayPhone}
                onChange={e => setMbwayPhone(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-400 focus:outline-none" />
              <button onClick={handlePayMbway} disabled={paying}
                className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl hover:bg-green-700 transition disabled:opacity-50">
                {paying ? 'A processar...' : `Pagar ${fmtEur(depositAmount)} com MB WAY`}
              </button>
              {payMessage}
              {deposit.paymentMethod === 'bank_transfer' && (
                <p className="text-xs text-gray-500">
                  Para pagar por transferência bancária, veja o IBAN e a descrição a usar em <Link to="/client/payments" className="text-pink-600 underline">Pagamentos</Link>.
                </p>
              )}
              {paymentsLink}
            </div>
          ) : deposit ? (
            <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
              O pagamento do sinal foi anulado. Se tiver dúvidas, entre em contacto connosco.
            </p>
          ) : createdBillingId ? (
            <p className="text-sm text-gray-600">
              O pagamento do sinal foi criado. Se não aparecer aqui dentro de instantes, veja em <Link to="/client/payments" className="text-pink-600 underline">Pagamentos</Link>.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">
                Para garantir a data, é necessário pagar o sinal de 50% ({fmtEur(depositAmount)}, IVA incluído).
                O valor restante é liquidado no dia da festa.
              </p>
              <button
                onClick={handleCreateDeposit}
                disabled={creatingDeposit}
                className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl hover:bg-green-700 transition disabled:opacity-50"
              >
                {creatingDeposit ? 'A preparar pagamento...' : `Pagar sinal — ${fmtEur(depositAmount)}`}
              </button>
              {payMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
