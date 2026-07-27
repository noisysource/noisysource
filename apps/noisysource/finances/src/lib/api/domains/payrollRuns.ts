import { where } from "firebase/firestore";
import { makeOrgCRUD } from "./base";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import { toDate } from "../utils";

type PayrollRunSave = Omit<PayrollRunDoc, "id" | "confirmedAt"> & { id?: string; confirmedAt?: Date };

const from = (raw: any, id: string): PayrollRunDoc => ({
  id,
  contractId: raw?.contractId ?? "",
  companyId: raw?.companyId ?? "",
  personId: raw?.personId ?? "",
  year: raw?.year ?? 0,
  month: raw?.month ?? 0,
  grossCents: raw?.grossCents ?? 0,
  irsCents: raw?.irsCents ?? 0,
  ssEmpCents: raw?.ssEmpCents ?? 0,
  ssErCents: raw?.ssErCents ?? 0,
  netCents: raw?.netCents ?? 0,
  benefitsCents: raw?.benefitsCents ?? 0,
  costToEmployerCents: raw?.costToEmployerCents ?? 0,
  cashOutCents: raw?.cashOutCents ?? 0,
  confirmedAt: toDate(raw?.confirmedAt) ?? new Date(),
  sourceAccountId: raw?.sourceAccountId,
});

export function makePayrollRunsDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<PayrollRunSave, PayrollRunDoc>(getOrgId, {
    collectionPath: "payrollRuns",
    from,
    sort: (a, b) => {
      const d = b.year - a.year || b.month - a.month;
      return d !== 0 ? d : a.personId.localeCompare(b.personId);
    },
  });

  return {
    ...base,
    async listByCompany(companyId: string) {
      return base.list([where("companyId", "==", companyId)]);
    },
    async listByPerson(personId: string) {
      return base.list([where("personId", "==", personId)]);
    },
  };
}
