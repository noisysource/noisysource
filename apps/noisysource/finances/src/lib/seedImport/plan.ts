/**
 * plan.ts — from validated seed records to the writes the importer makes (pure, no Firestore).
 *
 * Each write is the save input of one api domain, exactly as its form would pass it, written with
 * upsertWithId under the record's id, then followed by the same sync the form runs (contractSync),
 * so derived recurring entries come out as if typed in the app. HANDOFF-finhub-data.md §3.
 */
import {
  LOAN_KIND_SIGN,
  type Seed,
  type SeedBenefit,
  type SeedCollection,
  type SeedEntityId,
  type SeedRecord,
} from "@shared/lib/finhubSeed";
import { computeEcProjection } from "@shared/lib/ecProjection";
import { getOutstandingAtYM } from "@shared/lib/amortization";
import type { CreditContractDoc } from "@shared/models/CreditContract";

/** The form's follow-up for a collection: derived recurring entries. */
export type SeedSync = "employmentContract" | "incomeSource" | "ecContract" | "insurance";

export type SeedWrite = {
  collection: SeedCollection;
  entityId: SeedEntityId | null;
  id: string;
  path: string;
  /** Save input for the collection's api domain (upsertWithId). */
  input: Record<string, unknown>;
  sync?: SeedSync;
  /** Name the employment sync puts in its descriptions. */
  personName?: string;
};

/** Write order: what others point at first; within an entity, the order of this list. */
export const IMPORT_ORDER: readonly SeedCollection[] = [
  "people", "companies", "accounts", "categories", "employmentContracts", "payrollRuns", "incomeSources",
  "ecContracts", "creditContracts", "loans", "insurances", "recurring",
];
const ENTITY_ORDER: ReadonlyArray<SeedEntityId | null> = [null, "private", "noisysource", "noisyphocus"];

const SYNC: Partial<Record<SeedCollection, SeedSync>> = {
  employmentContracts: "employmentContract",
  incomeSources: "incomeSource",
  ecContracts: "ecContract",
  insurances: "insurance",
};

/** Noon local time: the EC form's convention, so the stored day never shifts with the time zone. */
const noon = (iso: string) => new Date(`${iso}T12:00:00`);

function benefit(b: SeedBenefit) {
  return {
    type: b.type,
    perMonthCents: b.perMonthCents,
    perDayCents: b.perDayCents,
    daysPerMonth: b.daysPerMonth,
    subjectToIRS: b.subjectToIRS,
    subjectToSS: b.subjectToSS,
    benefitAccountId: b.account ?? "", // "" = paid in cash / not tracked, as BenefitConfig expects
    expenseCategoryId: b.expenseCategory,
    payableCategoryId: b.payableCategory,
    providerFeePct: b.providerFeePct,
    providerFeeCents: b.providerFeeCents,
  };
}

/** The bank's balance at each sync, and what FinHub would have computed for it without that sync. */
function balanceSyncs(credit: Omit<CreditContractDoc, "id">, syncs: Array<{ syncYearMonth: string; actualOutstandingCents: number; note?: string }>) {
  const sorted = [...syncs].sort((a, b) => a.syncYearMonth.localeCompare(b.syncYearMonth));
  return sorted.map((s, i) => {
    const before = { ...credit, id: "seed", balanceSyncs: sorted.slice(0, i).map(p => ({ ...p, computedOutstandingCents: 0, deltaCents: 0 })) };
    const computedOutstandingCents = getOutstandingAtYM(before as CreditContractDoc, s.syncYearMonth);
    return {
      syncYearMonth: s.syncYearMonth,
      actualOutstandingCents: s.actualOutstandingCents,
      computedOutstandingCents,
      deltaCents: s.actualOutstandingCents - computedOutstandingCents,
      note: s.note,
    };
  });
}

function inputFor(r: SeedRecord, names: { person: Map<string, string>; company: Map<string, string> }, contracts: Map<string, any>): Record<string, unknown> {
  const d = r.data;
  switch (r.collection) {
    case "people":
      return { name: d.name, email: d.email };
    case "companies":
      return { name: d.name, shortCode: d.shortCode, taxNumber: d.taxNumber };
    case "accounts": {
      const [ownerType, ownerId] = d.owner ? String(d.owner).split(":") : [undefined, undefined];
      const base = {
        code: d.code, name: d.name, type: d.type, ownerType, ownerId,
        jointOwnerIds: d.jointOwners?.length ? d.jointOwners : undefined, currency: "EUR",
      };
      switch (d.type) {
        case "bank": return { ...base, bankName: d.bankName, iban: d.iban, bic: d.bic };
        case "credit": return { ...base, issuer: d.issuer, last4: d.last4 };
        case "voucher": return { ...base, voucherType: d.voucherType, provider: d.provider, issuingEmployer: names.company.get(d.issuingEmployer) };
        case "bonds": return { ...base, provider: d.provider };
        default: return base;
      }
    }
    case "categories":
      return { name: d.name, code: d.code, type: d.type, parentId: d.parent, active: true };
    case "employmentContracts":
      return {
        companyId: d.company, personId: d.person, contractType: d.contractType, active: true,
        grossMonthlyCents: d.grossMonthlyCents, irsRatePct: d.irsRatePct, ssEmpPct: d.ssEmpPct, ssErPct: d.ssErPct,
        payDay: d.payDay, startDate: d.from, endDate: d.to, benefits: d.benefits.map(benefit),
        netPayAccountId: d.netPayAccount ?? "", flowToPrivate: d.flowToPrivate,
      };
    case "payrollRuns": {
      const c = contracts.get(d.contract);
      const [y, m] = String(d.month).split("-").map(Number);
      const netCents = d.grossCents - d.irsCents - d.ssEmpCents;
      const benefitsCents = d.voucherBenefitsCents + d.cashBenefitsCents;
      return {
        contractId: d.contract, companyId: c.company, personId: c.person, year: y, month: m,
        grossCents: d.grossCents, irsCents: d.irsCents, ssEmpCents: d.ssEmpCents, ssErCents: d.ssErCents,
        netCents, benefitsCents,
        costToEmployerCents: d.grossCents + d.ssErCents + benefitsCents,
        cashOutCents: netCents + benefitsCents,
        confirmedAt: new Date(y, m, 0, 12), // the payslip month's last day: fixed, so a re-import changes nothing
        sourceAccountId: d.sourceAccount,
      };
    }
    case "incomeSources":
      return {
        personName: names.person.get(d.person), employerName: d.employerName,
        grossMonthlyCents: d.grossMonthlyCents, irsRatePct: d.irsRatePct, ssEmpPct: d.ssEmpPct, payDay: d.payDay,
        netPayAccountId: d.netPayAccount, active: true, benefits: d.benefits.map(benefit),
        startDate: d.from, endDate: d.to, notes: d.notes,
      };
    case "ecContracts": {
      // As the form: the end date is FinHub's own projection (validateSeed checked it against `to`).
      const p = computeEcProjection(
        { startDate: d.from, dailyRateCents: d.dailyRateCents, totalDays: d.totalDays },
        d.nonWorkingDays, noon(d.from), d.halfDays,
      );
      const avgDays = p.monthBreakdown.length
        ? Math.round((p.totalContractWorkingDays / p.monthBreakdown.length) * 10) / 10
        : 0;
      return {
        clientName: d.clientName, projectName: d.projectName, dailyRateCents: d.dailyRateCents,
        totalDays: d.totalDays, expectedDaysPerMonth: d.expectedDaysPerMonth ?? avgDays,
        startDate: noon(d.from), endDate: noon(p.contractEndDate), active: true,
        paymentAccountId: d.paymentAccount,
        nonWorkingDays: d.nonWorkingDays.length ? d.nonWorkingDays : undefined,
        halfDays: d.halfDays.length ? d.halfDays : undefined,
        daysToPayment: d.daysToPayment, vatCode: d.vatCode,
      };
    }
    case "creditContracts": {
      const credit = {
        type: d.type, description: d.description, creditor: d.creditor, loanAmountCents: d.loanAmountCents,
        startYearMonth: d.startYearMonth, termMonths: d.termMonths, rateType: d.rateType,
        annualRatePct: d.annualRatePct, spreadPct: d.spreadPct, rateHistory: d.rateHistory ?? [],
        interestOnlyPhase: d.interestOnlyPhase, accountId: d.account, dayOfMonth: d.dayOfMonth,
        active: d.active ?? true, notes: d.notes,
      };
      return { ...credit, balanceSyncs: balanceSyncs(credit as Omit<CreditContractDoc, "id">, d.balanceSyncs ?? []) };
    }
    case "loans":
      return {
        counterparty: d.counterparty, amountCents: d.amountCents * LOAN_KIND_SIGN[d.kind as keyof typeof LOAN_KIND_SIGN],
        description: d.description, date: d.date, kind: d.kind, notes: d.notes,
      };
    case "insurances":
      // No `attachments`: files uploaded in the app stay (merge write); a new doc reads as [].
      return {
        name: d.name, type: d.type, insurer: d.insurer, policyNumber: d.policyNumber, premiumCents: d.premiumCents,
        frequency: d.frequency, startDate: d.startDate, renewalDate: d.renewalDate, insuredPersons: d.insuredPersons,
        notes: d.notes, active: d.active ?? true,
      };
    case "recurring":
      return {
        type: d.type, description: d.description, amountCents: d.amountCents, accountId: d.account,
        toAccountId: d.toAccount, categoryId: d.category, frequency: d.frequency, dayOfMonth: d.dayOfMonth,
        monthOfYear: d.monthOfYear, startYearMonth: d.startYearMonth, endYearMonth: d.endYearMonth,
        onceYearMonth: d.onceYearMonth, active: d.active ?? true, reimbursable: d.reimbursable,
        paidByAccountId: d.paidByAccount, vatCode: d.vatCode, costModel: d.costModel,
        commissionPct: d.commissionPct, commissionVolumeSource: d.commissionVolumeSource,
      };
  }
  throw new Error(`unknown collection ${r.collection}`);
}

/** The writes for every importable record (validateSeed().importable), in import order. */
export function planSeedImport(seed: Seed, importable: readonly SeedRecord[]): SeedWrite[] {
  const names = {
    person: new Map(seed.people.map(p => [p.key, String(p.name)])),
    company: new Map(seed.companies.map(c => [c.key, String(c.name)])),
  };
  const contracts = new Map<string, any>();
  for (const eid of ["noisysource", "noisyphocus"] as const) {
    for (const c of seed.entities[eid]?.employmentContracts ?? []) contracts.set(c.key, c);
  }

  const rank = (r: SeedRecord) =>
    ENTITY_ORDER.indexOf(r.entityId) * 100 + IMPORT_ORDER.indexOf(r.collection);
  const ordered = importable
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(x => x.r);

  return ordered.map(r => ({
    collection: r.collection,
    entityId: r.entityId,
    id: r.id,
    path: r.path,
    input: inputFor(r, names, contracts),
    sync: SYNC[r.collection],
    personName: r.collection === "employmentContracts" ? names.person.get(r.data.person) : undefined,
  }));
}
