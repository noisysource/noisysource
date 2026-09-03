import { useState, useEffect } from 'react';
import { getDocs, deleteDoc, query, orderBy, Timestamp } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';

interface FamilyDoc {
  id: string;
  primaryContact?: { name?: string; email?: string; phone?: string; userId?: string };
  nif?: string;
  status?: string;
  paymentMethod?: string;
  profileComplete?: boolean;
  createdAt?: Timestamp;
  notes?: string;
}

interface ChildDoc {
  id: string;
  familyId: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: Timestamp;
  schoolYear?: string;
  schoolName?: string;
  status?: string;
}

interface StudyDoc {
  id: string;
  familyId: string;
  childName?: string;
  status?: string;
  monthlyPrice?: number;
  days?: { day: string }[];
}

interface TransportDoc {
  id: string;
  familyId: string;
  childName?: string;
  status?: string;
  monthlyFee?: number;
  schedule?: { dayOfWeek: string }[];
}

interface BillingDoc {
  id: string;
  familyId: string;
  status?: string;
  total?: number;
  periodLabel?: string;
}

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-gray-100 text-gray-600',
  suspended: 'bg-red-100 text-red-800',
  pending: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-emerald-100 text-emerald-800',
  canceled: 'bg-gray-100 text-gray-600',
};

function dayLabel(d: string) {
  const m: Record<string, string> = { monday:'2ª', tuesday:'3ª', wednesday:'4ª', thursday:'5ª', friday:'6ª' };
  return m[d] ?? d;
}

function age(ts?: Timestamp) {
  if (!ts) return null;
  const d = ts.toDate();
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
}

export default function FamiliesAdminPage() {
  const [families, setFamilies] = useState<FamilyDoc[]>([]);
  const [children, setChildren] = useState<ChildDoc[]>([]);
  const [study, setStudy] = useState<StudyDoc[]>([]);
  const [transport, setTransport] = useState<TransportDoc[]>([]);
  const [billing, setBilling] = useState<BillingDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [famSnap, childSnap, studySnap, transportSnap, billingSnap] = await Promise.all([
        getDocs(query(col('families'), orderBy('createdAt', 'desc'))),
        getDocs(col('children')),
        getDocs(col('studyroom')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('billing')),
      ]);
      setFamilies(famSnap.docs.map(d => ({ id: d.id, ...d.data() } as FamilyDoc)));
      setChildren(childSnap.docs.map(d => ({ id: d.id, ...d.data() } as ChildDoc)));
      setStudy(studySnap.docs.map(d => ({ id: d.id, ...d.data() } as StudyDoc)));
      setTransport(transportSnap.docs.map(d => ({ id: d.id, ...d.data() } as TransportDoc)));
      setBilling(billingSnap.docs.map(d => ({ id: d.id, ...d.data() } as BillingDoc)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDeleteFamily = async (familyId: string) => {
    if (!confirm('Eliminar esta família e todos os seus dados? Esta ação não pode ser revertida.')) return;
    setDeleting(familyId);
    try {
      const toDelete = [
        ...children.filter(c => c.familyId === familyId).map(c => docRef('children', c.id)),
        ...study.filter(s => s.familyId === familyId).map(s => docRef('studyroom', s.id)),
        ...transport.filter(t => t.familyId === familyId).map(t => docRef('transportationSubscriptions', t.id)),
        ...billing.filter(b => b.familyId === familyId).map(b => docRef('billing', b.id)),
        docRef('families', familyId),
      ];
      await Promise.all(toDelete.map(ref => deleteDoc(ref)));
      await load();
    } finally {
      setDeleting(null);
    }
  };

  const filtered = families.filter(f => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      f.primaryContact?.name?.toLowerCase().includes(q) ||
      f.primaryContact?.email?.toLowerCase().includes(q) ||
      f.nif?.includes(q)
    );
  });

  if (loading) return <div className="p-6 text-gray-400">A carregar...</div>;

  const familyIds = new Set(families.map(f => f.id));
  const orphanTransport = transport.filter(t => !t.familyId || !familyIds.has(t.familyId));
  const orphanStudy = study.filter(s => !s.familyId || !familyIds.has(s.familyId));
  const orphanChildren = children.filter(c => !c.familyId || !familyIds.has(c.familyId));

  const pendingBilling = (fid: string) => billing.filter(b => b.familyId === fid && b.status === 'pending');
  const pendingTotal = (fid: string) => pendingBilling(fid).reduce((s, b) => s + (b.total ?? 0), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">Famílias e Crianças</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">{families.length} família(s) registada(s)</span>
          <button
            onClick={load}
            className="text-sm text-blue-600 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-50"
          >
            ↻ Atualizar
          </button>
        </div>
      </div>

      <input
        type="text"
        placeholder="Pesquisar por nome, email ou NIF..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full border border-gray-200 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-blue-300 focus:outline-none"
      />

      {filtered.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-12">Nenhuma família encontrada.</p>
      )}

      <div className="space-y-3">
        {filtered.map(fam => {
          const famChildren = children.filter(c => c.familyId === fam.id);
          const famStudy = study.filter(s => s.familyId === fam.id);
          const famTransport = transport.filter(t => t.familyId === fam.id);
          const pendingAmt = pendingTotal(fam.id);
          const pendingCount = pendingBilling(fam.id).length;
          const isOpen = expanded === fam.id;

          return (
            <div key={fam.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {/* Header row */}
              <div
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50"
                onClick={() => setExpanded(isOpen ? null : fam.id)}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm shrink-0">
                    {fam.primaryContact?.name?.charAt(0)?.toUpperCase() ?? '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{fam.primaryContact?.name ?? '—'}</p>
                    <p className="text-sm text-gray-400 truncate">{fam.primaryContact?.email ?? '—'}</p>
                  </div>
                </div>

                <div className="flex items-center gap-6 shrink-0 ml-4">
                  <div className="text-center hidden sm:block">
                    <p className="text-xs text-gray-400">Crianças</p>
                    <p className="font-semibold text-gray-700">{famChildren.length}</p>
                  </div>
                  <div className="text-center hidden sm:block">
                    <p className="text-xs text-gray-400">Inscrições</p>
                    <p className="font-semibold text-gray-700">{famStudy.length + famTransport.length}</p>
                  </div>
                  {pendingCount > 0 && (
                    <div className="text-center">
                      <p className="text-xs text-yellow-600">Por pagar</p>
                      <p className="font-semibold text-yellow-700">€{pendingAmt.toFixed(2)}</p>
                      <p className="text-xs text-yellow-500">{pendingCount} mês(es)</p>
                    </div>
                  )}
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[fam.status ?? 'active'] ?? 'bg-gray-100 text-gray-600'}`}>
                    {fam.status ?? 'active'}
                  </span>
                  <span className="text-gray-300 text-lg">{isOpen ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {isOpen && (
                <div className="border-t border-gray-100 px-5 py-4 space-y-5 bg-gray-50">
                  {/* Contact */}
                  <section>
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Contacto</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div><p className="text-gray-400 text-xs">Telefone</p><p className="text-gray-700">{fam.primaryContact?.phone ?? '—'}</p></div>
                      <div><p className="text-gray-400 text-xs">NIF</p><p className="text-gray-700">{fam.nif ?? '—'}</p></div>
                      <div><p className="text-gray-400 text-xs">Método de pagamento</p><p className="text-gray-700 capitalize">{fam.paymentMethod ?? '—'}</p></div>
                      <div><p className="text-gray-400 text-xs">Perfil completo</p><p className="text-gray-700">{fam.profileComplete ? 'Sim' : 'Não'}</p></div>
                    </div>
                    {fam.notes && <p className="text-xs text-gray-500 mt-2 italic">{fam.notes}</p>}
                  </section>

                  {/* Children */}
                  <section>
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Crianças ({famChildren.length})
                    </h3>
                    {famChildren.length === 0 ? (
                      <p className="text-sm text-gray-400">Nenhuma criança registada.</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {famChildren.map(child => (
                          <div key={child.id} className="bg-white rounded-lg border border-gray-200 px-3 py-2 text-sm">
                            <p className="font-medium text-gray-800">{child.firstName} {child.lastName}</p>
                            <p className="text-xs text-gray-400">
                              {age(child.dateOfBirth as any) != null ? `${age(child.dateOfBirth as any)} anos` : ''}
                              {child.schoolYear ? ` · ${child.schoolYear}º ano` : ''}
                              {child.schoolName ? ` · ${child.schoolName}` : ''}
                            </p>
                            <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[child.status ?? 'active'] ?? 'bg-gray-100'}`}>
                              {child.status ?? 'active'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* Subscriptions */}
                  {(famStudy.length > 0 || famTransport.length > 0) && (
                    <section>
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Inscrições ({famStudy.length + famTransport.length})
                      </h3>
                      <div className="space-y-1">
                        {famStudy.map(s => (
                          <div key={s.id} className="flex justify-between text-sm bg-white rounded border border-gray-200 px-3 py-2">
                            <div>
                              <span className="text-gray-500 text-xs mr-2">📚</span>
                              <span className="text-gray-800">{s.childName ?? '—'}</span>
                              {s.days && s.days.length > 0 && (
                                <span className="text-xs text-gray-400 ml-2">({s.days.map(d => dayLabel(d.day)).join(', ')})</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-600 font-medium">€{(s.monthlyPrice ?? 0).toFixed(2)}/mês</span>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[s.status ?? ''] ?? 'bg-gray-100'}`}>{s.status}</span>
                            </div>
                          </div>
                        ))}
                        {famTransport.map(t => (
                          <div key={t.id} className="flex justify-between text-sm bg-white rounded border border-gray-200 px-3 py-2">
                            <div>
                              <span className="text-gray-500 text-xs mr-2">🚌</span>
                              <span className="text-gray-800">{t.childName ?? '—'}</span>
                              {t.schedule && t.schedule.length > 0 && (
                                <span className="text-xs text-gray-400 ml-2">({t.schedule.map(s => dayLabel(s.dayOfWeek)).join(', ')})</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-600 font-medium">€{(t.monthlyFee ?? 0).toFixed(2)}/mês</span>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[t.status ?? ''] ?? 'bg-gray-100'}`}>{t.status}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Billing summary */}
                  {pendingCount > 0 && (
                    <section>
                      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Cobranças pendentes ({pendingCount} meses)
                      </h3>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {pendingBilling(fam.id).slice(0, 4).map(b => (
                          <div key={b.id} className="bg-yellow-50 border border-yellow-100 rounded px-2 py-1 text-xs text-center">
                            <p className="text-yellow-700 font-medium">{b.periodLabel}</p>
                            <p className="text-yellow-800 font-bold">€{(b.total ?? 0).toFixed(2)}</p>
                          </div>
                        ))}
                        {pendingCount > 4 && (
                          <div className="bg-gray-100 rounded px-2 py-1 text-xs text-center text-gray-500 flex items-center justify-center">
                            +{pendingCount - 4} mais
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                  {/* Actions */}
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => handleDeleteFamily(fam.id)}
                      disabled={deleting === fam.id}
                      className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40"
                    >
                      {deleting === fam.id ? 'A eliminar...' : 'Eliminar família'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(orphanTransport.length > 0 || orphanStudy.length > 0 || orphanChildren.length > 0) && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-700 mb-3">Sem família associada</h2>
          <p className="text-xs text-gray-400 mb-3">Inscrições e crianças criadas manualmente ou sem conta de família ligada.</p>
          <div className="space-y-1">
            {orphanChildren.map(c => (
              <div key={c.id} className="flex justify-between text-sm bg-white rounded border border-gray-200 px-3 py-2">
                <div><span className="text-gray-500 text-xs mr-2">👤</span><span className="text-gray-800">{c.firstName} {c.lastName}</span></div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[c.status ?? 'active'] ?? 'bg-gray-100'}`}>{c.status ?? 'active'}</span>
              </div>
            ))}
            {orphanStudy.map(s => (
              <div key={s.id} className="flex justify-between text-sm bg-white rounded border border-gray-200 px-3 py-2">
                <div><span className="text-gray-500 text-xs mr-2">📚</span><span className="text-gray-800">{s.childName ?? '—'}</span></div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 font-medium">€{(s.monthlyPrice ?? 0).toFixed(2)}/mês</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[s.status ?? ''] ?? 'bg-gray-100'}`}>{s.status}</span>
                </div>
              </div>
            ))}
            {orphanTransport.map(t => (
              <div key={t.id} className="flex justify-between text-sm bg-white rounded border border-gray-200 px-3 py-2">
                <div><span className="text-gray-500 text-xs mr-2">🚌</span><span className="text-gray-800">{t.childName ?? '—'}</span></div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 font-medium">€{(t.monthlyFee ?? 0).toFixed(2)}/mês</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[t.status ?? ''] ?? 'bg-gray-100'}`}>{t.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
