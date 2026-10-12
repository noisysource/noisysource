import React, { useEffect, useState } from 'react';
import { getTransportationConfig, saveTransportationConfig } from '../../../services/transportationService';
import { TransportationConfig } from '@shared/models/Transportation'; // Removed ZonePrice
import { KIDCLUB_VAT, kidclubVatNote } from '@shared/models/kidclubVat';
import { vatCodeLabel } from '@shared/lib/vat';

// Add a unique id to each item for editing purposes
type Editable<T> = T & { id: string; isEditing?: boolean };

export default function AdminTransportationConfig() {
  const [config, setConfig] = useState<TransportationConfig | null>(null);
  const [flatRatePerTrip, setFlatRatePerTrip] = useState(0);
  const [isFlatRateEditing, setIsFlatRateEditing] = useState(false);
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
        } else {
          // Initialize with default empty config if not found
          setConfig({ flatRatePerTrip: 0, pricePerTrip: 0, multiTripDiscountPercentage: 0.3, minTripsForDiscount: 2, siblingDiscountPercentage: 0, returningStudentDiscountPercentage: 0, schoolDiscounts: [], driverRatePerHour: 7, weeksPerMonth: 4.33, vanCapacity: 8, vanMonthlyCost: 200, consumptionPer100km: 20, electricityPricePerKwh: 0.22 });
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
            <h3 className="text-xl font-semibold text-gray-700">Preço Fixo por Viagem (com IVA)</h3>
            <p className="text-base font-semibold mt-1">€{flatRatePerTrip.toFixed(2)}</p>
            <p className="text-xs text-gray-500 mt-0.5">{kidclubVatNote(flatRatePerTrip, 'transport')}</p>
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

      {/* VAT: set by the Vendus product, read-only here */}
      <div className="p-4 bg-white rounded-lg shadow-md">
        <h3 className="text-xl font-semibold text-gray-700">IVA</h3>
        <p className="text-base font-semibold mt-1">{vatCodeLabel(KIDCLUB_VAT.transport)}, incluído no preço</p>
        <p className="text-xs text-gray-500 mt-0.5">
          É a taxa do produto Transporte no Vendus, que fatura cada linha com IVA incluído. Muda-se no Vendus, não aqui.
        </p>
      </div>

      {/* Discounts moved to central system */}
      <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
        <p className="text-sm text-blue-800">
          Os descontos (multi-viagem, irmão, aluno anterior, escola) foram movidos para a página central de{' '}
          <a href="/admin/config/descontos" className="font-semibold underline">Configuração de Descontos</a>.
        </p>
      </div>
    </div>
  );
}
