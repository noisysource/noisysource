import { useState, useEffect } from 'react';
import { collection, getDocs, query, where, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { StudyRoomEntry, TransportationSubscription } from '@shared/models';
import { format } from 'date-fns';
import { pt } from 'date-fns/locale';

interface PendingStudy extends StudyRoomEntry {
  _type: 'study';
}

interface PendingTransport extends TransportationSubscription {
  _type: 'transport';
}

type PendingItem = PendingStudy | PendingTransport;

const toDate = (v: any): Date => v?.toDate?.() ?? new Date(v);

const locationStr = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.address || `${v.lat ?? ''},${v.lng ?? ''}`;
};

export default function EnrollmentRequestsPage() {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    let studySnap, transportSnap;
    try {
      [studySnap, transportSnap] = await Promise.all([
        getDocs(query(collection(db, 'studyroom'), where('status', '==', 'pending'))),
        getDocs(query(collection(db, 'transportationSubscriptions'), where('status', '==', 'pending'))),
      ]);
    } catch (err: any) {
      console.error('Failed to load enrollment requests:', err);
      setError(err?.message || 'Erro ao carregar pedidos. Verifique as permissões do Firestore.');
      setIsLoading(false);
      return;
    }

    const study: PendingStudy[] = studySnap.docs.map(d => ({
      ...d.data(), id: d.id, _type: 'study' as const,
      startDate: toDate(d.data().startDate),
      endDate: toDate(d.data().endDate),
      createdAt: toDate(d.data().createdAt),
      updatedAt: toDate(d.data().updatedAt),
    } as PendingStudy));

    const transport: PendingTransport[] = transportSnap.docs.map(d => ({
      ...d.data(), id: d.id, _type: 'transport' as const,
      createdAt: toDate(d.data().createdAt),
      updatedAt: toDate(d.data().updatedAt),
    } as PendingTransport));

    const all = [...study, ...transport].sort(
      (a, b) => (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0)
    );
    setItems(all);
    setIsLoading(false);
  };

  useEffect(() => { load(); }, []);

  const approve = async (item: PendingItem) => {
    setProcessing(item.id);
    try {
      const col = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(doc(db, col, item.id), {
        status: 'active',
        approvedAt: new Date(),
        updatedAt: new Date(),
      });
      setItems(prev => prev.filter(i => i.id !== item.id));
    } finally {
      setProcessing(null);
    }
  };

  const reject = async (item: PendingItem) => {
    if (!rejectReason.trim()) return;
    setProcessing(item.id);
    try {
      const col = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(doc(db, col, item.id), {
        status: 'cancelled',
        statusReason: rejectReason,
        rejectedAt: new Date(),
        updatedAt: new Date(),
      });
      setItems(prev => prev.filter(i => i.id !== item.id));
      setRejectId(null);
      setRejectReason('');
    } finally {
      setProcessing(null);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="font-semibold text-red-800 mb-2">Erro ao carregar pedidos</h2>
        <p className="text-red-700 text-sm mb-4">{error}</p>
        <button onClick={load} className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 text-sm">
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Pedidos de Inscrição</h1>
          <p className="text-sm text-gray-500 mt-1">
            {items.length === 0
              ? 'Sem pedidos pendentes'
              : `${items.length} pedido(s) aguardam aprovação`}
          </p>
        </div>
        <button onClick={load} className="text-sm text-blue-600 hover:underline">
          Atualizar
        </button>
      </div>

      {items.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          Não há pedidos pendentes de aprovação.
        </div>
      ) : (
        <div className="space-y-4">
          {items.map(item => (
            <div key={`${item._type}-${item.id}`} className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-4">
                {/* Info */}
                <div className="flex gap-4 flex-1">
                  <div className="text-3xl mt-1">
                    {item._type === 'study' ? '📚' : '🚌'}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-gray-900">
                        {item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}
                      </span>
                      <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">
                        Pendente
                      </span>
                    </div>

                    <p className="text-sm font-medium text-gray-800">
                      {item._type === 'study'
                        ? (item as PendingStudy).childName
                        : (item as PendingTransport).childName}
                    </p>

                    {item._type === 'study' && (
                      <>
                        {(item as PendingStudy).schoolName && (
                          <p className="text-sm text-gray-500">
                            {(item as PendingStudy).schoolName} · {(item as PendingStudy).schoolYear}
                          </p>
                        )}
                        <p className="text-sm text-gray-600 mt-1">
                          Dias: {((item as PendingStudy).days || []).map((d: any) => d.day || d).join(', ')}
                        </p>
                        <p className="text-sm font-medium text-gray-900">
                          €{((item as PendingStudy).monthlyPrice ?? 0).toFixed(2)}/mês
                        </p>
                      </>
                    )}

                    {item._type === 'transport' && (
                      <>
                        {(item as PendingTransport).schedule?.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {(item as PendingTransport).schedule.map((s, i) => (
                              <p key={i} className="text-sm text-gray-600">
                                {s.dayOfWeek} · {s.pickupTime} · {locationStr(s.pickupLocation)} → {locationStr(s.dropoffLocation)}
                              </p>
                            ))}
                          </div>
                        )}
                        <p className="text-sm font-medium text-gray-900 mt-1">
                          €{((item as PendingTransport).monthlyFee ?? 0).toFixed(2)}/mês
                        </p>
                      </>
                    )}

                    <p className="text-xs text-gray-400 mt-2">
                      Submetido em {format(item.createdAt, "d 'de' MMMM 'às' HH:mm", { locale: pt })}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={() => approve(item)}
                    disabled={processing === item.id}
                    className="bg-green-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-60 whitespace-nowrap"
                  >
                    {processing === item.id ? '...' : '✓ Aprovar'}
                  </button>
                  <button
                    onClick={() => { setRejectId(item.id); setRejectReason(''); }}
                    disabled={processing === item.id}
                    className="bg-red-50 text-red-600 border border-red-200 text-sm px-4 py-2 rounded-lg hover:bg-red-100 disabled:opacity-60 whitespace-nowrap"
                  >
                    ✕ Rejeitar
                  </button>
                </div>
              </div>

              {/* Reject reason inline */}
              {rejectId === item.id && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Motivo de rejeição (será enviado ao cliente)
                  </label>
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder="ex: Sem vagas disponíveis"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-400 mb-3"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => reject(item)}
                      disabled={!rejectReason.trim() || processing === item.id}
                      className="bg-red-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-red-700 disabled:opacity-60"
                    >
                      Confirmar rejeição
                    </button>
                    <button
                      onClick={() => setRejectId(null)}
                      className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
