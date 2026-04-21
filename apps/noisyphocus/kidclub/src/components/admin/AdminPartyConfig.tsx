import React, { useEffect, useState } from 'react';
import { PartyConfig, PartyType, ExtraItem } from '@shared/models/PartyConfig';
import { partyService } from '../../services/partyService';

// Add a unique id to each item for editing purposes
type Editable<T> = T & { id: string; isEditing?: boolean };

export default function PartyConfigAdmin() {
  const [config, setConfig] = useState<PartyConfig | null>(null);
  const [partyTypes, setPartyTypes] = useState<Editable<PartyType>[]>([]);
  const [extras, setExtras] = useState<Editable<ExtraItem>[]>([]);

  useEffect(() => {
    const fetchConfig = async () => {
      const data = await partyService.getPartyConfig();
      if (data) {
        setConfig(data);
        setPartyTypes(data.partyTypes.map((pt, index) => ({ ...pt, id: `pt-${index}` })));
        setExtras(data.extras.map((ex, index) => ({ ...ex, id: `ex-${index}` })));
      }
    };
    fetchConfig();
  }, []);

  const handleSave = async () => {
    if (!config) return;
    const newConfig = {
      ...config,
      partyTypes: partyTypes.map(({ id, isEditing, ...pt }) => pt),
      extras: extras.map(({ id, isEditing, ...ex }) => ex),
    };
    await partyService.savePartyConfig(newConfig);
    setConfig(newConfig);
    alert('Configurações guardadas com sucesso ✅');
  };

  const handlePartyTypeChange = (id: string, field: keyof PartyType, value: any) => {
    setPartyTypes(prev => prev.map(pt => pt.id === id ? { ...pt, [field]: value } : pt));
  };

  const toggleEditPartyType = (id: string) => {
    setPartyTypes(prev => prev.map(pt => pt.id === id ? { ...pt, isEditing: !pt.isEditing } : pt));
  };
  
  const addPartyType = () => {
    const newId = `pt-${Date.now()}`;
    setPartyTypes(prev => [...prev, { id: newId, name: '', description: '', basePrice: 0, includedKids: 0, pricePerExtraChild: 0, isEditing: true }]);
  };

  const deletePartyType = (id: string) => {
    if (window.confirm('Tem a certeza que quer apagar este tipo de festa?')) {
      setPartyTypes(prev => prev.filter(pt => pt.id !== id));
    }
  };

  const handleExtraChange = (id: string, field: keyof ExtraItem, value: any) => {
    setExtras(prev => prev.map(ex => ex.id === id ? { ...ex, [field]: value } : ex));
  };

  const toggleEditExtra = (id: string) => {
    setExtras(prev => prev.map(ex => ex.id === id ? { ...ex, isEditing: !ex.isEditing } : ex));
  };

  const addExtra = () => {
    const newId = `ex-${Date.now()}`;
    setExtras(prev => [...prev, { id: newId, name: '', price: 0, description: '', isEditing: true }]);
  };

  const deleteExtra = (id: string) => {
    if (window.confirm('Tem a certeza que quer apagar este extra?')) {
      setExtras(prev => prev.filter(ex => ex.id !== id));
    }
  };

  if (!config) return <div className="p-4">A carregar configurações...</div>;

  return (
    <div className="p-4 space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-800">🎂 Configuração das Festas</h2>
        <button onClick={handleSave} className="bg-blue-600 text-white px-4 py-2 rounded-lg shadow hover:bg-blue-700 transition-colors">
          Guardar Alterações
        </button>
      </div>

      {/* Party Types Section */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-xl font-semibold text-gray-700">Tipos de Festa</h3>
          <button onClick={addPartyType} className="bg-green-500 text-white px-3 py-1 rounded-lg shadow hover:bg-green-600 transition-colors text-sm">
            + Adicionar
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {partyTypes.map(pt => (
            <div key={pt.id} className="bg-white p-4 rounded-lg shadow-md space-y-2">
              {pt.isEditing ? (
                <>
                  <input placeholder="Nome do pacote" value={pt.name} onChange={e => handlePartyTypeChange(pt.id, 'name', e.target.value)} className="w-full border-gray-300 rounded-md shadow-sm text-sm" />
                  <textarea placeholder="Descrição" value={pt.description} onChange={e => handlePartyTypeChange(pt.id, 'description', e.target.value)} className="w-full border-gray-300 rounded-md shadow-sm text-sm" rows={2} />
                  <input type="number" placeholder="Preço Base (€)" value={pt.basePrice} onChange={e => handlePartyTypeChange(pt.id, 'basePrice', parseFloat(e.target.value))} className="w-full border-gray-300 rounded-md shadow-sm text-sm" />
                  <input type="number" placeholder="Crianças Incluídas" value={pt.includedKids} onChange={e => handlePartyTypeChange(pt.id, 'includedKids', parseInt(e.target.value))} className="w-full border-gray-300 rounded-md shadow-sm text-sm" />
                  <input type="number" placeholder="Preço por Criança Extra (€)" value={pt.pricePerExtraChild} onChange={e => handlePartyTypeChange(pt.id, 'pricePerExtraChild', parseFloat(e.target.value))} className="w-full border-gray-300 rounded-md shadow-sm text-sm" />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => toggleEditPartyType(pt.id)} className="text-xs text-gray-600">Cancelar</button>
                    <button onClick={() => toggleEditPartyType(pt.id)} className="text-xs text-blue-600 font-semibold">Guardar</button>
                  </div>
                </>
              ) : (
                <>
                  <h4 className="text-lg font-bold text-purple-600">{pt.name}</h4>
                  <p className="text-gray-600 text-xs">{pt.description}</p>
                  <p className="text-base font-semibold">€{pt.basePrice} <span className="text-xs font-normal text-gray-500">/ {pt.includedKids} crianças</span></p>
                  <p className="text-base font-semibold">€{pt.pricePerExtraChild} <span className="text-xs font-normal text-gray-500">/ criança extra</span></p>
                  <div className="flex justify-end gap-2 pt-2">
                    <button onClick={() => deletePartyType(pt.id)} className="text-xs text-red-500">Apagar</button>
                    <button onClick={() => toggleEditPartyType(pt.id)} className="text-xs text-blue-600 font-semibold">Editar</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Extras Section */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-xl font-semibold text-gray-700">Extras</h3>
          <button onClick={addExtra} className="bg-green-500 text-white px-3 py-1 rounded-lg shadow hover:bg-green-600 transition-colors text-sm">
            + Adicionar
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {extras.map(ex => (
            <div key={ex.id} className="bg-white p-4 rounded-lg shadow-md space-y-2">
              {ex.isEditing ? (
                <>
                  <input placeholder="Nome do extra" value={ex.name} onChange={e => handleExtraChange(ex.id, 'name', e.target.value)} className="w-full border-gray-300 rounded-md shadow-sm text-sm" />
                  <textarea placeholder="Descrição" value={ex.description} onChange={e => handleExtraChange(ex.id, 'description', e.target.value)} className="w-full border-gray-300 rounded-md shadow-sm text-sm" rows={2} />
                  <input type="number" placeholder="Preço (€)" value={ex.price} onChange={e => handleExtraChange(ex.id, 'price', parseFloat(e.target.value))} className="w-full border-gray-300 rounded-md shadow-sm text-sm" />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => toggleEditExtra(ex.id)} className="text-xs text-gray-600">Cancelar</button>
                    <button onClick={() => toggleEditExtra(ex.id)} className="text-xs text-blue-600 font-semibold">Guardar</button>
                  </div>
                </>
              ) : (
                <>
                  <h4 className="text-lg font-bold text-purple-600">{ex.name}</h4>
                  <p className="text-gray-600 text-xs">{ex.description}</p>
                  <p className="text-base font-semibold">€{ex.price}</p>
                  
                  <div className="flex justify-end gap-2 pt-2">
                    <button onClick={() => deleteExtra(ex.id)} className="text-xs text-red-500">Apagar</button>
                    <button onClick={() => toggleEditExtra(ex.id)} className="text-xs text-blue-600 font-semibold">Editar</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
