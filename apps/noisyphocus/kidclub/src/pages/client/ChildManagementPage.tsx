import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { Family, Child, StudyRoomEntry, TransportationSubscription } from '@shared/models';
import { Link } from 'react-router-dom';
import { calculateAge } from '../../lib/utils';
import { familyService } from '../../services/familyService';

interface ChildWithSubs {
  child: Child;
  study: StudyRoomEntry[];
  transport: TransportationSubscription[];
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Ativo', confirmed: 'Ativo',
  pending: 'Pendente', planned: 'Pendente',
  cancelled: 'Cancelado', canceled: 'Cancelado', archived: 'Cancelado', inactive: 'Cancelado',
  suspended: 'Suspenso',
};
const STATUS_CLASS: Record<string, string> = {
  active: 'bg-green-100 text-green-800', confirmed: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800', planned: 'bg-yellow-100 text-yellow-800',
  cancelled: 'bg-gray-100 text-gray-600', canceled: 'bg-gray-100 text-gray-600',
  archived: 'bg-gray-100 text-gray-600', inactive: 'bg-gray-100 text-gray-600',
  suspended: 'bg-red-100 text-red-800',
};
const isCancelled = (s: string) => ['cancelled', 'canceled', 'archived', 'inactive'].includes(s);

export default function ChildManagementPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [childData, setChildData] = useState<ChildWithSubs[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    if (user) load();
  }, [user]);

  const load = async () => {
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
      const active = kids.filter(c => c.status !== 'inactive');
      const withSubs = await Promise.all(
        active.map(async child => {
          try {
            const { study, transport } = await familyService.getChildSubscriptions(child.id, user.uid);
            return { child, study, transport };
          } catch {
            return { child, study: [], transport: [] };
          }
        })
      );
      setChildData(withSubs);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddChild = async (data: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>) => {
    if (!family || !user) return;
    await familyService.addChild(family.id, user.uid, data);
    await load();
    setShowAddForm(false);
  };

  const handleRemoveChild = async (child: Child) => {
    const count = await familyService.getChildSubscriptionCounts(child.id);
    if (count > 0) {
      if (!window.confirm(`${child.firstName} tem ${count} inscrição(ões) ativas. Deseja desativar a criança (mantém os dados)?`)) return;
      await familyService.deactivateChild(child.id);
    } else {
      if (!window.confirm(`Tem a certeza que pretende remover ${child.firstName} ${child.lastName}?`)) return;
      await familyService.deleteChild(child.id);
    }
    await load();
  };

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
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

      {childData.length === 0 && !showAddForm ? (
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
        <div className="space-y-4">
          {childData.map(({ child, study, transport }) => {
            const monthly =
              study.filter(s => !isCancelled(s.status ?? '')).reduce((s, x) => s + (x.monthlyPrice ?? 0), 0) +
              transport.filter(t => !isCancelled(t.status ?? '')).reduce((s, x) => s + (x.monthlyFee ?? 0), 0);

            const allSubs = [
              ...study.map(s => ({
                key: `study-${s.id}`, icon: '📚', type: 'Sala de Estudo',
                status: s.status ?? '', price: s.monthlyPrice,
                detail: s.days?.map((d: any) => d.day || d).join(', '),
                href: `/client/study/${s.id}`,
              })),
              ...transport.map(t => ({
                key: `transport-${t.id}`, icon: '🚌', type: 'Transporte Escolar',
                status: t.status ?? '', price: t.monthlyFee,
                detail: null,
                href: `/client/transport/${t.id}`,
              })),
            ];

            return (
              <div key={child.id} className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
                {/* Child header */}
                <div className="bg-gray-50 border-b border-gray-200 px-6 py-4 flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{child.firstName} {child.lastName}</h3>
                    <p className="text-sm text-gray-500">
                      {child.age ? `${child.age} anos` : ''}
                      {child.schoolName ? ` · ${child.schoolName}` : ''}
                      {child.schoolYear ? ` · ${child.schoolYear}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/client/children/${child.id}`}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Editar perfil →
                    </Link>
                  </div>
                </div>

                {/* Subscriptions */}
                <div className="divide-y divide-gray-100">
                  {allSubs.length === 0 ? (
                    <div className="px-6 py-5 text-sm text-gray-400 text-center">
                      Sem inscrições activas.
                    </div>
                  ) : (
                    allSubs.map(sub => (
                      <Link
                        key={sub.key}
                        to={sub.href}
                        className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-xl">{sub.icon}</span>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{sub.type}</p>
                            {sub.detail && <p className="text-xs text-gray-500">{sub.detail}</p>}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {!isCancelled(sub.status) && sub.price != null && (
                            <span className="text-sm font-semibold text-gray-900">
                              €{sub.price.toFixed(2)}/mês
                            </span>
                          )}
                          <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${STATUS_CLASS[sub.status] ?? 'bg-gray-100 text-gray-600'}`}>
                            {STATUS_LABEL[sub.status] ?? sub.status}
                          </span>
                          <span className="text-gray-300">›</span>
                        </div>
                      </Link>
                    ))
                  )}
                </div>

                {/* Footer */}
                <div className="bg-gray-50 border-t border-gray-200 px-6 py-3 flex items-center justify-between">
                  <div className="flex gap-2">
                    <Link
                      to={`/client/enroll/study?childId=${child.id}`}
                      className="text-xs bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-100"
                    >
                      + Sala de Estudo
                    </Link>
                    <Link
                      to={`/client/enroll/transport?childId=${child.id}`}
                      className="text-xs bg-green-50 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-100"
                    >
                      + Transporte
                    </Link>
                  </div>
                  <div className="flex items-center gap-4">
                    {monthly > 0 && (
                      <span className="text-sm font-bold text-gray-900">€{monthly.toFixed(2)}/mês</span>
                    )}
                    <button
                      onClick={() => handleRemoveChild(child)}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Remover
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
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
    <div className="bg-white p-6 rounded-lg border-2 border-blue-200">
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
