import { orderBy } from "firebase/firestore";
import { makeOrgCRUD } from "./base";
import type { LoanEntryDoc, LoanKind } from "@shared/models/Loan";
import { toDate } from "../utils";

type LoanSave = Omit<LoanEntryDoc, "id" | "createdAt"> & { id?: string };

const from = (raw: any, id: string): LoanEntryDoc => ({
  id,
  counterparty: raw?.counterparty ?? "",
  amountCents: raw?.amountCents ?? 0,
  description: raw?.description ?? "",
  date: raw?.date ?? "",
  kind: (raw?.kind ?? "lent") as LoanKind,
  notes: raw?.notes || undefined,
  createdAt: toDate(raw?.createdAt) ?? undefined,
});

export function makeLoansDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<LoanSave, LoanEntryDoc>(getOrgId, {
    collectionPath: "loans",
    from,
    sort: (a, b) => b.date.localeCompare(a.date),
  });

  return {
    ...base,

    async listAll(): Promise<LoanEntryDoc[]> {
      return base.list([], [orderBy("date", "desc")]);
    },
  };
}
