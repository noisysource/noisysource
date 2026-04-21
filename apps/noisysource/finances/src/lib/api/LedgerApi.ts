import { httpsCallable } from 'firebase/functions';
import { functions } from '@shared/firebase';

export type ExpandInput = {
  orgId: string;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  templateIds?: string[];
  dryRun?: boolean;
};

export type ExpandResult = {
  created: number;
  upserted: number;
  skipped: number;
  total: number;
  samples: string[];
  dryRun?: boolean;
};

export async function expandTemplatesInRange(
  args: { orgId: string; from: string; to: string; templateIds?: string[]; dryRun?: boolean; }
): Promise<{ upserted: number; created: number; skipped: number; samples: string[]; skippedDetails?: string[]; dryRun?: boolean; }> {
  const call = httpsCallable(functions, 'expandTemplatesInRange');
  const res = await call(args);
  return res.data as any;
}

export type PostInput = {
  orgId: string;
  instanceId: string;      // this is the Firestore doc id (already with underscores)
  cashAccountId: string;   // e.g. 'bank_main'
  createdBy: string;       // your user.uid
  postDate?: string;       // YYYY-MM-DD (optional)
};

export type PostResult = { ledgerId: string; idempotencyKey: string };

export async function postPlannedInstance(input: PostInput) {
  const call = httpsCallable(functions, 'postPlannedInstance');
  const res = await call(input);
  return res.data as PostResult;
}