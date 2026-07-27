import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { Child, StudyRoomEntry, TransportationSubscription, Family } from '@shared/models';
import { Link } from 'react-router-dom';
import { familyService } from '../../services/familyService';
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

export default function MySubscriptionsPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [childSubs, setChildSubs] = useState<ChildSubs[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setIsLoading(true);
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
      } finally {
        setIsLoading(false);
      }
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
            const allSubs = [
              ...study.map(s => ({ key: `study-${s.id}`, type: 'Sala de Estudo' as const, status: (s.status ?? 'pending') as SubStatus, price: s.monthlyPrice, days: s.days, startDate: s.startDate, id: s.id })),
              ...transport.map(t => ({ key: `transport-${t.id}`, type: 'Transporte' as const, status: (t.status ?? 'pending') as SubStatus, price: t.monthlyFee, days: null, startDate: t.createdAt, id: t.id })),
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
                    {allSubs.map(sub => (
                      <div key={sub.key} className="px-6 py-4 flex items-center justify-between">
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
                          {sub.status === 'active' && (
                            <span className="font-semibold text-gray-900">€{(sub.price ?? 0).toFixed(2)}/mês</span>
                          )}
                          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusClass[sub.status]}`}>
                            {statusLabel[sub.status]}
                          </span>
                          {sub.status === 'active' && (
                            <CancelButton childId={child.id} subId={sub.id} type={sub.type === 'Sala de Estudo' ? 'study' : 'transport'} onDone={() => window.location.reload()} />
                          )}
                        </div>
                      </div>
                    ))}
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

function CancelButton({ childId, subId, type, onDone }: { childId: string; subId: string; type: 'study' | 'transport'; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const handleCancel = async () => {
    setSending(true);
    try {
      // Mark as cancellation requested — admin will process
      const { doc, updateDoc } = await import('firebase/firestore');
      const { db } = await import('../../lib/firebase');
      const col = type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(doc(db, col, subId), {
        cancelRequested: true,
        cancelRequestedAt: new Date(),
        updatedAt: new Date(),
      });
      setOpen(false);
      onDone();
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-red-500 hover:text-red-700 underline"
      >
        Cancelar
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h3 className="font-bold text-lg mb-2">Pedir cancelamento</h3>
            <p className="text-gray-600 text-sm mb-4">
              O seu pedido de cancelamento será enviado à equipa para processamento. A inscrição mantém-se ativa até confirmação.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleCancel}
                disabled={sending}
                className="flex-1 bg-red-600 text-white py-2 rounded-lg hover:bg-red-700 disabled:opacity-60 text-sm"
              >
                {sending ? 'A enviar...' : 'Confirmar pedido'}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="flex-1 bg-gray-200 text-gray-700 py-2 rounded-lg hover:bg-gray-300 text-sm"
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
