import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { Child, StudyRoomEntry, TransportationSubscription, Family } from '@shared/models';
import { CampSubscription } from '@shared/models/Camp';
import { Link } from 'react-router-dom';
import { familyService } from '../../services/familyService';
import { getDocs, query, where } from 'firebase/firestore';
import { col } from '../../lib/db';
import { format } from 'date-fns';
import { pt } from 'date-fns/locale';

type SubStatus = 'active' | 'pending' | 'cancelled' | 'suspended';

const statusLabel: Record<SubStatus, string> = {
  active: 'Ativo',
  pending: 'Pendente de aprovação',
  cancelled: 'Cancelado',
  suspended: 'Suspenso',
};

const statusClass: Record<SubStatus, string> = {
  active: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  cancelled: 'bg-gray-100 text-gray-600',
  suspended: 'bg-red-100 text-red-700',
};

interface ChildSubs {
  child: Child;
  study: StudyRoomEntry[];
  transport: TransportationSubscription[];
}

const campStatusLabel: Record<string, string> = {
  pending: 'Pendente',
  confirmed: 'Confirmado',
  cancelled: 'Cancelado',
};

const campStatusClass: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-600',
};

export default function MySubscriptionsPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [childSubs, setChildSubs] = useState<ChildSubs[]>([]);
  const [campSubs, setCampSubs] = useState<CampSubscription[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);

      // Load family + per-child subscriptions
      try {
        const fam = await familyService.getOrCreateFamily(
          user.uid,
          user.name || '',
          user.email || ''
        );
        setFamily(fam);
        const children = await familyService.getFamilyChildren(fam.id, false, user.uid);
        const data = await Promise.all(
          children.map(async child => {
            const { study, transport } = await familyService.getChildSubscriptions(child.id, user.uid);
            return { child, study, transport };
          })
        );
        setChildSubs(data);
      } catch (e) {
        console.error('[MySubscriptionsPage] family load failed:', e);
      }

      // Load camp subscriptions independently so a family error doesn't block this
      try {
        const campSnap = await getDocs(
          query(col('campSubscriptions'), where('userId', '==', user.uid))
        );
        const subs = campSnap.docs.map(d => ({ id: d.id, ...d.data() } as CampSubscription));
        subs.sort((a, b) => {
          const ta = (a.createdAt as any)?.seconds ?? 0;
          const tb = (b.createdAt as any)?.seconds ?? 0;
          return tb - ta;
        });
        setCampSubs(subs);
      } catch (e) {
        console.error('[MySubscriptionsPage] camp subs load failed:', e);
      }

      setIsLoading(false);
    };
    load();
  }, [user]);

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  const hasChildren = childSubs.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">As minhas inscrições</h1>
      </div>

      {/* Camps section — shown regardless of children */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <div>
            <h2 className="font-semibold text-gray-900">Campos de Férias</h2>
            <p className="text-sm text-gray-500">Inscrições em campos de férias e atividades</p>
          </div>
          <Link
            to="/client/camps"
            className="bg-orange-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-orange-700"
          >
            + Inscrever
          </Link>
        </div>
        {campSubs.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-400 text-sm">
            Sem inscrições em campos de férias.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {campSubs.map(sub => (
              <div key={sub.id} className="px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="text-2xl">⛺</span>
                  <div>
                    <p className="font-medium text-gray-900">{sub.childName}</p>
                    <p className="text-sm text-gray-500">
                      {sub.subscriptionType === 'day' ? 'Dia avulso' :
                       sub.subscriptionType === 'week' ? 'Semana' : 'Período completo'}
                      {' · '}{sub.selectedDays.length} dia{sub.selectedDays.length !== 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-gray-400">
                      {format(sub.createdAt instanceof Date ? sub.createdAt : new Date((sub.createdAt as any)?.seconds ? (sub.createdAt as any).seconds * 1000 : sub.createdAt), 'dd MMM yyyy', { locale: pt })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-semibold text-gray-900">€{sub.totalAmount.toFixed(2)}</span>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${campStatusClass[sub.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {campStatusLabel[sub.status] ?? sub.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!hasChildren ? (
        <div className="bg-white p-8 rounded-lg border border-gray-200 text-center">
          <p className="text-gray-500 mb-4">Adicione uma criança primeiro para poder inscrever nos serviços.</p>
          <Link to="/client/children" className="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700">
            Gerir crianças
          </Link>
        </div>
      ) : (
        <div className="space-y-8">
          {childSubs.map(({ child, study, transport }) => {
            const toSubStatus = (raw: string | undefined, kind: 'study' | 'transport'): SubStatus => {
              if (kind === 'study') {
                if (raw === 'confirmed' || raw === 'active') return 'active';
                if (raw === 'canceled' || raw === 'cancelled' || raw === 'archived') return 'cancelled';
              } else {
                if (raw === 'active') return 'active';
                if (raw === 'inactive') return 'suspended';
                if (raw === 'cancelled') return 'cancelled';
              }
              return 'pending';
            };
            const allSubs = [
              ...study.map(s => ({ key: `study-${s.id}`, type: 'Sala de Estudo' as const, status: toSubStatus(s.status, 'study'), price: s.monthlyPrice, days: s.days, startDate: s.startDate, id: s.id })),
              ...transport.map(t => ({ key: `transport-${t.id}`, type: 'Transporte' as const, status: toSubStatus(t.status, 'transport'), price: t.monthlyFee, days: null, startDate: t.createdAt, id: t.id })),
            ];

            return (
              <div key={child.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {/* Child header */}
                <div className="bg-gray-50 px-6 py-4 border-b border-gray-200 flex justify-between items-center">
                  <div>
                    <h2 className="font-semibold text-gray-900">{child.firstName} {child.lastName}</h2>
                    {child.schoolName && (
                      <p className="text-sm text-gray-500">{child.schoolName} · {child.schoolYear}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Link
                      to={`/client/enroll/study?childId=${child.id}`}
                      className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700"
                    >
                      + Sala de Estudo
                    </Link>
                    <Link
                      to={`/client/enroll/transport?childId=${child.id}`}
                      className="bg-green-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-green-700"
                    >
                      + Transporte
                    </Link>
                  </div>
                </div>

                {/* Subscriptions */}
                {allSubs.length === 0 ? (
                  <div className="px-6 py-8 text-center text-gray-400 text-sm">
                    Sem inscrições. Utilize os botões acima para inscrever.
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {allSubs.map(sub => {
                      const detailPath = sub.type === 'Sala de Estudo'
                        ? `/client/study/${sub.id}`
                        : `/client/transport/${sub.id}`;
                      return (
                        <Link
                          key={sub.key}
                          to={detailPath}
                          className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                        >
                          <div className="flex items-center gap-4">
                            <span className="text-2xl">
                              {sub.type === 'Sala de Estudo' ? '📚' : '🚌'}
                            </span>
                            <div>
                              <p className="font-medium text-gray-900">{sub.type}</p>
                              {sub.days && sub.days.length > 0 && (
                                <p className="text-sm text-gray-500">
                                  {sub.days.map((d: any) => d.day || d).join(', ')}
                                </p>
                              )}
                              {sub.startDate && (
                                <p className="text-xs text-gray-400">
                                  Desde {format(sub.startDate instanceof Date ? sub.startDate : new Date(sub.startDate), 'MMMM yyyy', { locale: pt })}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            {sub.price != null && sub.status === 'active' && (
                              <span className="font-semibold text-gray-900">€{(sub.price).toFixed(2)}/mês</span>
                            )}
                            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusClass[sub.status]}`}>
                              {statusLabel[sub.status]}
                            </span>
                            <span className="text-gray-300 text-lg">›</span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

