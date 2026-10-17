import { describe, expect, it } from 'vitest';
import type { EmploymentContractDoc } from '@shared/models/Employment';
import type { PayrollRunDoc } from '@shared/models/PayrollRun';
import { buildTeam, contractVersionStatus } from './team';

// Made-up values only.
const contract = (over: Partial<EmploymentContractDoc>): EmploymentContractDoc => ({
  id: 'c', companyId: 'acme', personId: 'ana', active: true, grossMonthlyCents: 100000, irsRatePct: 10, ssEmpPct: 11,
  ssErPct: 23.75, payDay: 30, startDate: '2026-01-01' as any, netPayAccountId: '', benefits: [], ...over,
});
const run = (personId: string, month: number): PayrollRunDoc => ({
  id: `acme-${personId}-2026-${month}`, contractId: 'c', companyId: 'acme', personId, year: 2026, month,
  grossCents: 1, irsCents: 0, ssEmpCents: 0, ssErCents: 0, netCents: 1, benefitsCents: 0, costToEmployerCents: 1,
  cashOutCents: 1, confirmedAt: new Date(),
});
const names: Record<string, string> = { ana: 'Ana', bia: 'Bia', caio: 'Caio' };

describe('Equipa', () => {
  const v1 = contract({ id: 'v1', endDate: '2026-04-30' as any });
  const v2 = contract({ id: 'v2', startDate: '2026-05-01' as any, grossMonthlyCents: 120000 });

  it('gives each version its status for the month', () => {
    expect([v1, v2].map(c => contractVersionStatus(c, '2026-10'))).toEqual(['ended', 'current']);
    expect(contractVersionStatus(v2, '2026-03')).toBe('future');
    expect(contractVersionStatus(contract({ active: false }), '2026-10')).toBe('inactive');
  });

  it('groups versions and payslips per person, newest first, with the current cost', () => {
    const team = buildTeam(
      [v1, v2, contract({ id: 'b1', personId: 'bia', endDate: '2026-03-31' as any })],
      [run('ana', 2), run('ana', 9), run('bia', 1)],
      '2026-10',
      id => names[id],
    );
    expect(team.map(t => [t.personId, t.current?.id ?? null, t.latest.id, t.versions.map(v => `${v.contract.id}:${v.status}`), t.runs.map(r => r.month)])).toEqual([
      ['ana', 'v2', 'v2', ['v2:current', 'v1:ended'], [9, 2]],
      ['bia', null, 'b1', ['b1:ended'], [1]],
    ]);
    expect(team[0].monthlyCostCents).toBe(148500); // 120000 + 23.75% SS
    expect(team[1].monthlyCostCents).toBe(0);
  });

  it('lists people with a version in force first, then by name', () => {
    const team = buildTeam(
      [contract({ id: 'x', personId: 'caio' }), contract({ id: 'y', personId: 'bia', endDate: '2026-01-31' as any }), contract({ id: 'z', personId: 'ana' })],
      [], '2026-10', id => names[id],
    );
    expect(team.map(t => t.personId)).toEqual(['ana', 'caio', 'bia']);
  });
});
