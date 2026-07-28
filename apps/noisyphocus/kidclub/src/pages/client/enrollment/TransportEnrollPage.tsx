import { useState, useEffect } from 'react';
import { useSearchParams, Navigate, Link } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child } from '@shared/models';
import { TransportationConfig } from '@shared/models/Transportation';
import { familyService } from '../../../services/familyService';
import { getTransportationConfig } from '../../../services/transportationService';
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
  '07:00', '07:15', '07:30', '07:45',
  '08:00', '08:15', '08:30', '08:45',
  '09:00', '09:15', '09:30', '09:45',
  '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
  '16:00', '16:15', '16:30', '16:45',
  '17:00', '17:15', '17:30', '17:45',
  '18:00', '18:30', '19:00',
];

interface Slot {
  pickupTime: string;
  pickupLocation: string;
  dropoffLocation: string;
}

const DEFAULT_SLOT: Slot = {
  pickupTime: '08:00',
  pickupLocation: '',
  dropoffLocation: 'Arco-Íris da Pequenada',
};

export default function TransportEnrollPage() {
  const user = useUser();
  const [searchParams] = useSearchParams();
  const childId = searchParams.get('childId');

  const [child, setChild] = useState<Child | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [config, setConfig] = useState<TransportationConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // selectedDays drives which days are shown; daySlots holds slots per day
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [daySlots, setDaySlots] = useState<Record<string, Slot[]>>({});
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!user || !childId) return;
    const load = async () => {
      setIsLoading(true);
      try {
        const [fam, c, cfg] = await Promise.all([
          familyService.getOrCreateFamily(user.uid, user.name || '', user.email || ''),
          familyService.getChild(childId),
          getTransportationConfig(),
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

  const totalSlots = selectedDays.reduce((sum, day) => sum + (daySlots[day]?.length ?? 0), 0);
  const monthlyFee = config ? totalSlots * config.flatRatePerTrip * 4 : 0;

  const toggleDay = (day: string) => {
    setSelectedDays(prev => {
      if (prev.includes(day)) return prev.filter(d => d !== day);
      setDaySlots(s => ({ ...s, [day]: s[day] ?? [{ ...DEFAULT_SLOT }] }));
      return [...prev, day];
    });
  };

  const updateSlot = (day: string, index: number, field: keyof Slot, value: string) => {
    setDaySlots(s => {
      const slots = [...(s[day] ?? [])];
      slots[index] = { ...slots[index], [field]: value };
      return { ...s, [day]: slots };
    });
  };

  const addSlot = (day: string) => {
    setDaySlots(s => ({
      ...s,
      [day]: [...(s[day] ?? []), { ...DEFAULT_SLOT, pickupTime: '16:00' }],
    }));
  };

  const removeSlot = (day: string, index: number) => {
    setDaySlots(s => ({
      ...s,
      [day]: (s[day] ?? []).filter((_, i) => i !== index),
    }));
  };

  const isValid = selectedDays.length > 0
    && selectedDays.every(day =>
      (daySlots[day] ?? []).length > 0
      && (daySlots[day] ?? []).every(s => s.pickupLocation.trim())
    );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !familyId || !isValid) return;

    setSubmitting(true);
    try {
      const today = new Date();
      const nextJuly = new Date(today.getFullYear() + (today.getMonth() > 5 ? 1 : 0), 6, 31);

      const schedule = selectedDays.flatMap(day =>
        (daySlots[day] ?? []).map(slot => ({
          dayOfWeek: day,
          pickupTime: slot.pickupTime,
          pickupLocation: slot.pickupLocation,
          dropoffLocation: slot.dropoffLocation,
        }))
      );

      await addDoc(col('transportationSubscriptions'), {
        familyId,
        userId: user?.uid || '',
        childId: child.id,
        childName: `${child.firstName} ${child.lastName}`,
        childAge: child.age || 0,
        contactMobile: '',
        contactEmail: user?.email || '',
        startDate: today.toISOString().split('T')[0],
        endDate: nextJuly.toISOString().split('T')[0],
        status: 'pending',
        monthlyFee,
        schedule,
        note: note || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (!childId) return <Navigate to="/client/children" replace />;

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  if (submitted) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold mb-2">Pedido enviado!</h2>
        <p className="text-gray-600 mb-6">
          O pedido de inscrição no Transporte para <strong>{child?.firstName}</strong> foi recebido.
          A nossa equipa irá confirmar em breve.
        </p>
        <Link to="/client/subscriptions" className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700">
          Ver as minhas inscrições
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link to="/client/subscriptions" className="text-blue-600 hover:underline text-sm">← Voltar</Link>
        <h1 className="text-2xl font-bold mt-2">Inscrição — Transporte</h1>
        {child && <p className="text-gray-600 mt-1">Para {child.firstName} {child.lastName}</p>}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Days + slots */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-1">Dias da semana *</h2>
          {config && (
            <p className="text-sm text-gray-500 mb-4">
              €{config.flatRatePerTrip.toFixed(2)} por viagem · pode ter várias viagens por dia
            </p>
          )}
          <div className="space-y-3">
            {WEEKDAYS.map(({ label, value }) => {
              const selected = selectedDays.includes(value);
              const slots = daySlots[value] ?? [];
              return (
                <div
                  key={value}
                  className={`rounded-lg border transition-colors ${
                    selected ? 'border-green-500 bg-green-50' : 'border-gray-200'
                  }`}
                >
                  {/* Day checkbox row */}
                  <label className="flex items-center gap-3 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleDay(value)}
                      className="w-4 h-4 text-green-600"
                    />
                    <span className="font-medium text-sm">{label}</span>
                  </label>

                  {/* Slots for this day */}
                  {selected && (
                    <div className="px-3 pb-3 space-y-3">
                      {slots.map((slot, i) => (
                        <div key={i} className="bg-white rounded-lg border border-green-200 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">
                              Viagem {i + 1}
                            </span>
                            {slots.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeSlot(value, i)}
                                className="text-xs text-red-400 hover:text-red-600"
                              >
                                Remover
                              </button>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">Hora</label>
                              <select
                                value={slot.pickupTime}
                                onChange={e => updateSlot(value, i, 'pickupTime', e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                              >
                                {TIME_SLOTS.map(t => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Local de recolha *</label>
                            <input
                              type="text"
                              required
                              placeholder="Morada ou local"
                              value={slot.pickupLocation}
                              onChange={e => updateSlot(value, i, 'pickupLocation', e.target.value)}
                              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                            />
                          </div>

                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Destino</label>
                            <input
                              type="text"
                              placeholder="Arco-Íris da Pequenada"
                              value={slot.dropoffLocation}
                              onChange={e => updateSlot(value, i, 'dropoffLocation', e.target.value)}
                              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                            />
                          </div>
                        </div>
                      ))}

                      <button
                        type="button"
                        onClick={() => addSlot(value)}
                        className="w-full text-sm text-green-700 border border-green-300 border-dashed rounded-lg py-2 hover:bg-green-100 transition"
                      >
                        + Adicionar viagem
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Price preview */}
        {totalSlots > 0 && config && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex justify-between items-center">
            <div>
              <span className="font-medium text-green-900">Mensalidade estimada</span>
              <p className="text-xs text-green-700">
                {totalSlots} {totalSlots === 1 ? 'viagem' : 'viagens'}/semana × €{config.flatRatePerTrip.toFixed(2)} × 4 semanas
              </p>
            </div>
            <span className="text-2xl font-bold text-green-700">€{monthlyFee.toFixed(2)}</span>
          </div>
        )}

        {/* Notes */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-3">Observações (opcional)</h2>
          <textarea
            rows={3}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Informações adicionais para a equipa de transporte..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 resize-none"
          />
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
          O pedido será analisado pela nossa equipa. Receberá uma confirmação por email após aprovação.
        </div>

        <button
          type="submit"
          disabled={submitting || !isValid}
          className="w-full bg-green-600 text-white py-3 rounded-lg font-medium hover:bg-green-700 disabled:opacity-60"
        >
          {submitting ? 'A enviar pedido...' : 'Submeter pedido de inscrição'}
        </button>
      </form>
    </div>
  );
}
