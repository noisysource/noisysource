// apps/finhub/src/lib/templatesApi.ts
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  serverTimestamp, Timestamp, QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '@shared/firebase';
import type { PlannedTransactionTemplate, TemplateShape } from '@shared/models/Ledger';
import { toDate } from './utils';

// --- helper: deep prune undefined (keeps Date/Timestamp as-is)
function pruneUndefined<T>(v: T): T {
  if (v === undefined || v === null) return v;
  if (v instanceof Date) return v as T;
  // @ts-ignore - Firestore Timestamp type guard
  if (v?.toDate && typeof v.toDate === 'function') return v; // Timestamp
  if (Array.isArray(v)) return v.map(pruneUndefined) as any;
  if (typeof v === 'object') {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) out[k] = pruneUndefined(val as any);
    }
    return out;
  }
  return v;
}

const tplCol = (orgId: string) => collection(db, 'orgs', orgId, 'templates');
const tplDoc = (orgId: string, id: string) => doc(db, 'orgs', orgId, 'templates', id);

function serializeShape(shape: TemplateShape): any {
  return shape;
}

function parseShape(raw: any): TemplateShape {
  return raw as TemplateShape;
}

function serializeTemplate(input: Omit<PlannedTransactionTemplate, 'id' | 'createdAt'>) {
  const rec = {
    frequency: input.recurrence.frequency,
    interval: input.recurrence.interval,
    // include only if present
    dayOfMonth: input.recurrence.dayOfMonth,
    dayOfWeek: input.recurrence.dayOfWeek,
    endDate: input.recurrence.endDate
      ? Timestamp.fromDate(
          input.recurrence.endDate instanceof Date
            ? input.recurrence.endDate
            : new Date(input.recurrence.endDate)
        )
      : undefined,
  };

  const payload = pruneUndefined({
    ...input,
    dateAnchor: Timestamp.fromDate(
      input.dateAnchor instanceof Date ? input.dateAnchor : new Date(input.dateAnchor)
    ),
    shape: serializeShape(input.shape),
    recurrence: rec,
    createdAt: serverTimestamp(),
  });

  return payload;
}

function parseTemplateSnap(s: QueryDocumentSnapshot): PlannedTransactionTemplate {
  const d = s.data() as any;
  return {
    id: s.id,
    orgId: d.orgId,
    label: d.label,
    kind: d.kind,
    currency: d.currency,
    dateAnchor: toDate(d.dateAnchor),
    recurrence: {
      frequency: d.recurrence?.frequency,
      interval: d.recurrence?.interval,
      dayOfMonth: d.recurrence?.dayOfMonth,
      dayOfWeek: d.recurrence?.dayOfWeek,
      endDate: d.recurrence?.endDate ? toDate(d.recurrence.endDate) : undefined,
    },
    shape: parseShape(d.shape),
    tags: d.tags ?? [],
    active: Boolean(d.active),
    createdBy: d.createdBy,
    createdAt: toDate(d.createdAt),
  };
}

export async function listTemplates(orgId: string): Promise<PlannedTransactionTemplate[]> {
  const snap = await getDocs(tplCol(orgId));
  return snap.docs.map(parseTemplateSnap);
}

export async function createTemplate(
  orgId: string,
  data: Omit<PlannedTransactionTemplate, 'id' | 'createdAt'>
): Promise<PlannedTransactionTemplate> {
  const ref = await addDoc(tplCol(orgId), serializeTemplate(data));
  const all = await listTemplates(orgId);
  return all.find(t => t.id === ref.id)!;
}

export async function updateTemplate(
  orgId: string,
  id: string,
  data: Omit<PlannedTransactionTemplate, 'id' | 'createdAt'>
): Promise<void> {
  const payload = pruneUndefined({
    ...data,
    dateAnchor:
      data.dateAnchor instanceof Date
        ? Timestamp.fromDate(data.dateAnchor)
        : Timestamp.fromDate(new Date(data.dateAnchor)),
    shape: serializeShape(data.shape),
    // do not include createdAt on update
    recurrence: pruneUndefined({
      frequency: data.recurrence.frequency,
      interval: data.recurrence.interval,
      dayOfMonth: data.recurrence.dayOfMonth,
      dayOfWeek: data.recurrence.dayOfWeek,
      endDate: data.recurrence.endDate
        ? Timestamp.fromDate(
            data.recurrence.endDate instanceof Date
              ? data.recurrence.endDate
              : new Date(data.recurrence.endDate)
          )
        : undefined,
    }),
  });
  await updateDoc(tplDoc(orgId, id), payload);
}

export async function deleteTemplateById(orgId: string, id: string): Promise<void> {
  await deleteDoc(tplDoc(orgId, id));
}