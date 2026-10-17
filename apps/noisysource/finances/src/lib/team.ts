/**
 * team.ts — Equipa (HANDOFF-finhub-redesign.md step 3). Pure: a company's people, each with their
 * contract versions (a raise is a new version from its start date) and processed payroll runs.
 */
import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import { computeMonthlyPayroll, contractDateYM, contractInForce } from "@shared/lib/payroll";

export type VersionStatus = "current" | "future" | "ended" | "inactive";

export function contractVersionStatus(c: EmploymentContractDoc, ym: string): VersionStatus {
  if (c.active === false) return "inactive";
  const [y, m] = ym.split("-").map(Number);
  if (contractInForce(c, y, m)) return "current";
  const start = contractDateYM(c.startDate);
  return start && ym < start ? "future" : "ended";
}

export type TeamMember = {
  personId: string;
  /** Newest first. */
  versions: Array<{ contract: EmploymentContractDoc; status: VersionStatus }>;
  /** The version in force this month, if any. */
  current?: EmploymentContractDoc;
  /** The newest version: what "Nova versão" copies. */
  latest: EmploymentContractDoc;
  /** Processed months, newest first. */
  runs: PayrollRunDoc[];
  /** This month's cost to the company (gross + employer SS + benefits) of the current version. */
  monthlyCostCents: number;
};

const startKey = (c: EmploymentContractDoc) => contractDateYM(c.startDate) ?? "";

/** People with a contract at this company: those with a version in force first, then by name. */
export function buildTeam(
  contracts: readonly EmploymentContractDoc[],
  runs: readonly PayrollRunDoc[],
  ym: string,
  nameOf: (personId: string) => string,
): TeamMember[] {
  const [y, m] = ym.split("-").map(Number);
  const byPerson = new Map<string, EmploymentContractDoc[]>();
  for (const c of contracts) byPerson.set(c.personId, [...(byPerson.get(c.personId) ?? []), c]);

  const members = [...byPerson.entries()].map(([personId, list]): TeamMember => {
    const sorted = [...list].sort((a, b) => startKey(b).localeCompare(startKey(a)));
    const versions = sorted.map(contract => ({ contract, status: contractVersionStatus(contract, ym) }));
    const current = versions.find(v => v.status === "current")?.contract;
    return {
      personId,
      versions,
      current,
      latest: sorted[0],
      runs: runs.filter(r => r.personId === personId).sort((a, b) => b.year - a.year || b.month - a.month),
      monthlyCostCents: current ? computeMonthlyPayroll(current, y, m).totals.costToEmployerCents : 0,
    };
  });
  return members.sort((a, b) => Number(!!b.current) - Number(!!a.current) || nameOf(a.personId).localeCompare(nameOf(b.personId)));
}
