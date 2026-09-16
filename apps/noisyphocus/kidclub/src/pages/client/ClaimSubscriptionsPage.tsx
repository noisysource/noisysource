import { useState, useEffect } from 'react';
import { getDocs, addDoc, updateDoc, query, where } from 'firebase/firestore';
import { useUser } from '@shared/hooks';
import { Child } from '@shared/models';
import { col, docRef } from '../../lib/db';
import { familyService } from '../../services/familyService';
import { calculateAge, normalizeName } from '../../lib/utils';

const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);

interface LinkedSub {
  collection: 'transportationSubscriptions' | 'studyroom';
  id: string;
  monthlyFee: number;
  scheduleLabel: string;
  notes?: string;
  childId?: string;
}

interface PendingChild {
  key: string;
  childName: string;
  subs: LinkedSub[];
  // Set when a sub already carries a real childId (from ManualEnrollForm's
  // child-matching) — the admin already created this child, with whatever
  // details they entered. Claiming must link to it, not create a duplicate.
  existingChild?: Child | null;
}

interface ChildForm {
  firstName: string;
  lastName: string;
  dateOfBirth: string; // YYYY-MM-DD
  schoolName: string;
  schoolYear: string;
}

const PT_DAY: Record<string, string> = {
  monday: 'Seg', tuesday: 'Ter', wednesday: 'Qua', thursday: 'Qui', friday: 'Sex',
};

function transportScheduleLabel(schedule: any[]): string {
  const days = [...new Set(schedule.map((s: any) => PT_DAY[s.dayOfWeek] ?? s.dayOfWeek))];
  return `🚌 ${days.join(' · ')}` + (schedule.length === 1 ? ' — 1 viagem/semana' : ` — ${schedule.length} viagens/semana`);
}

function studyScheduleLabel(days: any[]): string {
  const labels = [...new Set(days.map((d: any) => PT_DAY[d.day] ?? d.day))];
  return `📚 Sala de Estudo — ${labels.join(' · ')}`;
}

function toDateInputValue(d: Date | undefined): string {
  if (!d || isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0];
}

export default function ClaimSubscriptionsPage({ onComplete }: { onComplete: () => void }) {
  const user = useUser();
  const [children, setChildren] = useState<PendingChild[]>([]);
  const [forms, setForms] = useState<Record<string, ChildForm>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!user?.email) return;
    (async () => {
      // Study-room docs inconsistently use `email` or `contactEmail` depending on which
      // admin flow created them (confirmed against prod: neither field alone covers every
      // record) — query both and dedupe.
      const [transportSnap, studyByEmailSnap, studyByContactEmailSnap] = await Promise.all([
        getDocs(query(col('transportationSubscriptions'), where('contactEmail', '==', user.email))),
        getDocs(query(col('studyroom'), where('email', '==', user.email))),
        getDocs(query(col('studyroom'), where('contactEmail', '==', user.email))),
      ]);
      const studyDocsById = new Map(
        [...studyByEmailSnap.docs, ...studyByContactEmailSnap.docs].map(d => [d.id, d])
      );

      const unclaimedTransport = transportSnap.docs.filter(
        d => !d.data().familyId && !CANCELLED_STATUSES.has(d.data().status)
      );
      const unclaimedStudy = [...studyDocsById.values()].filter(
        d => !d.data().familyId && !CANCELLED_STATUSES.has(d.data().status)
      );

      // Group by normalized child name; a study doc's linkedTransportId (when present)
      // forces it into the same group as that transport doc, even if the name differs slightly.
      const groups = new Map<string, PendingChild>();
      const keyByTransportId = new Map<string, string>();

      for (const d of unclaimedTransport) {
        const data = d.data();
        const childName = data.childName ?? data.kidName ?? '';
        const key = normalizeName(childName);
        keyByTransportId.set(d.id, key);
        const group = groups.get(key) ?? { key, childName, subs: [] as LinkedSub[] };
        group.subs.push({
          collection: 'transportationSubscriptions',
          id: d.id,
          monthlyFee: data.monthlyFee ?? 0,
          scheduleLabel: transportScheduleLabel(data.schedule ?? []),
          notes: data.notes ?? '',
          childId: data.childId || undefined,
        });
        groups.set(key, group);
      }

      for (const d of unclaimedStudy) {
        const data = d.data();
        const childName = data.childName ?? data.studentName ?? '';
        const linkedKey = data.linkedTransportId ? keyByTransportId.get(data.linkedTransportId) : undefined;
        const key = linkedKey ?? normalizeName(childName);
        const group = groups.get(key) ?? { key, childName, subs: [] as LinkedSub[] };
        group.subs.push({
          collection: 'studyroom',
          id: d.id,
          monthlyFee: data.monthlyPrice ?? 0,
          scheduleLabel: studyScheduleLabel(data.days ?? []),
          notes: data.note ?? '',
          childId: data.childId || undefined,
        });
        groups.set(key, group);
      }

      const unclaimed = [...groups.values()];

      // Resolve any existing childId per group (the admin already created this child
      // via ManualEnrollForm's matching flow) — fetch it so we link to it instead of
      // creating a duplicate, and so the form can be pre-filled/protected accordingly.
      await Promise.all(unclaimed.map(async child => {
        const existingChildId = child.subs.find(s => s.childId)?.childId;
        if (existingChildId) {
          child.existingChild = await familyService.getChild(existingChildId);
        }
      }));

      setChildren(unclaimed);
      const initial: Record<string, ChildForm> = {};
      for (const child of unclaimed) {
        if (child.existingChild) {
          const c = child.existingChild;
          initial[child.key] = {
            firstName: c.firstName ?? '',
            lastName: c.lastName ?? '',
            dateOfBirth: toDateInputValue(c.dateOfBirth),
            schoolName: c.schoolName ?? '',
            schoolYear: c.schoolYear ?? '',
          };
        } else {
          const parts = child.childName.trim().split(' ');
          initial[child.key] = {
            firstName: parts[0] ?? '',
            lastName: parts.slice(1).join(' '),
            dateOfBirth: '',
            schoolName: '',
            schoolYear: '',
          };
        }
      }
      setForms(initial);
      setLoading(false);
    })();
  }, [user]);

  function setField(childKey: string, field: keyof ChildForm, value: string) {
    setForms(prev => ({ ...prev, [childKey]: { ...prev[childKey], [field]: value } }));
    setErrors(prev => { const { [`${childKey}.${field}`]: _, ...rest } = prev; return rest; });
  }

  async function handleConfirm() {
    const newErrors: Record<string, string> = {};
    for (const child of children) {
      const f = forms[child.key];
      const existing = child.existingChild;
      // firstName/lastName always already exist on a linked child — nothing to require.
      if (!existing) {
        if (!f.firstName.trim()) newErrors[`${child.key}.firstName`] = 'Obrigatório';
        if (!f.lastName.trim()) newErrors[`${child.key}.lastName`] = 'Obrigatório';
      }
      const dobMissing = !existing || !existing.dateOfBirth || isNaN(existing.dateOfBirth.getTime());
      if (dobMissing && !f.dateOfBirth) newErrors[`${child.key}.dateOfBirth`] = 'Obrigatório';
    }
    if (Object.keys(newErrors).length) { setErrors(newErrors); return; }

    setSubmitting(true);
    try {
      const family = await familyService.getOrCreateFamily(
        user!.uid, user!.name || user!.email?.split('@')[0] || '', user!.email || ''
      );

      for (const child of children) {
        const f = forms[child.key];
        const existing = child.existingChild;
        let childId: string;
        let age: number;

        if (existing) {
          // Link to the child the admin already created — never duplicate it, and
          // never overwrite fields the admin already filled in. Only fill genuine
          // gaps (legacy children from before these fields were required).
          childId = existing.id;
          const patch: Record<string, any> = { familyId: family.id, userId: user!.uid };

          let dob = existing.dateOfBirth;
          if (!existing.dateOfBirth || isNaN(existing.dateOfBirth.getTime())) {
            dob = new Date(f.dateOfBirth);
            patch.dateOfBirth = dob;
          }
          age = calculateAge(dob);
          patch.age = age;
          if (!existing.schoolName) patch.schoolName = f.schoolName.trim() || null;
          if (!existing.schoolYear) patch.schoolYear = f.schoolYear.trim() || null;

          await updateDoc(docRef('children', childId), patch);
        } else {
          const dob = new Date(f.dateOfBirth);
          age = calculateAge(dob);
          const childRef = await addDoc(col('children'), {
            familyId: family.id,
            userId: user!.uid,
            firstName: f.firstName.trim(),
            lastName: f.lastName.trim(),
            dateOfBirth: dob,
            age,
            schoolName: f.schoolName.trim() || null,
            schoolYear: f.schoolYear.trim() || null,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          childId = childRef.id;
        }

        for (const sub of child.subs) {
          await updateDoc(docRef(sub.collection, sub.id), {
            familyId: family.id,
            childId,
            userId: user!.uid,
            childAge: age,
            source: 'web',
          });
        }
      }

      onComplete();
    } catch (e) {
      console.error('[ClaimSubscriptionsPage] failed', e);
      alert('Erro ao confirmar os dados. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        A carregar...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-start py-12 px-4">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="text-4xl mb-3">🚌</div>
          <h1 className="text-2xl font-bold text-gray-900">Bem-vindo ao KidClub!</h1>
          <p className="text-gray-500 mt-2">
            Encontrámos {children.length === 1 ? 'uma criança associada' : `${children.length} crianças associadas`} ao seu email.
            Por favor confirme os dados para ligar a sua conta.
          </p>
        </div>

        {/* One card per child (may combine transport + study room subscriptions) */}
        {children.map(child => {
          const f = forms[child.key] ?? { firstName: '', lastName: '', dateOfBirth: '', schoolName: '', schoolYear: '' };
          const err = (field: keyof ChildForm) => errors[`${child.key}.${field}`];
          const totalFee = child.subs.reduce((sum, s) => sum + s.monthlyFee, 0);
          const existing = child.existingChild;
          const nameLocked = !!existing;
          const dobLocked = !!existing && !!existing.dateOfBirth && !isNaN(existing.dateOfBirth.getTime());
          const schoolNameLocked = !!existing?.schoolName;
          const schoolYearLocked = !!existing?.schoolYear;
          const lockedCls = 'w-full border rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-500 border-gray-200';
          const editableCls = (field: keyof ChildForm) =>
            `w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 ${err(field) ? 'border-red-400' : 'border-gray-300'}`;
          return (
            <div key={child.key} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              {/* Sub summary */}
              <div className="bg-blue-50 border-b border-blue-100 px-6 py-4 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-blue-900">{child.childName}</p>
                  {child.subs.map(sub => (
                    <p key={sub.id} className="text-sm text-blue-600">{sub.scheduleLabel}</p>
                  ))}
                </div>
                {totalFee > 0 && (
                  <span className="font-bold text-blue-800 text-lg">€{totalFee.toFixed(0)}/mês</span>
                )}
              </div>

              {/* Form */}
              <div className="px-6 py-5 space-y-4">
                <p className="text-sm font-medium text-gray-700">
                  {existing ? 'Confirme os dados da criança (já registados pela equipa)' : 'Confirme os dados da criança'}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Primeiro nome {!nameLocked && '*'}</label>
                    {nameLocked ? (
                      <div className={lockedCls}>{f.firstName}</div>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={f.firstName}
                          onChange={e => setField(child.key, 'firstName', e.target.value)}
                          className={editableCls('firstName')}
                        />
                        {err('firstName') && <p className="text-xs text-red-500 mt-1">{err('firstName')}</p>}
                      </>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Apelido {!nameLocked && '*'}</label>
                    {nameLocked ? (
                      <div className={lockedCls}>{f.lastName}</div>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={f.lastName}
                          onChange={e => setField(child.key, 'lastName', e.target.value)}
                          className={editableCls('lastName')}
                        />
                        {err('lastName') && <p className="text-xs text-red-500 mt-1">{err('lastName')}</p>}
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-gray-500 mb-1">Data de nascimento {!dobLocked && '*'}</label>
                  {dobLocked ? (
                    <div className={lockedCls}>{f.dateOfBirth}</div>
                  ) : (
                    <>
                      <input
                        type="date"
                        value={f.dateOfBirth}
                        onChange={e => setField(child.key, 'dateOfBirth', e.target.value)}
                        max={new Date().toISOString().split('T')[0]}
                        className={editableCls('dateOfBirth')}
                      />
                      {err('dateOfBirth') && <p className="text-xs text-red-500 mt-1">{err('dateOfBirth')}</p>}
                    </>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Escola</label>
                    {schoolNameLocked ? (
                      <div className={lockedCls}>{f.schoolName}</div>
                    ) : (
                      <input
                        type="text"
                        value={f.schoolName}
                        onChange={e => setField(child.key, 'schoolName', e.target.value)}
                        placeholder="Nome da escola"
                        className={editableCls('schoolName')}
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Ano escolar</label>
                    {schoolYearLocked ? (
                      <div className={lockedCls}>{f.schoolYear}</div>
                    ) : (
                      <select
                        value={f.schoolYear}
                        onChange={e => setField(child.key, 'schoolYear', e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
                      >
                        <option value="">Selecionar</option>
                        {['1.º', '2.º', '3.º', '4.º', '5.º', '6.º', '7.º', '8.º', '9.º', '10.º', '11.º', '12.º'].map(y => (
                          <option key={y} value={y}>{y} ano</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {child.subs.map(sub => sub.notes && (
                  <p key={sub.id} className="text-xs text-gray-400 italic">Nota: {sub.notes}</p>
                ))}
              </div>
            </div>
          );
        })}

        {/* Confirm */}
        <button
          onClick={handleConfirm}
          disabled={submitting}
          className="w-full py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'A confirmar…' : 'Confirmar e ligar conta'}
        </button>
        <p className="text-xs text-center text-gray-400">
          Ao confirmar, as inscrições ficam associadas à sua conta e pode geri-las aqui.
        </p>
      </div>
    </div>
  );
}
