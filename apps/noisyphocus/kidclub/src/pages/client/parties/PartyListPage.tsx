import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { familyService } from '../../../services/familyService';
import { partyService } from '../../../services/partyService';
import { Booking, partyVatBreakdown } from '@shared/models';
import { useImpersonation } from '../../../contexts/ImpersonationContext';
import { reportClientError } from '../../../lib/clientErrors';

const STATUS = {
  pending:   { label: 'Aguarda confirmação', cls: 'bg-yellow-100 text-yellow-800' },
  confirmed: { label: 'Confirmada',          cls: 'bg-green-100 text-green-800'  },
  rejected:  { label: 'Não disponível',      cls: 'bg-gray-100 text-gray-600'    },
};

function fmtDate(dateStr: string) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function PartyListPage() {
  const user = useUser();
  const { impersonation } = useImpersonation();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const family = await familyService.getOrCreateFamily(user.uid, user.name ?? '', user.email ?? '');
        // A parent may only query bookings by their own userId (rules aren't
        // filters). While an admin impersonates a family, user.uid is the
        // admin's and matches nothing: query by the family instead.
        const list = await partyService.getBookingsByFamily(family.id, impersonation ? undefined : user.uid);
        setBookings(list);
      } catch (err) {
        reportClientError('[PartyListPage] load bookings failed', err);
        setLoadError('Não foi possível carregar as suas festas. Tente novamente mais tarde.');
      } finally {
        setLoading(false);
      }
    })();
  }, [user, impersonation]);

  if (loading) return <div className="p-6 text-gray-400 text-sm">A carregar...</div>;
  if (loadError) return <div className="p-6 max-w-2xl mx-auto"><p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{loadError}</p></div>;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">🎈 As minhas festas</h1>
        <Link
          to="/client/parties/new"
          className="bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-pink-700 transition"
        >
          + Nova reserva
        </Link>
      </div>

      {bookings.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">🎂</p>
          <p className="font-medium">Ainda não tem nenhuma festa reservada.</p>
          <Link to="/client/parties/new" className="mt-4 inline-block text-pink-600 underline text-sm">
            Reservar uma festa
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map(b => {
            const s = STATUS[b.status] ?? STATUS.pending;
            return (
              <Link
                key={b.id}
                to={`/client/parties/${b.id}`}
                className="block border border-gray-200 rounded-xl p-5 bg-white hover:shadow-md transition"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-gray-800">
                      {b.partyType || 'Festa'} — {b.childName}
                    </p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {fmtDate(b.date)} {b.time ? `às ${b.time}` : ''} · {b.numKids} crianças
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${s.cls}`}>{s.label}</span>
                    <p className="text-sm font-bold text-gray-700 mt-1.5">€{partyVatBreakdown(b.total).total.toFixed(2)}</p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
