import { useState, useEffect, useMemo } from 'react';
import { Booking } from '@shared/models/Booking';
import { PartyConfig } from '@shared/models/PartyConfig';
import { partyService } from '../services/partyService';

interface PartyBookingFormProps {
  initialData?: Booking;
  onSave?: (updatedBooking: Booking, reason: string) => void;
  partyConfig: PartyConfig;
}

const stripEmptyStringsToNull = <T extends Record<string, any>>(obj: T): T => {
  const newObj: T = { ...obj };
  for (const key in newObj) {
    if (typeof newObj[key] === 'string' && newObj[key] === '') {
      newObj[key] = null as any;
    }
  }
  return newObj;
};

export default function PartyBookingForm({ initialData, onSave, partyConfig }: PartyBookingFormProps) {
  const [formData, setFormData] = useState<Booking | null>(initialData ?? null);
  const [changeReason, setChangeReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);

  const total = useMemo(() => {
    if (!formData) return 0;

    const partyType = partyConfig.partyTypes.find(pt => pt.name === formData.partyType);
    if (!partyType) return 0;

    let calculatedTotal = partyType.basePrice;

    if (formData.numKids > partyType.includedKids) {
      calculatedTotal += (formData.numKids - partyType.includedKids) * partyType.pricePerExtraChild;
    }

    formData.extras?.forEach(extraName => {
      const extra = partyConfig.extras.find(ex => ex.name === extraName);
      if (extra) {
        calculatedTotal += extra.price;
      }
    });

    return calculatedTotal;
  }, [formData, partyConfig]);

  useEffect(() => {
    setFormData(prev => {
      if (prev && prev.total !== total) {
        return { ...prev, total };
      }
      return prev;
    });
  }, [total, setFormData]);

  useEffect(() => {
    if (initialData) {
      setFormData(initialData);
    }
  }, [initialData]);

  const nextStep = () => setCurrentStep(prev => prev + 1);
  const prevStep = () => setCurrentStep(prev => prev - 1);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData) return;

    const dataToSave = stripEmptyStringsToNull(formData);

    if (onSave) {
      if (!changeReason.trim()) {
        alert("Por favor, insira a razão da alteração.");
        return;
      }
      onSave(dataToSave, changeReason);
    } else {
      await partyService.createBooking({ ...dataToSave, createdAt: new Date(), status: 'pending' });
      setSubmitted(true);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => {
      if (!prev) return null;
      let newValue: string | number = value;
      if (type === 'number') {
        newValue = parseFloat(value);
      }
      return { ...prev, [name]: newValue };
    });
  };

  const handleExtraToggle = (extraName: string) => {
    setFormData(prev => {
      if (!prev) return null;
      const newExtras = prev.extras?.includes(extraName)
        ? prev.extras.filter(e => e !== extraName)
        : [...(prev.extras || []), extraName];
      return { ...prev, extras: newExtras };
    });
  };

  if (submitted && !onSave) {
    return (
      <div className="text-center p-6">
        <p className="text-green-600 text-lg">✅ Reserva enviada com sucesso!</p>
      </div>
    );
  }

  if (!formData) return null;

  const steps = ['Detalhes', 'Extras', 'Dados'];
  const partyType = partyConfig.partyTypes.find(pt => pt.name === formData.partyType);

  return (
    <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-xl max-w-3xl mx-auto relative pb-24">
      <h2 className="text-3xl font-bold text-center mb-2 text-purple-600">🎈 Reserva de Festa</h2>
      <p className="text-center text-gray-500 mb-6">Passo {currentStep} de {steps.length}: {steps[currentStep - 1]}</p>

      <div className="mb-6">
        <div className="flex justify-between">
          {steps.map((step) => (
            <div key={step} className={`w-1/3 text-center ${steps[currentStep - 1] === step ? 'font-bold text-purple-600' : 'text-gray-400'}`}>
              {step}
              <div className={`mt-2 h-1 ${steps.indexOf(step) + 1 <= currentStep ? 'bg-purple-600' : 'bg-gray-300'}`}></div>
            </div>
          ))}
        </div>
      </div>

      <div>
        {currentStep === 1 && (
          <div className="space-y-6">
            <div className="p-6 bg-white rounded-xl shadow-md">
              <div className="space-y-4">
                <div>
                  <label className="block font-semibold text-sm mb-2 text-gray-600">Tipo de Festa</label>
                  <select name="partyType" value={formData.partyType} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-purple-500 focus:ring-purple-500 text-sm" required>
                    <option value="">Selecione o tipo de festa</option>
                    {partyConfig.partyTypes.map(pt => (
                      <option key={pt.name} value={pt.name}>{pt.name}</option>
                    ))}
                  </select>
                  {formData.partyType && (
                    <p className="text-xs text-gray-500 mt-2 italic">
                      {partyConfig.partyTypes.find(pt => pt.name === formData.partyType)?.description}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block font-semibold text-gray-600 text-sm mb-2">📅 Data da Festa</label>
                  <input type="date" name="date" value={formData.date} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-purple-500 focus:ring-purple-500 text-sm" required />
                </div>
                <div>
                  <label className="block font-semibold text-gray-600 text-sm mb-2">⏰ Hora da Festa</label>
                  <input type="time" name="time" value={formData.time} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-purple-500 focus:ring-purple-500 text-sm" required />
                </div>
                <div>
                  <label className="block font-semibold text-sm mb-2 text-gray-600">👧👦 Número de Crianças</label>
                  <input type="number" name="numKids" value={formData.numKids} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-purple-500 focus:ring-purple-500 text-sm" required />
                  {partyType && (
                    <p className="text-xs text-gray-500 mt-2 italic">
                      Inclui {partyType.includedKids} crianças. Criança extra: €{partyType.pricePerExtraChild.toFixed(2)}.
                      {formData.numKids > partyType.includedKids && (
                        <span className="block text-green-600">
                          Custo adicional para {formData.numKids - partyType.includedKids} criança(s): €{((formData.numKids - partyType.includedKids) * partyType.pricePerExtraChild).toFixed(2)}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-6">
            <div className="p-6 bg-white rounded-xl shadow-md">
              <h3 className="text-xl font-semibold text-gray-700 mb-4">Extras</h3>
              <div className="space-y-4">
                {partyConfig.extras.map(extra => (
                  <div key={extra.name} className={`p-4 rounded-lg transition-all duration-300 flex items-center justify-between cursor-pointer border ${formData.extras?.includes(extra.name) ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'}`} onClick={() => handleExtraToggle(extra.name)}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" id={`extra-${extra.name}`} checked={formData.extras?.includes(extra.name) || false} onChange={() => {}} className="h-5 w-5 rounded-md border-gray-300 text-purple-500 focus:ring-purple-500" />
                      <span className="font-semibold text-gray-800">{extra.name}</span>
                    </label>
                    <span className="font-semibold text-purple-500">+€{extra.price.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {currentStep === 3 && (
          <div className="space-y-6">
            <div className="p-6 bg-white rounded-xl shadow-md">
              <div className="space-y-4">
                <div>
                  <label className="block font-semibold text-gray-600 text-sm mb-2">👤 Nome do Responsável</label>
                  <input type="text" name="parentName" value={formData.parentName} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-pink-500 focus:ring-pink-500 text-sm" required />
                </div>
                <div>
                  <label className="block font-semibold text-gray-600 text-sm mb-2">📧 Email</label>
                  <input type="email" name="email" value={formData.email} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-pink-500 focus:ring-pink-500 text-sm" required />
                </div>
                <div>
                  <label className="block font-semibold text-gray-600 text-sm mb-2">📞 Telemóvel</label>
                  <input type="tel" name="phone" value={formData.phone} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-pink-500 focus:ring-pink-500 text-sm" required />
                </div>
                <div>
                  <label className="block font-semibold text-gray-600 text-sm mb-2">🎉 Nome da Criança</label>
                  <input type="text" name="childName" value={formData.childName} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-pink-500 focus:ring-pink-500 text-sm" required />
                </div>
                <div>
                  <label className="block font-semibold text-gray-600 text-sm mb-2">🎂 Idade a Celebrar</label>
                  <input type="number" name="childAge" value={formData.childAge} onChange={handleChange} className="w-full border-gray-300 rounded-md shadow-sm focus:border-pink-500 focus:ring-pink-500 text-sm" required />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="p-6 bg-gray-50 rounded-xl shadow-md mt-6">
        <h3 className="text-xl font-semibold text-gray-700 mb-4">Resumo da Reserva</h3>
        {partyType && (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span>{partyType.name} (inclui {partyType.includedKids} crianças)</span>
              <span>€{partyType.basePrice.toFixed(2)}</span>
            </div>
            {formData.numKids > partyType.includedKids && (
              <div className="flex justify-between">
                <span>Crianças extra ({formData.numKids - partyType.includedKids} x €{partyType.pricePerExtraChild.toFixed(2)})</span>
                <span>€{((formData.numKids - partyType.includedKids) * partyType.pricePerExtraChild).toFixed(2)}</span>
              </div>
            )}
            {formData.extras && formData.extras.length > 0 && (
              <div>
                <p className="font-semibold mt-2">Extras:</p>
                {formData.extras.map(extraName => {
                  const extra = partyConfig.extras.find(ex => ex.name === extraName);
                  if (!extra) return null;
                  return (
                    <div className="flex justify-between" key={extra.id}>
                      <span>{extra.name}</span>
                      <span>€{extra.price.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="border-t pt-2 mt-2">
              <div className="flex justify-between font-semibold">
                <span>Subtotal</span>
                <span>€{total.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>IVA (23%)</span>
                <span>€{(total * 0.23).toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold text-lg mt-1">
                <span>Total</span>
                <span>€{(total * 1.23).toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 bg-gray-100 p-4 border-t border-gray-200 flex justify-end items-center">
        <div className="flex gap-4">
          {currentStep > 1 && (
            <button type="button" onClick={prevStep} className="px-6 py-2 rounded-lg bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors">
              Anterior
            </button>
          )}
          {currentStep < steps.length && (
            <button type="button" onClick={nextStep} className="px-6 py-2 rounded-lg bg-purple-500 text-white hover:bg-purple-600 transition-colors">
              Próximo
            </button>
          )}
          {currentStep === steps.length && !onSave && (
            <button type="submit" className="px-6 py-2 rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors">
              Enviar Reserva
            </button>
          )}
        </div>
      </div>

      {onSave && (
        <div className="mt-6 pt-4 border-t">
          <label className="block text-sm font-medium text-gray-700">Razão da Alteração</label>
          <textarea
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
            placeholder="Descreva o motivo da alteração..." required
          ></textarea>
          <div className="flex justify-end gap-4 mt-4">
            <button type="button" onClick={() => onSave(formData, changeReason)} className="px-4 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300">
              Cancelar
            </button>
            <button type="submit" className="px-4 py-2 rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:bg-blue-300" disabled={!changeReason.trim()}>
              Guardar Alterações
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
