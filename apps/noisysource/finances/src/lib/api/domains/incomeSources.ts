import { makeOrgCRUD } from "./base";
import type { IncomeSourceDoc } from "@shared/models/IncomeSource";
import { stripUndefined } from "../crud";

const from = (raw: any, id: string): IncomeSourceDoc => ({
  id,
  personName: raw?.personName ?? "",
  employerName: raw?.employerName ?? "",
  grossMonthlyCents: Number.isFinite(raw?.grossMonthlyCents) ? raw.grossMonthlyCents : 0,
  irsRatePct: Number.isFinite(raw?.irsRatePct) ? raw.irsRatePct : 0,
  ssEmpPct: Number.isFinite(raw?.ssEmpPct) ? raw.ssEmpPct : 11,
  payDay: typeof raw?.payDay === "number" ? raw.payDay : 25,
  netPayAccountId: raw?.netPayAccountId ?? "",
  active: raw?.active !== false,
  benefits: Array.isArray(raw?.benefits) ? raw.benefits : [],
  startDate: raw?.startDate ?? undefined,
  notes: raw?.notes ?? undefined,
  createdAt: raw?.createdAt,
});

const to = (doc: IncomeSourceDoc) =>
  stripUndefined({
    personName: doc.personName,
    employerName: doc.employerName,
    grossMonthlyCents: doc.grossMonthlyCents,
    irsRatePct: doc.irsRatePct,
    ssEmpPct: doc.ssEmpPct,
    payDay: doc.payDay,
    netPayAccountId: doc.netPayAccountId || undefined,
    active: doc.active !== false,
    benefits: Array.isArray(doc.benefits) ? doc.benefits.map((b) => stripUndefined(b)) : [],
    startDate: doc.startDate || undefined,
    notes: doc.notes || undefined,
  });

export function makeIncomeSourcesDomain(getEntityId: () => string) {
  return makeOrgCRUD<IncomeSourceDoc, IncomeSourceDoc>(getEntityId, {
    collectionPath: "incomeSources",
    from,
    to,
    sort: (a, b) => {
      const p = a.personName.localeCompare(b.personName);
      if (p !== 0) return p;
      return a.employerName.localeCompare(b.employerName);
    },
  });
}
