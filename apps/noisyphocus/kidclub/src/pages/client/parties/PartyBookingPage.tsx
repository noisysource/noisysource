import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child, PartyConfig } from '@shared/models';
import { familyService } from '../../../services/familyService';
import { partyService } from '../../../services/partyService';

function fmtEur(n: number) { return `€${n.toFixed(2)}`; }

export default function PartyBookingPage() {
  const user = useUser();
  const navigate = useNavigate();

  const [config, setConfig] = useState<PartyConfig | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [familyId, setFamilyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(1);

  // Form state
  const [partyType, setPartyType] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [numKids, setNumKids] = useState(10);
  const [extras, setExtras] = useState<string[]>([]);
  const [childId, setChildId] = useState('');

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [cfg, family] = await Promise.all([
        partyService.getPartyConfig(),
        familyService.getOrCreateFamily(user.uid, user.name ?? '', user.email ?? ''),
      ]);
      setConfig(cfg);
      setFamilyId(family.id);
      const kids = await familyService.getFamilyChildren(family.id, false, user.uid);
      setChildren(kids);
      if (kids.length === 1) setChildId(kids[0].id);
      setLoading(false);
    })();
  }, [user]);

  const selectedType = config?.partyTypes.find(pt => pt.name === partyType);

  const total = useMemo(() => {
    if (!selectedType) return 0;
    let t = selectedType.basePrice;
    if (numKids > selectedType.includedKids) {
      t += (numKids - selectedType.includedKids) * selectedType.pricePerExtraChild;
    }
    extras.forEach(name => {
      const ex = config?.extras.find(e => e.name === name);
      if (ex) t += ex.price;
    });
    return t;
  }, [selectedType, numKids, extras, config]);

  const toggleExtra = (name: string) =>
    setExtras(prev => prev.includes(name) ? prev.filter(e => e !== name) : [...prev, name]);

  const handleSubmit = async () => {
    if (!user || !familyId || !childId) return;
    const child = children.find(c => c.id === childId);
    if (!child) return;

    setSubmitting(true);
    try {
      await partyService.createBooking({
        familyId,
        childId,
        userId: user.uid,
        parentName: user.name || user.email?.split('@')[0] || '',
        email: user.email || '',
        phone: '',
        childName: `${child.firstName} ${child.lastName}`,
        childAge: child.age ?? new Date().getFullYear() - new Date(child.dateOfBirth).getFullYear(),
        partyType,
        date,
        time,
        numKids,
        extras,
        extrasDetail: {},
        total,
        status: 'pending',
        createdAt: new Date(),
      } as any);
      navigate('/client/parties');
    } catch (err: any) {
      alert(err?.message || 'Erro ao submeter reserva.');
      setSubmitting(false);
    }
  };

  if (loading || !config) return <div className="p-6 text-gray-400 text-sm">A carregar...</div>;

  const today = new Date().toISOString().split('T')[0];

  return (
    <div className="p-6 max-w-xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/client/parties')} className="text-gray-400 hover:text-gray-600">←</button>
        <h1 className="text-2xl font-bold text-gray-800">🎈 Reservar uma festa</h1>
      </div>

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
                    {fmtEur(pt.basePrice)} · inclui {pt.includedKids} crianças
                    {pt.pricePerExtraChild > 0 && ` (+${fmtEur(pt.pricePerExtraChild)}/criança extra)`}
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
            {selectedType && numKids > selectedType.includedKids && (
              <p className="text-xs text-pink-600 mt-1">
                +{numKids - selectedType.includedKids} crianças extra · +{fmtEur((numKids - selectedType.includedKids) * selectedType.pricePerExtraChild)}
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
          <p className="text-sm text-gray-600">Selecione os extras que pretende incluir na festa:</p>
          {config.extras.length === 0 ? (
            <p className="text-sm text-gray-400">Sem extras disponíveis.</p>
          ) : (
            <div className="space-y-2">
              {config.extras.map(ex => (
                <button
                  key={ex.name}
                  onClick={() => toggleExtra(ex.name)}
                  className={`w-full text-left p-4 rounded-xl border-2 transition flex justify-between items-center ${extras.includes(ex.name) ? 'border-pink-500 bg-pink-50' : 'border-gray-200 hover:border-gray-300'}`}
                >
                  <div>
                    <p className="font-medium text-gray-800">{ex.name}</p>
                    {ex.description && <p className="text-xs text-gray-500 mt-0.5">{ex.description}</p>}
                  </div>
                  <p className="text-pink-600 font-semibold text-sm shrink-0 ml-3">+{fmtEur(ex.price)}</p>
                </button>
              ))}
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
          {children.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Criança a celebrar</label>
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
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm">
            <p className="font-semibold text-gray-700 mb-2">Resumo da reserva</p>
            <div className="flex justify-between">
              <span>{selectedType?.name}</span>
              <span>{fmtEur(selectedType?.basePrice ?? 0)}</span>
            </div>
            {selectedType && numKids > selectedType.includedKids && (
              <div className="flex justify-between text-gray-500">
                <span>{numKids - selectedType.includedKids} crianças extra</span>
                <span>+{fmtEur((numKids - selectedType.includedKids) * selectedType.pricePerExtraChild)}</span>
              </div>
            )}
            {extras.map(name => {
              const ex = config.extras.find(e => e.name === name);
              return ex ? (
                <div key={name} className="flex justify-between text-gray-500">
                  <span>{ex.name}</span>
                  <span>+{fmtEur(ex.price)}</span>
                </div>
              ) : null;
            })}
            <div className="border-t pt-2 flex justify-between font-bold text-gray-800">
              <span>Total</span>
              <span>{fmtEur(total)}</span>
            </div>
            <p className="text-xs text-gray-400">Sinal de 50% ({fmtEur(total * 0.5)}) devido após confirmação</p>
          </div>

          <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg p-3">
            A reserva fica pendente até confirmação da nossa equipa. Receberá uma notificação quando estiver confirmada.
          </p>

          <div className="flex gap-3">
            <button onClick={() => setStep(2)} className="flex-1 border border-gray-300 text-gray-700 font-medium py-3 rounded-xl hover:bg-gray-50 transition">
              ← Anterior
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || !childId}
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
