import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { adhocSeatsLeft, type AdhocEvent, type AdhocEventRegistration } from '@shared/models';
import PublicShell from './PublicShell';
import { adhocEventService, fmtDay, fmtTime, fmtEur, lisbonToday, eventClosedReason } from '../../services/adhocEventService';

const STATUS_LABEL: Record<string, string> = { held: 'A aguardar pagamento', confirmed: 'Confirmada', cancelled: 'Cancelada', expired: 'Expirada' };

/** /eventos — the open one-off events. Public; a signed-in family also sees its own registrations. */
export default function EventsListPage() {
  const user = useUser();
  const [events, setEvents] = useState<AdhocEvent[] | null>(null);
  const [error, setError] = useState('');
  const [mine, setMine] = useState<AdhocEventRegistration[]>([]);
  const today = lisbonToday();

  useEffect(() => {
    adhocEventService.listUpcoming(today).then(setEvents).catch(err => { console.error(err); setError('Não foi possível carregar os eventos.'); setEvents([]); });
  }, [today]);

  useEffect(() => {
    if (!user) { setMine([]); return; }
    adhocEventService.listMine(user.uid)
      .then(list => setMine(list.filter(r => r.status === 'held' || r.status === 'confirmed').sort((a, b) => a.days[0].localeCompare(b.days[0]))))
      .catch(() => setMine([]));
  }, [user]);

  return (
    <PublicShell back={{ to: '/', label: 'Início' }}>
      <h1 className="text-3xl font-bold text-pink-600 mb-1">Eventos</h1>
      <p className="text-gray-600 mb-6">Dias especiais abertos a todas as crianças, clientes ou não. Inscreva e pague em poucos minutos.</p>

      {mine.length > 0 && (
        <section className="mb-8 bg-white border border-indigo-100 rounded-2xl p-4 shadow-sm">
          <h2 className="font-semibold text-indigo-800 mb-2">As minhas inscrições</h2>
          <ul className="divide-y divide-gray-100">
            {mine.map(r => (
              <li key={r.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{r.eventName}</span>
                  <span className="text-gray-500"> · {r.children.map(c => c.name).join(', ')} · {r.days.map(fmtDay).join(', ')}</span>
                </span>
                <Link to={`/eventos/inscricao/${r.id}?t=${encodeURIComponent(r.accessToken)}`} className="shrink-0 text-indigo-600 hover:underline">
                  {STATUS_LABEL[r.status] ?? r.status} →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {events === null ? (
        <p className="text-gray-400">A carregar...</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : events.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-gray-500 shadow-sm">
          <p className="text-4xl mb-2">🎈</p>
          <p>De momento não há eventos com inscrições abertas.</p>
          <p className="text-sm mt-1">Volte em breve!</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {events.map(ev => {
            const upcoming = ev.days.filter(d => d.date >= today);
            const left = upcoming.reduce((n, d) => n + adhocSeatsLeft(d), 0);
            const minPrice = Math.min(...upcoming.map(d => d.price));
            const closed = eventClosedReason(ev, today);
            return (
              <Link key={ev.id} to={`/eventos/${ev.id}`}
                className="block bg-white rounded-2xl border border-pink-100 p-5 shadow-sm hover:shadow-md hover:border-pink-200 transition">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-xl font-bold text-gray-800">{ev.name}</h2>
                  {closed ? (
                    <span className="shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">Inscrições fechadas</span>
                  ) : left === 0 ? (
                    <span className="shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-red-50 text-red-700">Esgotado</span>
                  ) : left <= 5 ? (
                    <span className="shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-700">Últimas vagas</span>
                  ) : null}
                </div>
                <ul className="mt-2 text-sm text-gray-600 space-y-0.5">
                  {upcoming.map(d => (
                    <li key={d.date}>📅 {fmtDay(d.date)}{fmtTime(d) ? ` · ${fmtTime(d)}` : ''}</li>
                  ))}
                </ul>
                {ev.location && <p className="mt-1 text-sm text-gray-500">📍 {ev.location}</p>}
                <p className="mt-3 text-sm">
                  <span className="font-semibold text-pink-600">{upcoming.length > 1 ? 'desde ' : ''}{fmtEur(minPrice)}</span>
                  <span className="text-gray-500"> por criança{upcoming.length > 1 ? ', por dia' : ''} · IVA incluído</span>
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </PublicShell>
  );
}
