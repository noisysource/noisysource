import { collection, doc, getDocs, orderBy, query } from 'firebase/firestore';
import { db } from '@shared/firebase';
import type { KidclubBillingRecord } from '@shared/lib/eventGenerators';

const kidclubRoot = () => doc(db, '_apps', 'arcoiris');

export function makeKidclubDomain() {
  return {
    async listBilling(): Promise<KidclubBillingRecord[]> {
      const snap = await getDocs(
        query(collection(kidclubRoot(), 'billing'), orderBy('dueDate', 'desc')),
      );
      return snap.docs.map(d => ({ id: d.id, ...d.data() } as KidclubBillingRecord));
    },
  };
}
