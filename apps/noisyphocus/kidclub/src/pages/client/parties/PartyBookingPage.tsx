import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child, Family, PartyConfig, ExtraItem, computePartyPrice, PARTY_VAT_RATE } from '@shared/models';
import { familyService } from '../../../services/familyService';
import { partyService } from '../../../services/partyService';
import { normalizeEmail } from '../../../lib/utils';
import { reportClientError } from '../../../lib/clientErrors';
import { callable } from '../../../lib/callable';

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }

const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Party booking form. `guest`: the public form at /festas, for anyone, with no
 * account. It asks for the parent's contact details instead of picking a child
 * from the family, and sends the request to requestPartyBooking, which prices
 * and saves it on the server (functions/src/kidclub/partyPublic.ts).
 */
export default function PartyBookingPage({ guest = false }: { guest?: boolean }) {
  const user = useUser();
  const navigate = useNavigate();

  const [config, setConfig] = useState<PartyConfig | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [family, setFamily] = useState<Family | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(1);

  // Form state
  const [partyType, setPartyType] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [numKids, setNumKids] = useState(10);
  // Quantity per extra name; 0 or missing means not chosen.
  const [extraQtys, setExtraQtys] = useState<Record<string, number>>({});
  const [childId, setChildId] = useState('');
  const [manualChild, setManualChild] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualAge, setManualAge] = useState<number | ''>('');
  // Guest form only
  const [parentName, setParentName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [nif, setNif] = useState('');
  const [notes, setNotes] = useState('');
  const [website, setWebsite] = useState(''); // honeypot, hidden from people
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (!guest) return;
    partyService.getPartyConfig()
      .then(setConfig)
      .catch(err => {
        reportClientError('[PartyBookingPage] guest load failed', err);
        setLoadError('Não foi possível carregar o formulário de reserva. Tente novamente mais tarde.');
      })
      .finally(() => setLoading(false));
  }, [guest]);

  useEffect(() => {
    if (guest || !user) return;
    (async () => {
      try {
        const [cfg, fam] = await Promise.all([
          partyService.getPartyConfig(),
          familyService.getOrCreateFamily(user.uid, user.name ?? '', user.email ?? ''),
        ]);
        setConfig(cfg);
        setFamily(fam);
        const kids = await familyService.getFamilyChildren(fam.id, false, user.uid);
        setChildren(kids);
        if (kids.length === 1) setChildId(kids[0].id);
      } catch (err) {
        reportClientError('[PartyBookingPage] load failed', err);
        setLoadError('Não foi possível carregar o formulário de reserva. Tente novamente mais tarde.');
      } finally {
        setLoading(false);
      }
    })();
  }, [user, guest]);

  const selectedType = config?.partyTypes.find(pt => pt.name === partyType);

  const extras = useMemo(
    () => (config?.extras ?? []).filter(ex => (extraQtys[ex.name] ?? 0) > 0).map(ex => ex.name),
    [config, extraQtys],
  );
  const extrasDetail = useMemo(
    () => Object.fromEntries(extras.map(name => [name, extraQtys[name]])),
    [extras, extraQtys],
  );

  const price = useMemo(
    () => (config ? computePartyPrice(config, { partyType, numKids, extras, extrasDetail }) : null),
    [config, partyType, numKids, extras, extrasDetail],
  );

  const setExtraQty = (name: string, qty: number) =>
    setExtraQtys(prev => ({ ...prev, [name]: Math.max(0, Math.min(999, Math.floor(qty) || 0)) }));

  const toggleExtra = (ex: ExtraItem) => setExtraQty(ex.name, (extraQtys[ex.name] ?? 0) > 0 ? 0 : 1);

  // With no registered children the name fields are the only option, without
  // "+ Outra criança" ever being clicked: manualChild alone left the button
  // disabled for good.
  const typedChild = guest || manualChild || children.length === 0;
  const childMissing = typedChild ? !manualName.trim() : !childId;
  const contactMissing = guest && (!parentName.trim() || !EMAIL_RE.test(email.trim()) || phone.replace(/\D/g, '').length < 9);
  const nifInvalid = guest && !!nif.trim() && !/^\d{9}$/.test(nif.replace(/\s/g, ''));

  const handleGuestSubmit = async () => {
    if (!price || childMissing || contactMissing || nifInvalid) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await callable<object, { ok: boolean; bookingId?: string; token?: string }>('requestPartyBooking')({
        parentName: parentName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        nif: nif.trim(),
        notes: notes.trim(),
        website,
        childName: manualName.trim(),
        childAge: manualAge === '' ? '' : Number(manualAge),
        partyType,
        date,
        time,
        numKids,
        extras,
        extrasDetail,
      });
      const { bookingId, token } = res.data;
      if (bookingId && token) navigate(`/festas/reserva/${encodeURIComponent(bookingId)}?t=${encodeURIComponent(token)}&novo=1`);
      else navigate('/festas/reserva/enviado');
    } catch (err: any) {
      reportClientError('[PartyBookingPage] guest request failed', err);
      setSubmitError(err?.message || 'Não foi possível enviar o pedido. Tente novamente.');
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (guest) return handleGuestSubmit();
    if (!user || !family || !price) return;
    if (childMissing) return;
    const child = children.find(c => c.id === childId);
    const resolvedName = typedChild ? manualName.trim() : child ? `${child.firstName} ${child.lastName}` : '';
    const resolvedAge = typedChild ? Number(manualAge) : child ? (child.age ?? new Date().getFullYear() - new Date(child.dateOfBirth).getFullYear()) : 0;
    if (!resolvedName) return;

    // The family's parent, not the admin, while impersonating: the booking's
    // userId is what lets the parent read it, and its email gets the party emails.
    const owner = familyService.owner(family, user);

    setSubmitting(true);
    try {
      await partyService.createBooking({
        familyId: family.id,
        childId: typedChild ? '' : childId,
        userId: owner.userId,
        parentName: owner.name || owner.email.split('@')[0] || '',
        email: normalizeEmail(owner.email),
        phone: family.primaryContact?.phone ?? '',
        childName: resolvedName,
        childAge: resolvedAge,
        partyType,
        date,
        time,
        numKids,
        extras,
        extrasDetail,
        total: price.subtotal, // before IVA, like every price in the party config
        status: 'pending',
        createdAt: new Date(),
      } as any);
      navigate('/client/parties');
    } catch (err: any) {
      reportClientError('[PartyBookingPage] submit booking failed', err);
      alert(err?.message || 'Erro ao submeter reserva.');
      setSubmitting(false);
    }
  };

  if (loadError) return <div className="p-6 max-w-xl mx-auto"><p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{loadError}</p></div>;
  if (loading || !config) return <div className="p-6 text-gray-400 text-sm">A carregar...</div>;

  const today = new Date().toISOString().split('T')[0];
  const vatPct = Math.round(PARTY_VAT_RATE * 100);

  return (
    <div className="p-6 max-w-xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(guest ? '/' : '/client/parties')} className="text-gray-400 hover:text-gray-600">←</button>
        <h1 className="text-2xl font-bold text-gray-800">🎈 {guest ? 'Pedir uma festa' : 'Reservar uma festa'}</h1>
      </div>
      {guest && (
        <p className="text-sm text-gray-500 -mt-3">
          Não precisa de conta. Escolha a festa, deixe o seu contacto e respondemos por email.
          {' '}<Link to="/login" className="text-pink-600 underline">Já é cliente? Entre aqui</Link>
        </p>
      )}

      {/* Step indicators */}
      <div className="flex gap-2 text-xs font-medium">
        {['Festa', 'Extras', 'Confirmar'].map((label, i) => (
          <div key={label} className={`flex items-center gap-1.5 ${i + 1 === step ? 'text-pink-600' : i + 1 < step ? 'text-green-600' : 'text-gray-300'}`}>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 ${i + 1 === step ? 'border-pink-600 bg-pink-50' : i + 1 < step ? 'border-green-500 bg-green-50' : 'border-gray-200'}`}>
              {i + 1 < step ? '✓' : i + 1}
            </span>
            {label}
            {i < 2 && <span className="text-gray-200 ml-1">›</span>}
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de festa</label>
            <div className="space-y-2">
              {config.partyTypes.map(pt => (
                <button
                  key={pt.name}
                  onClick={() => setPartyType(pt.name)}
                  className={`w-full text-left p-4 rounded-xl border-2 transition ${partyType === pt.name ? 'border-pink-500 bg-pink-50' : 'border-gray-200 hover:border-gray-300'}`}
                >
                  <p className="font-semibold text-gray-800">{pt.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{pt.description}</p>
                  <p className="text-sm text-pink-600 font-medium mt-1">
                    {fmtEur(Number(pt.basePrice))} + IVA · inclui {pt.includedKids} crianças
                    {Number(pt.pricePerExtraChild) > 0 && ` (+${fmtEur(Number(pt.pricePerExtraChild))}/criança extra)`}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Data</label>
              <input type="date" min={today} value={date} onChange={e => setDate(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Hora</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Número de crianças convidadas</label>
            <input type="number" min={1} value={numKids} onChange={e => setNumKids(Number(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400" />
            {price && price.extraKids > 0 && (
              <p className="text-xs text-pink-600 mt-1">
                +{price.extraKids} crianças extra · +{fmtEur(price.extraKidsAmount)} + IVA
              </p>
            )}
          </div>

          <button
            onClick={() => setStep(2)}
            disabled={!partyType || !date || !time}
            className="w-full bg-pink-600 text-white font-semibold py-3 rounded-xl hover:bg-pink-700 transition disabled:opacity-40"
          >
            Próximo →
          </button>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">Selecione os extras que pretende incluir na festa. Os preços não incluem IVA ({vatPct}%).</p>
          {config.extras.length === 0 ? (
            <p className="text-sm text-gray-400">Sem extras disponíveis.</p>
          ) : (
            <div className="space-y-2">
              {config.extras.map(ex => {
                const qty = extraQtys[ex.name] ?? 0;
                const chosen = qty > 0;
                const unitPrice = Number(ex.price) || 0;
                if (!ex.perUnit) {
                  return (
                    <button
                      key={ex.name}
                      onClick={() => toggleExtra(ex)}
                      className={`w-full text-left p-4 rounded-xl border-2 transition flex justify-between items-center ${chosen ? 'border-pink-500 bg-pink-50' : 'border-gray-200 hover:border-gray-300'}`}
                    >
                      <div>
                        <p className="font-medium text-gray-800">{ex.name}</p>
                        {ex.description && <p className="text-xs text-gray-500 mt-0.5">{ex.description}</p>}
                      </div>
                      <p className="text-pink-600 font-semibold text-sm shrink-0 ml-3">+{fmtEur(unitPrice)}</p>
                    </button>
                  );
                }
                return (
                  <div
                    key={ex.name}
                    className={`w-full p-4 rounded-xl border-2 transition flex justify-between items-center gap-3 ${chosen ? 'border-pink-500 bg-pink-50' : 'border-gray-200'}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-gray-800">{ex.name}</p>
                      {ex.description && <p className="text-xs text-gray-500 mt-0.5">{ex.description}</p>}
                      <p className="text-xs text-pink-600 font-semibold mt-0.5">
                        {fmtEur(unitPrice)} / {ex.unitLabel || 'unidade'}
                        {chosen && <span className="text-gray-500 font-normal"> · {fmtEur(unitPrice * qty)}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        aria-label={`Menos ${ex.name}`}
                        onClick={() => setExtraQty(ex.name, qty - 1)}
                        disabled={qty === 0}
                        className="w-8 h-8 rounded-lg border border-gray-300 text-gray-700 font-bold hover:bg-gray-50 disabled:opacity-30"
                      >−</button>
                      <input
                        type="number"
                        min={0}
                        max={999}
                        inputMode="numeric"
                        aria-label={`Quantidade de ${ex.name}`}
                        value={qty}
                        onChange={e => setExtraQty(ex.name, Number(e.target.value))}
                        className="w-14 border border-gray-300 rounded-lg px-1 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-pink-400"
                      />
                      <button
                        type="button"
                        aria-label={`Mais ${ex.name}`}
                        onClick={() => setExtraQty(ex.name, qty + 1)}
                        className="w-8 h-8 rounded-lg border border-gray-300 text-gray-700 font-bold hover:bg-gray-50"
                      >+</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="flex-1 border border-gray-300 text-gray-700 font-medium py-3 rounded-xl hover:bg-gray-50 transition">
              ← Anterior
            </button>
            <button onClick={() => setStep(3)} className="flex-1 bg-pink-600 text-white font-semibold py-3 rounded-xl hover:bg-pink-700 transition">
              Próximo →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 */}
      {step === 3 && (
        <div className="space-y-4">
          {guest && (
            <div className="space-y-3">
              <p className="block text-sm font-medium text-gray-700">Os seus contactos</p>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Nome</label>
                <input type="text" autoComplete="name" value={parentName} onChange={e => setParentName(e.target.value)} className={inputCls} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                  <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Telemóvel</label>
                  <input type="tel" autoComplete="tel" placeholder="9XXXXXXXX" value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">NIF para a fatura <span className="text-gray-400 font-normal">(opcional)</span></label>
                <input type="text" inputMode="numeric" value={nif} onChange={e => setNif(e.target.value)} className={inputCls} />
                {nifInvalid && <p className="text-xs text-pink-700 mt-1">O NIF tem 9 dígitos.</p>}
              </div>
              {/* Honeypot: hidden from people, bots fill it. */}
              <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
                <label>Website<input type="text" tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} /></label>
              </div>
            </div>
          )}

              <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Criança a celebrar</label>

              {/* Registered children */}
              {!typedChild && (
                <div className="space-y-2">
                  {children.map(c => (
                    <button
                      key={c.id}
                      onClick={() => setChildId(c.id)}
                      className={`w-full text-left p-3 rounded-xl border-2 transition ${childId === c.id ? 'border-pink-500 bg-pink-50' : 'border-gray-200 hover:border-gray-300'}`}
                    >
                      <p className="font-medium text-gray-800">{c.firstName} {c.lastName}</p>
                      {c.dateOfBirth && (
                        <p className="text-xs text-gray-500 mt-0.5">
                          {new Date().getFullYear() - new Date(c.dateOfBirth).getFullYear()} anos
                        </p>
                      )}
                    </button>
                  ))}
                  <button
                    onClick={() => { setManualChild(true); setChildId(''); }}
                    className="w-full text-left p-3 rounded-xl border-2 border-dashed border-gray-200 hover:border-pink-300 hover:bg-pink-50 transition text-sm text-gray-500"
                  >
                    + Outra criança (não está na lista)
                  </button>
                </div>
              )}

              {/* Manual entry — shown when no children or user chose "other" */}
              {typedChild && (
                <div className="space-y-3">
                  {!guest && children.length === 0 && (
                    <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                      Não tem crianças registadas na sua conta. Pode introduzir os dados directamente.
                    </p>
                  )}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Nome da criança</label>
                    <input
                      type="text"
                      placeholder="Nome completo"
                      value={manualName}
                      onChange={e => setManualName(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Idade a celebrar</label>
                    <input
                      type="number"
                      min={1}
                      max={18}
                      placeholder="ex: 7"
                      value={manualAge}
                      onChange={e => setManualAge(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
                    />
                  </div>
                  {!guest && manualChild && children.length > 0 && (
                    <button
                      onClick={() => { setManualChild(false); setManualName(''); setManualAge(''); }}
                      className="text-xs text-pink-600 underline"
                    >
                      ← Escolher da lista
                    </button>
                  )}
                </div>
              )}
            </div>

          {/* Summary */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
            <p className="font-semibold text-gray-700 mb-2">Resumo da reserva</p>
            <div className="flex justify-between">
              <span>{selectedType?.name}</span>
              <span>{fmtEur(price?.basePrice ?? 0)}</span>
            </div>
            {price && price.extraKids > 0 && (
              <div className="flex justify-between text-gray-500">
                <span>{price.extraKids} crianças extra × {fmtEur(price.pricePerExtraChild)}</span>
                <span>+{fmtEur(price.extraKidsAmount)}</span>
              </div>
            )}
            {price?.extraLines.map(line => (
              <div key={line.name} className="flex justify-between text-gray-500">
                <span>{line.perUnit ? `${line.qty} × ${line.name}` : line.name}</span>
                <span>+{fmtEur(line.amount)}</span>
              </div>
            ))}
            <div className="border-t pt-2 flex justify-between text-gray-700">
              <span>Subtotal (sem IVA)</span>
              <span>{fmtEur(price?.subtotal ?? 0)}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span>IVA ({vatPct}%)</span>
              <span>+{fmtEur(price?.vat ?? 0)}</span>
            </div>
            <div className="flex justify-between font-bold text-gray-800">
              <span>Total</span>
              <span>{fmtEur(price?.total ?? 0)}</span>
            </div>
            <p className="text-xs text-gray-400">Sinal de 50% ({fmtEur(price?.deposit ?? 0)}) devido após confirmação</p>
          </div>

          {guest && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Notas <span className="text-gray-400 font-normal">(opcional: tema, alergias, dúvidas)</span></label>
              <textarea rows={3} maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
            </div>
          )}

          <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg p-3">
            {guest
              ? 'O pedido fica pendente até confirmarmos a disponibilidade. Enviamos a resposta por email; depois de confirmada, a reserva fica garantida com o sinal de 50%, pago por MB WAY a partir do link no email.'
              : 'A reserva fica pendente até confirmação da nossa equipa. Receberá uma notificação quando estiver confirmada.'}
          </p>

          {contactMissing ? (
            <p className="text-xs text-pink-700">Indique o seu nome, um email válido e o telemóvel para enviar o pedido.</p>
          ) : childMissing && (
            <p className="text-xs text-pink-700">
              {typedChild ? 'Indique o nome da criança para enviar o pedido.' : 'Escolha a criança a celebrar para enviar o pedido.'}
            </p>
          )}
          {submitError && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{submitError}</p>}

          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="flex-1 border border-gray-300 text-gray-700 font-medium py-3 rounded-xl hover:bg-gray-50 transition">
              ← Anterior
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || childMissing || contactMissing || nifInvalid}
              className="flex-1 bg-pink-600 text-white font-semibold py-3 rounded-xl hover:bg-pink-700 transition disabled:opacity-40"
            >
              {submitting ? 'A enviar...' : 'Enviar pedido'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
