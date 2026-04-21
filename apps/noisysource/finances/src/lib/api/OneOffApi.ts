import { doc, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '@shared/firebase';
import type { TemplateKind, TemplateShape, PlannedTransactionInstance } from '@shared/models/Ledger';

export type OneOffInput = {
  orgId: string;
  label: string;
  date: Date;
  currency: string;
  kind: TemplateKind;
  shape: TemplateShape;
  // required only for 'single' (ignored by transfer/split)
  cashAccountId?: string;
  createdBy: string;
};

function newId(prefix = 'oneoff'): string {
  // id-safe; pairs nicely with func’s idempotency
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${nonce}`;
}

export async function postOneOff(input: OneOffInput) {
  const {
    orgId, label, date, currency, kind, shape, createdBy, cashAccountId,
  } = input;

  if (kind === 'single' && !cashAccountId) {
    throw new Error('Choose a cash/bank account for Single one-offs');
  }

  // Build an ephemeral planned instance (so we can reuse the existing Cloud Function)
  const id = newId();
  const idempotencyKey = id; // fine for one-offs
  const inst: Omit<PlannedTransactionInstance, 'id'> & { id: string } = {
    id,
    templateId: 'oneoff',
    orgId,
    label,
    kind,
    currency,
    date,
    status: 'draft',
    shape,
    idempotencyKey,
  };

  // Upsert the doc so the function can read it by id
  const ref = doc(db, 'orgs', orgId, 'plannedInstances', id);
  await setDoc(ref, {
    ...inst,
    // Firestore will store Dates as Timestamps; server will handle either
    createdAt: new Date(),
  }, { merge: true });

  // Call existing onCall to post it
  const call = httpsCallable(functions, 'postPlannedInstance');
  const res = await call({
    orgId,
    instanceId: id,
    cashAccountId: cashAccountId ?? 'ignored-for-transfer-or-split',
    createdBy,
    postDate: inst.date.toISOString().slice(0, 10),
  });

  return res.data as { ledgerId: string; idempotencyKey: string };
}