import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { Family } from '@shared/models';
import { familyService } from '../../services/familyService';

export default function AccountPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    nif: '',
    street: '',
    city: '',
    postalCode: '',
    defaultPaymentMethod: 'bank_transfer' as 'bank_transfer' | 'mbway',
  });

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const fam = await familyService.getOrCreateFamily(
        user.uid,
        user.name || user.email?.split('@')[0] || '',
        user.email || ''
      );
      setFamily(fam);
      setForm({
        name: fam.primaryContact.name,
        phone: fam.primaryContact.phone,
        nif: fam.nif || '',
        street: fam.billingAddress?.street || '',
        city: fam.billingAddress?.city || '',
        postalCode: fam.billingAddress?.postalCode || '',
        defaultPaymentMethod: fam.defaultPaymentMethod || 'bank_transfer',
      });
      setIsLoading(false);
    };
    load();
  }, [user]);

  const set = (field: keyof typeof form, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!family) return;
    setSaving(true);
    try {
      await familyService.updateFamily(family.id, {
        primaryContact: {
          ...family.primaryContact,
          name: form.name,
          phone: form.phone,
        },
        nif: form.nif || undefined,
        billingAddress: form.street
          ? { street: form.street, city: form.city, postalCode: form.postalCode, country: 'PT' }
          : undefined,
        defaultPaymentMethod: form.defaultPaymentMethod,
        profileComplete: true,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold mb-6">A minha conta</h1>

      {saved && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
          Dados guardados com sucesso.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Contact */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold text-gray-900">Contacto</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nome completo *</label>
            <input
              type="text"
              required
              autoComplete="name"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              disabled
              value={family?.primaryContact.email || ''}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
            />
            <p className="text-xs text-gray-400 mt-1">O email não pode ser alterado aqui.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Telefone *</label>
            <input
              type="tel"
              required
              autoComplete="tel"
              placeholder="9XX XXX XXX"
              value={form.phone}
              onChange={e => set('phone', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Billing */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold text-gray-900">Dados de faturação</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">NIF</label>
            <input
              type="text"
              placeholder="Número de contribuinte (opcional)"
              value={form.nif}
              onChange={e => set('nif', e.target.value)}
              maxLength={9}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Morada</label>
            <input
              type="text"
              autoComplete="street-address"
              placeholder="Rua e número"
              value={form.street}
              onChange={e => set('street', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Código postal</label>
              <input
                type="text"
                autoComplete="postal-code"
                placeholder="XXXX-XXX"
                value={form.postalCode}
                onChange={e => set('postalCode', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cidade</label>
              <input
                type="text"
                autoComplete="address-level2"
                value={form.city}
                onChange={e => set('city', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Payment method */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="font-semibold text-gray-900 mb-3">Método de pagamento preferido</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${form.defaultPaymentMethod === 'bank_transfer' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
              <input
                type="radio"
                name="payment"
                value="bank_transfer"
                checked={form.defaultPaymentMethod === 'bank_transfer'}
                onChange={() => set('defaultPaymentMethod', 'bank_transfer')}
                className="sr-only"
              />
              <span className="text-xl">🏦</span>
              <span className="font-medium text-sm">Transferência bancária</span>
            </label>
            <label className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${form.defaultPaymentMethod === 'mbway' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
              <input
                type="radio"
                name="payment"
                value="mbway"
                checked={form.defaultPaymentMethod === 'mbway'}
                onChange={() => set('defaultPaymentMethod', 'mbway')}
                className="sr-only"
              />
              <span className="text-xl">📱</span>
              <span className="font-medium text-sm">MB Way</span>
            </label>
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? 'A guardar...' : 'Guardar alterações'}
        </button>
      </form>
    </div>
  );
}
