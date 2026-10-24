import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdhocEvent } from '@shared/models';
import { adhocEventService, fmtDay, lisbonToday } from '../../services/adhocEventService';

/** Landing page strip: the next published one-off events, linking to /eventos. Renders nothing when there are none. */
export default function UpcomingEventsBanner({ pt }: { pt: boolean }) {
  const [events, setEvents] = useState<AdhocEvent[]>([]);
  useEffect(() => {
    adhocEventService.listUpcoming(lisbonToday()).then(setEvents).catch(() => setEvents([]));
  }, []);
  if (!events.length) return null;

  return (
    <section className="py-10 px-4 bg-orange-50">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-2xl font-bold text-center text-orange-700 mb-2">{pt ? 'Próximos eventos' : 'Upcoming events'}</h2>
        <p className="text-center text-sm text-orange-800 mb-6">
          {pt ? 'Abertos a todas as crianças — não precisa de conta para se inscrever.' : 'Open to every child — no account needed to sign up.'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {events.slice(0, 3).map(ev => (
            <Link key={ev.id} to={`/eventos/${ev.id}`} className="block bg-white border border-orange-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition">
              <p className="text-lg font-bold text-gray-800">{ev.name}</p>
              <p className="text-sm text-gray-600 mt-1">📅 {ev.days.map(d => fmtDay(d.date)).join(' · ')}</p>
              <p className="text-sm font-semibold text-orange-700 mt-3">{pt ? 'Inscrever →' : 'Sign up →'}</p>
            </Link>
          ))}
        </div>
        {events.length > 3 && (
          <p className="text-center mt-4"><Link to="/eventos" className="text-orange-700 font-medium underline">{pt ? 'Ver todos os eventos' : 'See all events'}</Link></p>
        )}
      </div>
    </section>
  );
}
