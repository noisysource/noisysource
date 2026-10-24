import { useCallback, useEffect, useState } from 'react';
import type { AdhocEvent } from '@shared/models';
import AdhocEventEditor from './AdhocEventEditor';
import AdhocRegistrationsPanel from './AdhocRegistrationsPanel';
import { adhocEventService, fmtDay, lisbonToday, lastDay } from '../../../services/adhocEventService';

/** /admin/eventos — one-off events: create/edit, publish, and follow registrations. */
export default function AdhocEventsAdminPage() {
  const [events, setEvents] = useState<AdhocEvent[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const today = lisbonToday();

  const load = useCallback(async () => {
    try {
      setEvents(await adhocEventService.listAll());
    } catch (err) {
      console.error(err);
      setError('Não foi possível carregar os eventos.');
      setEvents([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const selected = events?.find(e => e.id === selectedId) ?? null;

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0">
      <div className="md:w-72 shrink-0 bg-gray-50 border-b md:border-b-0 md:border-r border-gray-200 flex flex-col print:hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Eventos</h2>
          <button onClick={() => setSelectedId('new')} className="text-sm bg-indigo-600 text-white px-3 py-1 rounded hover:bg-indigo-700">+ Novo</button>
        </div>
        <div className="overflow-y-auto flex-1 max-h-64 md:max-h-none">
          {events === null ? (
            <p className="text-sm text-gray-400 p-4">A carregar...</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-gray-400 p-4">Ainda não há eventos.</p>
          ) : events.map(ev => {
            const past = lastDay(ev) < today;
            const taken = ev.days.reduce((n, d) => n + (d.taken ?? 0), 0);
            const cap = ev.days.reduce((n, d) => n + (d.capacity ?? 0), 0);
            return (
              <button key={ev.id} onClick={() => setSelectedId(ev.id)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-white transition-colors ${selectedId === ev.id ? 'bg-white border-l-2 border-l-indigo-500' : ''} ${past ? 'opacity-60' : ''}`}>
                <p className="font-medium text-sm text-gray-800 truncate">{ev.name}</p>
                <p className="text-xs text-gray-500">{ev.days.length ? `${fmtDay(ev.days[0].date)}${ev.days.length > 1 ? ` + ${ev.days.length - 1}` : ''}` : 'sem dias'} · {taken}/{cap} lugares</p>
                <p className="text-xs mt-0.5">
                  {ev.published ? <span className="text-green-700">Publicado</span> : <span className="text-gray-400">Rascunho</span>}
                  {ev.published && !ev.registrationOpen && <span className="text-amber-700"> · inscrições fechadas</span>}
                  {past && <span className="text-gray-400"> · terminado</span>}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {selectedId === null ? (
          <div className="text-gray-500 text-sm max-w-xl">
            <p className="font-medium text-gray-700 mb-1">Eventos pontuais (Halloween, dias de greve...)</p>
            <p>Abertos a todos: quem não tem conta inscreve-se e paga logo por MB WAY (a vaga fica reservada 30 minutos); as famílias KidClub têm o preço de cliente e podem pagar logo ou juntar à mensalidade. Escolha um evento ou crie um novo.</p>
            <p className="mt-2">Página pública: <a href="/eventos" target="_blank" rel="noreferrer" className="text-indigo-600 underline">{window.location.origin}/eventos</a></p>
          </div>
        ) : (
          <>
            <section className="bg-white rounded-lg border border-gray-200 p-4 print:hidden">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-800">{selected ? selected.name : 'Novo evento'}</h2>
                {selected?.published && (
                  <a href={`/eventos/${selected.id}`} target="_blank" rel="noreferrer" className="text-sm text-indigo-600 hover:underline">Ver página pública ↗</a>
                )}
              </div>
              <AdhocEventEditor
                key={selected?.id ?? 'new'}
                event={selected}
                onSaved={async (id) => { await load(); setSelectedId(id); }}
                onDeleted={async () => { setSelectedId(null); await load(); }}
              />
            </section>
            {selected && (
              <section className="bg-white rounded-lg border border-gray-200 p-4">
                <AdhocRegistrationsPanel event={selected} onChanged={load} />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
