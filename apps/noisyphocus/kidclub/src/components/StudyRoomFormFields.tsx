import { AppUser, StudyCenterConfig, StudyRoomEntry } from "@shared/models";
import React, { useEffect } from "react";

interface StudyRoomFormFieldsProps {
  formData: StudyRoomEntry;
  setFormData: React.Dispatch<React.SetStateAction<StudyRoomEntry | null>>;
  isSimulation?: boolean;
  priceConfig: StudyCenterConfig; // New prop
  needsTransport: boolean; // New prop
  currentUser: AppUser | null | undefined; // New prop
}

const WEEKDAYS = [
  { label: "Segunda-feira", value: "monday" },
  { label: "Terça-feira", value: "tuesday" },
  { label: "Quarta-feira", value: "wednesday" },
  { label: "Quinta-feira", value: "thursday" },
  { label: "Sexta-feira", value: "friday" },
];

export default function StudyRoomFormFields({
  formData,
  setFormData,
  isSimulation = false,
  priceConfig,
  needsTransport,
  currentUser,
}: StudyRoomFormFieldsProps) {

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => {
      if (!prev) return null;
      let newValue: string | Date | number = value;
      if (type === 'date') {
        newValue = new Date(value);
      } else if (type === 'number') {
        newValue = parseFloat(value);
      }
      const newState = { ...prev, [name]: newValue };
      return newState;
    });
  };

  const handleDayToggle = (dayValue: string) => {
    setFormData(prev => {
      if (!prev) return null;
      const existingDay = prev.days.find(d => d.day === dayValue);
      if (existingDay) {
        return {
          ...prev,
          days: prev.days.filter(d => d.day !== dayValue),
        };
      } else {
        return {
          ...prev,
          days: [...prev.days, { day: dayValue, hour: '14:00', transport: false }],
        };
      }
    });
  };

  const handleHourChange = (dayValue: string, hour: string) => {
    setFormData(prev => {
      if (!prev) return null;
      return {
        ...prev,
        days: prev.days.map(d => (d.day === dayValue ? { ...d, hour } : d)),
      };
    });
  };

  const handleTransportToggle = (dayValue: string) => {
    setFormData(prev => {
      if (!prev) return null;
      return {
        ...prev,
        days: prev.days.map(d => (d.day === dayValue ? { ...d, transport: !d.transport } : d)),
      };
    });
  };

  const isOwner = currentUser?.roles?.owner === true;

  // Calculate pricing within this component, as it depends on formData.days
  const { basePrice, transportFee, total } = React.useMemo(() => {
    let calculatedBasePrice = 0;
    let calculatedTransportFee = 0;

    if (isOwner && formData.basePrice !== undefined && formData.transportFee !== undefined) {
      calculatedBasePrice = formData.basePrice;
      calculatedTransportFee = formData.transportFee;
    } else {
      const monthlyPricePerWeekday = Number(priceConfig.monthlyPricePerWeekday) || 0;
      const monthlyTransportFeePerWeekday = Number(priceConfig.monthlyTransportFeePerWeekday) || 0;

      const currentDays = formData?.days || [];
      calculatedBasePrice = currentDays.length * monthlyPricePerWeekday;
      const transportDaysCount = currentDays.filter((d) => d.transport).length;
      calculatedTransportFee = transportDaysCount * monthlyTransportFeePerWeekday;
    }

    const registrationFee = Number(priceConfig.registrationFee) || 0;
    const insuranceFee = Number(priceConfig.insuranceFee) || 0;

    const total = calculatedBasePrice + registrationFee + insuranceFee + calculatedTransportFee;
    return { basePrice: calculatedBasePrice, transportFee: calculatedTransportFee, total };
  }, [formData?.days, formData.basePrice, formData.transportFee, priceConfig, isOwner]);

  // Update formData with calculated prices
  useEffect(() => {
    if (formData && (formData.basePrice !== basePrice || formData.transportFee !== transportFee || formData.total !== total)) {
      setFormData(prev => prev ? { ...prev, basePrice, transportFee, total } : null);
    }
  }, [basePrice, transportFee, total, formData, setFormData]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
      {/* Left Column - Student and Parent Data */}
      <div className="space-y-4">
        {!isSimulation && (
          <>
            <div>
              <label className="block font-medium">👧 Nome do Aluno</label>
              <input type="text" name="studentName" value={formData.studentName} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>

            <div>
              <label className="block font-medium">🏫 Escola</label>
              <input type="text" name="schoolName" value={formData.schoolName} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>

            <div>
              <label className="block font-medium">📚 Ano Escolar (1º ao 6º)</label>
              <input type="text" name="schoolYear" value={formData.schoolYear} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>

            <div>
              <label className="block font-medium">👨‍👩‍👧 Nome do Responsável</label>
              <input type="text" name="guardianName" value={formData.guardianName} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>

            <div>
              <label className="block font-medium">📧 Email</label>
              <input type="email" name="email" value={formData.email} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>

            <div>
              <label className="block font-medium">📞 Telemóvel</label>
              <input type="tel" name="phone" value={formData.phone} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>
          </>
        )}
      </div>

      {/* Right Column - Scheduling, Notes, and Pricing */}
      <div className="space-y-4">
        <div>
          <label className={`block font-medium ${isSimulation ? 'text-white' : ''}`}>📆 Dias de Frequência</label>
          <div className="mt-2 space-y-1">
            {WEEKDAYS.map((d) => {
              const selected = formData.days.find(day => day.day === d.value);
              return (
                <div key={d.value} className="flex items-center justify-between p-2 border-b border-gray-700">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!selected}
                      onChange={() => handleDayToggle(d.value)}
                    />
                    <span className={`font-semibold ${isSimulation ? 'text-white' : ''}`}>{d.label}</span>
                  </label>
                  {selected && (
                    <div className="flex items-center space-x-4">
                      <input
                        type="time"
                        className="border rounded px-2 py-1 w-fit bg-gray-800 text-white"
                        value={selected.hour}
                        onChange={(e) => handleHourChange(d.value, e.target.value)}
                      />
                      <label className={`flex items-center gap-2 text-sm ${isSimulation ? 'text-gray-300' : ''}`}>
                        <input type="checkbox" checked={selected.transport} onChange={() => handleTransportToggle(d.value)} />
                        Transporte
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {!isSimulation && (
          <>
            <div>
              <label className="block font-medium">📝 Observações</label>
              <textarea
                placeholder="Ex: Necessidades especiais, alergias, medicação, etc."
                className="w-full border rounded px-3 py-2 mt-1"
                rows={3}
                name="note"
                value={formData.note ?? ''}
                onChange={handleChange} />
            </div>

            <div>
              <label className="block font-medium">Data de Início</label>
              <input type="date" name="startDate" value={formData.startDate instanceof Date ? formData.startDate.toISOString().split('T')[0] : ''} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>

            <div>
              <label className="block font-medium">Data de Fim</label>
              <input type="date" name="endDate" value={formData.endDate instanceof Date ? formData.endDate.toISOString().split('T')[0] : ''} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" required />
            </div>

            {isOwner && (
              <div className="mt-4">
                <h3 className="text-lg font-semibold mb-2">Preços Manuais (Apenas para Proprietários)</h3>
                <div>
                  <label className="block font-medium">Mensalidade Estudo (€)</label>
                  <input type="number" name="basePrice" value={formData.basePrice ?? ''} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" step="0.01" />
                </div>
                <div className="mt-2">
                  <label className="block font-medium">Mensalidade Transporte (€)</label>
                  <input type="number" name="transportFee" value={formData.transportFee ?? ''} onChange={handleChange} className="w-full border rounded px-3 py-2 mt-1" step="0.01" />
                </div>
              </div>
            )}

            {/* Pricing display */}
            <div className={`mt-4 space-y-1 text-sm ${isSimulation ? 'text-gray-300' : 'text-gray-700'}`}>
              <p>💰 Mensalidade: €{basePrice.toFixed(2)}</p>
              {needsTransport && <p>🚐 Transporte: €{transportFee.toFixed(2)}</p>}
              <p>🟡 Inscrição (única): €{priceConfig.registrationFee.toFixed(2)}</p>
              <p>🔵 Seguro (único): €{priceConfig.insuranceFee.toFixed(2)}</p>
              <p className={`font-bold ${isSimulation ? 'text-white' : 'text-black'}`}>📦 Primeiro pagamento: €{total.toFixed(2)}</p>
              <p className={`italic ${isSimulation ? 'text-gray-400' : 'text-gray-500'}`}>* A partir do segundo mês: €{(basePrice + transportFee).toFixed(2)}/mês</p>
            </div>

            
          </>
        )}
      </div>
    </div>
  );
}