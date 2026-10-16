/**
 * apply.ts — preview and run a seed import (plan.ts) through the api domains, as the logged-in user
 * under the Firestore rules: the same screen works on dev and on prod.
 *
 * Every write is an upsert by the record's id (merge), so a re-import updates what changed and
 * creates nothing twice. After each contract, income source, EC contract and insurance, the same
 * sync as its form runs (contractSync.ts), which derives the recurring entries.
 */
import { api } from "../api";
import type { PayloadDiff } from "../api/payload";
import {
  syncEcContractRecurring,
  syncEmploymentContractRecurring,
  syncIncomeSourceRecurring,
  syncInsuranceRecurring,
} from "../contractSync";
import type { SeedWrite } from "./plan";

type UpsertDomain = {
  upsertWithId(id: string, input: any): Promise<string>;
  diffWithId(id: string, input: any): Promise<PayloadDiff>;
};

function domainFor(w: SeedWrite): UpsertDomain {
  switch (w.collection) {
    case "people": return api.people;
    case "companies": return api.companies;
    case "accounts": return api.accounts;
    case "categories": return api.categories;
    case "employmentContracts": return api.contracts;
    case "payrollRuns": return api.payrollRuns;
    case "incomeSources": return api.incomeSources;
    case "ecContracts": return api.ecContracts;
    case "creditContracts": return api.credits;
    case "loans": return api.loans;
    case "insurances": return api.insurances;
    case "recurring": return api.recurring;
  }
}

export type SeedPreviewRow = SeedWrite & { diff: PayloadDiff };

/** Reads each target document and compares it with the write (nothing is written). */
export async function previewSeedImport(
  writes: readonly SeedWrite[],
  onProgress?: (done: number, total: number) => void,
): Promise<SeedPreviewRow[]> {
  const prevEntity = api.entityId;
  const rows: SeedPreviewRow[] = [];
  try {
    for (const [i, w] of writes.entries()) {
      if (w.entityId) api.setEntity(w.entityId);
      rows.push({ ...w, diff: await domainFor(w).diffWithId(w.id, w.input) });
      onProgress?.(i + 1, writes.length);
    }
  } finally {
    api.setEntity(prevEntity);
  }
  return rows;
}

/** The form's follow-up after a write, run on the document as saved. */
async function runSync(w: SeedWrite): Promise<void> {
  if (!w.sync || !w.entityId) return;
  api.setEntity(w.entityId);
  switch (w.sync) {
    case "employmentContract": {
      const c = await api.contracts.get(w.id);
      if (c) await syncEmploymentContractRecurring(c, w.personName ?? c.personId, w.entityId);
      break;
    }
    case "incomeSource": {
      const s = await api.incomeSources.get(w.id);
      if (s) await syncIncomeSourceRecurring(s);
      break;
    }
    case "ecContract": {
      const c = await api.ecContracts.get(w.id);
      if (c) await syncEcContractRecurring(c);
      break;
    }
    case "insurance": {
      const ins = await api.insurances.get(w.id);
      if (ins) await syncInsuranceRecurring(ins);
      break;
    }
  }
}

/**
 * Writes in plan order, one at a time; stops at the first failure (the error names the record).
 * Everything is idempotent, so running it again after fixing the cause is safe.
 */
export async function applySeedImport(
  writes: readonly SeedWrite[],
  onProgress?: (done: number, total: number, w: SeedWrite) => void,
): Promise<void> {
  const prevEntity = api.entityId;
  try {
    for (const [i, w] of writes.entries()) {
      try {
        if (w.entityId) api.setEntity(w.entityId);
        await domainFor(w).upsertWithId(w.id, w.input);
        await runSync(w);
      } catch (e: any) {
        throw new Error(`${w.path} (${w.id}): ${e?.message ?? e}`);
      }
      onProgress?.(i + 1, writes.length, w);
    }
  } finally {
    api.setEntity(prevEntity);
  }
}
