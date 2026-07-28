import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate, Navigate, Link } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child, StudyCenterConfig } from '@shared/models';
import { familyService } from '../../../services/familyService';
import { studyRoomService } from '../../../services/studyRoomService';
import { addDoc } from 'firebase/firestore';
import { col } from '../../../lib/db';

const WEEKDAYS = [
  { label: 'Segunda-feira', value: 'monday' },
  { label: 'Terça-feira', value: 'tuesday' },
  { label: 'Quarta-feira', value: 'wednesday' },
  { label: 'Quinta-feira', value: 'thursday' },
  { label: 'Sexta-feira', value: 'friday' },
];

const TIME_SLOTS = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30', '18:00',
];

export default function StudyRoomEnrollPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const childId = searchParams.get('childId');

  const [child, setChild] = useState<Child | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [config, setConfig] = useState<StudyCenterConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [dayHours, setDayHours] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().split('T')[0];
  });

  useEffect(() => {
    if (!user || !childId) return;
    const load = async () => {
      setIsLoading(true);
      try {
        const [fam, c, cfg] = await Promise.all([
          familyService.getOrCreateFamily(user.uid, user.name || '', user.email || ''),
          familyService.getChild(childId),
          studyRoomService.getStudyCenterConfig(),
        ]);
        setFamilyId(fam.id);
        setChild(c);
        setConfig(cfg);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [user, childId]);

  const monthlyPrice = useMemo(() => {
    if (!config) return 0;
    return selectedDays.length * config.monthlyPricePerWeekday;
  }, [selectedDays, config]);

  const toggleDay = (day: string) => {
    setSelectedDays(prev => {
      if (prev.includes(day)) return prev.filter(d => d !== day);
      setDayHours(h => ({ ...h, [day]: h[day] ?? '14:00' }));
      return [...prev, day];
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !familyId || !config || selectedDays.length === 0) return;

    setSubmitting(true);
    try {
      const today = new Date();
      const nextJuly = new Date(today.getFullYear() + (today.getMonth() > 5 ? 1 : 0), 6, 31);

      await addDoc(col('studyroom'), {
        familyId,
        userId: user?.uid || '',
        childId: child.id,
        childName: `${child.firstName} ${child.lastName}`,
        studentName: `${child.firstName} ${child.lastName}`,
        schoolName: child.schoolName || '',
        schoolYear: child.schoolYear || '',
        guardianName: user?.name || '',
        email: user?.email || '',
        phone: '',
        days: selectedDays.map(d => ({ day: d, hour: dayHours[d] ?? '14:00', transport: false })),
        monthlyPrice,
        basePrice: monthlyPrice,
        startDate: new Date(startDate),
        endDate: nextJuly,
        note: note || null,
        status: 'pending',
        canceled: false,
        needsTransport: false,
        uploadedFiles: [],
        statusHistory: [],
        entryHistory: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (!childId) {
    return <Navigate to="/client/children" replace />;
  }

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  if (submitted) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold mb-2">Pedido enviado!</h2>
        <p className="text-gray-600 mb-6">
          O pedido de inscrição na Sala de Estudo para <strong>{child?.firstName}</strong> foi recebido.
          A nossa equipa irá confirmar em breve.
        </p>
        <Link to="/client/subscriptions" className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700">
          Ver as minhas inscrições
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link to="/client/subscriptions" className="text-blue-600 hover:underline text-sm">← Voltar</Link>
        <h1 className="text-2xl font-bold mt-2">Inscrição — Sala de Estudo</h1>
        {child && (
          <p className="text-gray-600 mt-1">Para {child.firstName} {child.lastName}</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Days selection */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-1">Dias da semana *</h2>
          <p className="text-sm text-gray-500 mb-4">
            {config ? `€${config.monthlyPricePerWeekday.toFixed(2)} por dia/mês` : ''}
          </p>
          <div className="space-y-2">
            {WEEKDAYS.map(({ label, value }) => {
              const selected = selectedDays.includes(value);
              return (
                <div
                  key={value}
                  className={`rounded-lg border transition-colors ${
                    selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                  }`}
                >
                  <label className="flex items-center justify-between p-3 cursor-pointer">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleDay(value)}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span className="font-medium text-sm">{label}</span>
                    </div>
                    {selected && config && (
                      <span className="text-sm text-blue-600 font-medium">
                        €{config.monthlyPricePerWeekday.toFixed(2)}/mês
                      </span>
                    )}
                  </label>
                  {selected && (
                    <div className="px-3 pb-3 flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-20 shrink-0">Hora de entrada</span>
                      <select
                        value={dayHours[value] ?? '14:00'}
                        onChange={e => setDayHours(h => ({ ...h, [value]: e.target.value }))}
                        className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {TIME_SLOTS.map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Price preview */}
        {selectedDays.length > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex justify-between items-center">
            <span className="font-medium text-blue-900">Mensalidade estimada</span>
            <span className="text-2xl font-bold text-blue-700">€{monthlyPrice.toFixed(2)}</span>
          </div>
        )}

        {/* Start date */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Data de início pretendida</h2>
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Notes */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Observações (opcional)</h2>
          <textarea
            rows={3}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Necessidades especiais, alergias, outras informações..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
          O pedido será analisado pela nossa equipa. Receberá uma confirmação por email após aprovação.
        </div>

        <button
          type="submit"
          disabled={submitting || selectedDays.length === 0}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? 'A enviar pedido...' : 'Submeter pedido de inscrição'}
        </button>
      </form>
    </div>
  );
}
