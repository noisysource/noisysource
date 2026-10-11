import { where } from "firebase/firestore";
import { makeOrgCRUD } from "./base";
import type { RecurringEntryDoc, RecurringType, RecurringFrequency } from "@shared/models/RecurringEntry";
import { toDate } from "../utils";

type RecurringSave = Omit<RecurringEntryDoc, "id" | "createdAt"> & { id?: string };

const from = (raw: any, id: string): RecurringEntryDoc => ({
  id,
  type: raw?.type as RecurringType,
  description: raw?.description ?? "",
  amountCents: raw?.amountCents ?? 0,
  accountId: raw?.accountId || undefined,
  toAccountId: raw?.toAccountId || undefined,
  categoryId: raw?.categoryId || undefined,
  frequency: (raw?.frequency ?? "monthly") as RecurringFrequency,
  dayOfMonth: raw?.dayOfMonth ?? 1,
  monthOfYear: raw?.monthOfYear || undefined,
  startYearMonth: raw?.startYearMonth || undefined,
  endYearMonth: raw?.endYearMonth || undefined,
  onceYearMonth: raw?.onceYearMonth || undefined,
  active: raw?.active !== false,
  sourceId: raw?.sourceId || undefined,
  reimbursable: raw?.reimbursable === true,
  paidByAccountId: raw?.paidByAccountId || undefined,
  lastReimbursedYM: raw?.lastReimbursedYM || undefined,
  ivaRatePct: typeof raw?.ivaRatePct === 'number' ? raw.ivaRatePct : undefined,
  costModel: raw?.costModel === 'commission' ? 'commission' : undefined,
  commissionPct: typeof raw?.commissionPct === 'number' ? raw.commissionPct : undefined,
  commissionVolumeSource: raw?.commissionVolumeSource === 'kidclub_billing' ? 'kidclub_billing' : undefined,
  createdAt: toDate(raw?.createdAt) ?? undefined,
});

export function makeRecurringDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<RecurringSave, RecurringEntryDoc>(getOrgId, {
    collectionPath: "recurring",
    from,
    sort: (a, b) => a.description.localeCompare(b.description),
  });

  return {
    ...base,

    async listActive(): Promise<RecurringEntryDoc[]> {
      return base.list([where("active", "==", true)]);
    },

    async upsertBySourceId(sourceId: string, data: Omit<RecurringSave, "id">): Promise<string> {
      const existing = await base.list([where("sourceId", "==", sourceId)]);
      return base.save({ ...data, id: existing[0]?.id } as RecurringSave);
    },

    async deactivateBySourceId(sourceId: string): Promise<void> {
      const existing = await base.list([where("sourceId", "==", sourceId)]);
      await Promise.all(existing.map(r => base.update(r.id, { active: false } as any)));
    },
  };
}
