import { useState, useEffect } from 'react';
import { getDocs, query, where } from 'firebase/firestore';
import { col } from '../../../lib/db';
import { AppliedDiscount } from '@shared/models/Discount';
import { SubItem } from './model';
import { DAY_PT } from './badges';

// ─── Version History Modal ────────────────────────────────────────────────────
export default function VersionHistoryModal({ item, onClose }: { item: SubItem; onClose: () => void }) {
  const [versions, setVersions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDocs(query(col('subscriptionVersions'), where('subscriptionId', '==', item.id)))
      .then(snap => {
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        docs.sort((a: any, b: any) => {
          const ta = a.changedAt?.toDate?.() ?? new Date(a.changedAt ?? 0);
          const tb = b.changedAt?.toDate?.() ?? new Date(b.changedAt ?? 0);
          return tb.getTime() - ta.getTime();
        });
        setVersions(docs);
      })
      .finally(() => setLoading(false));
  }, [item.id]);

  const changeTypeLabel: Record<string, string> = {
    status_change: 'Mudança de estado',
    schedule_edit: 'Alteração de horário',
    fee_change: 'Alteração de mensalidade',
    discount_change: 'Alteração de desconto',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="font-bold text-gray-900">Histórico de alterações</h2>
            <p className="text-xs text-gray-500 mt-0.5">{item.childName} · {item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl font-light leading-none">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">
          {loading ? (
            <div className="text-center text-gray-400 py-8">A carregar…</div>
          ) : versions.length === 0 ? (
            <div className="text-center text-gray-400 py-8">Sem histórico registado.</div>
          ) : (
            <div className="relative pl-8">
              <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-100" />
              <div className="space-y-5">
                {versions.map((v: any, idx) => {
                  const changedAt = v.changedAt?.toDate?.() ?? new Date(v.changedAt ?? 0);
                  const snap = v.snapshot ?? {};
                  const fee = snap.monthlyFee ?? snap.monthlyPrice ?? null;
                  const discounts: AppliedDiscount[] = snap.appliedDiscounts ?? [];
                  const pct = (d: number) => `${(d * 100).toFixed(0)}%`;
                  const newSchedule: any[] | null = v.patchApplied?.schedule ?? null;
                  return (
                    <div key={v.id} className="relative">
                      <div className={`absolute w-2.5 h-2.5 rounded-full border-2 border-white ${idx === 0 ? 'bg-amber-500' : 'bg-gray-300'}`} style={{ top: 4, left: -20 }} />
                      <div className="text-xs text-gray-400 mb-1">
                        {changedAt.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {' · '}
                        <span>{v.changedBy?.role === 'parent' ? 'Encarregado' : 'Admin'}</span>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3 space-y-1.5">
                        <span className="text-xs font-semibold text-gray-700">{changeTypeLabel[v.changeType] ?? v.changeType}</span>
                        {fee != null && (
                          <div className="text-xs text-gray-600">
                            Mensalidade antes: <span className="font-semibold">€{Number(fee).toFixed(2)}</span>
                          </div>
                        )}
                        {discounts.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {discounts.map((d: AppliedDiscount) => (
                              <span key={d.ruleId} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                {d.name} -{pct(d.percentage)}
                              </span>
                            ))}
                          </div>
                        )}
                        {newSchedule && newSchedule.length > 0 && (
                          <div className="text-xs text-gray-500">
                            Novo horário: {newSchedule.map((s: any) => `${DAY_PT[s.dayOfWeek] ?? s.dayOfWeek} ${s.pickupTime ?? ''}`).join(', ')}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
