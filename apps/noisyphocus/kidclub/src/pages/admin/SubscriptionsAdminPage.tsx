import { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';

type SubStatus = 'pending' | 'active' | 'cancelled';

interface SubItem {
  id: string;
  _type: 'study' | 'transport';
  childName: string;
  familyId?: string;
  contactEmail?: string;
  contactPhone?: string;
  // Study fields
  schoolName?: string;
  schoolYear?: string;
  days?: any[];
  monthlyPrice?: number;
  // Transport fields
  schedule?: any[];
  monthlyFee?: number;
  // Common
  status: SubStatus;
  statusReason?: string;
  note?: string;
  createdAt: Date;
  cancelRequested?: boolean;
}

const toDate = (v: any): Date => v?.toDate?.() ?? new Date(v ?? 0);

const locationStr = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.address || `${v.lat ?? ''},${v.lng ?? ''}`;
};

const DAY_PT: Record<string, string> = {
  monday: 'Seg', tuesday: 'Ter', wednesday: 'Qua',
  thursday: 'Qui', friday: 'Sex', saturday: 'Sáb', sunday: 'Dom',
};

const dayLabel = (d: any): string => {
  if (typeof d === 'string') return DAY_PT[d] ?? d;
  return DAY_PT[d?.day ?? d?.dayOfWeek] ?? d?.day ?? d?.dayOfWeek ?? '';
};

const StatusBadge = ({ status, cancelRequested }: { status: SubStatus; cancelRequested?: boolean }) => {
  if (cancelRequested && status === 'active') {
    return <span className="text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full font-medium">Cancelamento pedido</span>;
  }
  const map: Record<SubStatus, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    active: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  const label: Record<SubStatus, string> = {
    pending: 'Pendente',
    active: 'Ativa',
    cancelled: 'Cancelada',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status]}`}>{label[status]}</span>;
};

export default function SubscriptionsAdminPage() {
  const [items, setItems] = useState<SubItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<SubStatus | 'all'>('pending');
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [studySnap, transportSnap] = await Promise.all([
        getDocs(collection(db, 'studyroom')),
        getDocs(collection(db, 'transportationSubscriptions')),
      ]);

      const study: SubItem[] = studySnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          _type: 'study',
          childName: x.childName || x.studentName || '—',
          familyId: x.familyId,
          contactEmail: x.email || x.contactEmail,
          contactPhone: x.phone || x.contactPhone,
          schoolName: x.schoolName,
          schoolYear: x.schoolYear,
          days: x.days || [],
          monthlyPrice: x.monthlyPrice ?? x.basePrice ?? 0,
          status: (x.status === 'confirmed' ? 'active' : x.status) as SubStatus,
          statusReason: x.statusReason,
          note: x.note,
          createdAt: toDate(x.createdAt),
          cancelRequested: x.cancelRequested,
        };
      });

      const transport: SubItem[] = transportSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          _type: 'transport',
          childName: x.childName || '—',
          familyId: x.familyId,
          contactEmail: x.contactEmail,
          contactPhone: x.contactMobile,
          schedule: x.schedule || [],
          monthlyFee: x.monthlyFee ?? 0,
          status: x.status as SubStatus,
          statusReason: x.statusReason,
          note: x.note,
          createdAt: toDate(x.createdAt),
          cancelRequested: x.cancelRequested,
        };
      });

      const all = [...study, ...transport].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      );
      setItems(all);
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar inscrições.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const approve = async (item: SubItem) => {
    setProcessing(item.id);
    try {
      const col = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(doc(db, col, item.id), {
        status: 'active',
        approvedAt: new Date(),
        updatedAt: new Date(),
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'active' } : i));
    } finally {
      setProcessing(null);
    }
  };

  const reject = async (item: SubItem) => {
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
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'cancelled', statusReason: rejectReason } : i));
      setRejectId(null);
      setRejectReason('');
    } finally {
      setProcessing(null);
    }
  };

  const cancel = async (item: SubItem) => {
    if (!window.confirm(`Cancelar inscrição de ${item.childName}?`)) return;
    setProcessing(item.id);
    try {
      const col = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
      await updateDoc(doc(db, col, item.id), {
        status: 'cancelled',
        statusReason: 'Cancelado pelo administrador',
        cancelledAt: new Date(),
        updatedAt: new Date(),
      });
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: 'cancelled' } : i));
    } finally {
      setProcessing(null);
    }
  };

  const filtered = tab === 'all' ? items : items.filter(i => i.status === tab);

  const counts = {
    pending: items.filter(i => i.status === 'pending').length,
    active: items.filter(i => i.status === 'active').length,
    cancelled: items.filter(i => i.status === 'cancelled').length,
    all: items.length,
  };

  if (isLoading) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h2 className="font-semibold text-red-800 mb-2">Erro ao carregar inscrições</h2>
        <p className="text-red-700 text-sm mb-4">{error}</p>
        <button onClick={load} className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 text-sm">
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Inscrições</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {counts.pending > 0 && <span className="text-yellow-700 font-medium">{counts.pending} pendente(s) • </span>}
            {counts.active} ativas
          </p>
        </div>
        <button onClick={load} className="text-sm text-blue-600 hover:underline">
          Atualizar
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {([
          { key: 'pending', label: 'Pendentes', count: counts.pending },
          { key: 'active', label: 'Ativas', count: counts.active },
          { key: 'cancelled', label: 'Histórico', count: counts.cancelled },
          { key: 'all', label: 'Todas', count: counts.all },
        ] as const).map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                tab === key ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          {tab === 'pending' ? 'Sem pedidos pendentes.' : 'Sem inscrições nesta categoria.'}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(item => (
            <div key={`${item._type}-${item.id}`} className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-start justify-between gap-4">
                {/* Info */}
                <div className="flex gap-4 flex-1 min-w-0">
                  <div className="text-3xl mt-0.5 shrink-0">
                    {item._type === 'study' ? '📚' : '🚌'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-gray-900">{item.childName}</span>
                      <StatusBadge status={item.status} cancelRequested={item.cancelRequested} />
                      <span className="text-xs text-gray-400">
                        {item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}
                      </span>
                    </div>

                    {/* Study details */}
                    {item._type === 'study' && (
                      <div className="text-sm text-gray-600 space-y-0.5">
                        {(item.schoolName || item.schoolYear) && (
                          <p>{[item.schoolName, item.schoolYear].filter(Boolean).join(' · ')}</p>
                        )}
                        {item.days && item.days.length > 0 && (
                          <p>Dias: {item.days.map(dayLabel).filter(Boolean).join(', ')}</p>
                        )}
                        {(item.monthlyPrice ?? 0) > 0 && (
                          <p className="font-medium text-gray-800">€{(item.monthlyPrice ?? 0).toFixed(2)}/mês</p>
                        )}
                      </div>
                    )}

                    {/* Transport details */}
                    {item._type === 'transport' && (
                      <div className="text-sm text-gray-600 space-y-0.5">
                        {item.schedule?.map((s, i) => (
                          <p key={i}>
                            {DAY_PT[s.dayOfWeek] ?? s.dayOfWeek} {s.pickupTime && `· ${s.pickupTime}`}
                            {s.pickupLocation && ` · ${locationStr(s.pickupLocation)}`}
                          </p>
                        ))}
                        {(item.monthlyFee ?? 0) > 0 && (
                          <p className="font-medium text-gray-800">€{(item.monthlyFee ?? 0).toFixed(2)}/mês</p>
                        )}
                      </div>
                    )}

                    {/* Contact info */}
                    {(item.contactEmail || item.contactPhone) && (
                      <p className="text-xs text-gray-400 mt-1">
                        {[item.contactEmail, item.contactPhone].filter(Boolean).join(' · ')}
                      </p>
                    )}

                    {/* Notes */}
                    {item.note && (
                      <p className="text-xs text-gray-500 mt-1 italic">"{item.note}"</p>
                    )}

                    {/* Rejection reason */}
                    {item.statusReason && item.status === 'cancelled' && (
                      <p className="text-xs text-red-600 mt-1">Motivo: {item.statusReason}</p>
                    )}

                    <p className="text-xs text-gray-400 mt-2">
                      {item.createdAt.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 shrink-0">
                  {item.status === 'pending' && (
                    <>
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
                    </>
                  )}
                  {item.status === 'active' && (
                    <button
                      onClick={() => cancel(item)}
                      disabled={processing === item.id}
                      className="bg-gray-100 text-gray-600 border border-gray-200 text-sm px-4 py-2 rounded-lg hover:bg-gray-200 disabled:opacity-60 whitespace-nowrap"
                    >
                      {processing === item.id ? '...' : 'Cancelar'}
                    </button>
                  )}
                </div>
              </div>

              {/* Reject reason input */}
              {rejectId === item.id && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Motivo da rejeição
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
