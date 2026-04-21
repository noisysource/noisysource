// apps/finhub/src/lib/api/domains/planned.ts
import { where, orderBy, Timestamp } from "firebase/firestore";
import { makeOrgCRUD } from "./base";
import { toDate } from "../utils";
import { stripUndefined } from "../crud";


export type PlannedKind = "single" | "transfer" | "split";
export type PlannedStatus = "draft" | "posted";

export type PlannedLine = {
  accountId?: string;
  amountCents: number;
  label?: string;
  categoryId?: string;
};

export type PlannedInstance = {
  id: string;
  label: string;
  kind: PlannedKind;
  currency: string;
  date: Date;
  status: PlannedStatus;
  amountCents?: number;
  fromAccountId?: string;
  toAccountId?: string;
  lines?: PlannedLine[];
  meta?: Record<string, any>;
  createdAt?: Date;
};

export type PlannedSaveInput = Omit<PlannedInstance, "id" | "date" | "createdAt"> & {
  id?: string;
  date: Date | string;
};

const from = (raw: any, id: string): PlannedInstance => ({
  id,
  label: raw?.label ?? id,
  kind: raw?.kind,
  currency: raw?.currency ?? "EUR",
  date: toDate(raw?.date)!,
  status: raw?.status ?? "draft",
  amountCents: Number.isFinite(raw?.amountCents) ? raw.amountCents : undefined,
  fromAccountId: raw?.fromAccountId || undefined,
  toAccountId: raw?.toAccountId || undefined,
  lines: Array.isArray(raw?.lines)
    ? raw.lines.map((l: any) =>
      stripUndefined({
        accountId: l?.accountId || undefined,
        amountCents: Number(l?.amountCents) || 0,
        label: l?.label || undefined,
        categoryId: l?.categoryId || undefined,
      })
    )
    : undefined,
  meta: raw?.meta || undefined,
  createdAt: toDate(raw?.createdAt),
});

const to = (doc: PlannedSaveInput) => stripUndefined({
  label: doc.label,
  kind: doc.kind,
  currency: doc.currency ?? "EUR",
  date: Timestamp.fromDate(new Date(doc.date)),
  status: doc.status ?? "draft",
  amountCents: doc.amountCents,
  fromAccountId: doc.fromAccountId || undefined,
  toAccountId: doc.toAccountId || undefined,
  lines: Array.isArray(doc.lines) ? doc.lines.map(l => stripUndefined(l)) : undefined,
  meta: doc.meta ? stripUndefined(doc.meta) : undefined,
});

export function makePlannedDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<PlannedSaveInput, PlannedInstance>(getOrgId, {
    collectionPath: "plannedInstances",
    from,
    to,
    sort: (a, b) => (a.date?.getTime?.() ?? 0) - (b.date?.getTime?.() ?? 0),
  });

  return {
    ...base,

    async listByStatus(status: PlannedStatus) {
      // ✅ combine where + orderBy in ONE array
      return base.list([where("status", "==", status), orderBy("date", "asc")]);
    },

    async listInRange(fromDate: Date, toDate: Date, status?: PlannedStatus) {
      const constraints = [
        where("date", ">=", fromDate),
        where("date", "<=", toDate),
        orderBy("date", "asc"), // must orderBy the same field as the inequality
      ];
      if (status) constraints.unshift(where("status", "==", status));
      return base.list(constraints);
    },
  };
}

export type { PlannedInstance as Planned, PlannedSaveInput as PlannedSave };