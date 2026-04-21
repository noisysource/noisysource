import React, { useState, useEffect } from 'react';
import { studyRoomService } from '../../services/studyRoomService';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import StudyRoomForm from '../StudyRoomForm';

// Default data if nothing is found in Firestore
const initialConfig: StudyCenterConfig = {
  monthlyPricePerWeekday: 19,
  registrationFee: 35,
  insuranceFee: 25,
  monthlyTransportFeePerWeekday: 18,
};

interface ConfigInputProps {
  label: string;
  description?: string;
  value: number | string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  icon: string;
}

const ConfigInput: React.FC<ConfigInputProps> = ({ label, description, value, onChange, icon }) => (
  <div className="form-control">
    <label className="label">
      <span className="label-text font-semibold text-gray-700">{label}</span>
    </label>
    <div className="relative">
      <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-xl">{icon}</span>
      <input
        type="number"
        value={value}
        onChange={onChange}
        className="input input-bordered w-full text-lg pl-12"
      />
    </div>
    {description && (
      <label className="label">
        <span className="label-text-alt">{description}</span>
      </label>
    )}
  </div>
);

const AdminStudyCenterPricing: React.FC = () => {
  const [config, setConfig] = useState<StudyCenterConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const data = await studyRoomService.getStudyCenterConfig();
        if (data) {
          setConfig(data);
        } else {
          // If no config is found, use the initial default config
          setConfig(initialConfig);
        }
      } catch (error) {
        console.error("Error fetching study center config:", error);
        // Set initial config even if there is an error
        setConfig(initialConfig);
      } finally {
        setIsLoading(false);
      }
    };

    fetchConfig();
  }, []);

  const handleFeeChange = (field: keyof StudyCenterConfig, value: string) => {
    if (!config) return;
    setConfig(prev => ({
      ...prev!,
      [field]: Number(value),
    }));
  };

  const handleSave = async () => {
    if (!config) return;
    try {
      await studyRoomService.saveStudyCenterConfig(config);
      alert('Configuração salva com sucesso!');
    } catch (error) {
      console.error("Error saving config:", error);
      alert('Ocorreu um erro ao salvar a configuração.');
    }
  };

  if (isLoading) {
    return <div className="p-6">Carregando configuração...</div>;
  }

  if (!config) {
    return <div className="p-6">Não foi possível carregar a configuração.</div>;
  }

  return (
    <div className="p-6 bg-gray-50 min-h-full">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-3xl font-bold text-gray-800">Configurar Preços do Centro de Estudos</h2>
        <button onClick={handleSave} className="btn btn-success btn-lg">
          Salvar Configuração
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* --- Configuration Column --- */}
        <div className="bg-white p-8 rounded-2xl shadow-lg">
          <h3 className="text-2xl font-semibold text-pink-600 mb-6">Definições de Preços</h3>
          <div className="space-y-6">
            <ConfigInput
              label="Mensalidade por dia da semana (€)"
              description="Custo mensal por cada dia da semana (ex: todas as Segundas do mês)."
              icon="💰"
              value={config.monthlyPricePerWeekday}
              onChange={(e) => handleFeeChange('monthlyPricePerWeekday', e.target.value)}
            />
            <ConfigInput
              label="Transporte mensal por dia da semana (€)"
              description="Custo mensal de transporte por cada dia da semana."
              icon="🚐"
              value={config.monthlyTransportFeePerWeekday}
              onChange={(e) => handleFeeChange('monthlyTransportFeePerWeekday', e.target.value)}
            />
            <ConfigInput
              label="Taxa de Matrícula (pagamento único) (€)"
              icon="🎟️"
              value={config.registrationFee}
              onChange={(e) => handleFeeChange('registrationFee', e.target.value)}
            />
            <ConfigInput
              label="Seguro (pagamento único) (€)"
              icon="🛡️"
              value={config.insuranceFee}
              onChange={(e) => handleFeeChange('insuranceFee', e.target.value)}
            />
          </div>
        </div>

        {/* --- Simulation Column --- */}
        <div className="bg-gray-800 p-8 rounded-2xl shadow-lg">
            <h3 className="text-2xl font-semibold text-blue-400 mb-6">Simulação em Tempo Real</h3>
            <p className="mb-6 text-sm text-gray-400">Use o formulário abaixo para simular como os preços que você configurou à esquerda serão aplicados a uma inscrição de um novo aluno.</p>
            <div className="p-6 border border-gray-700 rounded-xl bg-gray-900">
              <StudyRoomForm priceConfig={config} isSimulation={true} />
            </div>
        </div>
      </div>
    </div>
  );
};

export default AdminStudyCenterPricing;
