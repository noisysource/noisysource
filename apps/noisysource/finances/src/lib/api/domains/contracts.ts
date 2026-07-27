import { where } from "firebase/firestore";
import { makeOrgCRUD } from "./base";
import type { EmploymentContractDoc, BenefitConfig } from "@shared/models/Employment";
import { stripUndefined } from "../crud";

/** ----- mappers ----- */
const mapBenefitsFrom = (raw: any[]): BenefitConfig[] =>
  Array.isArray(raw)
    ? raw.map((b: any) =>
        stripUndefined({
          type: b?.type,
          perMonthCents: Number.isFinite(b?.perMonthCents) ? b.perMonthCents : (Number.isFinite(b?.amountCents) ? b.amountCents : undefined),
          perDayCents: Number.isFinite(b?.perDayCents) ? b.perDayCents : (Number.isFinite(b?.meta?.dailyAmountCents) ? b.meta.dailyAmountCents : undefined),
          daysPerMonth:
            typeof b?.daysPerMonth === "number"
              ? b.daysPerMonth
              : typeof b?.meta?.workingDays === "number"
              ? b.meta.workingDays
              : undefined,
          subjectToIRS: !!(b?.subjectToIRS ?? b?.includeAboveCapInIRS),
          subjectToSS:  !!(b?.subjectToSS  ?? b?.includeAboveCapInSS),
          benefitAccountId: b?.benefitAccountId ?? b?.providerAccountId ?? "",
          expenseCategoryId: b?.expenseCategoryId,
          payableCategoryId: b?.payableCategoryId,
          providerFeePct: Number.isFinite(b?.providerFeePct) ? b.providerFeePct : undefined,
          providerFeeCents: Number.isFinite(b?.providerFeeCents) ? b.providerFeeCents : undefined,
        } as BenefitConfig)
      )
    : [];

const from = (raw: any, id: string): EmploymentContractDoc => ({
  id,
  orgId: raw?.orgId,
  companyId: raw?.companyId,
  personId: raw?.personId,
  active: raw?.active !== false,

  grossMonthlyCents: Number.isFinite(raw?.grossMonthlyCents) ? raw.grossMonthlyCents : 0,
  irsRatePct: Number.isFinite(raw?.irsRatePct) ? raw.irsRatePct : 0,
  ssEmpPct: Number.isFinite(raw?.ssEmpPct) ? raw.ssEmpPct : 0,
  ssErPct: Number.isFinite(raw?.ssErPct) ? raw.ssErPct : 0,

  payDay: typeof raw?.payDay === "number" ? raw.payDay : 25,

  startDate: raw?.startDate ?? undefined,
  endDate: raw?.endDate ?? undefined,

  benefits: mapBenefitsFrom(raw?.benefits),
  netPayAccountId: raw?.netPayAccountId || "",
});

const to = (doc: EmploymentContractDoc) =>
  stripUndefined({
    orgId: doc.orgId,
    companyId: doc.companyId,
    personId: doc.personId,
    active: doc.active !== false,

    grossMonthlyCents: doc.grossMonthlyCents ?? 0,
    irsRatePct: doc.irsRatePct ?? 0,
    ssEmpPct: doc.ssEmpPct ?? 0,
    ssErPct: doc.ssErPct ?? 0,

    payDay: typeof doc.payDay === "number" ? doc.payDay : 25,

    startDate: doc.startDate || undefined,
    endDate: doc.endDate || undefined,

    benefits: Array.isArray(doc.benefits) ? doc.benefits.map(b => stripUndefined(b)) : [],
    netPayAccountId: doc.netPayAccountId || "",
  });

/** ----- domain factory ----- */
export function makeContractsDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<EmploymentContractDoc, EmploymentContractDoc>(getOrgId, {
    collectionPath: "employmentContracts",
    from,
    to,
    sort: (a, b) => {
      const p = (a.personId ?? "").localeCompare(b.personId ?? "");
      if (p !== 0) return p;
      const ad = a.startDate ? new Date(a.startDate as any).getTime() : 0;
      const bd = b.startDate ? new Date(b.startDate as any).getTime() : 0;
      return bd - ad;
    },
  });

  return {
    ...base,
    async listByCompany(companyId: string): Promise<EmploymentContractDoc[]> {
      return base.list([where("companyId", "==", companyId)]);
    },
  };
}

export type { EmploymentContractDoc };