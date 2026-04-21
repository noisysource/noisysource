import React, { useEffect, useState } from 'react';
import { getTransportationConfig, saveTransportationConfig } from '../../../services/transportationService';
import { TransportationConfig } from '@shared/models/Transportation'; // Removed ZonePrice

// Add a unique id to each item for editing purposes
type Editable<T> = T & { id: string; isEditing?: boolean };

export default function AdminTransportationConfig() {
  const [config, setConfig] = useState<TransportationConfig | null>(null);
  const [flatRatePerTrip, setFlatRatePerTrip] = useState(0);
  const [vatRate, setVatRate] = useState(0.23);
  const [multiTripDiscountPercentage, setMultiTripDiscountPercentage] = useState(0.3);
  const [minTripsForDiscount, setMinTripsForDiscount] = useState(2);
  const [isFlatRateEditing, setIsFlatRateEditing] = useState(false);
  const [isVatEditing, setIsVatEditing] = useState(false);
  const [isDiscountEditing, setIsDiscountEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isNewTier, setIsNewTier] = useState(false);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const data = await getTransportationConfig();
        if (data) {
          setConfig(data);
          setFlatRatePerTrip(data.flatRatePerTrip || 0);
          setVatRate(data.vatRate || 0.23);
          setMultiTripDiscountPercentage(data.multiTripDiscountPercentage || 0.3);
          setMinTripsForDiscount(data.minTripsForDiscount || 2);
        } else {
          // Initialize with default empty config if not found
          setConfig({ flatRatePerTrip: 0, pricePerTrip: 0, vatRate: 0.23, multiTripDiscountPercentage: 0.3, minTripsForDiscount: 2 });
        }
      } catch (err) {
        console.error("Error fetching transportation config:", err);
        setError("Erro ao carregar a configuração de transporte.");
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, []);

  const handleBlurSave = async (field: keyof TransportationConfig, value: any) => {
    setLoading(true);
    setError(null);
    try {
      const newConfig = { ...config, [field]: value } as TransportationConfig;
      await saveTransportationConfig(newConfig);
      setConfig(newConfig);
    } catch (err) {
      console.error(`Error saving ${field}:`, err);
      setError(`Erro ao guardar o campo ${field}.`);
    } finally {
      setLoading(false);
      if (field === 'flatRatePerTrip') setIsFlatRateEditing(false);
      if (field === 'vatRate') setIsVatEditing(false);
      if (field === 'multiTripDiscountPercentage' || field === 'minTripsForDiscount') setIsDiscountEditing(false);
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setIsNewTier(false);
  }

  // Removed zone price handlers

  if (loading) return <div className="p-4">A carregar configurações de transporte...</div>;
  if (error) return <div className="p-4 text-red-500">{error}</div>;
  if (!config) return null; // Should not happen if initialized

  return (
    <div className="p-4 space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">🚌 Configuração de Transporte</h2>
      </div>

      {/* Flat Rate Section */}
      <div className="p-4 bg-white rounded-lg shadow-md">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="text-xl font-semibold text-gray-700">Preço Fixo por Viagem</h3>
            <p className="text-base font-semibold mt-1">€{flatRatePerTrip.toFixed(2)}</p>
          </div>
          {isFlatRateEditing ? (
            <div className="flex items-center gap-2">
              <input 
                type="number" 
                value={flatRatePerTrip} 
                onChange={e => setFlatRatePerTrip(parseFloat(e.target.value))} 
                onBlur={() => handleBlurSave('flatRatePerTrip', flatRatePerTrip)}
                className="w-24 border-gray-300 rounded-md shadow-sm text-sm" 
              />
            </div>
          ) : (
            <button onClick={() => setIsFlatRateEditing(true)} className="text-xs text-blue-600 font-semibold">Editar</button>
          )}
        </div>
      </div>

      {/* VAT Rate Section */}
      <div className="p-4 bg-white rounded-lg shadow-md">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="text-xl font-semibold text-gray-700">Taxa de IVA (%)</h3>
            <p className="text-base font-semibold mt-1">{vatRate * 100}%</p>
          </div>
          {isVatEditing ? (
            <div className="flex items-center gap-2">
              <input 
                type="number" 
                value={vatRate * 100} 
                onChange={e => setVatRate(parseFloat(e.target.value) / 100)} 
                onBlur={() => handleBlurSave('vatRate', vatRate)}
                className="w-24 border-gray-300 rounded-md shadow-sm text-sm" 
              />
            </div>
          ) : (
            <button onClick={() => setIsVatEditing(true)} className="text-xs text-blue-600 font-semibold">Editar</button>
          )}
        </div>
      </div>

      {/* Discount Section */}
      <div className="p-4 bg-white rounded-lg shadow-md">
        <div className="flex justify-between items-center">
          <div>
            <h3 className="text-xl font-semibold text-gray-700">Desconto Multi-Viagem</h3>
            <p className="text-sm text-gray-500 mt-1">Aplica um desconto para {minTripsForDiscount} ou mais viagens no mesmo dia.</p>
            <p className="text-base font-semibold mt-1">{(multiTripDiscountPercentage * 100).toFixed(0)}% de desconto</p>
          </div>
          {isDiscountEditing ? (
            <div className="flex items-center gap-4">
              <div>
                <label className="text-xs text-gray-500">Min. Viagens</label>
                <input 
                  type="number" 
                  value={minTripsForDiscount} 
                  onChange={e => setMinTripsForDiscount(parseInt(e.target.value))} 
                  onBlur={() => handleBlurSave('minTripsForDiscount', minTripsForDiscount)}
                  className="w-20 border-gray-300 rounded-md shadow-sm text-sm" 
                />
              </div>
              <div>
                <label className="text-xs text-gray-500">Desconto (%)</label>
                <input 
                  type="number" 
                  value={multiTripDiscountPercentage * 100} 
                  onChange={e => setMultiTripDiscountPercentage(parseFloat(e.target.value) / 100)} 
                  onBlur={() => handleBlurSave('multiTripDiscountPercentage', multiTripDiscountPercentage)}
                  className="w-20 border-gray-300 rounded-md shadow-sm text-sm" 
                />
              </div>
            </div>
          ) : (
            <button onClick={() => setIsDiscountEditing(true)} className="text-xs text-blue-600 font-semibold">Editar</button>
          )}
        </div>
      </div>
    </div>
  );
}
