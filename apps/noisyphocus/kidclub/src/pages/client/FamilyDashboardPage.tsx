import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { Family, Child, StudyRoomEntry, TransportationSubscription } from '@shared/models';
import { Link } from 'react-router-dom';
import { familyService } from '../../services/familyService';

interface ChildWithSubs {
  child: Child;
  study: StudyRoomEntry[];
  transport: TransportationSubscription[];
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Ativo', pending: 'Pendente', cancelled: 'Cancelado',
};
const STATUS_CLASS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  cancelled: 'bg-gray-100 text-gray-600',
};
const isActive = (s: string) => s === 'active';
const isPending = (s: string) => s === 'pending';
const isCancelled = (s: string) => s === 'cancelled';

export default function FamilyDashboardPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [childData, setChildData] = useState<ChildWithSubs[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const fam = await familyService.getOrCreateFamily(
          user.uid,
          user.name || user.email?.split('@')[0] || 'Utilizador',
          user.email || ''
        );
        setFamily(fam);

        const children = await familyService.getFamilyChildren(fam.id, false, user.uid);
        const withSubs = await Promise.all(
          children.map(async child => {
            try {
              const { study, transport } = await familyService.getChildSubscriptions(child.id, user.uid);
              return { child, study, transport };
            } catch {
              return { child, study: [], transport: [] };
            }
          })
        );
        setChildData(withSubs);
      } catch (err: any) {
        console.error('Dashboard load error:', err);
        setError(err?.message || 'Erro ao carregar dados.');
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [user]);

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-sm text-red-700">
        <p className="font-semibold mb-1">Erro ao carregar dashboard</p>
        <p>{error}</p>
      </div>
    );
  }

  const totalMonthly = childData.reduce((sum, { study, transport }) =>
    sum +
    study.filter(s => !isCancelled(s.status ?? '')).reduce((s, x) => s + (x.monthlyPrice ?? 0), 0) +
    transport.filter(t => !isCancelled(t.status ?? '')).reduce((s, x) => s + (x.monthlyFee ?? 0), 0),
    0
  );

  const activeCount = childData.reduce((sum, { study, transport }) =>
    sum + study.filter(s => isActive(s.status ?? '')).length + transport.filter(t => isActive(t.status ?? '')).length,
    0
  );

  const pendingCount = childData.reduce((sum, { study, transport }) =>
    sum + study.filter(s => isPending(s.status ?? '')).length + transport.filter(t => isPending(t.status ?? '')).length,
    0
  );

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-6 rounded-lg shadow-lg">
        <h1 className="text-2xl font-bold mb-1">Bem-vindo, {family?.primaryContact.name.split(' ')[0]}</h1>
        <p className="text-blue-100 text-sm mb-6">Área de Família — Arco-Íris da Pequenada</p>
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <div className="bg-white/10 rounded-lg p-3 sm:p-4">
            <p className="text-xs sm:text-sm opacity-90 mb-1">Mensalidade total</p>
            <p className="text-xl sm:text-3xl font-bold">€{totalMonthly.toFixed(2)}</p>
          </div>
          <div className="bg-white/10 rounded-lg p-3 sm:p-4">
            <p className="text-xs sm:text-sm opacity-90 mb-1">Crianças</p>
            <p className="text-xl sm:text-3xl font-bold">{childData.length}</p>
          </div>
          <div className="bg-white/10 rounded-lg p-3 sm:p-4">
            <p className="text-xs sm:text-sm opacity-90 mb-1">Inscrições ativas</p>
            <p className="text-xl sm:text-3xl font-bold">{activeCount}</p>
          </div>
        </div>
      </div>

      {/* Pending approvals notice */}
      {pendingCount > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-center gap-3">
          <span className="text-yellow-500 text-xl">⏳</span>
          <div>
            <p className="font-medium text-yellow-900">
              {pendingCount} {pendingCount === 1 ? 'inscrição pendente' : 'inscrições pendentes'} de aprovação
            </p>
            <p className="text-sm text-yellow-700">Irá receber um email quando forem confirmadas.</p>
          </div>
        </div>
      )}

      {/* Children */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">As minhas crianças</h2>
          <Link
            to="/client/children"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm"
          >
            + Adicionar criança
          </Link>
        </div>

        {childData.length === 0 ? (
          <div className="bg-white p-8 rounded-lg border border-gray-200 text-center">
            <p className="text-gray-500 mb-4">Ainda não adicionou nenhuma criança.</p>
            <Link
              to="/client/children"
              className="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
            >
              Adicionar primeira criança
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {childData.map(({ child, study, transport }) => {
              const monthly =
                study.filter(s => !isCancelled(s.status ?? '')).reduce((s, x) => s + (x.monthlyPrice ?? 0), 0) +
                transport.filter(t => !isCancelled(t.status ?? '')).reduce((s, x) => s + (x.monthlyFee ?? 0), 0);

              const allSubs = [
                ...study.map(s => ({ id: s.id, subType: 'study' as const, type: 'Sala de Estudo', status: s.status ?? '', price: s.monthlyPrice, appliedDiscounts: s.appliedDiscounts ?? [], clientReviewPending: (s as any).clientReviewPending === true })),
                ...transport.map(t => ({ id: t.id, subType: 'transport' as const, type: 'Transporte', status: t.status ?? '', price: t.monthlyFee, appliedDiscounts: t.appliedDiscounts ?? [], clientReviewPending: (t as any).clientReviewPending === true })),
              ];

              return (
                <div key={child.id} className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-semibold">{child.firstName} {child.lastName}</h3>
                      {child.schoolName && (
                        <p className="text-sm text-gray-500">{child.schoolName} · {child.schoolYear}</p>
                      )}
                    </div>
                    <Link to={`/client/children/${child.id}`} className="text-blue-600 text-sm hover:underline">
                      Ver detalhes →
                    </Link>
                  </div>

                  <div className="space-y-2 mb-4">
                    {allSubs.length === 0 ? (
                      <p className="text-sm text-gray-400">Sem inscrições</p>
                    ) : (
                      allSubs.map((sub, i) => (
                        <div key={i} className="text-sm space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-gray-700">{sub.type}</span>
                            <div className="flex items-center gap-2">
                              {!isCancelled(sub.status) && (
                                <span className="text-gray-600">€{(sub.price ?? 0).toFixed(2)}/mês</span>
                              )}
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_CLASS[sub.status] ?? 'bg-gray-100 text-gray-600'}`}>
                                {STATUS_LABEL[sub.status] ?? sub.status}
                              </span>
                            </div>
                          </div>
                          {sub.appliedDiscounts.length > 0 && (
                            <div className="flex gap-1 flex-wrap pl-1">
                              {sub.appliedDiscounts.map(d => (
                                <span key={d.ruleId} className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-medium">
                                  {d.name} −{Math.round(d.percentage * 100)}%
                                </span>
                              ))}
                            </div>
                          )}
                          {sub.clientReviewPending && (
                            <Link
                              to={`/client/${sub.subType === 'transport' ? 'transport' : 'study'}/${sub.id}`}
                              className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded-lg px-3 py-1.5 hover:bg-purple-100 transition-colors w-fit"
                            >
                              ✅ Inscrição foi alterada — confirme aqui
                            </Link>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  <div className="pt-4 border-t flex justify-between items-center">
                    <span className="font-bold">€{monthly.toFixed(2)}/mês</span>
                    <Link
                      to={`/client/children/${child.id}`}
                      className="text-blue-600 text-sm hover:underline"
                    >
                      Ver detalhes →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link to="/client/children" className="bg-white p-5 rounded-lg border border-gray-200 hover:shadow-md transition-shadow">
          <div className="text-2xl mb-2">👧</div>
          <div className="font-semibold text-sm">As minhas crianças</div>
          <div className="text-xs text-gray-500 mt-1">Crianças e inscrições</div>
        </Link>
        <Link to="/client/invoices" className="bg-white p-5 rounded-lg border border-gray-200 hover:shadow-md transition-shadow">
          <div className="text-2xl mb-2">🧾</div>
          <div className="font-semibold text-sm">Faturas</div>
          <div className="text-xs text-gray-500 mt-1">Consultar faturas e pagamentos</div>
        </Link>
        <Link to="/client/account" className="bg-white p-5 rounded-lg border border-gray-200 hover:shadow-md transition-shadow">
          <div className="text-2xl mb-2">👤</div>
          <div className="font-semibold text-sm">A minha conta</div>
          <div className="text-xs text-gray-500 mt-1">Dados de faturação e NIF</div>
        </Link>
      </div>
    </div>
  );
}
