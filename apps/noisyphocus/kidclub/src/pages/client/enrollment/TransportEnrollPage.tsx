import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Navigate, Link } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child } from '@shared/models';
import { TransportationConfig } from '@shared/models/Transportation';
import { familyService } from '../../../services/familyService';
import { getTransportationConfig } from '../../../services/transportationService';
import { collection, addDoc } from 'firebase/firestore';
import { db } from '../../../lib/firebase';

const WEEKDAYS = [
  { label: 'Segunda-feira', value: 'monday' },
  { label: 'Terça-feira', value: 'tuesday' },
  { label: 'Quarta-feira', value: 'wednesday' },
  { label: 'Quinta-feira', value: 'thursday' },
  { label: 'Sexta-feira', value: 'friday' },
];

interface ScheduleEntry {
  dayOfWeek: string;
  pickupTime: string;
  pickupLocation: string;
  dropoffLocation: string;
}

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

  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [pickupLocation, setPickupLocation] = useState('');
  const [dropoffLocation, setDropoffLocation] = useState('Arco-Íris da Pequenada');
  const [pickupTime, setPickupTime] = useState('08:00');
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

  const monthlyFee = config
    ? selectedDays.length * config.flatRatePerTrip * 4 // approx 4 weeks
    : 0;

  const toggleDay = (day: string) =>
    setSelectedDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !familyId || selectedDays.length === 0) return;

    setSubmitting(true);
    try {
      const today = new Date();
      const nextJuly = new Date(today.getFullYear() + (today.getMonth() > 5 ? 1 : 0), 6, 31);

      const schedule: ScheduleEntry[] = selectedDays.map(day => ({
        dayOfWeek: day,
        pickupTime,
        pickupLocation,
        dropoffLocation,
      }));

      await addDoc(collection(db, 'transportationSubscriptions'), {
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
          O pedido de inscrição no Transporte para <strong>{child?.firstName}</strong> foi recebido.
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
        <h1 className="text-2xl font-bold mt-2">Inscrição — Transporte</h1>
        {child && (
          <p className="text-gray-600 mt-1">Para {child.firstName} {child.lastName}</p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Days */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold mb-1">Dias da semana *</h2>
          {config && (
            <p className="text-sm text-gray-500 mb-4">
              €{config.flatRatePerTrip.toFixed(2)} por viagem
            </p>
          )}
          <div className="space-y-2">
            {WEEKDAYS.map(({ label, value }) => (
              <label
                key={value}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedDays.includes(value)
                    ? 'border-green-500 bg-green-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedDays.includes(value)}
                  onChange={() => toggleDay(value)}
                  className="w-4 h-4 text-green-600"
                />
                <span className="font-medium text-sm">{label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Price preview */}
        {selectedDays.length > 0 && config && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex justify-between items-center">
            <div>
              <span className="font-medium text-green-900">Mensalidade estimada</span>
              <p className="text-xs text-green-700">{selectedDays.length} dias × €{config.flatRatePerTrip.toFixed(2)} × 4 semanas</p>
            </div>
            <span className="text-2xl font-bold text-green-700">€{monthlyFee.toFixed(2)}</span>
          </div>
        )}

        {/* Route */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold">Percurso</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Local de recolha *</label>
            <input
              type="text"
              required
              placeholder="Morada de recolha da criança"
              value={pickupLocation}
              onChange={e => setPickupLocation(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Destino</label>
            <input
              type="text"
              value={dropoffLocation}
              onChange={e => setDropoffLocation(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Hora de recolha</label>
            <input
              type="time"
              value={pickupTime}
              onChange={e => setPickupTime(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

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
          disabled={submitting || selectedDays.length === 0 || !pickupLocation}
          className="w-full bg-green-600 text-white py-3 rounded-lg font-medium hover:bg-green-700 disabled:opacity-60"
        >
          {submitting ? 'A enviar pedido...' : 'Submeter pedido de inscrição'}
        </button>
      </form>
    </div>
  );
}
