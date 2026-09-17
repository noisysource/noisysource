import { useState, useEffect } from 'react';
import { useSearchParams, Navigate, Link, useNavigate } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child } from '@shared/models';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { familyService } from '../../../services/familyService';
import { studyRoomService } from '../../../services/studyRoomService';
import { getDiscountRules, resolveAutoDiscounts, applyDiscounts } from '../../../services/discountService';
import { DiscountRule } from '@shared/models/Discount';
import { inferDirection } from '@shared/models/Transportation';
import { addDoc, getDoc, getDocs, updateDoc, query, where } from 'firebase/firestore';
import { col, docRef } from '../../../lib/db';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import WeekSchedulePicker, { WeekScheduleValue, DayConfig } from '../../../components/WeekSchedulePicker';
import EnrollmentDetailsForm, { EnrollmentDetailsValue, EMPTY_ENROLLMENT_DETAILS, validateEnrollmentDetails } from '../../../components/EnrollmentDetailsForm';
import { calculateAge, normalizeSubStatus } from '../../../lib/utils';


function buildTransportCoverage(subs: any[]) {
  const coverage: { weekday: string; direction: 'pickup' | 'dropoff' | 'both' }[] = [];
  for (const sub of subs) {
    for (const s of (sub.schedule ?? [])) {
      coverage.push({ weekday: s.dayOfWeek, direction: inferDirection(s) });
    }
  }
  return coverage;
}

function computeStudyFee(days: DayConfig[], cfg: StudyCenterConfig, weekPattern: WeekScheduleValue['weekPattern']): number {
  const studyDays = days.filter(d => d.services.study).length;
  const ratePerDay = cfg.pricePerDayPerWeek != null && cfg.weeksPerMonth != null
    ? cfg.pricePerDayPerWeek * cfg.weeksPerMonth
    : cfg.monthlyPricePerWeekday;
  const weeksActive = activeWeeksInPattern(weekPattern);
  const weeksBase = cfg.weeksPerMonth ?? 4;
  return studyDays * ratePerDay * (weeksActive / weeksBase);
}

export default function StudyRoomEnrollPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const childId = searchParams.get('childId');
  const editId = searchParams.get('editId');

  const [child, setChild] = useState<Child | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [config, setConfig] = useState<StudyCenterConfig | null>(null);
  const [transportCoverage, setTransportCoverage] = useState<{ weekday: string; direction: 'pickup' | 'dropoff' | 'both' }[]>([]);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [activeSiblingCount, setActiveSiblingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // No childId yet: collect child details inline (same shared form the admin flow uses)
  // and create the child before continuing to the schedule step below.
  const [newChildDetails, setNewChildDetails] = useState<EnrollmentDetailsValue>(EMPTY_ENROLLMENT_DETAILS);
  const [newChildErrors, setNewChildErrors] = useState<Partial<Record<keyof EnrollmentDetailsValue, string>>>({});
  const [creatingChild, setCreatingChild] = useState(false);

  const handleCreateChild = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const errs = validateEnrollmentDetails(newChildDetails);
    if (Object.keys(errs).length) { setNewChildErrors(errs); return; }
    setCreatingChild(true);
    try {
      const fam = await familyService.getOrCreateFamily(user.uid, user.name || '', user.email || '');
      const dob = new Date(newChildDetails.dateOfBirth + 'T12:00:00');
      const newChildId = await familyService.addChild(fam.id, user.uid, {
        firstName: newChildDetails.firstName.trim(),
        lastName: newChildDetails.lastName.trim(),
        dateOfBirth: dob,
        age: calculateAge(dob),
        schoolName: newChildDetails.schoolName.trim() || undefined,
        schoolYear: newChildDetails.schoolYear.trim() || undefined,
        homeAddress: {
          street: newChildDetails.homeAddress.street.trim(),
          city: newChildDetails.homeAddress.city.trim(),
          postalCode: newChildDetails.homeAddress.postalCode.trim(),
          country: newChildDetails.homeAddress.country.trim() || undefined,
        },
        status: 'active',
      });
      navigate(`/client/enroll/study?childId=${newChildId}`, { replace: true });
    } finally {
      setCreatingChild(false);
    }
  };

  const [schedule, setSchedule] = useState<WeekScheduleValue>({ weekPattern: 'all', days: [] });
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!user || !childId) return;
    const load = async () => {
      setIsLoading(true);
      try {
        const promises: Promise<any>[] = [
          familyService.getOrCreateFamily(user.uid, user.name || '', user.email || ''),
          familyService.getChild(childId),
          studyRoomService.getStudyCenterConfig(),
          getDocs(query(col('transportationSubscriptions'), where('childId', '==', childId))),
          getDiscountRules(),
        ];
        if (editId) promises.push(getDoc(docRef('studyroom', editId)));
        const [fam, c, cfg, transSnap, rules, existingSnap] = await Promise.all(promises);
        setFamilyId(fam.id);
        setChild(c);
        setConfig(cfg);
        setDiscountRules(rules ?? []);
        setTransportCoverage(buildTransportCoverage(
          transSnap.docs
            .map((d: any) => ({ id: d.id, ...d.data() }))
            .filter((s: any) => normalizeSubStatus(s.status) !== 'cancelled')
        ));

        // Sibling count for discount preview: both collections, any non-cancelled status
        try {
          const CANCELLED = new Set(['cancelled', 'canceled']);
          const [tSibSnap, sSibSnap] = await Promise.all([
            getDocs(query(col('transportationSubscriptions'), where('familyId', '==', fam.id))),
            getDocs(query(col('studyroom'), where('familyId', '==', fam.id))),
          ]);
          const siblingChildIds = new Set<string>();
          for (const d of [...tSibSnap.docs, ...sSibSnap.docs]) {
            const x = d.data();
            if (!CANCELLED.has(x.status) && x.childId && x.childId !== childId) siblingChildIds.add(x.childId);
          }
          setActiveSiblingCount(siblingChildIds.size);
        } catch { /* best-effort */ }
        if (existingSnap?.exists()) {
          const sub = existingSnap.data();
          // Legacy/corrupted docs may hold plain day-name strings instead of
          // {day, hour} objects (an admin-side edit bug); handle both so this
          // page never silently renders a blank schedule from either shape.
          const days: DayConfig[] = (sub.days ?? []).map((d: any) => ({
            weekday: typeof d === 'string' ? d : (d?.day ?? d?.dayOfWeek ?? ''),
            hour: (typeof d === 'string' ? undefined : d?.hour) ?? '16:00',
            services: { study: true },
          }));
          setSchedule({ weekPattern: sub.weekPattern ?? 'all', days });
          setNote(sub.note ?? '');
        }
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [user, childId, editId]);

  const studyDays = schedule.days.filter(d => d.services.study);
  const monthlyFee = config ? computeStudyFee(schedule.days, config, schedule.weekPattern) : 0;
  const uncoveredDays = studyDays.filter(d => !transportCoverage.some(c => c.weekday === d.weekday));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !familyId || !config || studyDays.length === 0) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (!editId) {
        const dupSnap = await getDocs(query(col('studyroom'), where('childId', '==', child.id)));
        const hasDup = dupSnap.docs.some(d => {
          const data = d.data();
          return !data.canceled &&
            data.schoolYear === (child.schoolYear || '') &&
            normalizeSubStatus(data.status) !== 'cancelled';
        });
        if (hasDup) {
          setSubmitError('Já existe uma inscrição na Sala de Estudo para este aluno este ano letivo.');
          return;
        }
      }

      const today = new Date();
      const nextJuly = new Date(today.getFullYear() + (today.getMonth() > 5 ? 1 : 0), 6, 31);
      const days = studyDays.map(d => ({ day: d.weekday, hour: d.hour }));

      if (editId) {
        await updateDoc(docRef('studyroom', editId), {
          days,
          weekPattern: schedule.weekPattern,
          monthlyPrice: monthlyFee,
          basePrice: monthlyFee,
          note: note.trim() || null,
          // The parent editing directly (e.g. from an admin-edit review prompt) counts
          // as having acted on it — clear the flag rather than leaving it stuck open.
          // The edit itself is a client-initiated change, so admin gets notified too.
          clientReviewPending: false,
          adminReviewPending: true, lastClientAction: 'edited',
          updatedAt: new Date(),
        });
        navigate(`/client/study/${editId}`, { replace: true });
        return;
      }

      const appliedDiscounts = resolveAutoDiscounts(discountRules, 'study', [], child.schoolName, activeSiblingCount);
      const discountedFee = applyDiscounts(monthlyFee, appliedDiscounts);

      await addDoc(col('studyroom'), {
        familyId,
        userId: user?.uid || '',
        childId: child.id,
        childName: `${child.firstName} ${child.lastName}`,
        studentName: `${child.firstName} ${child.lastName}`,
        schoolName: child.schoolName || '',
        schoolYear: child.schoolYear || '',
        guardianName: user?.name || '',
        email: user?.email || '',
        phone: '',
        days,
        weekPattern: schedule.weekPattern,
        monthlyPrice: discountedFee,
        basePrice: monthlyFee,
        appliedDiscounts,
        note: note.trim() || null,
        startDate: today,
        endDate: nextJuly,
        status: 'pending',
        canceled: false,
        uploadedFiles: [],
        statusHistory: [],
        entryHistory: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (!childId) {
    return (
      <div className="max-w-lg">
        <div className="mb-6">
          <Link to="/client/children" className="text-blue-600 hover:underline text-sm">← Voltar</Link>
          <h1 className="text-2xl font-bold mt-2">Sala de Estudo</h1>
          <p className="text-gray-600 mt-1">Para começar, diga-nos para quem é a inscrição.</p>
        </div>
        <form onSubmit={handleCreateChild} className="space-y-5">
          <EnrollmentDetailsForm value={newChildDetails} onChange={setNewChildDetails} showContactFields={false} errors={newChildErrors} />
          <button type="submit" disabled={creatingChild}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60">
            {creatingChild ? 'A continuar…' : 'Continuar'}
          </button>
        </form>
      </div>
    );
  }
  if (isLoading) return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;

  if (submitted) {
    const DAY_PT: Record<string, string> = { monday: 'Segunda', tuesday: 'Terça', wednesday: 'Quarta', thursday: 'Quinta', friday: 'Sexta' };
    return (
      <div className="max-w-md mx-auto text-center py-12 space-y-4">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold">Pedido enviado!</h2>
        <p className="text-gray-600">
          A inscrição na Sala de Estudo para <strong>{child?.firstName}</strong> foi recebida. A nossa equipa irá confirmar em breve.
        </p>
        {uncoveredDays.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-left">
            <p className="font-semibold text-amber-900 mb-1">Sem transporte em alguns dias</p>
            <p className="text-sm text-amber-800">
              {uncoveredDays.map(d => DAY_PT[d.weekday] ?? d.weekday).join(', ')} — não tens transporte configurado. Queres inscrever?
            </p>
          </div>
        )}
        <div className="flex flex-col gap-3 pt-2">
          {uncoveredDays.length > 0 && (
            <button
              onClick={() => navigate(`/client/enroll/transport?childId=${childId}`)}
              className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700"
            >
              Inscrever no transporte
            </button>
          )}
          <Link
            to="/client/children"
            className={uncoveredDays.length > 0 ? 'text-gray-500 text-sm hover:underline' : 'bg-blue-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-blue-700 inline-block'}
          >
            {uncoveredDays.length > 0 ? 'Fazer mais tarde' : 'Ver as minhas crianças'}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link to={editId ? `/client/study/${editId}` : '/client/children'} className="text-blue-600 hover:underline text-sm">← Voltar</Link>
        <h1 className="text-2xl font-bold mt-2">Sala de Estudo</h1>
        {child && <p className="text-gray-600 mt-1">{editId ? 'Editar pedido de' : 'Inscrição para'} {child.firstName} {child.lastName}</p>}
        {editId && <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-1.5 mt-2 inline-block">A editar pedido pendente</p>}
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <WeekSchedulePicker
          value={schedule}
          onChange={setSchedule}
          availableServices={['study']}
          existingTransportCoverage={transportCoverage}
          studyCenterConfig={config}
        />

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-semibold mb-2">Observações</h2>
          <textarea
            rows={3}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Necessidades especiais, alergias, outras informações..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        <p className="text-xs text-gray-400 text-center px-2">
          O pedido será analisado pela nossa equipa. Receberá uma confirmação após aprovação.
        </p>

        {submitError && (
          <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-center">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || studyDays.length === 0}
          className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? 'A guardar...' : editId ? 'Guardar alterações' : 'Enviar pedido de inscrição'}
        </button>
      </form>
    </div>
  );
}
