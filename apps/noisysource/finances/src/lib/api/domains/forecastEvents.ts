import { where, setDoc, doc } from "firebase/firestore";
import { makeOrgCRUD, orgDoc } from "./base";
import { db } from "../../firebase";
import type { ForecastEventDoc, ForecastEventStatus, RecurringType } from "@shared/models/RecurringEntry";
import { toDate } from "../utils";

type ForecastEventSave = Omit<ForecastEventDoc, "createdAt"> & { id: string };

const from = (raw: any, id: string): ForecastEventDoc => ({
  id,
  recurringId: raw?.recurringId || undefined,
  type: raw?.type as RecurringType,
  description: raw?.description ?? "",
  amountCents: raw?.amountCents ?? 0,
  accountId: raw?.accountId || undefined,
  toAccountId: raw?.toAccountId || undefined,
  categoryId: raw?.categoryId || undefined,
  yearMonth: raw?.yearMonth ?? "",
  dayOfMonth: raw?.dayOfMonth ?? 1,
  status: (raw?.status ?? "forecast") as ForecastEventStatus,
  createdAt: toDate(raw?.createdAt) ?? undefined,
});

export function makeForecastEventsDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<ForecastEventSave, ForecastEventDoc>(getOrgId, {
    collectionPath: "forecastEvents",
    from,
    sort: (a, b) => {
      const ym = a.yearMonth.localeCompare(b.yearMonth);
      return ym !== 0 ? ym : a.dayOfMonth - b.dayOfMonth;
    },
  });

  return {
    ...base,

    async listByMonth(yearMonth: string): Promise<ForecastEventDoc[]> {
      return base.list([where("yearMonth", "==", yearMonth)]);
    },

    async listInRange(startYM: string, endYM: string): Promise<ForecastEventDoc[]> {
      return base.list([
        where("yearMonth", ">=", startYM),
        where("yearMonth", "<=", endYM),
      ]);
    },

    /** Upsert with deterministic ID — safe to call multiple times */
    async upsertEvent(event: ForecastEventDoc): Promise<void> {
      const ref = orgDoc(getOrgId(), "forecastEvents", event.id);
      await setDoc(ref, {
        recurringId: event.recurringId ?? null,
        type: event.type,
        description: event.description,
        amountCents: event.amountCents,
        accountId: event.accountId ?? null,
        toAccountId: event.toAccountId ?? null,
        categoryId: event.categoryId ?? null,
        yearMonth: event.yearMonth,
        dayOfMonth: event.dayOfMonth,
        status: event.status,
      }, { merge: true });
    },

    async updateStatus(id: string, status: ForecastEventStatus): Promise<void> {
      const ref = doc(db, "finances_entities", getOrgId(), "forecastEvents", id);
      const { updateDoc } = await import("firebase/firestore");
      await updateDoc(ref, { status });
    },
  };
}
