import {
  collection, doc, addDoc, updateDoc, getDocs, getDoc,
  query, where, orderBy, serverTimestamp, type QueryConstraint,
} from 'firebase/firestore';
import { db } from '../../firebase';
import type { FinanceEvent, FinanceEntityId, FinanceEventType, FinanceEventStatus } from '@shared/models/FinanceEvent';
import { toDate } from '../utils';

const COLLECTION = 'finances_events';
const col = () => collection(db, COLLECTION);
const docRef = (id: string) => doc(db, COLLECTION, id);

type EventSave = Omit<FinanceEvent, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

function from(raw: any, id: string): FinanceEvent {
  return {
    id,
    entityId: raw?.entityId as FinanceEntityId,
    type: raw?.type as FinanceEventType,
    date: raw?.date ?? '',
    amountCents: raw?.amountCents ?? 0,
    status: (raw?.status ?? 'planned') as FinanceEventStatus,
    description: raw?.description || undefined,
    accountId: raw?.accountId || undefined,
    toAccountId: raw?.toAccountId || undefined,
    categoryId: raw?.categoryId || undefined,
    sourceType: raw?.sourceType || undefined,
    sourceId: raw?.sourceId || undefined,
    tags: Array.isArray(raw?.tags) ? raw.tags : undefined,
    metadata: raw?.metadata || undefined,
    correctedBy: raw?.correctedBy || undefined,
    createdAt: toDate(raw?.createdAt) ?? undefined,
    updatedAt: toDate(raw?.updatedAt) ?? undefined,
  };
}

function stripUndefined(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out;
  }
  return obj;
}

export function makeFinanceEventsDomain() {
  async function listByDateRange(from_: string, to_: string): Promise<FinanceEvent[]> {
    const snap = await getDocs(
      query(col(), orderBy('date'), where('date', '>=', from_), where('date', '<=', to_))
    );
    return snap.docs.map(d => from(d.data(), d.id));
  }

  async function listByEntity(entityId: FinanceEntityId, constraints?: QueryConstraint[]): Promise<FinanceEvent[]> {
    const q = query(col(), where('entityId', '==', entityId), ...(constraints ?? []));
    const snap = await getDocs(q);
    return snap.docs
      .map(d => from(d.data(), d.id))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async function listAll(constraints?: QueryConstraint[]): Promise<FinanceEvent[]> {
    const q = constraints?.length ? query(col(), ...constraints) : col();
    const snap = await getDocs(q as any);
    return snap.docs
      .map(d => from(d.data(), d.id))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async function get(id: string): Promise<FinanceEvent | undefined> {
    const d = await getDoc(docRef(id));
    if (!d.exists()) return undefined;
    return from(d.data(), d.id);
  }

  async function save(input: EventSave): Promise<string> {
    const { id, ...rest } = input;
    const payload = stripUndefined(rest);
    if (id) {
      await updateDoc(docRef(id), { ...payload, updatedAt: serverTimestamp() });
      return id;
    }
    const ref = await addDoc(col(), { ...payload, createdAt: serverTimestamp() });
    return ref.id;
  }

  /** Immutable correction: mark original as corrected, save a new event */
  async function correct(originalId: string, corrected: Omit<EventSave, 'id'>): Promise<string> {
    const newId = await save(corrected);
    await updateDoc(docRef(originalId), {
      status: 'corrected' as FinanceEventStatus,
      correctedBy: newId,
      updatedAt: serverTimestamp(),
    });
    return newId;
  }

  async function cancel(id: string): Promise<void> {
    await updateDoc(docRef(id), { status: 'cancelled' as FinanceEventStatus, updatedAt: serverTimestamp() });
  }

  async function confirm(id: string): Promise<void> {
    await updateDoc(docRef(id), { status: 'confirmed' as FinanceEventStatus, updatedAt: serverTimestamp() });
  }

  return { listByDateRange, listByEntity, listAll, get, save, correct, cancel, confirm };
}
