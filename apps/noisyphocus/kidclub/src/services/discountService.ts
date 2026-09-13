import { getDoc, setDoc } from 'firebase/firestore';
import { docRef } from '../lib/db';
import { DiscountRule } from '@shared/models/Discount';

// Pure logic lives in shared so the Cloud Function can use the same code
export { resolveAutoDiscounts, applyDiscounts, grossFromAppliedDiscounts } from '@shared/models/discountLogic';
export type { DayLike } from '@shared/models/discountLogic';

const CONFIG_DOC = 'discounts';

export const getDiscountRules = async (): Promise<DiscountRule[]> => {
  const snap = await getDoc(docRef('config', CONFIG_DOC));
  if (!snap.exists()) return [];
  return (snap.data().rules ?? []) as DiscountRule[];
};

const stripUndefined = <T extends object>(obj: T): T =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;

export const saveDiscountRules = async (rules: DiscountRule[]): Promise<void> => {
  await setDoc(docRef('config', CONFIG_DOC), { rules: rules.map(stripUndefined), updatedAt: new Date() }, { merge: true });
};
