import { makeOrgCRUD } from "./base";
import type { CreditContractDoc, CreditType, RateType, RateHistoryEntry, BalanceSyncEntry } from "@shared/models/CreditContract";
import { toDate } from "../utils";

type CreditSave = Omit<CreditContractDoc, "id" | "createdAt"> & { id?: string };

const from = (raw: any, id: string): CreditContractDoc => ({
  id,
  type: (raw?.type ?? 'personal') as CreditType,
  description: raw?.description ?? '',
  creditor: raw?.creditor ?? '',
  loanAmountCents: raw?.loanAmountCents ?? 0,
  startYearMonth: raw?.startYearMonth ?? '',
  termMonths: raw?.termMonths ?? 0,
  rateType: (raw?.rateType ?? 'fixed') as RateType,
  annualRatePct: raw?.annualRatePct ?? 0,
  spreadPct: raw?.spreadPct ?? undefined,
  rateHistory: (raw?.rateHistory ?? []) as RateHistoryEntry[],
  balanceSyncs: (raw?.balanceSyncs ?? []) as BalanceSyncEntry[],
  interestOnlyPhase: raw?.interestOnlyPhase === true,
  accountId: raw?.accountId || undefined,
  dayOfMonth: raw?.dayOfMonth ?? undefined,
  active: raw?.active !== false,
  notes: raw?.notes || undefined,
  createdAt: toDate(raw?.createdAt) ?? undefined,
});

export function makeCreditsDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<CreditSave, CreditContractDoc>(getOrgId, {
    collectionPath: 'creditContracts',
    from,
    sort: (a, b) => a.description.localeCompare(b.description),
  });

  return {
    ...base,

    async listActive(): Promise<CreditContractDoc[]> {
      const all = await base.list();
      return all.filter(c => c.active);
    },

    async addRateHistory(id: string, entry: RateHistoryEntry): Promise<void> {
      const contract = await base.get(id);
      if (!contract) throw new Error(`Credit contract ${id} not found`);
      const history = [...(contract.rateHistory ?? []), entry]
        .sort((a, b) => a.effectiveYearMonth.localeCompare(b.effectiveYearMonth));
      await base.update(id, { rateHistory: history, annualRatePct: entry.annualRatePct } as any);
    },

    async addBalanceSync(id: string, entry: BalanceSyncEntry): Promise<void> {
      const contract = await base.get(id);
      if (!contract) throw new Error(`Credit contract ${id} not found`);
      // Replace any existing sync for the same month, then sort
      const syncs = [
        ...(contract.balanceSyncs ?? []).filter(s => s.syncYearMonth !== entry.syncYearMonth),
        entry,
      ].sort((a, b) => a.syncYearMonth.localeCompare(b.syncYearMonth));
      await base.update(id, { balanceSyncs: syncs } as any);
    },
  };
}
