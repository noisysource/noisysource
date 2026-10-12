import { makeOrgCRUD } from "./base";
import type { EcContractDoc } from "@shared/models/EcContract";
import { toDate } from "../utils";
import { parseVatCode } from "@shared/lib/vat";

type EcContractSave = Omit<EcContractDoc, "id" | "createdAt"> & { id?: string };

const from = (raw: any, id: string): EcContractDoc => ({
  id,
  clientName: raw?.clientName ?? "",
  projectName: raw?.projectName,
  dailyRateCents: raw?.dailyRateCents ?? 0,
  totalDays: raw?.totalDays ?? undefined,
  expectedDaysPerMonth: raw?.expectedDaysPerMonth ?? 0,
  startDate: toDate(raw?.startDate) ?? undefined,
  endDate: toDate(raw?.endDate) ?? undefined,
  active: raw?.active !== false,
  nonWorkingDays: Array.isArray(raw?.nonWorkingDays) ? (raw.nonWorkingDays as string[]) : undefined,
  halfDays: Array.isArray(raw?.halfDays) ? (raw.halfDays as string[]) : undefined,
  daysToPayment: raw?.daysToPayment != null ? Number(raw.daysToPayment) : undefined,
  paymentAccountId: raw?.paymentAccountId || undefined,
  vatCode: parseVatCode(raw?.vatCode),
  ivaRatePct: typeof raw?.ivaRatePct === 'number' ? raw.ivaRatePct : undefined,
  createdAt: toDate(raw?.createdAt) ?? undefined,
});

export function makeEcContractsDomain(getOrgId: () => string) {
  return makeOrgCRUD<EcContractSave, EcContractDoc>(getOrgId, {
    collectionPath: "ecContracts",
    from,
    sort: (a, b) => a.clientName.localeCompare(b.clientName),
  });
}
