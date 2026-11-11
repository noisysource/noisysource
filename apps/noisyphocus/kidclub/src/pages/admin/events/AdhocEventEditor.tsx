import { useState } from 'react';
import type { AdhocEvent } from '@shared/models';
import { kidclubVatNote } from '@shared/models/kidclubVat';
import { adhocEventService, callableMessage } from '../../../services/adhocEventService';

interface DayForm { date: string; startTime: string; endTime: string; capacity: string; price: string; memberPrice: string; taken: number }

const toForm = (ev: AdhocEvent | null) => ({
  name: ev?.name ?? '',
  description: ev?.description ?? '',
  location: ev?.location ?? '',
  published: ev?.published ?? false,
  registrationOpen: ev?.registrationOpen ?? true,
  closesOn: ev?.closesOn ?? '',
  days: (ev?.days ?? []).map<DayForm>(d => ({
    date: d.date, startTime: d.startTime ?? '', endTime: d.endTime ?? '',
    capacity: String(d.capacity), price: String(d.price), memberPrice: d.memberPrice === undefined ? '' : String(d.memberPrice), taken: d.taken ?? 0,
  })),
});

const newDay = (prev?: DayForm): DayForm => ({
  date: '', startTime: prev?.startTime ?? '09:00', endTime: prev?.endTime ?? '17:30',
  capacity: prev?.capacity ?? '20', price: prev?.price ?? '', memberPrice: prev?.memberPrice ?? '', taken: 0,
});

const input = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm';

/** Create or edit a one-off event. Seat counts are the server's; prices are com IVA (23%). */
export default function AdhocEventEditor({ event, onSaved, onDeleted }: {
  event: AdhocEvent | null;
  onSaved: (eventId: string) => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState(() => {
    const f = toForm(event);
    return f.days.length ? f : { ...f, days: [newDay()] };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const setDay = (i: number, patch: Partial<DayForm>) => setForm(f => ({ ...f, days: f.days.map((d, j) => j === i ? { ...d, ...patch } : d) }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    if (form.days.some(d => !d.date || d.price === '' || d.capacity === '')) { setError('Cada dia precisa de data, capacidade e preço.'); return; }
    setSaving(true);
    try {
      const { eventId } = await adhocEventService.save({
        ...(event ? { eventId: event.id } : {}),
        name: form.name,
        description: form.description,
        location: form.location,
        published: form.published,
        registrationOpen: form.registrationOpen,
        closesOn: form.closesOn || undefined,
        days: form.days.map(d => ({
          date: d.date,
          ...(d.startTime ? { startTime: d.startTime } : {}),
          ...(d.endTime ? { endTime: d.endTime } : {}),
          capacity: Number(d.capacity),
          price: Number(d.price),
          ...(d.memberPrice !== '' ? { memberPrice: Number(d.memberPrice) } : {}),
        })),
      });
      setSaved(true);
      onSaved(eventId);
    } catch (err) {
      setError(callableMessage(err, 'Não foi possível guardar.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!event || !confirm(`Apagar "${event.name}"? Só é possível sem inscrições.`)) return;
    try {
      await adhocEventService.remove(event.id);
      onDeleted();
    } catch (err) {
      setError(callableMessage(err, 'Não foi possível apagar.'));
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-sm font-medium text-gray-700">Nome *
          <input className={`${input} mt-1`} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="ex. Halloween 2026, Greve 14/11" maxLength={120} />
        </label>
        <label className="block text-sm font-medium text-gray-700">Local
          <input className={`${input} mt-1`} value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} placeholder="ex. Arco-Íris, Guarda Inglesa" maxLength={200} />
        </label>
      </div>
      <label className="block text-sm font-medium text-gray-700">Descrição (aparece na página pública)
        <textarea className={`${input} mt-1`} rows={4} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
          placeholder="O que vão fazer, o que levar (lanche, muda de roupa...), idades." maxLength={4000} />
      </label>

      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium text-gray-700">Dias</p>
          <button type="button" onClick={() => setForm(f => ({ ...f, days: [...f.days, newDay(f.days[f.days.length - 1])] }))} className="text-xs text-indigo-600 hover:underline">+ Dia</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="font-medium pb-1 pr-2">Data</th>
                <th className="font-medium pb-1 pr-2">Início</th>
                <th className="font-medium pb-1 pr-2">Fim</th>
                <th className="font-medium pb-1 pr-2">Vagas</th>
                <th className="font-medium pb-1 pr-2">Preço €</th>
                <th className="font-medium pb-1 pr-2">Preço cliente €</th>
                <th className="font-medium pb-1 pr-2">Ocupadas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.days.map((d, i) => (
                <tr key={i} className="align-top">
                  <td className="pr-2 pb-2"><input type="date" className={input} value={d.date} disabled={d.taken > 0} onChange={e => setDay(i, { date: e.target.value })} /></td>
                  <td className="pr-2 pb-2"><input type="time" className={input} value={d.startTime} onChange={e => setDay(i, { startTime: e.target.value })} /></td>
                  <td className="pr-2 pb-2"><input type="time" className={input} value={d.endTime} onChange={e => setDay(i, { endTime: e.target.value })} /></td>
                  <td className="pr-2 pb-2 w-20"><input type="number" min={0} className={input} value={d.capacity} onChange={e => setDay(i, { capacity: e.target.value })} /></td>
                  <td className="pr-2 pb-2 w-28">
                    <input type="number" min={0} step="0.01" className={input} value={d.price} onChange={e => setDay(i, { price: e.target.value })} />
                    {d.price !== '' && Number(d.price) > 0 && <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">{kidclubVatNote(Number(d.price), 'event')}</p>}
                  </td>
                  <td className="pr-2 pb-2 w-28">
                    <input type="number" min={0} step="0.01" className={input} value={d.memberPrice} placeholder="= preço" onChange={e => setDay(i, { memberPrice: e.target.value })} />
                  </td>
                  <td className="pr-2 pb-2 text-gray-600 pt-1.5">{d.taken}{Number(d.capacity) > 0 && d.taken > Number(d.capacity) && <span className="text-red-600"> ⚠️</span>}</td>
                  <td className="pb-2 pt-1">
                    {d.taken === 0 && form.days.length > 1 && (
                      <button type="button" onClick={() => setForm(f => ({ ...f, days: f.days.filter((_, j) => j !== i) }))} className="text-xs text-red-600 hover:underline">Remover</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400">Preços por criança e por dia, com IVA (23%). "Preço cliente" vazio = famílias KidClub pagam o mesmo. Um dia com inscrições não pode ser removido nem mudar de data.</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.published} onChange={e => setForm({ ...form, published: e.target.checked })} /> Publicado (visível em /eventos)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.registrationOpen} onChange={e => setForm({ ...form, registrationOpen: e.target.checked })} /> Inscrições abertas</label>
        <label className="flex items-center gap-2">Fecham a
          <input type="date" className="border border-gray-300 rounded px-2 py-1 text-sm" value={form.closesOn} onChange={e => setForm({ ...form, closesOn: e.target.value })} />
          <span className="text-xs text-gray-400">(inclusive, opcional)</span>
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && !error && <p className="text-sm text-green-700">Guardado.</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="bg-indigo-600 text-white text-sm px-4 py-2 rounded hover:bg-indigo-700 disabled:opacity-60">{saving ? 'A guardar...' : event ? 'Guardar alterações' : 'Criar evento'}</button>
        {event && form.days.every(d => d.taken === 0) && (
          <button type="button" onClick={remove} className="text-sm text-red-600 hover:underline">Apagar evento</button>
        )}
      </div>
    </form>
  );
}
