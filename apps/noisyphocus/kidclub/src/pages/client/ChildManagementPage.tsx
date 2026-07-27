import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { Family, Child } from '@shared/models';
import { Link } from 'react-router-dom';
import { calculateAge } from '../../lib/utils';
import { familyService } from '../../services/familyService';

export default function ChildManagementPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    if (user) fetchFamilyAndChildren();
  }, [user]);

  const fetchFamilyAndChildren = async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const fam = await familyService.getOrCreateFamily(
        user.uid,
        user.name || user.email?.split('@')[0] || 'Utilizador',
        user.email || ''
      );
      setFamily(fam);
      const kids = await familyService.getFamilyChildren(fam.id, true, user.uid);
      setChildren(kids);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddChild = async (data: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>) => {
    if (!family || !user) return;
    await familyService.addChild(family.id, user.uid, data);
    await fetchFamilyAndChildren();
    setShowAddForm(false);
  };

  const handleRemoveChild = async (child: Child) => {
    const count = await familyService.getChildSubscriptionCounts(child.id);
    if (count > 0) {
      if (!window.confirm(`${child.firstName} tem ${count} inscrição(ões) ativas. Deseja desativar a criança (mantém os dados) em vez de eliminar?`)) return;
      await familyService.deactivateChild(child.id);
    } else {
      if (!window.confirm(`Tem a certeza que pretende remover ${child.firstName} ${child.lastName}?`)) return;
      await familyService.deleteChild(child.id);
    }
    await fetchFamilyAndChildren();
  };

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  const activeChildren = children.filter(c => c.status !== 'inactive');

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">As minhas crianças</h1>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          {showAddForm ? 'Cancelar' : '+ Adicionar criança'}
        </button>
      </div>

      {showAddForm && (
        <AddChildForm
          onSave={handleAddChild}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {activeChildren.length === 0 && !showAddForm ? (
        <div className="bg-white p-8 rounded-lg border border-gray-200 text-center">
          <p className="text-gray-500 mb-4">Ainda não adicionou nenhuma criança.</p>
          <button
            onClick={() => setShowAddForm(true)}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
          >
            Adicionar primeira criança
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {activeChildren.map(child => (
            <div key={child.id} className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold">{child.firstName} {child.lastName}</h3>
                  <p className="text-sm text-gray-500">{child.age ? `${child.age} anos` : ''}</p>
                  {child.schoolName && (
                    <p className="text-xs text-gray-400 mt-0.5">{child.schoolName} · {child.schoolYear}</p>
                  )}
                </div>
                <Link to={`/client/children/${child.id}`} className="text-blue-600 text-sm hover:underline">
                  Editar →
                </Link>
              </div>

              <div className="flex gap-2">
                <Link
                  to={`/client/children/${child.id}`}
                  className="flex-1 bg-blue-50 text-blue-600 py-2 px-3 rounded text-center text-sm hover:bg-blue-100"
                >
                  Perfil
                </Link>
                <Link
                  to="/client/subscriptions"
                  className="flex-1 bg-green-50 text-green-700 py-2 px-3 rounded text-center text-sm hover:bg-green-100"
                >
                  Inscrições
                </Link>
              </div>

              <div className="mt-3 pt-3 border-t">
                <button
                  onClick={() => handleRemoveChild(child)}
                  className="w-full bg-red-50 text-red-600 py-2 px-4 rounded text-sm hover:bg-red-100"
                >
                  Remover
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddChildForm({
  onSave,
  onCancel,
}: {
  onSave: (data: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    dateOfBirth: '',
    schoolName: '',
    schoolYear: '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const dob = new Date(form.dateOfBirth + 'T12:00:00');
    onSave({
      firstName: form.firstName,
      lastName: form.lastName,
      dateOfBirth: dob,
      age: calculateAge(dob),
      schoolName: form.schoolName || undefined,
      schoolYear: form.schoolYear || undefined,
      status: 'active',
    });
  };

  return (
    <div className="bg-white p-6 rounded-lg border-2 border-blue-200 mb-6">
      <h2 className="text-xl font-bold mb-4">Adicionar criança</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Primeiro nome *</label>
            <input
              type="text"
              required
              value={form.firstName}
              onChange={e => setForm({ ...form, firstName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Apelido *</label>
            <input
              type="text"
              required
              value={form.lastName}
              onChange={e => setForm({ ...form, lastName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Data de nascimento *</label>
          <input
            type="date"
            required
            value={form.dateOfBirth}
            onChange={e => setForm({ ...form, dateOfBirth: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Escola</label>
            <input
              type="text"
              value={form.schoolName}
              onChange={e => setForm({ ...form, schoolName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ano letivo</label>
            <input
              type="text"
              placeholder="ex: 2024/2025"
              value={form.schoolYear}
              onChange={e => setForm({ ...form, schoolYear: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button type="submit" className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700">
            Guardar
          </button>
          <button type="button" onClick={onCancel} className="bg-gray-200 text-gray-700 px-6 py-2 rounded-lg hover:bg-gray-300">
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
