import { useState } from 'react';
import { adhocSeatsLeft, adhocTotal, ADHOC_MAX_CHILDREN, type AdhocEvent } from '@shared/models';
import { isValidNif, normalizeNif } from '../../../lib/nif';
import { adhocEventService, fmtDay, fmtEur, callableMessage } from '../../../services/adhocEventService';

const input = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm';

/**
 * Admin adds a registration by hand (phone call, at the door) for someone
 * without an account. Public price; seats held until it's paid or cancelled
 * (no 30-minute expiry), also on a closed event. Then: mark it paid by
 * transfer, or copy the payment link to the family. For a KidClub family,
 * impersonate them and sign up on /eventos instead (member price, monthly bill).
 */
export default function WalkInForm({ event, onDone, onCancel }: { event: AdhocEvent; onDone: (message: string) => void; onCancel: () => void }) {
  const [days, setDays] = useState<string[]>([]);
  const [kids, setKids] = useState([{ name: '', birthDate: '', healthNotes: '' }]);
  const [g, setG] = useState({ name: '', email: '', phone: '', nif: '' });
  const [pickupNotes, setPickupNotes] = useState('');
  const [photoConsent, setPhotoConsent] = useState(false);
  const [terms, setTerms] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const total = adhocTotal(event.days, days, kids.length, 'public');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (g.nif.trim() && !isValidNif(g.nif)) { setError('NIF inválido.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await adhocEventService.register({
        eventId: event.id,
        days,
        guardian: { name: g.name.trim(), email: g.email.trim(), phone: g.phone, ...(g.nif.trim() ? { nif: normalizeNif(g.nif) } : {}) },
        children: kids.map(k => ({ name: k.name.trim(), ...(k.birthDate ? { birthDate: k.birthDate } : {}), ...(k.healthNotes.trim() ? { healthNotes: k.healthNotes.trim() } : {}) })),
        ...(pickupNotes.trim() ? { pickupNotes: pickupNotes.trim() } : {}),
        photoConsent,
        acceptTerms: terms,
        payment: 'now',
        adminEntry: true,
      });
      onDone(res.status === 'confirmed' ? 'Inscrição criada e confirmada.' : `Inscrição criada (${fmtEur(res.total)} por pagar). Marque-a como paga quando receber a transferência, ou copie o link de pagamento para a família.`);
    } catch (err) {
      setError(callableMessage(err, 'Não foi possível criar a inscrição.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <p className="text-xs text-gray-500">Para alguém sem conta (preço público). Para uma família KidClub, use "👁 Ver como cliente" (Famílias e inscrições) e inscreva em /eventos — fica com preço de cliente e pode juntar à mensalidade.</p>
      <div className="flex flex-wrap gap-2">
        {event.days.map(d => (
          <label key={d.date} className={`flex items-center gap-1.5 border rounded px-2 py-1 ${days.includes(d.date) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-300'}`}>
            <input type="checkbox" checked={days.includes(d.date)} onChange={() => setDays(days.includes(d.date) ? days.filter(x => x !== d.date) : [...days, d.date])} />
            {fmtDay(d.date)} <span className="text-gray-400">({adhocSeatsLeft(d)} vagas)</span>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input className={input} placeholder="Encarregado — nome *" value={g.name} onChange={e => setG({ ...g, name: e.target.value })} />
        <input className={input} placeholder="Email *" type="email" value={g.email} onChange={e => setG({ ...g, email: e.target.value })} />
        <input className={input} placeholder="Telemóvel *" type="tel" value={g.phone} onChange={e => setG({ ...g, phone: e.target.value })} />
        <input className={input} placeholder="NIF (opcional)" value={g.nif} onChange={e => setG({ ...g, nif: e.target.value })} />
      </div>
      {kids.map((k, i) => (
        <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
          <input className={input} placeholder={`Criança ${i + 1} — nome *`} value={k.name} onChange={e => setKids(kids.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
          <input className={input} type="date" value={k.birthDate} onChange={e => setKids(kids.map((x, j) => j === i ? { ...x, birthDate: e.target.value } : x))} />
          <input className={input} placeholder="Saúde / alergias" value={k.healthNotes} onChange={e => setKids(kids.map((x, j) => j === i ? { ...x, healthNotes: e.target.value } : x))} />
          {kids.length > 1 ? <button type="button" onClick={() => setKids(kids.filter((_, j) => j !== i))} className="text-xs text-red-600">✕</button> : <span />}
        </div>
      ))}
      {kids.length < ADHOC_MAX_CHILDREN && <button type="button" onClick={() => setKids([...kids, { name: '', birthDate: '', healthNotes: '' }])} className="text-xs text-indigo-600 hover:underline">+ Criança</button>}
      <input className={input} placeholder="Recolha (quem vai buscar)" value={pickupNotes} onChange={e => setPickupNotes(e.target.value)} />
      <div className="flex flex-wrap gap-4 text-xs text-gray-700">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={photoConsent} onChange={e => setPhotoConsent(e.target.checked)} /> Autoriza fotografias</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} /> A família foi informada e aceita os termos e a política de privacidade</label>
      </div>
      {error && <p className="text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700 disabled:opacity-60">{saving ? 'A criar...' : `Criar inscrição · ${fmtEur(total)}`}</button>
        <button type="button" onClick={onCancel} className="text-gray-500 hover:text-gray-700">Cancelar</button>
      </div>
    </form>
  );
}
