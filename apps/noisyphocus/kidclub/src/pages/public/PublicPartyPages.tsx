import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import PartyBookingPage from '../client/parties/PartyBookingPage';
import { callable } from '../../lib/callable';
import { reportClientError } from '../../lib/clientErrors';
import { PARTY_VAT_RATE } from '@shared/models';

// Parties without an account. /festas is the public request form; every party
// email links to /festas/reserva/<bookingId>?t=<token>, where the parent
// follows the request and pays the deposit by MB WAY, signed in or not. Both
// talk to functions/src/kidclub/partyPublic.ts; nothing here reads Firestore
// directly except the party config (public in firestore.rules).

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }

function fmtDate(dateStr: string) {
  const d = new Date(dateStr);
  return isNaN(d.getTime())
    ? dateStr
    : d.toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-fredoka min-h-screen bg-white text-gray-800">
      <div className="flex justify-between items-center p-2 px-4 border-b border-gray-100">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo.png" alt="" className="h-8 object-contain" />
          <span className="text-sm font-semibold text-pink-600">Arco-Íris da Pequenada</span>
        </Link>
        <Link to="/login" className="text-sm font-medium text-blue-600 hover:text-blue-800 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50 transition">
          Área de Clientes
        </Link>
      </div>
      {children}
    </div>
  );
}

export function PublicPartyRequestPage() {
  return <PublicShell><PartyBookingPage guest /></PublicShell>;
}

interface PublicBooking {
  status: 'pending' | 'confirmed' | 'rejected';
  statusReason: string;
  parentName: string;
  childName: string;
  partyType: string;
  date: string;
  time: string;
  numKids: number;
  extras: { name: string; qty: number }[];
  subtotal: number;
  vat: number;
  total: number;
  depositAmount: number;
  depositStatus: 'none' | 'pending' | 'failed' | 'processing' | 'paid' | string;
  phone: string;
}

const POLL_MS = 5000;
const POLL_MAX = 60; // 5 minutes, then the parent refreshes by hand

export function PublicPartyBookingPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const justSent = params.get('novo') === '1';

  const [booking, setBooking] = useState<PublicBooking | null>(null);
  const [loadError, setLoadError] = useState('');
  const [phone, setPhone] = useState('');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [waiting, setWaiting] = useState(false); // MB WAY sent, waiting for the parent to approve
  const polls = useRef(0);

  const load = useCallback(async () => {
    const res = await callable<object, PublicBooking>('getPartyBookingByLink')({ bookingId: id, token });
    setBooking(res.data);
    return res.data;
  }, [id, token]);

  useEffect(() => {
    if (id === 'enviado') return;
    load()
      .then(b => setPhone(p => p || b.phone))
      .catch(err => {
        reportClientError('[PublicPartyBookingPage] load failed', err, { bookingId: id });
        setLoadError(err?.message || 'Não foi possível abrir esta reserva.');
      });
  }, [id, load]);

  // While an MB WAY request is out, follow the bill until it's paid or refused.
  useEffect(() => {
    if (!waiting) return;
    polls.current = 0;
    const timer = setInterval(async () => {
      polls.current += 1;
      try {
        const b = await load();
        if (b.depositStatus !== 'processing' || polls.current >= POLL_MAX) {
          setWaiting(false);
          if (b.depositStatus === 'failed') setPayError('O pagamento MB WAY não foi concluído. Pode tentar de novo.');
        }
      } catch {
        if (polls.current >= POLL_MAX) setWaiting(false);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const pay = async () => {
    setPaying(true);
    setPayError('');
    try {
      await callable('payPartyDepositByLink')({ bookingId: id, token, phone: phone.trim() });
      setWaiting(true);
      await load();
    } catch (err: any) {
      reportClientError('[PublicPartyBookingPage] MB WAY failed', err, { bookingId: id });
      setPayError(err?.message || 'Não foi possível iniciar o pagamento.');
    } finally {
      setPaying(false);
    }
  };

  if (id === 'enviado') {
    return (
      <PublicShell>
        <div className="p-6 max-w-xl mx-auto text-center space-y-3">
          <p className="text-4xl">🎈</p>
          <h1 className="text-2xl font-bold text-gray-800">Pedido enviado</h1>
          <p className="text-sm text-gray-600">Respondemos por email assim que confirmarmos a disponibilidade.</p>
        </div>
      </PublicShell>
    );
  }

  if (loadError) {
    return (
      <PublicShell>
        <div className="p-6 max-w-xl mx-auto space-y-3">
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{loadError}</p>
          <Link to="/festas" className="text-pink-600 underline text-sm">Fazer um pedido de festa</Link>
        </div>
      </PublicShell>
    );
  }

  if (!booking) return <PublicShell><div className="p-6 text-gray-400 text-sm">A carregar...</div></PublicShell>;

  const b = booking;
  const vatPct = Math.round(PARTY_VAT_RATE * 100);
  const canPay = b.status === 'confirmed' && ['none', 'pending', 'failed'].includes(b.depositStatus) && !waiting;

  return (
    <PublicShell>
      <div className="p-6 max-w-xl mx-auto space-y-5">
        {justSent && b.status === 'pending' && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800">
            <p className="font-semibold">Pedido enviado!</p>
            <p className="mt-1">Enviámos-lhe um email com este link. Respondemos por email assim que confirmarmos a disponibilidade.</p>
          </div>
        )}

        <div>
          <h1 className="text-2xl font-bold text-gray-800">🎈 Festa de {b.childName || 'aniversário'}</h1>
          <p className="text-sm text-gray-500 mt-1 ">{fmtDate(b.date)}{b.time ? ` às ${b.time}` : ''}</p>
        </div>

        {b.status === 'pending' && (
          <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4 text-sm text-yellow-800">
            Estamos a confirmar a disponibilidade. Receberá um email com a resposta.
          </div>
        )}
        {b.status === 'rejected' && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-700">
            <p className="font-medium">Não foi possível confirmar esta data.</p>
            {b.statusReason && <p className="mt-1">{b.statusReason}</p>}
            <Link to="/festas" className="mt-3 inline-block text-pink-600 underline">Fazer um novo pedido</Link>
          </div>
        )}

        <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-gray-500">Festa</span><span className="font-medium">{b.partyType || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Crianças</span><span className="font-medium">{b.numKids}</span></div>
          {b.extras.length > 0 && (
            <div className="flex justify-between gap-4">
              <span className="text-gray-500">Extras</span>
              <span className="font-medium text-right">{b.extras.map(e => (e.qty > 1 ? `${e.qty} × ${e.name}` : e.name)).join(', ')}</span>
            </div>
          )}
          <div className="border-t pt-2 flex justify-between"><span className="text-gray-500">Subtotal (sem IVA)</span><span>{fmtEur(b.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">IVA ({vatPct}%)</span><span>{fmtEur(b.vat)}</span></div>
          <div className="flex justify-between font-bold text-gray-800"><span>Total</span><span>{fmtEur(b.total)}</span></div>
        </div>

        {b.status === 'confirmed' && (
          <div className="bg-white border border-green-200 rounded-xl p-5 space-y-3">
            <p className="font-semibold text-gray-800">Sinal de 50%: {fmtEur(b.depositAmount)} <span className="text-xs font-normal text-gray-500">(IVA incluído)</span></p>

            {b.depositStatus === 'paid' ? (
              <p className="text-sm text-green-700 font-medium">✓ Sinal pago. A reserva está garantida; o valor restante é pago no dia da festa.</p>
            ) : waiting || b.depositStatus === 'processing' ? (
              <div className="text-sm text-gray-700 space-y-1">
                <p className="font-medium">📱 Aprove o pagamento na app MB WAY.</p>
                <p className="text-gray-500">{waiting ? 'Esta página atualiza sozinha quando o pagamento for aprovado.' : 'Já aprovou? Atualize a página daqui a pouco.'}</p>
              </div>
            ) : (
              <p className="text-sm text-gray-600">A festa está confirmada. Para garantir a data, pague o sinal por MB WAY. O valor restante é pago no dia da festa.</p>
            )}

            {canPay && (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-600">Telemóvel associado ao MB WAY</label>
                <input type="tel" placeholder="9XXXXXXXX" value={phone} onChange={e => setPhone(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-400 focus:outline-none" />
                <button onClick={pay} disabled={paying || phone.replace(/\D/g, '').length < 9}
                  className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl hover:bg-green-700 transition disabled:opacity-50">
                  {paying ? 'A enviar pedido MB WAY...' : `Pagar sinal — ${fmtEur(b.depositAmount)}`}
                </button>
              </div>
            )}
            {payError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{payError}</p>}
          </div>
        )}

        <p className="text-xs text-gray-400">
          Guarde o email com este link: é por ele que acompanha a reserva. Dúvidas? Escreva para{' '}
          <a href="mailto:geral.arcoirisdapequenada@gmail.com" className="underline">geral.arcoirisdapequenada@gmail.com</a>.
        </p>
      </div>
    </PublicShell>
  );
}
