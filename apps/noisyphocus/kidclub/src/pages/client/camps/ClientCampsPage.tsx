import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getDocs, query, where, orderBy } from 'firebase/firestore';
import { useUser } from '@shared/hooks';
import { col } from '../../../lib/db';
import { callable } from '../../../lib/callable';
import { Camp, CampDay, CampSubscription } from '@shared/models/Camp';
import { familyService } from '../../../services/familyService';
import { Child } from '@shared/models';

// ── helpers ────────────────────────────────────────────────────────────────────

const safeDate = (d: any): Date => {
  if (!d) return new Date();
  if (d instanceof Date) return d;
  if (d.toDate) return d.toDate();
  if (typeof d === 'string') return new Date(d);
  return new Date();
};

function fmtDate(d?: string) {
  if (!d) return '—';
  try {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  } catch { return d; }
}

function fmtDayOfWeek(dateStr: string) {
  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  try {
    const d = new Date(dateStr + 'T12:00:00');
    return days[d.getDay()];
  } catch { return ''; }
}

function getWeekKey(dateStr: string) {
  // Returns ISO week start (Monday) as YYYY-MM-DD
  try {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setDate(diff));
    return monday.toISOString().split('T')[0];
  } catch { return dateStr; }
}

const CAMP_TYPE_LABELS: Record<string, string> = {
  october: 'Outubro',
  christmas: 'Natal',
  easter: 'Páscoa',
  summer: 'Verão',
  other: 'Outro',
};

// ── component ──────────────────────────────────────────────────────────────────

type SubType = 'day' | 'week' | 'full';

export default function ClientCampsPage() {
  const user = useUser();
  const navigate = useNavigate();

  const [camps, setCamps] = useState<Camp[]>([]);
  const [selectedCamp, setSelectedCamp] = useState<Camp | null>(null);
  const [campDays, setCampDays] = useState<CampDay[]>([]);
  const [confirmedCountsPerDay, setConfirmedCountsPerDay] = useState<Record<string, number>>({});

  const [children, setChildren] = useState<Child[]>([]);
  const [familyId, setFamilyId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingDays, setLoadingDays] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [childName, setChildName] = useState('');
  const [childAge, setChildAge] = useState('');
  const [parentName, setParentName] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [subscriptionType, setSubscriptionType] = useState<SubType>('day');
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [selectedWeeks, setSelectedWeeks] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState('');

  // Load active camps
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const snap = await getDocs(query(col('camps'), where('active', '==', true), orderBy('startDate', 'asc')));
        setCamps(snap.docs.map(d => ({
          id: d.id,
          ...(d.data() as Omit<Camp, 'id' | 'createdAt' | 'updatedAt'>),
          createdAt: safeDate(d.data().createdAt),
          updatedAt: safeDate(d.data().updatedAt),
        })));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Load family & children
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      try {
        const fam = await familyService.getOrCreateFamily(user.uid, user.name ?? '', user.email ?? '');
        setFamilyId(fam.id);
        setParentName(fam.primaryContact?.name ?? user.name ?? '');
        setParentEmail(fam.primaryContact?.email ?? user.email ?? '');
        setParentPhone(fam.primaryContact?.phone ?? '');
        const kids = await familyService.getFamilyChildren(fam.id, false, user.uid);
        setChildren(kids);
      } catch {
        // Ignore — user may not have a family profile yet
      }
    };
    load();
  }, [user]);

  // Load camp days + capacity when camp selected
  useEffect(() => {
    if (!selectedCamp) return;
    const load = async () => {
      setLoadingDays(true);
      setSelectedDays(new Set());
      setSelectedWeeks(new Set());
      setError(null);
      try {
        const daysSnap = await getDocs(
          query(col('campDays'), where('campId', '==', selectedCamp.id), orderBy('date', 'asc'))
        );
        const days: CampDay[] = daysSnap.docs
          .filter(d => d.data().active !== false)
          .map(d => ({
            id: d.id,
            ...(d.data() as Omit<CampDay, 'id' | 'createdAt' | 'updatedAt'>),
            createdAt: safeDate(d.data().createdAt),
            updatedAt: safeDate(d.data().updatedAt),
          }));
        setCampDays(days);

        // Fetch confirmed subscription counts per day
        const subsSnap = await getDocs(
          query(col('campSubscriptions'), where('campId', '==', selectedCamp.id), where('status', '==', 'confirmed'))
        );
        const counts: Record<string, number> = {};
        for (const sub of subsSnap.docs) {
          const subData = sub.data() as CampSubscription;
          for (const dayId of subData.selectedDays) {
            counts[dayId] = (counts[dayId] ?? 0) + 1;
          }
        }
        setConfirmedCountsPerDay(counts);
      } finally {
        setLoadingDays(false);
      }
    };
    load();
  }, [selectedCamp]);

  // Group days by week
  const daysByWeek = useMemo(() => {
    const weeks: Map<string, CampDay[]> = new Map();
    for (const day of campDays) {
      const wk = getWeekKey(day.date);
      if (!weeks.has(wk)) weeks.set(wk, []);
      weeks.get(wk)!.push(day);
    }
    return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [campDays]);

  // Computed selections
  const effectiveSelectedDays = useMemo(() => {
    if (subscriptionType === 'full') return new Set(campDays.map(d => d.id));
    if (subscriptionType === 'week') {
      const ids = new Set<string>();
      for (const [wk, days] of daysByWeek) {
        if (selectedWeeks.has(wk)) days.forEach(d => ids.add(d.id));
      }
      return ids;
    }
    return selectedDays;
  }, [subscriptionType, selectedDays, selectedWeeks, campDays, daysByWeek]);

  const totalAmount = useMemo(() => {
    let sum = 0;
    for (const id of effectiveSelectedDays) {
      const day = campDays.find(d => d.id === id);
      if (day) sum += day.price;
    }
    return Math.round(sum * 100) / 100;
  }, [effectiveSelectedDays, campDays]);

  const depositAmount = Math.round(totalAmount * 0.25 * 100) / 100;
  const balanceAmount = Math.round((totalAmount - depositAmount) * 100) / 100;

  const isDayFull = (dayId: string, capacity: number) =>
    (confirmedCountsPerDay[dayId] ?? 0) >= capacity;

  const spotsLeft = (dayId: string, capacity: number) =>
    Math.max(0, capacity - (confirmedCountsPerDay[dayId] ?? 0));

  // Toggle day selection
  const toggleDay = (dayId: string, capacity: number) => {
    if (isDayFull(dayId, capacity)) return;
    setSelectedDays(prev => {
      const next = new Set(prev);
      if (next.has(dayId)) next.delete(dayId);
      else next.add(dayId);
      return next;
    });
  };

  const toggleWeek = (weekKey: string, days: CampDay[]) => {
    const allFull = days.every(d => isDayFull(d.id, d.capacity));
    if (allFull) return;
    setSelectedWeeks(prev => {
      const next = new Set(prev);
      if (next.has(weekKey)) next.delete(weekKey);
      else next.add(weekKey);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedCamp) return;
    if (effectiveSelectedDays.size === 0) {
      setError('Selecione pelo menos um dia.');
      return;
    }
    if (!childName.trim() || !parentName.trim() || !parentEmail.trim()) {
      setError('Preencha todos os campos obrigatórios.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await callable('createCampSubscription')({
        campId: selectedCamp.id,
        childName: childName.trim(),
        ...(childAge ? { childAge: Number(childAge) } : {}),
        parentName: parentName.trim(),
        parentEmail: parentEmail.trim(),
        ...(parentPhone ? { parentPhone: parentPhone.trim() } : {}),
        subscriptionType,
        selectedDays: [...effectiveSelectedDays],
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setSubmitted(true);
    } catch (e: any) {
      setError(e.message ?? 'Erro ao submeter inscrição.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold mb-2">Inscrição submetida!</h2>
        <p className="text-gray-600 mb-6">
          A sua inscrição no campo <strong>{selectedCamp?.name}</strong> foi recebida.
          A nossa equipa irá confirmar em breve e poderá pagar o sinal na sua área de pagamentos.
        </p>
        <Link to="/client/payments" className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700">
          Ver pagamentos
        </Link>
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">A carregar...</div>;
  }

  if (camps.length === 0) {
    return (
      <div className="max-w-lg mx-auto text-center py-12">
        <div className="text-4xl mb-4">🏕️</div>
        <h2 className="text-xl font-bold mb-2 text-gray-700">Sem campos disponíveis</h2>
        <p className="text-gray-500">Não há campos ativos de momento. Consulte mais tarde.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link to="/client" className="text-blue-600 hover:underline text-sm">← Voltar</Link>
        <h1 className="text-2xl font-bold mt-2">Campos de Férias</h1>
        <p className="text-gray-500 mt-1 text-sm">Inscreva o seu filho num dos nossos campos.</p>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-4 font-bold">×</button>
        </div>
      )}

      {/* Camp selection */}
      <div className="space-y-3 mb-6">
        <h2 className="font-semibold text-gray-700">Escolha um campo</h2>
        {camps.map(camp => (
          <button
            key={camp.id}
            onClick={() => { setSelectedCamp(camp); setSubmitted(false); }}
            className={`w-full text-left p-4 rounded-lg border transition-colors ${
              selectedCamp?.id === camp.id
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-gray-800">{camp.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {CAMP_TYPE_LABELS[camp.type] ?? camp.type} · {fmtDate(camp.startDate)} – {fmtDate(camp.endDate)}
                </p>
                {camp.description && <p className="text-sm text-gray-600 mt-1">{camp.description}</p>}
              </div>
              {selectedCamp?.id === camp.id && (
                <span className="text-blue-600 text-lg shrink-0 ml-2">✓</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Camp days + enrollment form */}
      {selectedCamp && (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Subscription type */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="font-semibold mb-3">Tipo de inscrição</h2>
            <div className="grid grid-cols-3 gap-3">
              {(['day', 'week', 'full'] as SubType[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setSubscriptionType(t); setSelectedDays(new Set()); setSelectedWeeks(new Set()); }}
                  className={`py-3 px-2 rounded-lg border text-sm font-medium transition-colors ${
                    subscriptionType === t
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {t === 'day' ? 'Dia(s)' : t === 'week' ? 'Semana(s)' : 'Campo Completo'}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {subscriptionType === 'day' && 'Selecione os dias individuais que pretende.'}
              {subscriptionType === 'week' && 'Selecione semanas completas.'}
              {subscriptionType === 'full' && 'Todos os dias do campo são incluídos.'}
            </p>
          </div>

          {/* Day selection */}
          {loadingDays ? (
            <div className="text-center py-6 text-gray-400 text-sm">A carregar dias...</div>
          ) : campDays.length === 0 ? (
            <div className="text-center py-6 text-gray-400 text-sm">Nenhum dia configurado para este campo.</div>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="font-semibold mb-3">Dias disponíveis</h2>

              {/* Full — show all days read-only */}
              {subscriptionType === 'full' && (
                <div className="space-y-2">
                  {campDays.map(day => (
                    <DayCard
                      key={day.id}
                      day={day}
                      selected
                      disabled={false}
                      spotsLeft={spotsLeft(day.id, day.capacity)}
                      isFull={isDayFull(day.id, day.capacity)}
                    />
                  ))}
                </div>
              )}

              {/* Day — multi-select */}
              {subscriptionType === 'day' && (
                <div className="space-y-2">
                  {campDays.map(day => {
                    const full = isDayFull(day.id, day.capacity);
                    const sel = selectedDays.has(day.id);
                    return (
                      <DayCard
                        key={day.id}
                        day={day}
                        selected={sel}
                        disabled={full}
                        spotsLeft={spotsLeft(day.id, day.capacity)}
                        isFull={full}
                        onClick={() => toggleDay(day.id, day.capacity)}
                      />
                    );
                  })}
                </div>
              )}

              {/* Week — select by week */}
              {subscriptionType === 'week' && (
                <div className="space-y-4">
                  {daysByWeek.map(([wk, days]) => {
                    const wkSelected = selectedWeeks.has(wk);
                    const wkStart = fmtDate(days[0]?.date);
                    const wkEnd = fmtDate(days[days.length - 1]?.date);
                    const allFull = days.every(d => isDayFull(d.id, d.capacity));
                    return (
                      <div key={wk} className={`rounded-lg border p-4 ${wkSelected ? 'border-blue-400 bg-blue-50' : 'border-gray-200'} ${allFull ? 'opacity-50' : ''}`}>
                        <div
                          className={`flex items-center justify-between mb-3 ${allFull ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                          onClick={() => toggleWeek(wk, days)}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={wkSelected}
                              onChange={() => toggleWeek(wk, days)}
                              disabled={allFull}
                              className="w-4 h-4 text-blue-600"
                            />
                            <span className="font-medium text-sm text-gray-800">
                              Semana {wkStart} – {wkEnd}
                            </span>
                          </div>
                          <span className="text-sm font-medium text-blue-700">
                            €{days.reduce((s, d) => s + d.price, 0).toFixed(2)}
                          </span>
                        </div>
                        <div className="space-y-1 pl-7">
                          {days.map(day => (
                            <DayCard
                              key={day.id}
                              day={day}
                              selected={wkSelected}
                              disabled={isDayFull(day.id, day.capacity)}
                              spotsLeft={spotsLeft(day.id, day.capacity)}
                              isFull={isDayFull(day.id, day.capacity)}
                              compact
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Price summary */}
          {effectiveSelectedDays.size > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-5 space-y-2">
              <h3 className="font-semibold text-blue-900 mb-1">Resumo</h3>
              <div className="flex justify-between text-sm text-blue-800">
                <span>{effectiveSelectedDays.size} dia(s) selecionado(s)</span>
                <span className="font-semibold">€{totalAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm text-blue-700">
                <span>Sinal a pagar agora (25%)</span>
                <span className="font-semibold">€{depositAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm text-blue-600">
                <span>Saldo a pagar após o campo (75%)</span>
                <span>€{balanceAmount.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Child info */}
          <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold">Dados da criança</h2>
            {children.length > 0 && (
              <div>
                <label className="block text-sm text-gray-600 mb-2">Escolha uma criança do seu perfil:</label>
                <div className="flex flex-wrap gap-2">
                  {children.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setChildName(`${c.firstName} ${c.lastName}`);
                        if (c.age) setChildAge(String(c.age));
                      }}
                      className="text-sm border border-gray-300 rounded-full px-3 py-1 hover:bg-gray-100"
                    >
                      {c.firstName} {c.lastName}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome da criança *</label>
                <input
                  type="text"
                  required
                  value={childName}
                  onChange={e => setChildName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Idade</label>
                <input
                  type="number"
                  min="1"
                  max="18"
                  value={childAge}
                  onChange={e => setChildAge(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Parent info */}
          <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
            <h2 className="font-semibold">Dados do encarregado</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nome *</label>
              <input
                type="text"
                required
                value={parentName}
                onChange={e => setParentName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                <input
                  type="email"
                  required
                  value={parentEmail}
                  onChange={e => setParentEmail(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Telefone</label>
                <input
                  type="tel"
                  value={parentPhone}
                  onChange={e => setParentPhone(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                  placeholder="+351 ..."
                />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <label className="block font-semibold mb-2">Observações (opcional)</label>
            <textarea
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Alergias, necessidades especiais, outras informações..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Deposit notice */}
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
            Ao submeter esta inscrição, será criado um pagamento de sinal de <strong>25%</strong> (€{depositAmount.toFixed(2)}).
            O restante saldo (€{balanceAmount.toFixed(2)}) será cobrado após o campo.
            A inscrição ficará pendente de confirmação pela nossa equipa.
          </div>

          <button
            type="submit"
            disabled={submitting || effectiveSelectedDays.size === 0}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {submitting ? 'A processar...' : 'Inscrever'}
          </button>
        </form>
      )}
    </div>
  );
}

// ── DayCard sub-component ─────────────────────────────────────────────────────

function DayCard({
  day, selected, disabled, spotsLeft, isFull, onClick, compact = false,
}: {
  day: CampDay;
  selected: boolean;
  disabled: boolean;
  spotsLeft: number;
  isFull: boolean;
  onClick?: () => void;
  compact?: boolean;
}) {
  const base = compact
    ? 'flex items-center justify-between py-1.5 px-2 rounded text-xs'
    : 'flex items-start justify-between p-3 rounded-lg border transition-colors';

  const border = compact
    ? ''
    : isFull
      ? 'border-gray-200 bg-gray-50 opacity-60'
      : selected
        ? 'border-blue-400 bg-blue-50 cursor-pointer'
        : 'border-gray-200 bg-white cursor-pointer hover:border-gray-300';

  return (
    <div className={`${base} ${border}`} onClick={onClick}>
      <div className="flex items-center gap-2">
        {!compact && onClick && (
          <input type="checkbox" checked={selected} disabled={disabled} onChange={onClick}
            className="w-4 h-4 text-blue-600 shrink-0" />
        )}
        <div>
          <span className="font-medium text-gray-800">{fmtDayOfWeek(day.date)} {fmtDate(day.date)}</span>
          {!compact && (
            <div className="text-xs text-gray-500 mt-0.5 space-y-0.5">
              <p>M: {day.morning}</p>
              <p>A: {day.lunch}</p>
              <p>T: {day.afternoon}</p>
            </div>
          )}
        </div>
      </div>
      <div className="text-right shrink-0 ml-3">
        <p className="font-semibold text-gray-800 text-sm">€{day.price.toFixed(2)}</p>
        {isFull ? (
          <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-medium">Esgotado</span>
        ) : (
          <p className="text-xs text-gray-500">{spotsLeft} vaga(s)</p>
        )}
      </div>
    </div>
  );
}
