import { useState, useEffect, useCallback, useRef } from 'react';
import { getDocs, getDoc } from 'firebase/firestore';
import { col, docRef } from '../../../lib/db';
import { getTransportationConfig } from '../../../services/transportationService';
import { getDiscountRules } from '../../../services/discountService';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { DiscountRule } from '@shared/models/Discount';
import { Child, Family } from '@shared/models';
import { resolvePersonalData } from '../../../lib/personalData';
import { normalizeSubStatus } from '../../../lib/utils';
import { SubItem, FamilyDoc, ChildDoc, BillRow, toDate } from './model';

/**
 * Everything the admin families + subscriptions page shows, read once.
 *
 * The page does not live-update: it reads every subscription, child, family
 * and bill up front (tens to low hundreds of documents in prod) and filters in
 * the browser. After an action whose effect lands via a backend trigger, call
 * `reload()`.
 */
export function useAdminData() {
  const [items, setItems] = useState<SubItem[]>([]);
  const [families, setFamilies] = useState<Map<string, FamilyDoc>>(new Map());
  const [children, setChildren] = useState<Map<string, ChildDoc>>(new Map());
  const [bills, setBills] = useState<BillRow[]>([]);
  const [transportConfig, setTransportConfig] = useState<TransportationConfig | null>(null);
  const [studyConfig, setStudyConfig] = useState<StudyCenterConfig | null>(null);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // A reload after the first one refreshes in place: blanking the page would
  // close the family panel and drop whatever form was open in it.
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnce = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (loadedOnce.current) setRefreshing(true); else setIsLoading(true);
    setError(null);
    try {
      const [studySnap, transportSnap, childrenSnap, familiesSnap, billingSnap, cfg, studyCfgSnap, rules] = await Promise.all([
        getDocs(col('studyroom')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('children')),
        getDocs(col('families')),
        getDocs(col('billing')),
        getTransportationConfig(),
        getDoc(docRef('config', 'studyCenter')),
        getDiscountRules(),
      ]);
      if (cfg) setTransportConfig(cfg);
      if (studyCfgSnap.exists()) setStudyConfig(studyCfgSnap.data() as StudyCenterConfig);
      setDiscountRules(rules ?? []);

      setFamilies(new Map(familiesSnap.docs.map(d => [d.id, { ...d.data(), id: d.id } as FamilyDoc])));
      setChildren(new Map(childrenSnap.docs.map(d => [d.id, { ...d.data(), id: d.id } as ChildDoc])));
      setBills(billingSnap.docs.map(d => {
        const x = d.data();
        const start = x.periodStart ? toDate(x.periodStart) : null;
        return {
          id: d.id,
          familyId: x.familyId ?? '',
          status: x.status ?? '',
          total: x.total ?? 0,
          periodLabel: x.periodLabel ?? '',
          periodKey: start ? `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}` : (x.periodLabel ?? ''),
          dueDate: x.dueDate ? toDate(x.dueDate) : undefined,
          invoiceError: x.invoiceError || undefined,
          invoiceNumber: x.invoiceNumber || undefined,
          easypayId: x.easypayId || undefined,
          duplicatePaymentEasypayIds: x.duplicatePaymentEasypayIds?.length ? x.duplicatePaymentEasypayIds : undefined,
        };
      }));

      // Personal data (child name, school, guardian contact) is resolved from
      // these two collections, not from each subscription's own denormalized
      // copies — a child's details then appear once, identically, on every
      // subscription they hold, instead of once per subscription with the two
      // free to disagree (which is what had happened in prod: 5 of 10
      // dual-service children had two different schoolName values, two of them
      // street addresses). See lib/personalData.ts.
      const childMap = new Map<string, Child>(
        childrenSnap.docs.map(d => [d.id, { ...d.data(), id: d.id } as Child]),
      );
      const familyMap = new Map<string, Family>(
        familiesSnap.docs.map(d => [d.id, { ...d.data(), id: d.id } as Family]),
      );
      const personFor = (x: any) => resolvePersonalData(
        x.childId ? childMap.get(x.childId) : null,
        x.familyId ? familyMap.get(x.familyId) : null,
        { ...x, childName: x.childName ?? x.studentName },
      );
      const study: SubItem[] = studySnap.docs.map(d => {
        const x = d.data();
        const person = personFor(x);
        return {
          id: d.id, _type: 'study',
          childName: person.childName || '—',
          childId: x.childId || undefined,
          familyId: x.familyId,
          contactName: person.contactName,
          contactEmail: person.contactEmail,
          contactPhone: person.contactPhone,
          source: x.source,
          schoolName: person.schoolName, schoolYear: person.schoolYear,
          days: x.days || [], monthlyPrice: x.monthlyPrice ?? x.basePrice ?? 0,
          basePrice: x.basePrice ?? x.monthlyPrice ?? 0,
          returningStudent: x.returningStudent ?? false,
          appliedDiscounts: x.appliedDiscounts ?? [],
          discountOverrides: x.discountOverrides,
          weekPattern: x.weekPattern ?? 'all',
          status: normalizeSubStatus(x.status),
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested, legacyPricing: x.legacyPricing,
          feeReviewRequired: x.feeReviewRequired ?? false,
          clientReviewPending: x.clientReviewPending ?? x.needsClientReview ?? false,
          adminReviewPending: x.adminReviewPending ?? false,
          lastClientAction: x.lastClientAction,
        };
      });
      const transport: SubItem[] = transportSnap.docs.map(d => {
        const x = d.data();
        const person = personFor(x);
        return {
          id: d.id, _type: 'transport',
          childName: person.childName || '—',
          childId: x.childId || undefined,
          familyId: x.familyId,
          contactName: person.contactName,
          contactEmail: person.contactEmail, contactPhone: person.contactPhone,
          source: x.source,
          schoolName: person.schoolName, schoolYear: person.schoolYear,
          schedule: x.schedule || [], monthlyFee: x.monthlyFee ?? 0,
          routeAssigned: x.routeAssigned ?? false,
          originalFee: x.originalFee ?? x.monthlyFee ?? 0,
          returningStudent: x.returningStudent ?? false,
          appliedDiscounts: x.appliedDiscounts ?? [],
          discountOverrides: x.discountOverrides,
          weekPattern: x.weekPattern ?? 'all',
          status: normalizeSubStatus(x.status),
          statusReason: x.statusReason, note: x.note,
          createdAt: toDate(x.createdAt), cancelRequested: x.cancelRequested, legacyPricing: x.legacyPricing,
          feeReviewRequired: x.feeReviewRequired ?? false,
          clientReviewPending: x.clientReviewPending ?? x.needsClientReview ?? false,
          adminReviewPending: x.adminReviewPending ?? false,
          lastClientAction: x.lastClientAction,
        };
      });
      setItems([...study, ...transport].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
    } catch (err: any) {
      setError(err?.message || 'Erro ao carregar inscrições.');
    } finally {
      loadedOnce.current = true;
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return {
    items, setItems, families, setFamilies, children, bills, setBills,
    transportConfig, studyConfig, discountRules,
    isLoading, refreshing, error, reload,
  };
}

export type AdminData = ReturnType<typeof useAdminData>;
