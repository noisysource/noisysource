import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import { getDoc, getDocs, query, where } from 'firebase/firestore';
import { useUser } from '@shared/hooks';
import { adhocDayPrice, adhocSeatsLeft, adhocTotal, ADHOC_MAX_CHILDREN, ADHOC_HOLD_MINUTES, type AdhocEvent, type Child } from '@shared/models';
import PublicShell from './PublicShell';
import { col, docRef } from '../../lib/db';
import { familyService } from '../../services/familyService';
import { useImpersonation } from '../../contexts/ImpersonationContext';
import { isValidNif, normalizeNif } from '../../lib/nif';
import { reportClientError } from '../../lib/clientErrors';
import { adhocEventService, fmtDay, fmtTime, fmtEur, lisbonToday, eventClosedReason, callableMessage } from '../../services/adhocEventService';

interface FamilyInfo { id: string; name: string; email: string; phone: string }
interface GuestChild { name: string; birthDate: string; healthNotes: string }

const emptyChild = (): GuestChild => ({ name: '', birthDate: '', healthNotes: '' });
const childName = (c: Child) => `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || (c as any).name || 'Criança';
const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300';

/**
 * /eventos/:eventId — event details and the signup form. A signed-in parent
 * with a family signs up their own children at the member price and may put
 * it on the monthly bill; anyone else is a guest and pays now by MB WAY.
 */
export default function EventSignupPage() {
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useUser();
  const { impersonation } = useImpersonation();
  const today = lisbonToday();

  const [ev, setEv] = useState<AdhocEvent | null | undefined>(undefined);
  const [family, setFamily] = useState<FamilyInfo | null>(null);
  const [kids, setKids] = useState<Child[]>([]);
  const [familyLoading, setFamilyLoading] = useState(true);

  const [days, setDays] = useState<string[]>([]);
  const [childIds, setChildIds] = useState<string[]>([]);
  const [memberNotes, setMemberNotes] = useState<Record<string, string>>({});
  const [guestKids, setGuestKids] = useState<GuestChild[]>([emptyChild()]);
  const [guardian, setGuardian] = useState({ name: '', email: '', phone: '', nif: '' });
  const [pickupNotes, setPickupNotes] = useState('');
  const [photoConsent, setPhotoConsent] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [payment, setPayment] = useState<'now' | 'monthly'>('now');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    adhocEventService.get(eventId).then(e => {
      setEv(e);
      const open = (e?.days ?? []).filter(d => d.date >= today && adhocSeatsLeft(d) > 0);
      if (open.length === 1) setDays([open[0].date]);
    }).catch(err => { console.error(err); setEv(null); });
  }, [eventId, today]);

  // Member or guest. Never creates a family (unlike familyService.getOrCreateFamily).
  useEffect(() => {
    if (user === undefined) return;
    if (!user) { setFamily(null); setKids([]); setFamilyLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        let famId = '';
        let data: any = null;
        if (impersonation) {
          const snap = await getDoc(docRef('families', impersonation.familyId));
          if (snap.exists()) { famId = snap.id; data = snap.data(); }
        } else {
          const snap = await getDocs(query(col('families'), where('primaryContact.userId', '==', user.uid)));
          const oldest = snap.docs.sort((a, b) => (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0))[0];
          if (oldest) { famId = oldest.id; data = oldest.data(); }
        }
        if (cancelled) return;
        if (!famId) {
          setFamily(null);
          setGuardian(g => ({ ...g, name: g.name || user.name || '', email: g.email || user.email || '' }));
          return;
        }
        const pc = data.primaryContact ?? {};
        setFamily({ id: famId, name: pc.name ?? '', email: pc.email ?? '', phone: pc.phone ?? '' });
        setGuardian(g => ({ ...g, phone: g.phone || pc.phone || '' }));
        const children = await familyService.getFamilyChildren(famId, false, impersonation ? undefined : user.uid);
        if (cancelled) return;
        setKids(children);
        setMemberNotes(Object.fromEntries(children.map(c => [c.id, c.medicalNotes ?? ''])));
      } catch (err) {
        console.error(err);
        reportClientError('[eventos] load family failed', err, { eventId });
      } finally {
        if (!cancelled) setFamilyLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, impersonation, eventId]);

  const member = !!family;
  const tier = member ? 'member' : 'public';
  const childCount = member ? childIds.length : guestKids.length;
  const total = useMemo(() => (ev ? adhocTotal(ev.days, days, childCount, tier) : 0), [ev, days, childCount, tier]);
  const hasMemberPrice = !!ev?.days.some(d => typeof d.memberPrice === 'number' && d.memberPrice < d.price);

  if (ev === undefined) return <PublicShell><p className="text-gray-400">A carregar...</p></PublicShell>;
  if (ev === null) {
    return (
      <PublicShell back={{ to: '/eventos', label: 'Eventos' }}>
        <p className="text-gray-600">Evento não encontrado.</p>
      </PublicShell>
    );
  }

  const closed = eventClosedReason(ev, today);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const validate = (): string => {
    if (!days.length) return 'Escolha pelo menos um dia.';
    if (!childCount) return 'Escolha pelo menos uma criança.';
    if (!member) {
      if (guestKids.some(k => k.name.trim().length < 2)) return 'Indique o nome de cada criança.';
      if (guardian.name.trim().length < 2) return 'Indique o nome do encarregado de educação.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardian.email.trim())) return 'Indique um email válido.';
      if (guardian.nif.trim() && !isValidNif(guardian.nif)) return 'NIF inválido — confirme os 9 dígitos, ou deixe em branco.';
    }
    if (guardian.phone.replace(/\D/g, '').length < 9) return 'Indique um número de telemóvel válido.';
    if (!acceptTerms) return 'É necessário aceitar os termos e a política de privacidade.';
    return '';
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const msg = validate();
    if (msg) { setError(msg); return; }
    setError('');
    setSubmitting(true);
    try {
      const res = await adhocEventService.register({
        eventId: ev.id,
        days,
        guardian: member
          ? { phone: guardian.phone }
          : { name: guardian.name.trim(), email: guardian.email.trim(), phone: guardian.phone, ...(guardian.nif.trim() ? { nif: normalizeNif(guardian.nif) } : {}) },
        children: member
          ? childIds.map(id => ({ childId: id, ...(memberNotes[id]?.trim() ? { healthNotes: memberNotes[id].trim() } : {}) }))
          : guestKids.map(k => ({ name: k.name.trim(), ...(k.birthDate ? { birthDate: k.birthDate } : {}), ...(k.healthNotes.trim() ? { healthNotes: k.healthNotes.trim() } : {}) })),
        ...(pickupNotes.trim() ? { pickupNotes: pickupNotes.trim() } : {}),
        photoConsent,
        acceptTerms,
        payment: member ? payment : 'now',
        ...(impersonation && family ? { familyId: family.id } : {}),
      });
      navigate(`/eventos/inscricao/${res.registrationId}?t=${encodeURIComponent(res.token)}`);
    } catch (err) {
      console.error(err);
      reportClientError('[eventos] register failed', err, { eventId: ev.id });
      setError(callableMessage(err, 'Não foi possível concluir a inscrição. Tente novamente.'));
      adhocEventService.get(ev.id).then(fresh => fresh && setEv(fresh)).catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PublicShell back={{ to: '/eventos', label: 'Eventos' }}>
      <h1 className="text-3xl font-bold text-pink-600">{ev.name}</h1>
      {ev.location && <p className="text-gray-500 mt-1">📍 {ev.location}</p>}
      {ev.description && <p className="text-gray-700 mt-3 whitespace-pre-line">{ev.description}</p>}

      {closed ? (
        <div className="mt-6 bg-white border border-gray-200 rounded-2xl p-5 text-gray-600">{closed}</div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-5" noValidate>
          {/* Who's signing up */}
          {familyLoading ? null : member ? (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3 text-sm text-indigo-800">
              A inscrever como família KidClub{family?.name ? ` — ${family.name}` : ''}{hasMemberPrice ? ', com preço de cliente' : ''}.
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-600">
              Não precisa de conta para se inscrever.{' '}
              {!user && (
                <>Já é cliente KidClub? <Link to="/login" state={{ from: location.pathname }} className="text-indigo-600 font-medium hover:underline">Entre</Link>
                {hasMemberPrice ? ' para ter o preço de cliente' : ''} e poder juntar à mensalidade.</>
              )}
            </div>
          )}

          {/* Days */}
          <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="font-semibold text-gray-800 mb-3">Dias</h2>
            <div className="space-y-2">
              {ev.days.map(d => {
                const past = d.date < today;
                const left = adhocSeatsLeft(d);
                const disabled = past || left === 0;
                const price = adhocDayPrice(d, tier);
                return (
                  <label key={d.date} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-pink-50'} ${days.includes(d.date) ? 'border-pink-300 bg-pink-50' : 'border-gray-200'}`}>
                    <input type="checkbox" disabled={disabled} checked={days.includes(d.date)} onChange={() => setDays(toggle(days, d.date))} className="accent-pink-600" />
                    <span className="flex-1 min-w-0">
                      <span className="font-medium">{fmtDay(d.date)}</span>
                      {fmtTime(d) && <span className="text-gray-500 text-sm"> · {fmtTime(d)}</span>}
                      <span className="block text-xs text-gray-500">
                        {past ? 'Já passou' : left === 0 ? 'Esgotado' : left <= 5 ? `Últimas ${left} vagas` : `${left} vagas`}
                      </span>
                    </span>
                    <span className="text-sm font-semibold text-gray-700 shrink-0">
                      {member && price < d.price && <span className="line-through text-gray-400 font-normal mr-1">{fmtEur(d.price)}</span>}
                      {fmtEur(price)}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-gray-400 mt-2">Preço por criança, por dia, IVA incluído.</p>
          </section>

          {/* Children */}
          <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="font-semibold text-gray-800 mb-3">Crianças</h2>
            {member ? (
              kids.length === 0 ? (
                <p className="text-sm text-gray-500">Ainda não tem crianças registadas. <Link to="/client/children" className="text-indigo-600 hover:underline">Adicione-as em As minhas crianças</Link>.</p>
              ) : (
                <div className="space-y-3">
                  {kids.map(c => (
                    <div key={c.id} className={`rounded-lg border px-3 py-2 ${childIds.includes(c.id) ? 'border-pink-300 bg-pink-50' : 'border-gray-200'}`}>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" checked={childIds.includes(c.id)}
                          disabled={!childIds.includes(c.id) && childIds.length >= ADHOC_MAX_CHILDREN}
                          onChange={() => setChildIds(toggle(childIds, c.id))} className="accent-pink-600" />
                        <span className="font-medium">{childName(c)}</span>
                      </label>
                      {childIds.includes(c.id) && (
                        <input className={`${inputCls} mt-2`} placeholder="Alergias, medicação ou outras notas de saúde (opcional)"
                          value={memberNotes[c.id] ?? ''} onChange={e => setMemberNotes({ ...memberNotes, [c.id]: e.target.value })} maxLength={500} />
                      )}
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div className="space-y-4">
                {guestKids.map((k, i) => (
                  <div key={i} className="space-y-2 rounded-lg border border-gray-200 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-600">Criança {i + 1}</span>
                      {guestKids.length > 1 && (
                        <button type="button" onClick={() => setGuestKids(guestKids.filter((_, j) => j !== i))} className="text-xs text-red-600 hover:underline">Remover</button>
                      )}
                    </div>
                    <input className={inputCls} placeholder="Nome completo" value={k.name} maxLength={100}
                      onChange={e => setGuestKids(guestKids.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <label className="block text-xs text-gray-500">Data de nascimento
                      <input type="date" className={`${inputCls} mt-1`} value={k.birthDate} max={today}
                        onChange={e => setGuestKids(guestKids.map((x, j) => j === i ? { ...x, birthDate: e.target.value } : x))} />
                    </label>
                    <input className={inputCls} placeholder="Alergias, medicação ou outras notas de saúde (opcional)" value={k.healthNotes} maxLength={500}
                      onChange={e => setGuestKids(guestKids.map((x, j) => j === i ? { ...x, healthNotes: e.target.value } : x))} />
                  </div>
                ))}
                {guestKids.length < ADHOC_MAX_CHILDREN && (
                  <button type="button" onClick={() => setGuestKids([...guestKids, emptyChild()])} className="text-sm text-pink-600 font-medium hover:underline">+ Adicionar outra criança</button>
                )}
              </div>
            )}
          </section>

          {/* Guardian */}
          <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
            <h2 className="font-semibold text-gray-800">Encarregado de educação</h2>
            {member ? (
              <p className="text-sm text-gray-600">{family?.name}{family?.email ? ` · ${family.email}` : ''}</p>
            ) : (
              <>
                <input className={inputCls} placeholder="Nome" value={guardian.name} maxLength={100} autoComplete="name"
                  onChange={e => setGuardian({ ...guardian, name: e.target.value })} />
                <input className={inputCls} type="email" placeholder="Email (recebe a confirmação e a fatura)" value={guardian.email} maxLength={200} autoComplete="email"
                  onChange={e => setGuardian({ ...guardian, email: e.target.value })} />
              </>
            )}
            <input className={inputCls} type="tel" placeholder="Telemóvel" value={guardian.phone} maxLength={20} autoComplete="tel"
              onChange={e => setGuardian({ ...guardian, phone: e.target.value })} />
            {!member && (
              <input className={inputCls} inputMode="numeric" placeholder="NIF para a fatura (opcional)" value={guardian.nif} maxLength={11}
                onChange={e => setGuardian({ ...guardian, nif: e.target.value })} />
            )}
            <textarea className={inputCls} rows={2} placeholder="Quem vai buscar a(s) criança(s)? (nome e contacto, se não for o próprio)" value={pickupNotes} maxLength={500}
              onChange={e => setPickupNotes(e.target.value)} />
          </section>

          {/* Payment (members) */}
          {member && (
            <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-2">
              <h2 className="font-semibold text-gray-800 mb-1">Pagamento</h2>
              <label className={`flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer ${payment === 'now' ? 'border-pink-300 bg-pink-50' : 'border-gray-200'}`}>
                <input type="radio" name="payment" checked={payment === 'now'} onChange={() => setPayment('now')} className="mt-1 accent-pink-600" />
                <span><span className="font-medium">Pagar agora com MB WAY</span><span className="block text-xs text-gray-500">A inscrição fica confirmada assim que pagar.</span></span>
              </label>
              <label className={`flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer ${payment === 'monthly' ? 'border-pink-300 bg-pink-50' : 'border-gray-200'}`}>
                <input type="radio" name="payment" checked={payment === 'monthly'} onChange={() => setPayment('monthly')} className="mt-1 accent-pink-600" />
                <span><span className="font-medium">Juntar à mensalidade</span><span className="block text-xs text-gray-500">Fica confirmada já; o valor entra na mensalidade do mês do evento (ou na seguinte, se essa já estiver paga).</span></span>
              </label>
            </section>
          )}

          {/* Consents */}
          <section className="space-y-2 text-sm text-gray-700">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={photoConsent} onChange={e => setPhotoConsent(e.target.checked)} className="mt-1 accent-pink-600" />
              <span>Autorizo fotografias da(s) criança(s) durante o evento, para partilha com as famílias e nas redes do Arco-Íris.</span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={acceptTerms} onChange={e => setAcceptTerms(e.target.checked)} className="mt-1 accent-pink-600" />
              <span>Li e aceito os <Link to="/terms" target="_blank" className="text-indigo-600 underline">termos</Link> e a <Link to="/privacy" target="_blank" className="text-indigo-600 underline">política de privacidade</Link>.</span>
            </label>
          </section>

          {/* Total + submit */}
          <div className="bg-white rounded-2xl border border-pink-200 shadow-sm p-5">
            <div className="flex items-baseline justify-between">
              <span className="text-gray-600">Total</span>
              <span className="text-2xl font-bold text-pink-600">{fmtEur(total)}</span>
            </div>
            <p className="text-xs text-gray-400 text-right">IVA incluído · {childCount} criança(s) × {days.length} dia(s)</p>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={submitting || familyLoading}
              className="mt-4 w-full bg-pink-600 text-white font-semibold py-3 rounded-xl hover:bg-pink-700 disabled:opacity-60 transition">
              {submitting ? 'A enviar...' : member && payment === 'monthly' ? 'Inscrever e juntar à mensalidade' : total > 0 ? 'Continuar para pagamento' : 'Inscrever'}
            </button>
            {(!member || payment === 'now') && total > 0 && (
              <p className="mt-2 text-xs text-gray-500 text-center">A vaga fica reservada durante {ADHOC_HOLD_MINUTES} minutos enquanto paga por MB WAY.</p>
            )}
          </div>
        </form>
      )}
    </PublicShell>
  );
}
