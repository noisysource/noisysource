import React, { useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type { ForecastDirection, ForecastScenario } from '../types/finance';
import {
  build12MonthForecast,
  currentMonthKey,
  formatMoney,
  isVoucherAccountType,
} from '../utils/financeMath';
import { ForecastChart } from './ForecastChart';

interface ForecastViewProps {
  createModalOpen: boolean;
  onCloseCreateModal: () => void;
  onOpenCreateModal: () => void;
}

export function ForecastView({
  createModalOpen,
  onCloseCreateModal,
  onOpenCreateModal,
}: ForecastViewProps) {
  const {
    entities,
    filteredAccounts,
    filteredFacilities,
    filteredPayslips,
    filteredForecastItems,
    filteredPersonalIncomes,
    filteredRecurringExpenses,
    employmentContracts,
    currencyCode,
    entityFilter,
    addForecastItem,
    toggleForecastItem,
    deleteForecastItem,
  } = useTreasury();

  const [scenario, setScenario] = useState<ForecastScenario>('baseline');

  const defaultEntityId = entityFilter !== 'all' ? entityFilter : entities[0]?.id ?? '';
  const [formEntityId, setFormEntityId] = useState(defaultEntityId);
  const [formName, setFormName] = useState('');
  const [formDirection, setFormDirection] = useState<ForecastDirection>('inflow');
  const [formCategory, setFormCategory] = useState('Operating Revenue');
  const [formAmount, setFormAmount] = useState('5000');
  const [formStartMonth, setFormStartMonth] = useState(currentMonthKey());
  const [formEndMonth, setFormEndMonth] = useState('');
  const [formGrowth, setFormGrowth] = useState('3');
  const [saving, setSaving] = useState(false);

  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e.name])), [entities]);

  const rows = useMemo(
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

  const summary = useMemo(() => {
    const startCash = rows[0]?.startingCash ?? 0;
    const lastRow = rows[rows.length - 1];
    const endCash = lastRow?.endingCash ?? startCash;
    const endLiquidCash = lastRow?.endingLiquidCash ?? endCash;
    const endVoucherBalance = lastRow?.endingVoucherBalance ?? 0;
    const totalInflows = rows.reduce((s, r) => s + r.inflows, 0);
    const totalOutflows = rows.reduce(
      (s, r) => s + r.payrollOutflow + r.debtService + r.operatingOutflow,
      0
    );
    const totalVoucherCovered = rows.reduce((s, r) => s + (r.voucherCoveredOutflow ?? 0), 0);
    const lowest = rows.reduce(
      (min, r) => (r.endingCash < min.endingCash ? r : min),
      rows[0] ?? { monthLabel: '-', endingCash: 0 }
    );
    const hasVouchers =
      filteredAccounts.some((a) => isVoucherAccountType(a.accountType)) ||
      endVoucherBalance > 0 ||
      totalVoucherCovered > 0;
    return {
      startCash,
      endCash,
      endLiquidCash,
      endVoucherBalance,
      totalInflows,
      totalOutflows,
      totalVoucherCovered,
      lowest,
      hasVouchers,
    };
  }, [rows, filteredAccounts]);

  const handleCreateDriver = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEntity = formEntityId || entities[0]?.id;
    if (!targetEntity) return;
    setSaving(true);
    try {
      await addForecastItem({
        entityId: targetEntity,
        name: formName,
        direction: formDirection,
        category: formCategory,
        monthlyAmount: Number(formAmount) || 0,
        startMonth: formStartMonth,
        endMonth: formEndMonth,
        annualGrowthRate: Number(formGrowth) || 0,
        active: true,
      });
      setFormName('');
      onCloseCreateModal();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">12-Month Projected Inflows</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-emerald-400 mt-2">
            {formatMoney(summary.totalInflows, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">Scenario-adjusted receipts</p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">12-Month Projected Outflows</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-amber-300 mt-2">
            {formatMoney(summary.totalOutflows, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {summary.totalVoucherCovered > 0
              ? `${formatMoney(summary.totalVoucherCovered, currencyCode, true)} offset by Meal/Child vouchers`
              : 'Payroll + Debt + OpEx'}
          </p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Lowest Cash Runway Point</p>
          <p
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              summary.lowest.endingCash < 0 ? 'text-rose-400' : 'text-slate-100'
            }`}
          >
            {formatMoney(summary.lowest.endingCash, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">Occurs in {summary.lowest.monthLabel}</p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">
            {summary.hasVouchers ? 'Year-End Liquid Cash' : 'Year-End Projected Balance'}
          </p>
          <p
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              (summary.hasVouchers ? summary.endLiquidCash : summary.endCash) >= 0
                ? 'text-emerald-400'
                : 'text-rose-400'
            }`}
          >
            {formatMoney(summary.hasVouchers ? summary.endLiquidCash : summary.endCash, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
            {summary.hasVouchers
              ? `+${formatMoney(summary.endVoucherBalance, currencyCode, true)} restricted vouchers`
              : `Net ${summary.endCash - summary.startCash >= 0 ? '+' : ''}${formatMoney(
                  summary.endCash - summary.startCash,
                  currencyCode
                )} YoY`}
          </p>
        </div>
      </div>

      {/* Chart */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Rolling 12-Month Cash Projection</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Conservative applies -15% inflows / +10% OpEx; Growth models +18% inflows / +4% OpEx
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-[#1E293B] border border-slate-700/80 rounded-lg self-start">
            {(['baseline', 'conservative', 'growth'] as ForecastScenario[]).map((sc) => (
              <button
                key={sc}
                onClick={() => setScenario(sc)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  scenario === sc ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {sc === 'baseline' ? 'Baseline' : sc === 'conservative' ? 'Conservative' : 'Growth'}
              </button>
            ))}
          </div>
        </div>
        <ForecastChart rows={rows} currencyCode={currencyCode} height={280} />
      </section>

      {/* Month-by-Month Ledger Forecast Table */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100">Monthly Cash Flow Projection Grid</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="py-3 px-6 font-medium">Month</th>
                <th className="py-3 px-3 font-medium text-right">Starting Cash</th>
                <th className="py-3 px-3 font-medium text-right">Inflows</th>
                <th className="py-3 px-3 font-medium text-right">Payroll &amp; Tax</th>
                <th className="py-3 px-3 font-medium text-right">Debt Service</th>
                <th className="py-3 px-3 font-medium text-right">Operating OpEx</th>
                <th className="py-3 px-3 font-medium text-right">Net Flow</th>
                <th className="py-3 px-6 font-medium text-right">Ending Cash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs font-mono tabular-nums">
              {rows.map((r) => (
                <tr key={r.monthKey} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-6 font-sans font-medium text-slate-200">{r.monthLabel}</td>
                  <td className="py-3 px-3 text-right text-slate-300">
                    {formatMoney(r.startingCash, currencyCode)}
                  </td>
                  <td className="py-3 px-3 text-right text-emerald-400">
                    +{formatMoney(r.inflows, currencyCode)}
                  </td>
                  <td className="py-3 px-3 text-right text-slate-300">
                    -{formatMoney(r.payrollOutflow, currencyCode)}
                  </td>
                  <td className="py-3 px-3 text-right text-slate-300">
                    -{formatMoney(r.debtService, currencyCode)}
                  </td>
                  <td className="py-3 px-3 text-right text-slate-300">
                    <div>-{formatMoney(r.operatingOutflow, currencyCode)}</div>
                    {(r.voucherCoveredOutflow ?? 0) > 0 && (
                      <div className="text-[10px] text-amber-300">
                        {formatMoney(r.voucherCoveredOutflow ?? 0, currencyCode, true)} via vouchers
                      </div>
                    )}
                  </td>
                  <td
                    className={`py-3 px-3 text-right font-medium ${
                      r.netCashFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {r.netCashFlow >= 0 ? '+' : ''}
                    {formatMoney(r.netCashFlow, currencyCode)}
                  </td>
                  <td
                    className={`py-3 px-6 text-right font-semibold ${
                      (r.endingLiquidCash ?? r.endingCash) >= 0 ? 'text-slate-100' : 'text-rose-400'
                    }`}
                  >
                    <div>{formatMoney(r.endingLiquidCash ?? r.endingCash, currencyCode)}</div>
                    {(r.endingVoucherBalance ?? 0) > 0 && (
                      <div className="text-[10px] font-normal text-amber-300">
                        +{formatMoney(r.endingVoucherBalance ?? 0, currencyCode, true)} vouchers
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recurring Forecast Drivers */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Recurring Revenue &amp; Expense Drivers</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Loan debt service, payslip costs, and active subscriptions are pulled automatically; manage recurring revenue and operating budgets here
            </p>
          </div>
          <button
            onClick={onOpenCreateModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Driver</span>
          </button>
        </div>

        {filteredForecastItems.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No forecast drivers configured yet. Add recurring revenue or expense assumptions to project 12-month cash.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Driver</th>
                  <th className="py-3 px-4 font-medium">Entity</th>
                  <th className="py-3 px-4 font-medium">Window</th>
                  <th className="py-3 px-4 font-medium text-right">YoY Growth</th>
                  <th className="py-3 px-4 font-medium text-right">Monthly Amount</th>
                  <th className="py-3 px-6 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredForecastItems.map((item) => (
                  <tr key={item.id} className={item.active ? '' : 'opacity-50'}>
                    <td className="py-3 px-6">
                      <p className="font-medium text-slate-100">{item.name}</p>
                      <p className="text-xs text-slate-400">
                        {item.direction === 'inflow' ? 'Inflow' : 'Outflow'} · {item.category}
                      </p>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-300">
                      {entityMap.get(item.entityId) ?? 'Entity'}
                    </td>
                    <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-400">
                      {item.startMonth} → {item.endMonth || 'Ongoing'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-300">
                      {item.annualGrowthRate > 0 ? `+${item.annualGrowthRate}%` : `${item.annualGrowthRate}%`}
                    </td>
                    <td
                      className={`py-3 px-4 text-right font-mono tabular-nums font-medium ${
                        item.direction === 'inflow' ? 'text-emerald-400' : 'text-amber-300'
                      }`}
                    >
                      {item.direction === 'inflow' ? '+' : '-'}
                      {formatMoney(item.monthlyAmount, currencyCode)}
                    </td>
                    <td className="py-3 px-6 text-right">
                      <div className="inline-flex items-center gap-3">
                        <button
                          onClick={() => void toggleForecastItem(item.id, !item.active)}
                          className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                        >
                          {item.active ? 'Pause' : 'Enable'}
                        </button>
                        <button
                          onClick={() => void deleteForecastItem(item.id)}
                          aria-label={`Delete ${item.name}`}
                          className="text-slate-500 hover:text-rose-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Add Driver Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={onCloseCreateModal} />
          <form
            onSubmit={handleCreateDriver}
            className="relative z-10 max-w-lg w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Add Forecast Driver</h3>
              <button
                type="button"
                onClick={onCloseCreateModal}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Entity</label>
                <select
                  value={formEntityId || defaultEntityId}
                  onChange={(e) => setFormEntityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Direction</label>
                <select
                  value={formDirection}
                  onChange={(e) => setFormDirection(e.target.value as ForecastDirection)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="inflow">Monthly Inflow (Revenue / Income)</option>
                  <option value="outflow">Monthly Outflow (Expense / Draw)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Driver Name</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  placeholder="e.g. Monthly Client Retainers"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Category</label>
                <input
                  type="text"
                  required
                  maxLength={60}
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Monthly Amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Annual Growth %</label>
                <input
                  type="number"
                  step="0.5"
                  min="-100"
                  max="500"
                  required
                  value={formGrowth}
                  onChange={(e) => setFormGrowth(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Start Month</label>
                <input
                  type="month"
                  required
                  value={formStartMonth}
                  onChange={(e) => setFormStartMonth(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">End (Optional)</label>
                <input
                  type="month"
                  value={formEndMonth}
                  onChange={(e) => setFormEndMonth(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={onCloseCreateModal}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {saving ? 'Saving...' : 'Save Driver'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
