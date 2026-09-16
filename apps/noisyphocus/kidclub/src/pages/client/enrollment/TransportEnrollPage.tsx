import { useState, useEffect } from 'react';
import { useSearchParams, Navigate, Link, useNavigate } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child } from '@shared/models';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { familyService } from '../../../services/familyService';
import { getTransportationConfig } from '../../../services/transportationService';
import { studyRoomService } from '../../../services/studyRoomService';
import { addDoc, getDoc, updateDoc, writeBatch, doc, getDocs, query, where } from 'firebase/firestore';
import { col, docRef } from '../../../lib/db';
import { db } from '../../../lib/firebase';
import { activeWeeksInPattern } from '@shared/models/weekPattern';
import WeekSchedulePicker, { WeekScheduleValue, DayConfig } from '../../../components/WeekSchedulePicker';
import { DiscountRule } from '@shared/models/Discount';
import { getDiscountRules, resolveAutoDiscounts, applyDiscounts } from '../../../services/discountService';
import EnrollmentDetailsForm, { EnrollmentDetailsValue, EMPTY_ENROLLMENT_DETAILS, validateEnrollmentDetails } from '../../../components/EnrollmentDetailsForm';
import { calculateAge } from '../../../lib/utils';

function computeTransportFee(
  days: DayConfig[],
  cfg: TransportationConfig,
  weekPattern: WeekScheduleValue['weekPattern'],
  discountRules: DiscountRule[],
  schoolName?: string,
  activeSiblingCount?: number,
): number {
  const totalTrips = days.reduce((sum, d) => sum + (d.services.transportTrips?.length ?? 0), 0);
  const weeks = activeWeeksInPattern(weekPattern);
  const gross = totalTrips * cfg.flatRatePerTrip * weeks;
  const resolved = resolveAutoDiscounts(discountRules, 'transport', days, schoolName, activeSiblingCount);
  return applyDiscounts(gross, resolved);
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

export default function TransportEnrollPage() {
  const user = useUser();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const childId = searchParams.get('childId');
  const editId = searchParams.get('editId');

  const [child, setChild] = useState<Child | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const [tConfig, setTConfig] = useState<TransportationConfig | null>(null);
  const [sConfig, setSConfig] = useState<StudyCenterConfig | null>(null);
  const [activeSiblingCount, setActiveSiblingCount] = useState(0);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
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
      navigate(`/client/enroll/transport?childId=${newChildId}`, { replace: true });
    } finally {
      setCreatingChild(false);
    }
  };

  const [schedule, setSchedule] = useState<WeekScheduleValue>({
    weekPattern: 'all',
    days: [],
  });

  useEffect(() => {
    if (!user || !childId) return;
    const load = async () => {
      setIsLoading(true);
      try {
        const promises: Promise<any>[] = [
          familyService.getOrCreateFamily(user.uid, user.name || '', user.email || ''),
          familyService.getChild(childId),
          getTransportationConfig(),
          studyRoomService.getStudyCenterConfig(),
          getDiscountRules(),
        ];
        if (editId) promises.push(getDoc(docRef('transportationSubscriptions', editId)));
        const [fam, c, cfg, sCfg, rules, existingSnap] = await Promise.all(promises);
        setFamilyId(fam.id);
        setChild(c);
        setTConfig(cfg);
        setSConfig(sCfg);
        setDiscountRules(rules ?? []);

        // Count siblings across both services (any non-cancelled status) for sibling discount preview
        try {
          const [tSibSnap, sSibSnap] = await Promise.all([
            getDocs(query(col('transportationSubscriptions'), where('familyId', '==', fam.id))),
            getDocs(query(col('studyroom'), where('familyId', '==', fam.id))),
          ]);
          const CANCELLED = new Set(['cancelled', 'canceled']);
          const siblingChildIds = new Set<string>();
          for (const d of [...tSibSnap.docs, ...sSibSnap.docs]) {
            const x = d.data();
            if (!CANCELLED.has(x.status) && x.childId && x.childId !== childId) {
              siblingChildIds.add(x.childId);
            }
          }
          setActiveSiblingCount(siblingChildIds.size);
        } catch {
          // Firestore rules may not permit this query — sibling discount silently unavailable
        }

        if (existingSnap?.exists()) {
          const sub = existingSnap.data();
          const dayMap: Record<string, DayConfig> = {};
          for (const s of (sub.schedule ?? [])) {
            if (!dayMap[s.dayOfWeek]) {
              dayMap[s.dayOfWeek] = { weekday: s.dayOfWeek, hour: '17:00', services: { transportTrips: [] } };
            }
            dayMap[s.dayOfWeek].services.transportTrips!.push({
              time: s.pickupTime ?? '08:00',
              pickupAddress: s.pickupLocation ?? '',
              dropoffAddress: s.dropoffLocation ?? '',
            });
          }
          setSchedule({ weekPattern: sub.weekPattern ?? 'all', days: Object.values(dayMap) });
        }
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [user, childId, editId]);

  const transportDays = schedule.days.filter(d => (d.services.transportTrips?.length ?? 0) > 0);
  const studyDays = schedule.days.filter(d => d.services.study);
  const tFee = tConfig ? computeTransportFee(schedule.days, tConfig, schedule.weekPattern, discountRules, child?.schoolName, activeSiblingCount) : 0;
  const sFee = sConfig && studyDays.length > 0 ? computeStudyFee(schedule.days, sConfig, schedule.weekPattern) : 0;

  const isValid = transportDays.length > 0 &&
    transportDays.every(d => d.services.transportTrips!.every(
      t => t.pickupAddress.trim() && t.dropoffAddress.trim()
    ));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!child || !familyId || !tConfig || !isValid) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (!editId) {
        const [tDupSnap, sDupSnap] = await Promise.all([
          getDocs(query(col('transportationSubscriptions'), where('childId', '==', child.id))),
          studyDays.length > 0 ? getDocs(query(col('studyroom'), where('childId', '==', child.id))) : Promise.resolve(null),
        ]);
        const hasTransportDup = tDupSnap.docs.some(d => {
          const data = d.data();
          return ['pending', 'confirmed', 'active', 'planned', 'offered'].includes(data.status);
        });
        const hasStudyDup = sDupSnap?.docs.some(d => {
          const data = d.data();
          return !data.canceled &&
            data.schoolYear === (child.schoolYear || '') &&
            ['pending', 'confirmed', 'active', 'planned', 'offered'].includes(data.status);
        });
        if (hasTransportDup) {
          setSubmitError('Já existe uma inscrição de transporte ativa para este aluno.');
          return;
        }
        if (hasStudyDup) {
          setSubmitError('Já existe uma inscrição na Sala de Estudo para este aluno este ano letivo.');
          return;
        }
      }

      const today = new Date();
      const nextJuly = new Date(today.getFullYear() + (today.getMonth() > 5 ? 1 : 0), 6, 31);

      const transportSchedule = transportDays.flatMap(d =>
        d.services.transportTrips!.map(t => ({
          dayOfWeek: d.weekday,
          pickupTime: t.time,
          pickupLocation: t.pickupAddress,
          dropoffLocation: t.dropoffAddress,
        }))
      );

      const appliedDiscounts = resolveAutoDiscounts(discountRules, 'transport', transportDays, child?.schoolName, activeSiblingCount);

      if (editId) {
        await updateDoc(docRef('transportationSubscriptions', editId), {
          schedule: transportSchedule,
          weekPattern: schedule.weekPattern,
          monthlyFee: tFee,
          appliedDiscounts,
          // The parent editing directly (e.g. from an admin-edit review prompt) counts
          // as having acted on it — clear the flag rather than leaving it stuck open.
          needsClientReview: false,
          updatedAt: new Date(),
        });
        navigate(`/client/transport/${editId}`, { replace: true });
        return;
      }

      // If study days also selected, batch-create both subscriptions atomically
      if (studyDays.length > 0 && sConfig) {
        const batch = writeBatch(db);
        const tRef = doc(col('transportationSubscriptions'));
        const sRef = doc(col('studyroom'));

        batch.set(tRef, {
          familyId, userId: user?.uid || '', childId: child.id,
          childName: `${child.firstName} ${child.lastName}`,
          childAge: child.age || 0,
          contactMobile: '', contactEmail: user?.email || '',
          startDate: today.toISOString().split('T')[0],
          endDate: nextJuly.toISOString().split('T')[0],
          status: 'pending', monthlyFee: tFee, weekPattern: schedule.weekPattern,
          schedule: transportSchedule, appliedDiscounts,
          createdAt: new Date(), updatedAt: new Date(),
        });

        batch.set(sRef, {
          familyId, userId: user?.uid || '', childId: child.id,
          childName: `${child.firstName} ${child.lastName}`,
          studentName: `${child.firstName} ${child.lastName}`,
          schoolName: child.schoolName || '', schoolYear: child.schoolYear || '',
          guardianName: user?.name || '', email: user?.email || '', phone: '',
          days: studyDays.map(d => ({ day: d.weekday, hour: d.hour })),
          weekPattern: schedule.weekPattern,
          monthlyPrice: sFee, basePrice: sFee,
          startDate: today, endDate: nextJuly,
          status: 'pending', canceled: false,
          uploadedFiles: [], statusHistory: [], entryHistory: [],
          createdAt: new Date(), updatedAt: new Date(),
        });

        await batch.commit();
      } else {
        await addDoc(col('transportationSubscriptions'), {
          familyId, userId: user?.uid || '', childId: child.id,
          childName: `${child.firstName} ${child.lastName}`,
          childAge: child.age || 0,
          contactMobile: '', contactEmail: user?.email || '',
          startDate: today.toISOString().split('T')[0],
          endDate: nextJuly.toISOString().split('T')[0],
          status: 'pending', monthlyFee: tFee, weekPattern: schedule.weekPattern,
          schedule: transportSchedule, appliedDiscounts,
          createdAt: new Date(), updatedAt: new Date(),
        });
      }

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
          <h1 className="text-2xl font-bold mt-2">Transporte Escolar</h1>
          <p className="text-gray-600 mt-1">Para começar, diga-nos para quem é a inscrição.</p>
        </div>
        <form onSubmit={handleCreateChild} className="space-y-5">
          <EnrollmentDetailsForm value={newChildDetails} onChange={setNewChildDetails} showContactFields={false} errors={newChildErrors} />
          <button type="submit" disabled={creatingChild}
            className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 disabled:opacity-60">
            {creatingChild ? 'A continuar…' : 'Continuar'}
          </button>
        </form>
      </div>
    );
  }
  if (isLoading) return <div className="flex justify-center items-center h-64 text-gray-500">A carregar...</div>;

  if (submitted) {
    return (
      <div className="max-w-md mx-auto text-center py-12 space-y-4">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold">Pedido enviado!</h2>
        <p className="text-gray-600">
          O pedido de transporte para <strong>{child?.firstName}</strong> foi recebido.
          {studyDays.length > 0 && ' A inscrição na Sala de Estudo também foi registada.'}
          {' '}A nossa equipa irá confirmar em breve.
        </p>
        <Link to="/client/children" className="bg-green-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-green-700 inline-block">
          Ver as minhas crianças
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <Link to={editId ? `/client/transport/${editId}` : '/client/children'} className="text-blue-600 hover:underline text-sm">← Voltar</Link>
        <h1 className="text-2xl font-bold mt-2">Transporte Escolar</h1>
        {child && <p className="text-gray-600 mt-1">{editId ? 'Editar pedido de' : 'Inscrição para'} {child.firstName} {child.lastName}</p>}
        {editId && <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-1.5 mt-2 inline-block">A editar pedido pendente</p>}
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <WeekSchedulePicker
          value={schedule}
          onChange={setSchedule}
          availableServices={['transport', 'study']}
          studyCenterConfig={sConfig}
          transportConfig={tConfig}
          discountRules={discountRules}
          schoolName={child?.schoolName}
          activeSiblingCount={activeSiblingCount}
        />

        {transportDays.length > 0 && !isValid && (
          <p className="text-sm text-red-500 text-center">Preenche a origem e o destino em todas as viagens.</p>
        )}

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
          disabled={submitting || !isValid}
          className="w-full bg-green-600 text-white py-3 rounded-xl font-semibold hover:bg-green-700 disabled:opacity-60"
        >
          {submitting ? 'A guardar...' : editId ? 'Guardar alterações' : 'Enviar pedido de inscrição'}
        </button>
      </form>
    </div>
  );
}
