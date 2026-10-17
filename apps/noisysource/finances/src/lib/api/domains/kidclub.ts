import { collection, doc, getDocs, orderBy, query } from 'firebase/firestore';
import { db } from '@shared/firebase';
import type { KidclubBillingRecord } from '@shared/lib/eventGenerators';

const kidclubRoot = () => doc(db, '_apps', 'arcoiris');

export function makeKidclubDomain() {
  const listBilling = async (): Promise<KidclubBillingRecord[]> => {
    const snap = await getDocs(
      query(collection(kidclubRoot(), 'billing'), orderBy('dueDate', 'desc')),
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as KidclubBillingRecord));
  };

  return {
    listBilling,

    /**
     * Total processed (paid/invoiced) KidClub billing volume for a given
     * "YYYY-MM", in cents. Used as the volume base for commission-model
     * recurring costs (e.g. EasyPay's payment-processing fee) — see
     * RecurringEntry.ts `recurringMonthlyAmountCents`.
     *
     * Mirrors the paid/invoiced handling in
     * `packages/shared/lib/eventGenerators.ts` generateKidclubEvents: only
     * records confirmed as settled (paidAt set, status paid/invoiced) count
     * as real volume — pending/processing records aren't "processed" yet.
     */
    async monthlyProcessedVolumeCents(yearMonth: string): Promise<number> {
      const records = await listBilling();
      let totalCents = 0;
      for (const r of records) {
        if (r.status !== 'paid' && r.status !== 'invoiced') continue;
        const d = r.paidAt?.toDate?.();
        if (!d) continue;
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (ym !== yearMonth) continue;
        totalCents += Math.round((r.total ?? 0) * 100);
      }
      return totalCents;
    },
  };
}
