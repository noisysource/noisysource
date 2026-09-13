import { useState } from 'react';
import { useUser } from '@shared/hooks';
import { Family } from '@shared/models';
import { familyService } from '../../services/familyService';

interface SetupForm {
  name: string;
  phone: string;
  nif: string;
  street: string;
  city: string;
  postalCode: string;
  defaultPaymentMethod: 'bank_transfer' | 'mbway';
}

export default function FamilyProfileSetupPage({ family, onComplete }: { family: Family; onComplete: () => void }) {
  const user = useUser();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<SetupForm>({
    name: family.primaryContact.name || user?.name || '',
    phone: family.primaryContact.phone || '',
    nif: family.nif || '',
    street: family.billingAddress?.street || '',
    city: family.billingAddress?.city || '',
    postalCode: family.billingAddress?.postalCode || '',
    defaultPaymentMethod: family.defaultPaymentMethod || 'bank_transfer',
  });

  const set = (field: keyof SetupForm, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
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
      onComplete();
    } catch (err: any) {
      setError(err?.message || 'Erro ao guardar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-md w-full max-w-lg p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Bem-vindo ao Arco-Íris</h1>
          <p className="text-gray-500 mt-2 text-sm">
            Complete o seu perfil antes de continuar. Estes dados serão usados nas faturas.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Contact */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Contacto</h2>
            <div className="space-y-3">
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
          </div>

          {/* Billing */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Faturação</h2>
            <div className="space-y-3">
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
          </div>

          {/* Payment method */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Método de pagamento preferido</h2>
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
                <span className="font-medium text-sm">Transferência</span>
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
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {saving ? 'A guardar...' : 'Concluir configuração'}
          </button>
        </form>
      </div>
    </div>
  );
}
