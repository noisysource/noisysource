import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getDocs, query, where } from 'firebase/firestore';
import { useUser } from '@shared/hooks';
import { col } from '../../../lib/db';
import { callable } from '../../../lib/callable';
import { Camp, CampDay } from '@shared/models/Camp';
import { familyService } from '../../../services/familyService';
import { Child } from '@shared/models';

// ── helpers ───────────────────────────────────────────────────────────────────

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
  try { return days[new Date(dateStr + 'T12:00:00').getDay()]; } catch { return ''; }
}

function getWeekKey(dateStr: string) {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff)).toISOString().split('T')[0];
  } catch { return dateStr; }
}

function extractErrorMessage(e: any): string {
  if (!e) return 'Ocorreu um erro. Tente novamente.';
  if (typeof e.message === 'string' && e.message) return e.message;
  if (typeof e.details === 'string' && e.details) return e.details;
  if (typeof e.code === 'string') return `Erro: ${e.code}`;
  return 'Ocorreu um erro. Tente novamente.';
}

const CAMP_TYPE_META: Record<string, { label: string; from: string; to: string; icon: string }> = {
  october:  { label: 'Outubro',  from: '#f97316', to: '#ef4444', icon: '🍂' },
  christmas:{ label: 'Natal',    from: '#16a34a', to: '#15803d', icon: '🎄' },
  easter:   { label: 'Páscoa',   from: '#8b5cf6', to: '#6d28d9', icon: '🐣' },
  summer:   { label: 'Verão',    from: '#0ea5e9', to: '#0284c7', icon: '☀️' },
  other:    { label: 'Outro',    from: '#6366f1', to: '#4f46e5', icon: '⛺' },
};

// ── types ─────────────────────────────────────────────────────────────────────

type SubType = 'day' | 'week' | 'full';

// ── component ─────────────────────────────────────────────────────────────────

export default function ClientCampsPage() {
  const user = useUser();
  useNavigate();

  const [camps, setCamps] = useState<Camp[]>([]);
  const [selectedCamp, setSelectedCamp] = useState<Camp | null>(null);
  const [campDays, setCampDays] = useState<CampDay[]>([]);
  const [confirmedCountsPerDay, setConfirmedCountsPerDay] = useState<Record<string, number>>({});

  const [children, setChildren] = useState<Child[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadingDays, setLoadingDays] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<{ reservedDays: string[]; waitlistedDays: string[]; holdExpiresAt?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const snap = await getDocs(col('camps'));
        setCamps(
          snap.docs
            .map(d => ({ id: d.id, ...(d.data() as Omit<Camp, 'id' | 'createdAt' | 'updatedAt'>), createdAt: safeDate(d.data().createdAt), updatedAt: safeDate(d.data().updatedAt) }))
            .filter(c => c.active === true)
            .sort((a, b) => a.startDate.localeCompare(b.startDate))
        );
      } catch (e) {
        console.error('[ClientCampsPage] camps load failed:', e);
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
        setParentName(fam.primaryContact?.name ?? user.name ?? '');
        setParentEmail(fam.primaryContact?.email ?? user.email ?? '');
        setParentPhone(fam.primaryContact?.phone ?? '');
        const kids = await familyService.getFamilyChildren(fam.id, false, user.uid);
        setChildren(kids);
      } catch (e) {
        console.error('[ClientCampsPage] family load failed:', e);
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
        const daysSnap = await getDocs(query(col('campDays'), where('campId', '==', selectedCamp.id)));
        const days: CampDay[] = daysSnap.docs
          .filter(d => d.data().active !== false)
          .map(d => ({ id: d.id, ...(d.data() as Omit<CampDay, 'id' | 'createdAt' | 'updatedAt'>), createdAt: safeDate(d.data().createdAt), updatedAt: safeDate(d.data().updatedAt) }))
          .sort((a, b) => a.date.localeCompare(b.date));
        setCampDays(days);

        // Seats taken per day come from a function: parents can't read other families' sign-ups.
        // If it fails the counts don't show; the server decides seat vs. waiting list on submit anyway.
        try {
          const res = await callable('getCampAvailability')({ campId: selectedCamp.id });
          setConfirmedCountsPerDay(((res.data as any)?.taken ?? {}) as Record<string, number>);
        } catch (e) {
          console.error('[ClientCampsPage] availability load failed:', e);
          setConfirmedCountsPerDay({});
        }
      } catch (e) {
        console.error('[ClientCampsPage] campDays load failed:', e);
        setError('Erro ao carregar dias do campo. Tente novamente.');
      } finally {
        setLoadingDays(false);
      }
    };
    load();
  }, [selectedCamp]);

  const daysByWeek = useMemo(() => {
    const weeks: Map<string, CampDay[]> = new Map();
    for (const day of campDays) {
      const wk = getWeekKey(day.date);
      if (!weeks.has(wk)) weeks.set(wk, []);
      weeks.get(wk)!.push(day);
    }
    return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [campDays]);

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

  // Full days can still be picked: they go to the waiting list, with nothing to pay for now.
  const waitlistCount = useMemo(
    () => campDays.filter(d => effectiveSelectedDays.has(d.id) && (confirmedCountsPerDay[d.id] ?? 0) >= d.capacity).length,
    [effectiveSelectedDays, campDays, confirmedCountsPerDay],
  );
  const seatCount = effectiveSelectedDays.size - waitlistCount;

  const totalAmount = useMemo(() => {
    let sum = 0;
    for (const day of campDays) {
      if (effectiveSelectedDays.has(day.id) && (confirmedCountsPerDay[day.id] ?? 0) < day.capacity) sum += day.price;
    }
    return Math.round(sum * 100) / 100;
  }, [effectiveSelectedDays, campDays, confirmedCountsPerDay]);

  const depositAmount = Math.round(totalAmount * 0.25 * 100) / 100;
  const balanceAmount = Math.round((totalAmount - depositAmount) * 100) / 100;

  const isDayFull = (dayId: string, capacity: number) => (confirmedCountsPerDay[dayId] ?? 0) >= capacity;
  const spotsLeft = (dayId: string, capacity: number) => Math.max(0, capacity - (confirmedCountsPerDay[dayId] ?? 0));

  const toggleDay = (dayId: string) => {
    setSelectedDays(prev => {
      const next = new Set(prev);
      next.has(dayId) ? next.delete(dayId) : next.add(dayId);
      return next;
    });
  };

  const toggleWeek = (weekKey: string, days: CampDay[]) => {
    if (days.length === 0) return;
    setSelectedWeeks(prev => {
      const next = new Set(prev);
      next.has(weekKey) ? next.delete(weekKey) : next.add(weekKey);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedCamp) return;
    if (effectiveSelectedDays.size === 0) { setError('Selecione pelo menos um dia.'); return; }
    if (!childName.trim() || !parentName.trim() || !parentEmail.trim()) { setError('Preencha todos os campos obrigatórios.'); return; }

    setSubmitting(true);
    setError(null);
    try {
      const res = await callable('createCampSubscription')({
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
      const data = (res.data ?? {}) as any;
      setResult({ reservedDays: data.reservedDays ?? [], waitlistedDays: data.waitlistedDays ?? [], holdExpiresAt: data.holdExpiresAt });
      setSubmitted(true);
    } catch (e: any) {
      console.error('[ClientCampsPage] createCampSubscription failed:', e);
      setError(extractErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────────

  if (submitted) {
    const meta = CAMP_TYPE_META[selectedCamp?.type ?? 'other'] ?? CAMP_TYPE_META.other;
    return (
      <div className="max-w-md mx-auto text-center py-16 px-4">
        <div className="text-6xl mb-6">{meta.icon}</div>
        <h2 className="text-2xl font-bold mb-3">
          {result && result.reservedDays.length === 0 ? 'Está na lista de espera' : 'Inscrição recebida!'}
        </h2>
        <p className="text-gray-600 mb-4">
          Inscrição de <strong>{childName}</strong> no campo <strong>{selectedCamp?.name}</strong>.
        </p>
        {result && result.reservedDays.length > 0 && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800 mb-3 text-left">
            <p className="font-semibold mb-1">Vaga à espera do sinal</p>
            <p>{result.reservedDays.join(', ')}</p>
            <p className="mt-1">
              A vaga fica reservada com o pagamento do sinal
              {result.holdExpiresAt ? <> até <strong>{new Date(result.holdExpiresAt).toLocaleDateString('pt-PT')}</strong></> : null}.
              Sem pagamento até lá, a inscrição passa para a lista de espera.
            </p>
          </div>
        )}
        {result && result.waitlistedDays.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 mb-3 text-left">
            <p className="font-semibold mb-1">Lista de espera</p>
            <p>{result.waitlistedDays.join(', ')}</p>
            <p className="mt-1">Estes dias já estão completos. Avisamos por email se surgir uma vaga; não há nada a pagar por eles para já.</p>
          </div>
        )}
        <div className="mb-5" />
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link to="/client/payments" className="bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-medium hover:bg-indigo-700">
            Ver pagamentos
          </Link>
          <Link to="/client/subscriptions" className="border border-gray-300 text-gray-700 px-6 py-2.5 rounded-xl font-medium hover:bg-gray-50">
            As minhas inscrições
          </Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">⛺</div>
          <p className="text-gray-500">A carregar campos...</p>
        </div>
      </div>
    );
  }

  if (camps.length === 0) {
    return (
      <div className="max-w-lg mx-auto text-center py-16 px-4">
        <div className="text-5xl mb-4">🏕️</div>
        <h2 className="text-xl font-bold mb-2 text-gray-800">Sem campos disponíveis</h2>
        <p className="text-gray-500 mb-6">Não há campos ativos de momento. Consulte mais tarde.</p>
        <Link to="/client" className="text-indigo-600 hover:underline text-sm">← Voltar à área de cliente</Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div>
        <Link to="/client" className="text-sm text-gray-500 hover:text-gray-700">← Área de cliente</Link>
        <h1 className="text-2xl font-bold mt-2">Campos de Férias</h1>
        <p className="text-gray-500 text-sm mt-1">Inscreva o seu filho num dos nossos campos de atividades.</p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl flex items-start justify-between gap-3">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} className="shrink-0 text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
        </div>
      )}

      {/* Camp selection */}
      <div className="space-y-3">
        <h2 className="font-semibold text-gray-700">Escolha um campo</h2>
        <div className="grid gap-3">
          {camps.map(camp => {
            const meta = CAMP_TYPE_META[camp.type] ?? CAMP_TYPE_META.other;
            const isSelected = selectedCamp?.id === camp.id;
            return (
              <button
                key={camp.id}
                onClick={() => { setSelectedCamp(camp); setSubmitted(false); }}
                className={`w-full text-left rounded-2xl overflow-hidden border-2 transition-all ${isSelected ? 'border-indigo-500 shadow-md' : 'border-transparent shadow-sm hover:shadow-md'}`}
              >
                {/* Gradient header */}
                <div
                  className="px-5 py-4 text-white"
                  style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{meta.icon}</span>
                      <div>
                        <p className="font-bold text-lg leading-tight">{camp.name}</p>
                        <p className="text-sm text-white/80">{meta.label}</p>
                      </div>
                    </div>
                    {isSelected && (
                      <span className="bg-white/20 rounded-full w-7 h-7 flex items-center justify-center text-white font-bold">✓</span>
                    )}
                  </div>
                </div>
                {/* Info bar */}
                <div className="bg-white px-5 py-3 flex items-center gap-6 text-sm text-gray-600">
                  <span>📅 {fmtDate(camp.startDate)} – {fmtDate(camp.endDate)}</span>
                  {camp.description && <span className="text-gray-400 truncate">{camp.description}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Camp details + enrollment form */}
      {selectedCamp && (
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Subscription type */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h2 className="font-semibold text-gray-800 mb-4">Tipo de inscrição</h2>
            <div className="grid grid-cols-3 gap-2">
              {(['day', 'week', 'full'] as SubType[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setSubscriptionType(t); setSelectedDays(new Set()); setSelectedWeeks(new Set()); }}
                  className={`py-3 rounded-xl border-2 text-sm font-medium transition-all ${
                    subscriptionType === t
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {t === 'day' ? '🗓 Dia(s)' : t === 'week' ? '📅 Semana(s)' : '🎯 Completo'}
                </button>
              ))}
            </div>
          </div>

          {/* Day selection */}
          {loadingDays ? (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
              <div className="text-3xl mb-2 animate-pulse">📅</div>
              <p className="text-gray-500 text-sm">A carregar dias disponíveis...</p>
            </div>
          ) : campDays.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
              <div className="text-3xl mb-2">🗓</div>
              <p className="text-gray-500 text-sm">Nenhum dia configurado para este campo.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <h2 className="font-semibold text-gray-800 mb-4">
                Dias disponíveis
                <span className="ml-2 text-sm font-normal text-gray-400">
                  {campDays.length} dia{campDays.length !== 1 ? 's' : ''}
                </span>
              </h2>

              {subscriptionType === 'full' && (
                <div className="space-y-2">
                  {campDays.map(day => (
                    <DayRow key={day.id} day={day} selected spotsLeft={spotsLeft(day.id, day.capacity)} isFull={isDayFull(day.id, day.capacity)} />
                  ))}
                </div>
              )}

              {subscriptionType === 'day' && (
                <div className="space-y-2">
                  {campDays.map(day => {
                    const full = isDayFull(day.id, day.capacity);
                    const sel = selectedDays.has(day.id);
                    return (
                      <DayRow
                        key={day.id} day={day} selected={sel} isFull={full}
                        spotsLeft={spotsLeft(day.id, day.capacity)}
                        onClick={() => toggleDay(day.id)}
                      />
                    );
                  })}
                </div>
              )}

              {subscriptionType === 'week' && (
                <div className="space-y-4">
                  {daysByWeek.map(([wk, days]) => {
                    const wkSelected = selectedWeeks.has(wk);
                    const weekTotal = days.reduce((s, d) => s + d.price, 0);
                    return (
                      <div key={wk} className={`rounded-xl border-2 overflow-hidden transition-all ${wkSelected ? 'border-indigo-400' : 'border-gray-200'}`}>
                        <button
                          type="button"
                          onClick={() => toggleWeek(wk, days)}
                          className={`w-full flex items-center justify-between px-4 py-3 text-sm font-semibold ${wkSelected ? 'bg-indigo-50 text-indigo-800' : 'bg-gray-50 text-gray-700'}`}
                        >
                          <span className="flex items-center gap-2">
                            <span className={`w-5 h-5 rounded border-2 flex items-center justify-center text-xs ${wkSelected ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-gray-400'}`}>
                              {wkSelected && '✓'}
                            </span>
                            Semana {fmtDate(days[0]?.date)} – {fmtDate(days[days.length - 1]?.date)}
                          </span>
                          <span className="text-indigo-600 font-bold">€{weekTotal.toFixed(2)}</span>
                        </button>
                        <div className="divide-y divide-gray-100">
                          {days.map(day => (
                            <DayRow key={day.id} day={day} selected={wkSelected} isFull={isDayFull(day.id, day.capacity)} spotsLeft={spotsLeft(day.id, day.capacity)} compact />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Summary */}
          {effectiveSelectedDays.size > 0 && (
            <div className="rounded-2xl overflow-hidden shadow-sm">
              <div className="bg-indigo-600 px-5 py-4 text-white">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Resumo da inscrição</span>
                  <span className="text-2xl font-bold">€{totalAmount.toFixed(2)}</span>
                </div>
                <p className="text-indigo-200 text-sm mt-1">
                  {seatCount} dia{seatCount !== 1 ? 's' : ''} com vaga
                  {waitlistCount > 0 && <> · {waitlistCount} em lista de espera (sem pagamento para já)</>}
                </p>
              </div>
              <div className="bg-indigo-50 px-5 py-3 space-y-1.5 text-sm">
                <div className="flex justify-between text-indigo-800">
                  <span>Sinal agora (25%)</span>
                  <span className="font-semibold">€{depositAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-indigo-600">
                  <span>Saldo após o campo (75%)</span>
                  <span>€{balanceAmount.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Child info */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Dados da criança</h2>
            {children.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-2">Escolha do perfil:</p>
                <div className="flex flex-wrap gap-2">
                  {children.map(c => (
                    <button key={c.id} type="button"
                      onClick={() => { setChildName(`${c.firstName} ${c.lastName}`); if (c.age) setChildAge(String(c.age)); }}
                      className="text-sm border border-indigo-200 bg-indigo-50 text-indigo-700 rounded-full px-3 py-1 hover:bg-indigo-100 transition-colors"
                    >
                      {c.firstName} {c.lastName}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Nome da criança *</label>
                <input type="text" required value={childName} onChange={e => setChildName(e.target.value)}
                  placeholder="Nome completo"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Idade</label>
                <input type="number" min="1" max="18" value={childAge} onChange={e => setChildAge(e.target.value)}
                  placeholder="Anos"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
              </div>
            </div>
          </div>

          {/* Parent info */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
            <h2 className="font-semibold text-gray-800">Dados do encarregado</h2>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Nome *</label>
              <input type="text" required value={parentName} onChange={e => setParentName(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Email *</label>
                <input type="email" required value={parentEmail} onChange={e => setParentEmail(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Telefone</label>
                <input type="tel" value={parentPhone} onChange={e => setParentPhone(e.target.value)}
                  placeholder="+351 9XX XXX XXX"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <label className="block font-semibold text-gray-800 mb-2">Observações <span className="font-normal text-gray-400 text-sm">(opcional)</span></label>
            <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Alergias, necessidades especiais, outros detalhes..."
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
          </div>

          {/* Submit */}
          <div className="space-y-3 pb-8">
            {effectiveSelectedDays.size > 0 && (
              <p className="text-xs text-center text-gray-500">
                {seatCount > 0
                  ? <>A vaga fica reservada com o pagamento do sinal de <strong>€{depositAmount.toFixed(2)}</strong>, no prazo de 7 dias. Sem pagamento, a inscrição passa para a lista de espera.</>
                  : <>Os dias escolhidos estão completos: a inscrição fica em lista de espera, sem nada a pagar para já.</>}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting || effectiveSelectedDays.size === 0}
              className="w-full bg-indigo-600 text-white py-3.5 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
            >
              {submitting ? 'A processar...' : effectiveSelectedDays.size === 0 ? 'Selecione pelo menos um dia' : seatCount === 0 ? 'Entrar na lista de espera' : `Inscrever — €${totalAmount.toFixed(2)}`}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── DayRow ─────────────────────────────────────────────────────────────────────

function DayRow({
  day, selected, isFull, spotsLeft, onClick, compact = false,
}: {
  day: CampDay; selected: boolean; isFull: boolean; spotsLeft: number;
  onClick?: () => void; compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex items-center justify-between px-4 py-2 text-sm">
        <span className="text-gray-700">
          {fmtDayOfWeek(day.date)} {fmtDate(day.date)}
        </span>
        <div className="flex items-center gap-3">
          <span className={`text-xs ${isFull ? 'text-amber-600' : 'text-gray-500'}`}>{isFull ? 'Completo · lista de espera' : `${spotsLeft} vaga${spotsLeft !== 1 ? 's' : ''}`}</span>
          <span className="font-semibold text-gray-800">€{day.price.toFixed(2)}</span>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className={[
        'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all text-left',
        selected && isFull ? 'border-amber-400 bg-amber-50 cursor-pointer' :
        selected ? 'border-indigo-400 bg-indigo-50 cursor-pointer' :
        onClick ? 'border-gray-100 bg-white hover:border-indigo-200 cursor-pointer' :
        'border-gray-100 bg-gray-50',
      ].join(' ')}
    >
      {onClick && (
        <span className={`w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center text-xs ${
          selected ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-gray-300'
        }`}>
          {selected && '✓'}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-800">{fmtDayOfWeek(day.date)} {fmtDate(day.date)}</span>
          {isFull && <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Completo · lista de espera</span>}
        </div>
        <div className="text-xs text-gray-400 mt-0.5 space-x-2">
          <span>Manhã: {day.morning}</span>
          <span>·</span>
          <span>Tarde: {day.afternoon}</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="font-bold text-gray-800">€{day.price.toFixed(2)}</p>
        {!isFull && <p className="text-xs text-gray-400">{spotsLeft} vaga{spotsLeft !== 1 ? 's' : ''}</p>}
      </div>
    </button>
  );
}
