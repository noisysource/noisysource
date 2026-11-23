import React, { useMemo, useState } from 'react';
import { CheckCircle2, Clock, Plus, Trash2, X } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type { CreditFacility, FacilityType } from '../types/finance';
import { buildAmortizationSchedule, formatMoney, todayIsoDate } from '../utils/financeMath';

const FACILITY_TYPE_LABELS: Record<FacilityType, string> = {
  term_loan: 'Term Loan',
  credit_line: 'Revolving Credit Line',
  credit_card: 'Credit Card',
  mortgage: 'Mortgage',
  equipment_loan: 'Equipment Loan',
};

interface CreditsLoansViewProps {
  createModalOpen: boolean;
  onCloseCreateModal: () => void;
  onOpenCreateModal: () => void;
}

export function CreditsLoansView({
  createModalOpen,
  onCloseCreateModal,
  onOpenCreateModal,
}: CreditsLoansViewProps) {
  const {
    entities,
    accounts,
    filteredFacilities,
    currencyCode,
    entityFilter,
    addCreditFacility,
    recordLoanPayment,
    deleteCreditFacility,
  } = useTreasury();

  const [selectedFacility, setSelectedFacility] = useState<CreditFacility | null>(null);
  const [payAmount, setPayAmount] = useState<string>('');
  const [payAccountId, setPayAccountId] = useState<string>('');
  const [payDate, setPayDate] = useState<string>(todayIsoDate());
  const [paying, setPaying] = useState(false);

  // Add Facility Form State
  const defaultEntityId = entityFilter !== 'all' ? entityFilter : entities[0]?.id ?? '';
  const [formEntityId, setFormEntityId] = useState<string>(defaultEntityId);
  const [formFundingAccountId, setFormFundingAccountId] = useState<string>('');
  const [formName, setFormName] = useState('');
  const [formLender, setFormLender] = useState('');
  const [formType, setFormType] = useState<FacilityType>('term_loan');
  const [formLimit, setFormLimit] = useState('50000');
  const [formBalance, setFormBalance] = useState('35000');
  const [formApr, setFormApr] = useState('6.5');
  const [formMonthlyPay, setFormMonthlyPay] = useState('1200');
  const [formDueDay, setFormDueDay] = useState('15');
  const [formMaturity, setFormMaturity] = useState('2029-12-31');
  const [saving, setSaving] = useState(false);

  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e.name])), [entities]);

  const metrics = useMemo(() => {
    const active = filteredFacilities.filter((f) => f.status === 'active');
    const totalLimit = active.reduce((s, f) => s + f.principalOrLimit, 0);
    const totalBalance = active.reduce((s, f) => s + f.currentBalance, 0);
    const monthlyService = active.reduce((s, f) => s + f.monthlyPayment, 0);
    const weightedApr =
      totalBalance > 0
        ? active.reduce((s, f) => s + f.apr * f.currentBalance, 0) / totalBalance
        : 0;
    return { totalLimit, totalBalance, monthlyService, weightedApr, activeCount: active.length };
  }, [filteredFacilities]);

  const activeFacilityLive = useMemo(() => {
    if (!selectedFacility) return null;
    return filteredFacilities.find((f) => f.id === selectedFacility.id) ?? selectedFacility;
  }, [selectedFacility, filteredFacilities]);

  const amortizationRows = useMemo(() => {
    if (!activeFacilityLive) return [];
    return buildAmortizationSchedule(activeFacilityLive, 12);
  }, [activeFacilityLive]);

  const openDrawer = (facility: CreditFacility) => {
    setSelectedFacility(facility);
    setPayAmount(String(Math.min(facility.currentBalance, facility.monthlyPayment) || ''));
    const fallbackAcc =
      facility.fundingAccountId ||
      accounts.find((a) => a.entityId === facility.entityId)?.id ||
      accounts[0]?.id ||
      '';
    setPayAccountId(fallbackAcc);
    setPayDate(todayIsoDate());
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeFacilityLive) return;
    setPaying(true);
    try {
      await recordLoanPayment({
        facility: activeFacilityLive,
        amount: Number(payAmount) || 0,
        accountId: payAccountId,
        date: payDate,
      });
    } finally {
      setPaying(false);
    }
  };

  const handleCreateFacility = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEntity = formEntityId || entities[0]?.id;
    if (!targetEntity) return;
    setSaving(true);
    try {
      await addCreditFacility({
        entityId: targetEntity,
        fundingAccountId: formFundingAccountId,
        name: formName,
        lender: formLender,
        facilityType: formType,
        principalOrLimit: Number(formLimit) || 0,
        currentBalance: Number(formBalance) || 0,
        apr: Number(formApr) || 0,
        monthlyPayment: Number(formMonthlyPay) || 0,
        dueDay: Number(formDueDay) || 15,
        maturityDate: formMaturity,
      });
      setFormName('');
      setFormLender('');
      onCloseCreateModal();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Outstanding Debt</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(metrics.totalBalance, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            Across {metrics.activeCount} active facilities
          </p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Total Principal / Credit Limit</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(metrics.totalLimit, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
            {metrics.totalLimit > 0
              ? `${((metrics.totalBalance / metrics.totalLimit) * 100).toFixed(1)}% utilization`
              : '0.0% utilization'}
          </p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Weighted Average APR</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-amber-300 mt-2">
            {metrics.weightedApr.toFixed(2)}%
          </p>
          <p className="text-xs text-slate-400 mt-2">Annualized borrowing rate</p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Scheduled Monthly Service</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(metrics.monthlyService, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">Auto-linked to 12-mo forecast</p>
        </div>
      </div>

      {/* Facilities Table */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Credits, Loans &amp; Mortgages</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Select any facility to inspect 12-month amortization or record a principal &amp; interest payment
            </p>
          </div>
          <button
            onClick={onOpenCreateModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Facility</span>
          </button>
        </div>

        {filteredFacilities.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-slate-300">No credit lines or loans recorded yet.</p>
            <p className="text-xs text-slate-500">
              Add business term loans, credit cards, or personal mortgages to project debt payoff and due dates.
            </p>
            <button
              onClick={onOpenCreateModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add First Facility</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Facility &amp; Lender</th>
                  <th className="py-3 px-4 font-medium">Entity</th>
                  <th className="py-3 px-4 font-medium">Utilization / Remaining</th>
                  <th className="py-3 px-4 font-medium text-right">APR</th>
                  <th className="py-3 px-4 font-medium text-right">Monthly</th>
                  <th className="py-3 px-4 font-medium text-right">Balance</th>
                  <th className="py-3 px-6 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-sm">
                {filteredFacilities.map((f) => {
                  const pct =
                    f.principalOrLimit > 0
                      ? Math.min(100, (f.currentBalance / f.principalOrLimit) * 100)
                      : 0;
                  return (
                    <tr
                      key={f.id}
                      onClick={() => openDrawer(f)}
                      className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                    >
                      <td className="py-3.5 px-6">
                        <p className="font-medium text-slate-100">{f.name}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {f.lender} · {FACILITY_TYPE_LABELS[f.facilityType]} · Due day {f.dueDay}
                        </p>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300">
                        {entityMap.get(f.entityId) ?? 'Entity'}
                      </td>
                      <td className="py-3.5 px-4 min-w-[160px]">
                        <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-400 mb-1">
                          <span>{pct.toFixed(0)}%</span>
                          <span>{formatMoney(f.principalOrLimit, currencyCode, true)}</span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              pct > 75 ? 'bg-rose-500' : pct > 40 ? 'bg-amber-500' : 'bg-blue-500'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-300">
                        {f.apr.toFixed(2)}%
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-300">
                        {formatMoney(f.monthlyPayment, currencyCode)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-medium text-slate-100">
                        {formatMoney(f.currentBalance, currencyCode)}
                      </td>
                      <td className="py-3.5 px-6 text-right">
                        {f.status === 'paid_off' ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-400 whitespace-nowrap">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Paid Off
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-blue-400 whitespace-nowrap">
                            <Clock className="w-3.5 h-3.5" />
                            Active
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Amortization & Payment Drawer */}
      {activeFacilityLive && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={() => setSelectedFacility(null)}
          />
          <aside className="relative z-10 w-full max-w-xl bg-[#0F172A] border-l border-slate-800 h-full overflow-y-auto p-6 space-y-6">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
              <div>
                <p className="text-xs text-slate-400">
                  {entityMap.get(activeFacilityLive.entityId)} ·{' '}
                  {FACILITY_TYPE_LABELS[activeFacilityLive.facilityType]}
                </p>
                <h3 className="text-lg font-semibold text-slate-100 mt-1">
                  {activeFacilityLive.name}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {activeFacilityLive.lender} · {activeFacilityLive.apr.toFixed(2)}% APR · Maturity{' '}
                  {activeFacilityLive.maturityDate || 'Open-ended'}
                </p>
              </div>
              <button
                onClick={() => setSelectedFacility(null)}
                className="p-1.5 text-slate-400 hover:text-slate-100 rounded-lg cursor-pointer"
                aria-label="Close drawer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="p-3.5 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
                <p className="text-xs text-slate-400">Balance</p>
                <p className="text-base font-mono tabular-nums font-semibold text-slate-100 mt-1">
                  {formatMoney(activeFacilityLive.currentBalance, currencyCode)}
                </p>
              </div>
              <div className="p-3.5 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
                <p className="text-xs text-slate-400">Limit / Orig</p>
                <p className="text-base font-mono tabular-nums font-semibold text-slate-200 mt-1">
                  {formatMoney(activeFacilityLive.principalOrLimit, currencyCode)}
                </p>
              </div>
              <div className="p-3.5 bg-[#1E293B]/60 border border-slate-800 rounded-lg">
                <p className="text-xs text-slate-400">Installment</p>
                <p className="text-base font-mono tabular-nums font-semibold text-slate-200 mt-1">
                  {formatMoney(activeFacilityLive.monthlyPayment, currencyCode)}
                </p>
              </div>
            </div>

            {activeFacilityLive.status === 'active' && (
              <form
                onSubmit={handleRecordPayment}
                className="p-4 bg-[#1E293B]/40 border border-slate-800 rounded-lg space-y-3"
              >
                <h4 className="text-sm font-semibold text-slate-100">Record Payment</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Amount</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-1.5 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Date</label>
                    <input
                      type="date"
                      required
                      value={payDate}
                      onChange={(e) => setPayDate(e.target.value)}
                      className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Funding Account</label>
                    <select
                      value={payAccountId}
                      onChange={(e) => setPayAccountId(e.target.value)}
                      className="w-full bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
                    >
                      <option value="">No bank deduction</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <p className="text-xs text-slate-400">
                    Deducts accrued monthly interest first, then reduces principal.
                  </p>
                  <button
                    type="submit"
                    disabled={paying}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {paying ? 'Recording...' : 'Post Payment'}
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-slate-100">12-Month Amortization Projection</h4>
              <div className="border border-slate-800 rounded-lg overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#1E293B]/60 border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-3 font-medium">Month</th>
                      <th className="py-2.5 px-3 font-medium text-right">Payment</th>
                      <th className="py-2.5 px-3 font-medium text-right">Principal</th>
                      <th className="py-2.5 px-3 font-medium text-right">Interest</th>
                      <th className="py-2.5 px-3 font-medium text-right">Ending Bal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                    {amortizationRows.map((r) => (
                      <tr key={r.monthIndex}>
                        <td className="py-2 px-3 text-slate-300 font-sans">{r.monthLabel}</td>
                        <td className="py-2 px-3 text-right text-slate-200">
                          {formatMoney(r.payment, currencyCode)}
                        </td>
                        <td className="py-2 px-3 text-right text-emerald-400">
                          {formatMoney(r.principalPaid, currencyCode)}
                        </td>
                        <td className="py-2 px-3 text-right text-amber-300">
                          {formatMoney(r.interestPaid, currencyCode)}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-100">
                          {formatMoney(r.endingBalance, currencyCode)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800 flex justify-between items-center">
              <button
                onClick={async () => {
                  await deleteCreditFacility(activeFacilityLive.id);
                  setSelectedFacility(null);
                }}
                className="inline-flex items-center gap-1.5 text-xs text-rose-400 hover:text-rose-300 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Remove Facility</span>
              </button>
              <button
                onClick={() => setSelectedFacility(null)}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Close
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Create Credit Facility Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={onCloseCreateModal} />
          <form
            onSubmit={handleCreateFacility}
            className="relative z-10 max-w-lg w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Add Credit or Loan Facility</h3>
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
                <label className="block text-xs text-slate-300 mb-1">Facility Type</label>
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value as FacilityType)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {Object.entries(FACILITY_TYPE_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Facility Name</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder="e.g. SBA Working Capital"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Lender / Issuer</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder="e.g. JPMorgan Chase"
                  value={formLender}
                  onChange={(e) => setFormLender(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Limit / Orig</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={formLimit}
                  onChange={(e) => setFormLimit(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Current Bal</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={formBalance}
                  onChange={(e) => setFormBalance(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">APR (%)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  required
                  value={formApr}
                  onChange={(e) => setFormApr(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Monthly Pay</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={formMonthlyPay}
                  onChange={(e) => setFormMonthlyPay(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Due Day (1–31)</label>
                <input
                  type="number"
                  min="1"
                  max="31"
                  required
                  value={formDueDay}
                  onChange={(e) => setFormDueDay(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Maturity Date</label>
                <input
                  type="date"
                  value={formMaturity}
                  onChange={(e) => setFormMaturity(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Funding Account</label>
                <select
                  value={formFundingAccountId}
                  onChange={(e) => setFormFundingAccountId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="">Unassigned</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
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
                {saving ? 'Saving...' : 'Save Facility'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
