import React, { useMemo, useState } from 'react';
import { ArrowRight, Briefcase, Building2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type {
  NavSection,
  PersonalIncome,
  PersonalIncomeCategory,
  PersonalIncomeFrequency,
} from '../types/finance';
import {
  computeContractAnnualTotals,
  computePersonalIrsSummary,
  formatMoney,
  getAnnualGrossForPersonalIncome,
  getMonthlyNetCashForPersonalIncome,
  PERSONAL_INCOME_CATEGORY_LABELS,
} from '../utils/financeMath';

interface PersonalIncomeViewProps {
  createModalOpen: boolean;
  onOpenCreateModal: () => void;
  onCloseCreateModal: () => void;
  onNavigate: (section: NavSection, calendarTab?: 'calendar' | 'annual' | 'contracts') => void;
}

const FREQUENCY_LABELS: Record<PersonalIncomeFrequency, string> = {
  '14_months': '14x / Year (Subsídios)',
  monthly: '12x / Year (Monthly)',
  annual: 'Annual Lump Sum',
  one_off: 'One-Off Receipt',
};

export function PersonalIncomeView({
  createModalOpen,
  onOpenCreateModal,
  onCloseCreateModal,
  onNavigate,
}: PersonalIncomeViewProps) {
  const {
    entities,
    accounts,
    transactions,
    personalIncomes,
    filteredPersonalIncomes,
    employmentContracts,
    taxSettings,
    entityFilter,
    currencyCode,
    addPersonalIncome,
    updatePersonalIncome,
    togglePersonalIncome,
    deletePersonalIncome,
  } = useTreasury();

  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e.name])), [entities]);

  const ownerContracts = useMemo(
    () =>
      employmentContracts.filter(
        (c) =>
          c.isOwnerIncome &&
          (entityFilter === 'all' || c.personalEntityId === entityFilter || c.entityId === entityFilter)
      ),
    [employmentContracts, entityFilter]
  );

  const personalEntities = useMemo(
    () => entities.filter((e) => e.entityType === 'personal'),
    [entities]
  );
  const defaultPersonalEntity = personalEntities[0] ?? entities[0];

  const personalAccounts = useMemo(() => {
    const pIds = new Set(personalEntities.map((e) => e.id));
    const list = accounts.filter((a) => pIds.has(a.entityId));
    return list.length > 0 ? list : accounts;
  }, [personalEntities, accounts]);

  const [editingItem, setEditingItem] = useState<PersonalIncome | null>(null);
  const [formEntityId, setFormEntityId] = useState(defaultPersonalEntity?.id ?? '');
  const [formAccountId, setFormAccountId] = useState(personalAccounts[0]?.id ?? '');
  const [formTitle, setFormTitle] = useState('');
  const [formPayer, setFormPayer] = useState('');
  const [formCategory, setFormCategory] = useState<PersonalIncomeCategory>('cat_a_dependent');
  const [formFrequency, setFormFrequency] = useState<PersonalIncomeFrequency>('14_months');
  const [formGross, setFormGross] = useState('2200');
  const [formIrsRate, setFormIrsRate] = useState('18');
  const [formSsRate, setFormSsRate] = useState('11');
  const [formCountsIrs, setFormCountsIrs] = useState(true);

  const personalTaxSetting = useMemo(() => {
    if (!defaultPersonalEntity) return undefined;
    return taxSettings.find((s) => s.entityId === defaultPersonalEntity.id);
  }, [taxSettings, defaultPersonalEntity]);

  const irsSummary = useMemo(
    () =>
      computePersonalIrsSummary({
        personalIncomes,
        employmentContracts,
        entities,
        personalEntityIds: personalEntities.map((e) => e.id),
        transactions,
        taxSetting: personalTaxSetting,
        includeLedgerPersonalIncome: false,
      }),
    [personalIncomes, employmentContracts, entities, personalEntities, transactions, personalTaxSetting]
  );

  const totals = useMemo(() => {
    let annualGross = 0;
    let monthlyNetCash = 0;
    let monthlyBankCash = 0;
    let monthlyVoucherTotal = 0;
    let annualWithheld = 0;
    let irsEligibleCount = 0;

    for (const item of filteredPersonalIncomes) {
      if (!item.active) continue;
      const ag = getAnnualGrossForPersonalIncome(item);
      const mNet = getMonthlyNetCashForPersonalIncome(item);
      annualGross += ag;
      monthlyNetCash += mNet;
      monthlyBankCash += mNet;
      annualWithheld += ag * (item.irsWithheldRate / 100);
      if (item.countsTowardsIrs) irsEligibleCount += 1;
    }

    for (const c of ownerContracts) {
      if (!c.active) continue;
      const annual = computeContractAnnualTotals(c);
      annualGross += annual.annualGross;
      monthlyNetCash += annual.annualNetCash / 12;
      monthlyBankCash += annual.annualCashToBank / 12;
      monthlyVoucherTotal += (annual.annualMealCard + annual.annualChildVoucher) / 12;
      annualWithheld += annual.annualIrsWithheld;
      irsEligibleCount += 1;
    }

    return {
      annualGross,
      monthlyNetCash,
      monthlyBankCash,
      monthlyVoucherTotal,
      annualWithheld,
      irsEligibleCount,
    };
  }, [filteredPersonalIncomes, ownerContracts]);

  const openCreate = () => {
    setEditingItem(null);
    setFormEntityId(defaultPersonalEntity?.id ?? '');
    setFormAccountId(personalAccounts[0]?.id ?? '');
    setFormTitle('');
    setFormPayer('');
    setFormCategory('cat_a_dependent');
    setFormFrequency('14_months');
    setFormGross('2200');
    setFormIrsRate('18');
    setFormSsRate('11');
    setFormCountsIrs(true);
    onOpenCreateModal();
  };

  const openEdit = (item: PersonalIncome) => {
    setEditingItem(item);
    setFormEntityId(item.entityId);
    setFormAccountId(item.accountId || personalAccounts[0]?.id || '');
    setFormTitle(item.title);
    setFormPayer(item.payerName);
    setFormCategory(item.incomeCategory);
    setFormFrequency(item.frequency);
    setFormGross(String(item.grossAmount));
    setFormIrsRate(String(item.irsWithheldRate));
    setFormSsRate(String(item.ssRate));
    setFormCountsIrs(item.countsTowardsIrs);
    onOpenCreateModal();
  };

  const closeModal = () => {
    setEditingItem(null);
    onCloseCreateModal();
  };

  const modalVisible = createModalOpen || editingItem !== null;

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Annual Gross Personal Income</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(totals.annualGross, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {totals.irsEligibleCount} active {totals.irsEligibleCount === 1 ? 'stream' : 'streams'} in IRS englobamento
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Monthly Net Take-Home</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-emerald-400 mt-2">
            {formatMoney(totals.monthlyNetCash, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
            {totals.monthlyVoucherTotal > 0
              ? `Bank ${formatMoney(totals.monthlyBankCash, currencyCode, true)} + Vouchers ${formatMoney(totals.monthlyVoucherTotal, currencyCode, true)}`
              : 'Automatically feeds 12-month cash forecast'}
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Annual IRS Withheld at Source</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-blue-400 mt-2">
            {formatMoney(totals.annualWithheld, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">Retenção na fonte across jobs</p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">
            {irsSummary.estimatedPayableOrRefund <= 0 ? 'Estimated IRS Refund' : 'Estimated IRS Payable'}
          </p>
          <p
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              irsSummary.estimatedPayableOrRefund <= 0 ? 'text-emerald-400' : 'text-amber-300'
            }`}
          >
            {formatMoney(Math.abs(irsSummary.estimatedPayableOrRefund), currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
            {irsSummary.bracketLabel}
          </p>
        </div>
      </div>

      {/* Owned-Company Linked Contracts */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Income from Owned Companies (Linked Employment Contracts)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Automatically synced from company employment contracts marked as Owner Income — respects PT benefit tax exemptions
            </p>
          </div>
          <button
            onClick={() => onNavigate('calendar', 'contracts')}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>Manage Company Contracts</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {ownerContracts.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No company employment contracts are currently linked as Owner Income. Flag a contract under Payroll &amp; Calendar → Contracts to sync it here automatically.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Role &amp; Owned Company</th>
                  <th className="py-3 px-4 font-medium">Schedule &amp; Benefits</th>
                  <th className="py-3 px-4 font-medium text-right">Annual Gross + Vouchers</th>
                  <th className="py-3 px-4 font-medium text-right">IRS Taxable Base</th>
                  <th className="py-3 px-4 font-medium text-right">IRS Withheld</th>
                  <th className="py-3 px-6 font-medium text-right">Avg. Monthly Take-Home</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {ownerContracts.map((c) => {
                  const annual = computeContractAnnualTotals(c);
                  return (
                    <tr
                      key={c.id}
                      className={`hover:bg-slate-800/40 transition-colors ${c.active ? '' : 'opacity-50'}`}
                    >
                      <td className="py-3.5 px-6">
                        <div className="flex items-center gap-2">
                          <Building2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                          <div>
                            <p className="font-medium text-slate-100">
                              {c.roleTitle} · {c.workerName}
                            </p>
                            <p className="text-xs text-slate-400">
                              {entityMap.get(c.entityId) ?? 'Owned Company'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300">
                        <p>
                          {c.paySchedule === '14_months' ? '14x (Subsídios)' : '12x (Duodécimos)'} ·{' '}
                          {c.mealPaymentMethod === 'card'
                            ? `Meal Card €${c.mealAllowanceDaily.toFixed(2)}/d`
                            : c.mealPaymentMethod === 'cash'
                            ? `Meal Cash €${c.mealAllowanceDaily.toFixed(2)}/d`
                            : 'No Meal Voucher'}
                        </p>
                        {c.childVoucherMonthly > 0 && (
                          <p className="text-slate-500 mt-0.5">
                            Child Voucher {formatMoney(c.childVoucherMonthly, currencyCode)}/mo
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-200">
                        {formatMoney(annual.annualGross, currencyCode)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-300">
                        {formatMoney(annual.annualIrsTaxable, currencyCode)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-blue-400">
                        {formatMoney(annual.annualIrsWithheld, currencyCode)}
                      </td>
                      <td className="py-3.5 px-6 text-right font-mono tabular-nums font-medium text-emerald-400">
                        <div>{formatMoney(annual.annualNetCash / 12, currencyCode)}</div>
                        {annual.annualMealCard + annual.annualChildVoucher > 0 && (
                          <div className="text-[11px] font-normal text-amber-300 mt-0.5">
                            Bank {formatMoney(annual.annualCashToBank / 12, currencyCode, true)} · Vouchers{' '}
                            {formatMoney(
                              (annual.annualMealCard + annual.annualChildVoucher) / 12,
                              currencyCode,
                              true
                            )}
                          </div>
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

      {/* Personal Jobs & Side Incomes Table */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Personal Jobs, Freelance &amp; Other Income Sources
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Track employment, Recibos Verdes (Cat. B), dividends, and side jobs — all IRS-flagged streams aggregate automatically
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onNavigate('taxes')}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>Inspect IRS Brackets</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Job / Income</span>
            </button>
          </div>
        </div>

        {filteredPersonalIncomes.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No personal jobs or income streams configured yet. Add your primary salary, part-time roles, or freelance work to model take-home cash and IRS.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Role / Income Source</th>
                  <th className="py-3 px-4 font-medium">Category &amp; Schedule</th>
                  <th className="py-3 px-4 font-medium text-right">Gross / Period</th>
                  <th className="py-3 px-4 font-medium text-right">IRS / SS %</th>
                  <th className="py-3 px-4 font-medium text-right">Monthly Net Cash</th>
                  <th className="py-3 px-4 font-medium text-right">Annual Gross</th>
                  <th className="py-3 px-4 font-medium">IRS</th>
                  <th className="py-3 px-6 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredPersonalIncomes.map((inc) => {
                  const annualGross = getAnnualGrossForPersonalIncome(inc);
                  const monthlyNet = getMonthlyNetCashForPersonalIncome(inc);
                  return (
                    <tr
                      key={inc.id}
                      className={`hover:bg-slate-800/40 transition-colors ${inc.active ? '' : 'opacity-50'}`}
                    >
                      <td className="py-3.5 px-6">
                        <div className="flex items-center gap-2">
                          <Briefcase className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <div>
                            <p className="font-medium text-slate-100">{inc.title}</p>
                            <p className="text-xs text-slate-400">{inc.payerName}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300">
                        <p>{PERSONAL_INCOME_CATEGORY_LABELS[inc.incomeCategory]}</p>
                        <p className="text-slate-500 mt-0.5">{FREQUENCY_LABELS[inc.frequency]}</p>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-200">
                        {formatMoney(inc.grossAmount, currencyCode)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-300">
                        {inc.irsWithheldRate.toFixed(1)}% · {inc.ssRate.toFixed(1)}%
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-medium text-emerald-400">
                        {formatMoney(monthlyNet, currencyCode)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-200">
                        {formatMoney(annualGross, currencyCode)}
                      </td>
                      <td className="py-3.5 px-4 text-xs">
                        <span className={inc.countsTowardsIrs ? 'text-blue-400' : 'text-slate-500'}>
                          {inc.countsTowardsIrs ? 'Included' : 'Excluded'}
                        </span>
                      </td>
                      <td className="py-3.5 px-6 text-right">
                        <div className="inline-flex items-center gap-2.5">
                          <button
                            onClick={() => void togglePersonalIncome(inc.id, !inc.active)}
                            className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                          >
                            {inc.active ? 'Pause' : 'Enable'}
                          </button>
                          <button
                            onClick={() => openEdit(inc)}
                            aria-label={`Edit ${inc.title}`}
                            className="text-slate-400 hover:text-slate-100 p-1 cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => void deletePersonalIncome(inc.id)}
                            aria-label={`Delete ${inc.title}`}
                            className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Add / Edit Personal Income Modal */}
      {modalVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={closeModal} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const targetEntity = formEntityId || defaultPersonalEntity?.id || entities[0]?.id || '';
              if (!targetEntity) return;

              const payload = {
                entityId: targetEntity,
                accountId: formAccountId || personalAccounts[0]?.id || '',
                title: formTitle,
                payerName: formPayer,
                incomeCategory: formCategory,
                frequency: formFrequency,
                grossAmount: Number(formGross) || 0,
                irsWithheldRate: Number(formIrsRate) || 0,
                ssRate: Number(formSsRate) || 0,
                countsTowardsIrs: formCountsIrs,
              };

              if (editingItem) {
                await updatePersonalIncome(editingItem.id, payload);
              } else {
                await addPersonalIncome({ ...payload, active: true });
              }
              closeModal();
            }}
            className="relative z-10 max-w-lg w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                {editingItem ? 'Edit Personal Income Source' : 'Add Personal Job or Income Source'}
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Personal Entity</label>
                <select
                  value={formEntityId}
                  onChange={(e) => setFormEntityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {(personalEntities.length > 0 ? personalEntities : entities).map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Deposit Account</label>
                <select
                  value={formAccountId}
                  onChange={(e) => setFormAccountId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {personalAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Job Title / Stream Name</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  placeholder="e.g. Evening Consulting / University"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Employer / Payer</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  placeholder="e.g. Tech Studio Lda"
                  value={formPayer}
                  onChange={(e) => setFormPayer(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">IRS Income Category</label>
                <select
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value as PersonalIncomeCategory)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {Object.entries(PERSONAL_INCOME_CATEGORY_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Payment Schedule</label>
                <select
                  value={formFrequency}
                  onChange={(e) => setFormFrequency(e.target.value as PersonalIncomeFrequency)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {Object.entries(FREQUENCY_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Gross Amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={formGross}
                  onChange={(e) => setFormGross(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">IRS Withheld %</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  required
                  value={formIrsRate}
                  onChange={(e) => setFormIrsRate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Social Sec %</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  required
                  value={formSsRate}
                  onChange={(e) => setFormSsRate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <label className="flex items-center gap-2.5 pt-1 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={formCountsIrs}
                onChange={(e) => setFormCountsIrs(e.target.checked)}
                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
              />
              <span>Include this income stream in annual Portuguese IRS Englobamento calculation</span>
            </label>

            <div className="flex justify-end gap-3 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={closeModal}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {editingItem ? 'Save Changes' : 'Add Income Source'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
