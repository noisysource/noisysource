import { useState, useMemo, useEffect } from 'react';
import { DaySelection, StudyRoomEntry } from '@shared/models/StudyRoomEntry';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import StudyRoomFormFields from "./StudyRoomFormFields";
import { useUser } from '@shared/hooks';
import { studyRoomService } from '../services/studyRoomService';

const WEEKDAYS = [
  { label: 'Segunda-feira', value: 'monday' },
  { label: 'Terça-feira', value: 'tuesday' },
  { label: 'Quarta-feira', value: 'wednesday' },
  { label: 'Quinta-feira', value: 'thursday' },
  { label: 'Sexta-feira', value: 'friday' },
];

interface StudyRoomFormProps {
  priceConfig: StudyCenterConfig;
  isSimulation?: boolean;
  initialData?: StudyRoomEntry; // New prop for initial data
  onSave?: (updatedEntry: StudyRoomEntry, reason: string) => void; // New prop for save callback
}

// Helper to convert empty strings to null for Firestore compatibility
const stripEmptyStringsToNull = <T extends Record<string, any>>(obj: T): T => {
  const newObj: T = { ...obj };
  for (const key in newObj) {
    if (typeof newObj[key] === 'string' && newObj[key] === '') {
      newObj[key] = null as any; // Cast to any to allow null assignment
    }
  }
  return newObj;
};

export default function StudyRoomForm({ priceConfig, isSimulation = false, initialData, onSave }: StudyRoomFormProps) {
  const user = useUser();
  const [formData, setFormData] = useState<StudyRoomEntry | null>(initialData || (() => {
    const today = new Date();
    const nextJuly = new Date(today.getFullYear() + (today.getMonth() > 6 ? 1 : 0), 6, 31); // July is month 6 (0-indexed)

    return {
      id: '',
      familyId: '',
      childId: '',
      childName: '',
      schoolName: '',
      schoolYear: '',
      days: [],
      note: undefined,
      monthlyPrice: 0,
      startDate: today,
      endDate: nextJuly,
      createdAt: new Date(),
      updatedAt: new Date(),
      needsTransport: false,
      status: 'pending',
      uploadedFiles: [],
      statusHistory: [],
      entryHistory: [],
    } as StudyRoomEntry;
  })());
  const [changeReason, setChangeReason] = useState(''); // For edit mode
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (initialData) {
      setFormData(initialData);
    }
  }, [initialData]);

  const needsTransport = formData?.days.some(d => d.transport) || false;

  // Pricing calculation is now handled in StudyRoomFormFields
  // We still need these values for the new entry submission
  const { basePrice, transportFee, monthlyPrice } = useMemo(() => {
    const monthlyPricePerWeekday = Number(priceConfig.monthlyPricePerWeekday) || 0;
    const registrationFee = Number(priceConfig.registrationFee) || 0;
    const insuranceFee = Number(priceConfig.insuranceFee) || 0;
    const monthlyTransportFeePerWeekday = Number(priceConfig.monthlyTransportFeePerWeekday) || 0;

    const currentDays = formData?.days || [];
    const basePrice = currentDays.length * monthlyPricePerWeekday;
    const transportDaysCount = currentDays.filter((d) => d.transport).length;
    const transportFee = transportDaysCount * monthlyTransportFeePerWeekday;
    const monthlyPrice = basePrice + registrationFee + insuranceFee + transportFee;
    return { basePrice, transportFee, monthlyPrice };
  }, [formData?.days, priceConfig]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData) return;

    const dataToSave = stripEmptyStringsToNull(formData);

    if (onSave) { // Edit mode
      if (!changeReason.trim()) {
        alert("Por favor, insira a razão da alteração.");
        return;
      }
      onSave({
        ...dataToSave,
        monthlyPrice,
      }, changeReason);
    } else { // New entry mode
      if (isSimulation) return;

      await studyRoomService.createEntry({
        ...dataToSave,
        monthlyPrice,
        startDate: dataToSave.startDate,
        endDate: dataToSave.endDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'pending',
      });
      setSubmitted(true);
    }
  };

  if (submitted && !onSave) { // Only show submitted message for new entries
    return (
      <div className="text-center p-6">
        <p className="text-green-600 text-lg">✅ Inscrição enviada com sucesso!</p>
      </div>
    );
  }

  if (!formData) return null; // Should not happen with initial state

  return (
    <form onSubmit={handleSubmit} className={`${isSimulation ? '' : 'bg-white p-6 rounded shadow'} max-w-4xl mx-auto`}>
      <h2 className={`text-2xl font-bold text-center mb-6 ${isSimulation ? 'text-white' : ''}`}>🧮 Inscrição - Sala de Estudo</h2>

      <StudyRoomFormFields formData={formData} setFormData={setFormData} isSimulation={isSimulation} priceConfig={priceConfig} needsTransport={needsTransport} currentUser={user} />

      {onSave && ( // Only show reason input and buttons in edit mode
        <div className="mt-4 pt-4 border-t border-gray-200">
          <label className="block text-sm font-medium text-gray-700">Razão da Alteração</label>
          <textarea
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
            placeholder="Descreva o motivo da alteração..." required
          ></textarea>

          <div className="flex justify-end gap-4 mt-6">
            <button
              type="button"
              onClick={() => onSave(formData, changeReason)} // Pass current formData and reason on cancel
              className="px-4 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors duration-200"
            >
              Cancelar
            </button>
            <button type="submit" className="px-4 py-2 rounded-md bg-blue-500 text-white hover:bg-blue-600 transition-colors duration-200 disabled:bg-blue-300"
              disabled={!changeReason.trim()}
            >
              Guardar Alterações
            </button>
          </div>
        </div>
      )}

      {!onSave && !isSimulation && (
        <div className="mt-4">
          <div className="text-sm text-gray-600 italic mt-2">
            ⚠️ Esta é uma pré-reserva. A inscrição será confirmada posteriormente pela nossa equipa.
          </div>
          <button type="submit" className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 w-full">Enviar Inscrição</button>
        </div>
      )}
    </form>
  );
}
