import { useMemo, useState } from 'react';
import { ArrowRight, CalendarDays, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type { ForecastScenario, NavSection } from '../types/finance';
import {
  addMonths,
  build12MonthForecast,
  buildCalendarEvents,
  computeEntityIrcSummary,
  computeEntityIvaSummary,
  computePersonalIrsSummary,
  currentMonthKey,
  formatMoney,
  isVoucherAccountType,
} from '../utils/financeMath';
import { ForecastChart } from './ForecastChart';

interface OverviewViewProps {
  onNavigate: (section: NavSection) => void;
}

export function OverviewView({ onNavigate }: OverviewViewProps) {
  const {
    entities,
    filteredAccounts,
    filteredFacilities,
    filteredPayslips,
    filteredForecastItems,
    filteredTransactions,
    filteredStatementLines,
    filteredPersonalIncomes,
    filteredRecurringExpenses,
    accounts,
    creditFacilities,
    transactions,
    payslips,
    forecastItems,
    personalIncomes,
    employmentContracts,
    recurringExpenses,
    reimbursements,
    taxSettings,
    currencyCode,
    entityFilter,
    setEntityFilter,
  } = useTreasury();

  const [scenario, setScenario] = useState<ForecastScenario>('baseline');

  const totalCash = useMemo(
    () => filteredAccounts.reduce((sum, a) => sum + a.balance, 0),
    [filteredAccounts]
  );

  const liquidCash = useMemo(
    () =>
      filteredAccounts
        .filter((a) => !isVoucherAccountType(a.accountType))
        .reduce((sum, a) => sum + a.balance, 0),
    [filteredAccounts]
  );

  const voucherCash = totalCash - liquidCash;

  const activeFacilities = useMemo(
    () => filteredFacilities.filter((f) => f.status === 'active'),
    [filteredFacilities]
  );

  const totalDebt = useMemo(
    () => activeFacilities.reduce((sum, f) => sum + f.currentBalance, 0),
    [activeFacilities]
  );

  const totalLimit = useMemo(
    () => activeFacilities.reduce((sum, f) => sum + f.principalOrLimit, 0),
    [activeFacilities]
  );

  const utilizationPct = totalLimit > 0 ? Math.min(100, (totalDebt / totalLimit) * 100) : 0;

  const forecastRows = useMemo(
    () =>
      build12MonthForecast({
        accounts: filteredAccounts,
        creditFacilities: filteredFacilities,
        payslips: filteredPayslips,
        forecastItems: filteredForecastItems,
        personalIncomes: filteredPersonalIncomes,
        employmentContracts,
        recurringExpenses: filteredRecurringExpenses,
        scenario,
      }),
    [
      filteredAccounts,
      filteredFacilities,
      filteredPayslips,
      filteredForecastItems,
      filteredPersonalIncomes,
      employmentContracts,
      filteredRecurringExpenses,
      scenario,
    ]
  );

  const taxRollup = useMemo(() => {
    const settingMap = new Map(taxSettings.map((s) => [s.entityId, s]));
    const companies = entities.filter(
      (e) => e.entityType === 'company' && (entityFilter === 'all' || e.id === entityFilter)
    );
    const personalEnts = entities.filter((e) => e.entityType === 'personal');

    const netIva = companies.reduce(
      (sum, ent) =>
        sum +
        computeEntityIvaSummary({
          entity: ent,
          transactions,
          reimbursements,
          taxSetting: settingMap.get(ent.id),
        }).netIvaPayable,
      0
    );

    const netIrc = companies.reduce(
      (sum, ent) =>
        sum +
        computeEntityIrcSummary({
          entity: ent,
          transactions,
          payslips,
          creditFacilities,
          forecastItems,
          employmentContracts,
          recurringExpenses,
          reimbursements,
          taxSetting: settingMap.get(ent.id),
          mode: 'annualized',
        }).netIrcDue,
      0
    );

    const irs = computePersonalIrsSummary({
      personalIncomes,
      employmentContracts,
      entities,
      personalEntityIds: personalEnts.map((e) => e.id),
      transactions,
      taxSetting: personalEnts[0] ? settingMap.get(personalEnts[0].id) : undefined,
      includeLedgerPersonalIncome: false,
    });

    return { netIva, netIrc, irs };
  }, [
    entities,
    entityFilter,
    taxSettings,
    transactions,
    payslips,
    creditFacilities,
    forecastItems,
    personalIncomes,
    employmentContracts,
    recurringExpenses,
    reimbursements,
  ]);

  const monthKey = currentMonthKey();
  const nextMonthKey = addMonths(monthKey, 1);

  const upcomingEvents = useMemo(() => {
    const cur = buildCalendarEvents({
      monthKey,
      payslips: filteredPayslips,
      creditFacilities: filteredFacilities,
      transactions: filteredTransactions,
      recurringExpenses: filteredRecurringExpenses,
      entities,
    });
    const nxt = buildCalendarEvents({
      monthKey: nextMonthKey,
      payslips: filteredPayslips,
      creditFacilities: filteredFacilities,
      transactions: filteredTransactions,
      recurringExpenses: filteredRecurringExpenses,
      entities,
    });
    return [...cur, ...nxt].filter((ev) => ev.status !== 'paid').slice(0, 6);
  }, [
    monthKey,
    nextMonthKey,
    filteredPayslips,
    filteredFacilities,
    filteredTransactions,
    filteredRecurringExpenses,
    entities,
  ]);

  const openReimbursementsTotal = useMemo(
    () =>
      reimbursements
        .filter((r) => r.status === 'open')
        .reduce((s, r) => s + r.amount, 0),
    [reimbursements]
  );

  const obligations30d = useMemo(() => {
    const firstMonth = forecastRows[0];
    if (!firstMonth) return 0;
    return firstMonth.payrollOutflow + firstMonth.debtService + firstMonth.operatingOutflow;
  }, [forecastRows]);

  const lastForecastRow = forecastRows[forecastRows.length - 1];
  const endingCash12m = lastForecastRow?.endingCash ?? totalCash;
  const endingLiquidCash12m = lastForecastRow?.endingLiquidCash ?? endingCash12m;
  const endingVoucher12m = lastForecastRow?.endingVoucherBalance ?? voucherCash;

  const reconStats = useMemo(() => {
    const unmatched = filteredStatementLines.filter((l) => l.reconciliationStatus === 'unmatched').length;
    const suggested = filteredStatementLines.filter((l) => l.reconciliationStatus === 'suggested').length;
    const discrepancy = filteredStatementLines.filter((l) => l.reconciliationStatus === 'discrepancy').length;
    const reconciled = filteredStatementLines.filter((l) => l.reconciliationStatus === 'reconciled').length;
    return { unmatched, suggested, discrepancy, reconciled, total: filteredStatementLines.length };
  }, [filteredStatementLines]);

  const entityRollups = useMemo(() => {
    return entities.map((ent) => {
      const entAccounts = accounts.filter((a) => a.entityId === ent.id);
      const cash = entAccounts
        .filter((a) => !isVoucherAccountType(a.accountType))
        .reduce((s, a) => s + a.balance, 0);
      const vouchers = entAccounts
        .filter((a) => isVoucherAccountType(a.accountType))
        .reduce((s, a) => s + a.balance, 0);
      const debt = creditFacilities
        .filter((f) => f.entityId === ent.id && f.status === 'active')
        .reduce((s, f) => s + f.currentBalance, 0);
      const monthlyService = creditFacilities
        .filter((f) => f.entityId === ent.id && f.status === 'active')
        .reduce((s, f) => s + f.monthlyPayment, 0);
      return {
        entity: ent,
        accountCount: entAccounts.length,
        cash,
        vouchers,
        debt,
        net: cash - debt,
        monthlyService,
      };
    });
  }, [entities, accounts, creditFacilities]);

  return (
    <div className="space-y-6">
      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Liquid Cash Position</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(liquidCash, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {voucherCash > 0 ? (
              <span className="font-mono tabular-nums text-amber-300">
                +{formatMoney(voucherCash, currencyCode, true)} vouchers ·{' '}
              </span>
            ) : (
              <span>
                {filteredAccounts.length} {filteredAccounts.length === 1 ? 'account' : 'accounts'} ·{' '}
              </span>
            )}
            <button
              onClick={() => onNavigate('accounts')}
              className="text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              Manage accounts
            </button>
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Total Debt &amp; Credit Drawn</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(totalDebt, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
            {utilizationPct.toFixed(1)}% utilized · {activeFacilities.length} facilities
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Monthly Cost Run-Rate</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(obligations30d, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            Payroll + Debt + Subs ·{' '}
            <button
              onClick={() => onNavigate('expenses')}
              className="text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              {openReimbursementsTotal > 0
                ? `${formatMoney(openReimbursementsTotal, currencyCode, true)} owed`
                : 'Expenses & subs'}
            </button>
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">12-Month Projected Liquid Cash</p>
          <p
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              endingLiquidCash12m < 0 ? 'text-rose-400' : 'text-emerald-400'
            }`}
          >
            {formatMoney(endingLiquidCash12m, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {scenario === 'baseline' ? 'Baseline' : scenario === 'conservative' ? 'Conservative' : 'Growth'}
            {endingVoucher12m > 0
              ? ` · +${formatMoney(endingVoucher12m, currencyCode, true)} vouchers`
              : ' scenario'}
          </p>
        </div>
      </div>

      {/* Focal Anchor: 12-Month Cash Trajectory */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
          <div>
            <h2 className="text-base font-semibold text-slate-100">12-Month Cash Runway Forecast</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Combines account liquidity, personal job net inflows, loan installments, payslips, and recurring drivers
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-[#1E293B] border border-slate-700/80 rounded-lg self-start">
            {(['baseline', 'conservative', 'growth'] as ForecastScenario[]).map((sc) => (
              <button
                key={sc}
                onClick={() => setScenario(sc)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  scenario === sc
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {sc === 'baseline' ? 'Baseline' : sc === 'conservative' ? 'Conservative' : 'Growth'}
              </button>
            ))}
          </div>
        </div>
        <ForecastChart rows={forecastRows} currencyCode={currencyCode} height={260} />
      </section>

      {/* Automated Tax Summary Strip (IVA · IRS · IRC) */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Automated Fiscal Engine (IVA · IRS · IRC)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Live 2026 calculations from tagged invoices, company P&amp;L drivers, and personal job incomes
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('personal_income')}
              className="text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
            >
              Personal Streams (
              {personalIncomes.filter((i) => i.active).length +
                employmentContracts.filter((c) => c.active && c.isOwnerIncome).length}
              )
            </button>
            <button
              onClick={() => onNavigate('taxes')}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap cursor-pointer"
            >
              <span>Open Tax Cockpit</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
            <p className="text-xs text-slate-400">Net IVA (VAT Balance)</p>
            <p
              className={`text-xl font-mono tabular-nums font-semibold mt-1.5 ${
                taxRollup.netIva > 0 ? 'text-amber-300' : 'text-emerald-400'
              }`}
            >
              {taxRollup.netIva >= 0 ? 'Pay ' : 'Credit '}
              {formatMoney(Math.abs(taxRollup.netIva), currencyCode)}
            </p>
            <p className="text-xs text-slate-500 mt-1">IVA Liquidado − Dedutível</p>
          </div>

          <div className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
            <p className="text-xs text-slate-400">Personal IRS (2026 Englobamento)</p>
            <p
              className={`text-xl font-mono tabular-nums font-semibold mt-1.5 ${
                taxRollup.irs.estimatedPayableOrRefund <= 0 ? 'text-emerald-400' : 'text-amber-300'
              }`}
            >
              {taxRollup.irs.estimatedPayableOrRefund <= 0 ? 'Refund ' : 'Due '}
              {formatMoney(Math.abs(taxRollup.irs.estimatedPayableOrRefund), currencyCode)}
            </p>
            <p className="text-xs text-slate-500 mt-1">{taxRollup.irs.bracketLabel}</p>
          </div>

          <div className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
            <p className="text-xs text-slate-400">Corporate IRC (Annualized Est.)</p>
            <p className="text-xl font-mono tabular-nums font-semibold text-blue-400 mt-1.5">
              {formatMoney(taxRollup.netIrc, currencyCode)}
            </p>
            <p className="text-xs text-slate-500 mt-1">PME 15%/19% + Derrama − On Account</p>
          </div>
        </div>
      </section>

      {/* Entity Rollup Table */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Entity Balance Sheet Summary</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Click an entity row to isolate its accounts, loans, and forecasts
            </p>
          </div>
          <div className="flex items-center gap-3">
            {entityFilter !== 'all' && (
              <button
                onClick={() => setEntityFilter('all')}
                className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap cursor-pointer"
              >
                Show All Entities
              </button>
            )}
            <button
              onClick={() => onNavigate('accounts')}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap cursor-pointer"
            >
              <span>All Accounts</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="py-3 px-6 font-medium">Entity</th>
                <th className="py-3 px-4 font-medium">Type &amp; Accounts</th>
                <th className="py-3 px-4 font-medium text-right">Cash Reserve</th>
                <th className="py-3 px-4 font-medium text-right">Debt Drawn</th>
                <th className="py-3 px-4 font-medium text-right">Monthly Debt Service</th>
                <th className="py-3 px-6 font-medium text-right">Net Position</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-sm">
              {entityRollups.map(({ entity, accountCount, cash, vouchers, debt, net, monthlyService }) => {
                const isSelected = entityFilter === entity.id;
                return (
                  <tr
                    key={entity.id}
                    onClick={() => setEntityFilter(isSelected ? 'all' : entity.id)}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-950/30' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <td className="py-3 px-6 font-medium text-slate-100">
                      <span>{entity.name}</span>
                      {entity.registrationCode && (
                        <span className="ml-2 text-xs text-slate-500 font-normal">
                          · {entity.registrationCode}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-400">
                      {entity.entityType === 'personal' ? 'Personal' : 'Company'} · {accountCount}{' '}
                      {accountCount === 1 ? 'account' : 'accounts'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                      <div>{formatMoney(cash, currencyCode)}</div>
                      {vouchers > 0 && (
                        <div className="text-[11px] text-amber-300">
                          +{formatMoney(vouchers, currencyCode, true)} vouchers
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-300">
                      {formatMoney(debt, currencyCode)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                      {formatMoney(monthlyService, currencyCode)}
                    </td>
                    <td
                      className={`py-3 px-6 text-right font-mono tabular-nums font-medium ${
                        net >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatMoney(net, currencyCode)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Bottom 2-Column Split: Upcoming Obligations & Reconciliation Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="text-base font-semibold text-slate-100">Upcoming Obligations</h2>
              <button
                onClick={() => onNavigate('calendar')}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap cursor-pointer"
              >
                <span>Open Calendar</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {upcomingEvents.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-lg">
                No scheduled payroll or loan obligations in the next 60 days.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {upcomingEvents.map((ev) => (
                  <div key={ev.id} className="py-3 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200 truncate">{ev.title}</p>
                      <p className="text-xs text-slate-400 mt-0.5 truncate">
                        <span className="font-mono tabular-nums">{ev.date}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{ev.entityName}</span>
                        <span aria-hidden="true"> · </span>
                        <span className={ev.status === 'overdue' ? 'text-rose-400' : 'text-slate-400'}>
                          {ev.status === 'overdue' ? 'Overdue' : 'Scheduled'}
                        </span>
                      </p>
                    </div>
                    <span className="font-mono tabular-nums text-sm font-medium text-slate-100 shrink-0">
                      {formatMoney(ev.amount, currencyCode)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-6 flex flex-col justify-between">
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-slate-100">Bank Statement Reconciliation</h2>
              <button
                onClick={() => onNavigate('reconciliation')}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap cursor-pointer"
              >
                <span>Reconcile Workbench</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-amber-400">
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  <span>Pending Review</span>
                </div>
                <p className="text-xl font-mono tabular-nums font-semibold text-slate-100 mt-2">
                  {reconStats.unmatched + reconStats.suggested}
                </p>
              </div>
              <div className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Reconciled Lines</span>
                </div>
                <p className="text-xl font-mono tabular-nums font-semibold text-slate-100 mt-2">
                  {reconStats.reconciled}
                </p>
              </div>
              <div className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-rose-400">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>Discrepancies</span>
                </div>
                <p className="text-xl font-mono tabular-nums font-semibold text-slate-100 mt-2">
                  {reconStats.discrepancy}
                </p>
              </div>
              <div className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <CalendarDays className="w-3.5 h-3.5 shrink-0" />
                  <span>Total Imported Lines</span>
                </div>
                <p className="text-xl font-mono tabular-nums font-semibold text-slate-100 mt-2">
                  {reconStats.total}
                </p>
              </div>
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
            <span>Upload PDF, image, or CSV statements for automated matching</span>
            <button
              onClick={() => onNavigate('reconciliation')}
              className="px-3 py-1.5 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-slate-200 font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Import Statement
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
