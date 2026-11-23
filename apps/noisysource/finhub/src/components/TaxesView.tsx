import React, { useMemo, useState } from 'react';
import { ArrowRight, Settings2, X } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type {
  Entity,
  FiscalRegion,
  IrsMaritalStatus,
  IvaPeriodicity,
  NavSection,
} from '../types/finance';
import {
  computeEntityIrcSummary,
  computeEntityIvaSummary,
  computePersonalIrsSummary,
  formatMoney,
} from '../utils/financeMath';

interface TaxesViewProps {
  settingsModalOpen: boolean;
  onOpenSettingsModal: () => void;
  onCloseSettingsModal: () => void;
  onNavigate: (section: NavSection) => void;
}

type TaxTab = 'iva' | 'irs' | 'irc';

const REGION_LABELS: Record<FiscalRegion, string> = {
  continente: 'Portugal Continental (23% / 13% / 6%)',
  madeira: 'Madeira (22% / 12% / 4%)',
  acores: 'Açores (16% / 9% / 4%)',
};

const IRS_2026_TABLE = [
  { label: '1.º Escalão', upTo: '€8,342', rate: '12.50%', abater: '€0.00' },
  { label: '2.º Escalão', upTo: '€12,587', rate: '15.70%', abater: '€266.94' },
  { label: '3.º Escalão', upTo: '€17,838', rate: '21.20%', abater: '€959.26' },
  { label: '4.º Escalão', upTo: '€23,089', rate: '24.10%', abater: '€1,476.45' },
  { label: '5.º Escalão', upTo: '€29,397', rate: '31.10%', abater: '€3,092.77' },
  { label: '6.º Escalão', upTo: '€43,090', rate: '34.90%', abater: '€4,209.94' },
  { label: '7.º Escalão', upTo: '€46,566', rate: '43.10%', abater: '€7,743.27' },
  { label: '8.º Escalão', upTo: '€86,634', rate: '44.60%', abater: '€8,441.48' },
  { label: '9.º Escalão', upTo: '> €86,634', rate: '48.00%', abater: '€11,387.17' },
];

export function TaxesView({
  settingsModalOpen,
  onOpenSettingsModal,
  onCloseSettingsModal,
  onNavigate,
}: TaxesViewProps) {
  const {
    entities,
    transactions,
    payslips,
    creditFacilities,
    forecastItems,
    personalIncomes,
    employmentContracts,
    recurringExpenses,
    reimbursements,
    taxSettings,
    entityFilter,
    currencyCode,
    upsertTaxSetting,
  } = useTreasury();

  const [activeTab, setActiveTab] = useState<TaxTab>('iva');
  const [ivaMonthFilter, setIvaMonthFilter] = useState<string>('');
  const [ircMode, setIrcMode] = useState<'annualized' | 'actual'>('annualized');
  const [includeLedgerInIrs, setIncludeLedgerInIrs] = useState<boolean>(false);

  // Fiscal Settings Modal state
  const [editingEntity, setEditingEntity] = useState<Entity | null>(null);
  const [cfgEntityId, setCfgEntityId] = useState<string>(entities[0]?.id ?? '');
  const [cfgRegion, setCfgRegion] = useState<FiscalRegion>('continente');
  const [cfgIsPme, setCfgIsPme] = useState(true);
  const [cfgIvaPeriodicity, setCfgIvaPeriodicity] = useState<IvaPeriodicity>('quarterly');
  const [cfgDerrama, setCfgDerrama] = useState('1.5');
  const [cfgPaymentsOnAccount, setCfgPaymentsOnAccount] = useState('0');
  const [cfgMarital, setCfgMarital] = useState<IrsMaritalStatus>('single');
  const [cfgDependents, setCfgDependents] = useState('0');
  const [cfgDeductions, setCfgDeductions] = useState('500');

  const settingsByEntity = useMemo(
    () => new Map(taxSettings.map((s) => [s.entityId, s])),
    [taxSettings]
  );

  const companyEntities = useMemo(() => {
    const list = entities.filter((e) => e.entityType === 'company');
    if (entityFilter !== 'all') {
      return list.filter((e) => e.id === entityFilter);
    }
    return list;
  }, [entities, entityFilter]);

  const personalEntities = useMemo(
    () => entities.filter((e) => e.entityType === 'personal'),
    [entities]
  );

  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      if (tx.date && tx.date.length >= 7) set.add(tx.date.slice(0, 7));
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [transactions]);

  const ivaSummaries = useMemo(
    () =>
      companyEntities.map((ent) =>
        computeEntityIvaSummary({
          entity: ent,
          transactions,
          reimbursements,
          taxSetting: settingsByEntity.get(ent.id),
          monthPrefix: ivaMonthFilter || undefined,
        })
      ),
    [companyEntities, transactions, reimbursements, settingsByEntity, ivaMonthFilter]
  );

  const totalNetIva = useMemo(
    () => ivaSummaries.reduce((s, r) => s + r.netIvaPayable, 0),
    [ivaSummaries]
  );

  const ircSummaries = useMemo(
    () =>
      companyEntities.map((ent) =>
        computeEntityIrcSummary({
          entity: ent,
          transactions,
          payslips,
          creditFacilities,
          forecastItems,
          employmentContracts,
          recurringExpenses,
          reimbursements,
          taxSetting: settingsByEntity.get(ent.id),
          mode: ircMode,
        })
      ),
    [
      companyEntities,
      transactions,
      payslips,
      creditFacilities,
      forecastItems,
      employmentContracts,
      recurringExpenses,
      reimbursements,
      settingsByEntity,
      ircMode,
    ]
  );

  const totalNetIrcDue = useMemo(
    () => ircSummaries.reduce((s, r) => s + r.netIrcDue, 0),
    [ircSummaries]
  );

  const primaryPersonalEntity = personalEntities[0];
  const irsSummary = useMemo(
    () =>
      computePersonalIrsSummary({
        personalIncomes,
        employmentContracts,
        entities,
        personalEntityIds: personalEntities.map((e) => e.id),
        transactions,
        taxSetting: primaryPersonalEntity ? settingsByEntity.get(primaryPersonalEntity.id) : undefined,
        includeLedgerPersonalIncome: includeLedgerInIrs,
      }),
    [
      personalIncomes,
      employmentContracts,
      entities,
      personalEntities,
      transactions,
      primaryPersonalEntity,
      settingsByEntity,
      includeLedgerInIrs,
    ]
  );

  const combinedTaxExposure =
    Math.max(0, totalNetIva) +
    Math.max(0, totalNetIrcDue) +
    Math.max(0, irsSummary.estimatedPayableOrRefund);

  const openEntitySettings = (ent: Entity) => {
    const existing = settingsByEntity.get(ent.id);
    setEditingEntity(ent);
    setCfgEntityId(ent.id);
    setCfgRegion(existing?.region ?? 'continente');
    setCfgIsPme(existing?.isPme ?? true);
    setCfgIvaPeriodicity(
      existing?.ivaPeriodicity ?? (ent.entityType === 'personal' ? 'exempt' : 'quarterly')
    );
    setCfgDerrama(String(existing?.derramaRate ?? (ent.entityType === 'company' ? 1.5 : 0)));
    setCfgPaymentsOnAccount(String(existing?.ircPaymentsOnAccount ?? 0));
    setCfgMarital(existing?.irsMaritalStatus ?? 'single');
    setCfgDependents(String(existing?.irsDependents ?? 0));
    setCfgDeductions(String(existing?.irsDeductions ?? 500));
    onOpenSettingsModal();
  };

  // Sync modal state if opened via header CTA without a specific entity clicked
  const modalVisible = settingsModalOpen;
  const activeModalEntity =
    editingEntity ??
    entities.find((e) => e.id === cfgEntityId) ??
    (activeTab === 'irs' ? primaryPersonalEntity : companyEntities[0]) ??
    entities[0];

  const handleCloseModal = () => {
    setEditingEntity(null);
    onCloseSettingsModal();
  };

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Net IVA Position</p>
          <p
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              totalNetIva > 0 ? 'text-amber-300' : 'text-emerald-400'
            }`}
          >
            {formatMoney(Math.abs(totalNetIva), currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {totalNetIva >= 0 ? 'Payable to AT (Liquidado − Dedutível)' : 'Recoverable IVA Credit'}
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Projected Corporate IRC</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-blue-400 mt-2">
            {formatMoney(totalNetIrcDue, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {ircMode === 'annualized' ? '12-mo forecast basis' : 'Actual YTD ledger'} · PME &amp; Derrama
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">
            {irsSummary.estimatedPayableOrRefund <= 0 ? 'Personal IRS Refund Est.' : 'Personal IRS Payable Est.'}
          </p>
          <p
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              irsSummary.estimatedPayableOrRefund <= 0 ? 'text-emerald-400' : 'text-amber-300'
            }`}
          >
            {formatMoney(Math.abs(irsSummary.estimatedPayableOrRefund), currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            Across {irsSummary.sourcesBreakdown.length} IRS income streams
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Net Cash Tax Provision Needed</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-100 mt-2">
            {formatMoney(combinedTaxExposure, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">Combined IVA + IRC + IRS balance due</p>
        </div>
      </div>

      {/* Tab Bar + Fiscal Settings Trigger */}
      <div className="bg-[#0F172A] border border-slate-800 rounded-xl px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-[#1E293B] border border-slate-700/80 rounded-lg">
          {(
            [
              { id: 'iva', label: 'IVA (VAT)' },
              { id: 'irs', label: 'IRS (Personal)' },
              { id: 'irc', label: 'IRC (Corporate)' },
            ] as Array<{ id: TaxTab; label: string }>
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === t.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {activeTab === 'iva' && (
            <select
              value={ivaMonthFilter}
              onChange={(e) => setIvaMonthFilter(e.target.value)}
              className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100"
            >
              <option value="">All Recorded Periods</option>
              {availableMonths.map((m) => (
                <option key={m} value={m}>
                  Month: {m}
                </option>
              ))}
            </select>
          )}
          {activeTab === 'irc' && (
            <div className="flex items-center gap-1 p-1 bg-[#1E293B] border border-slate-700/80 rounded-lg">
              <button
                onClick={() => setIrcMode('annualized')}
                className={`px-2.5 py-1 text-xs rounded-md cursor-pointer ${
                  ircMode === 'annualized' ? 'bg-slate-700 text-white' : 'text-slate-400'
                }`}
              >
                Annualized Forecast
              </button>
              <button
                onClick={() => setIrcMode('actual')}
                className={`px-2.5 py-1 text-xs rounded-md cursor-pointer ${
                  ircMode === 'actual' ? 'bg-slate-700 text-white' : 'text-slate-400'
                }`}
              >
                Actual YTD
              </button>
            </div>
          )}
          <button
            onClick={() => {
              const target =
                (activeTab === 'irs' ? primaryPersonalEntity : companyEntities[0]) ?? entities[0];
              if (target) openEntitySettings(target);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>Tax Parameters</span>
          </button>
        </div>
      </div>

      {/* TAB 1: IVA */}
      {activeTab === 'iva' && (
        <div className="space-y-6">
          <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  IVA Liquidado vs. IVA Dedutível by Company
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Calculated automatically from IVA-tagged ledger invoices, deductible supplier expenses, and invoiced cross-entity reimbursements
                </p>
              </div>
              <button
                onClick={() => onNavigate('ledger')}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 cursor-pointer"
              >
                <span>Tag Invoices in Ledger</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {ivaSummaries.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No company entities in the current scope. Switch entity filter or add a company under Accounts.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th className="py-3 px-6 font-medium">Company</th>
                      <th className="py-3 px-4 font-medium">Regime</th>
                      <th className="py-3 px-4 font-medium text-right">Sales (Net Base)</th>
                      <th className="py-3 px-4 font-medium text-right">IVA Liquidado (+)</th>
                      <th className="py-3 px-4 font-medium text-right">Purchases Gross</th>
                      <th className="py-3 px-4 font-medium text-right">IVA Dedutível (-)</th>
                      <th className="py-3 px-6 font-medium text-right">Net IVA Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {ivaSummaries.map((row) => {
                      const ent = companyEntities.find((e) => e.id === row.entityId);
                      return (
                        <tr key={row.entityId} className="hover:bg-slate-800/40">
                          <td className="py-3.5 px-6 font-medium text-slate-100">
                            <button
                              onClick={() => ent && openEntitySettings(ent)}
                              className="text-left hover:text-blue-400 cursor-pointer"
                            >
                              {row.entityName}
                            </button>
                          </td>
                          <td className="py-3.5 px-4 text-xs text-slate-400 capitalize">
                            {row.periodicity}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-300">
                            {formatMoney(row.salesBaseNet, currencyCode)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums text-amber-300">
                            {formatMoney(row.ivaLiquidado, currencyCode)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-300">
                            {formatMoney(row.purchasesGross, currencyCode)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums text-emerald-400">
                            {formatMoney(row.ivaDedutivel, currencyCode)}
                          </td>
                          <td
                            className={`py-3.5 px-6 text-right font-mono tabular-nums font-semibold ${
                              row.netIvaPayable > 0 ? 'text-amber-300' : 'text-emerald-400'
                            }`}
                          >
                            {row.netIvaPayable >= 0 ? 'Pay ' : 'Credit '}
                            {formatMoney(Math.abs(row.netIvaPayable), currencyCode)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Breakdown by Tax Rate */}
          {ivaSummaries.some((s) => s.breakdownByRate.length > 0) && (
            <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold text-slate-100">IVA Breakdown by Rate Tier</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {ivaSummaries
                  .filter((s) => s.breakdownByRate.length > 0)
                  .map((s) => (
                    <div
                      key={s.entityId}
                      className="p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg space-y-3"
                    >
                      <p className="text-xs font-semibold text-slate-200">{s.entityName}</p>
                      <div className="divide-y divide-slate-800/80 text-xs">
                        {s.breakdownByRate.map((b) => (
                          <div
                            key={b.rate}
                            className="py-2 flex items-center justify-between font-mono tabular-nums"
                          >
                            <span className="text-slate-300">IVA {b.rate}%</span>
                            <span className="text-amber-300">
                              Liq: {formatMoney(b.liquidado, currencyCode)}
                            </span>
                            <span className="text-emerald-400">
                              Ded: {formatMoney(b.dedutivel, currencyCode)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* TAB 2: IRS */}
      {activeTab === 'irs' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Calculation Waterfall */}
            <section className="lg:col-span-7 bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-100">
                    2026 Personal IRS Aggregation (Englobamento)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Combines all active personal jobs &amp; side incomes flagged for IRS
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeLedgerInIrs}
                    onChange={(e) => setIncludeLedgerInIrs(e.target.checked)}
                    className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                  />
                  <span>Include Personal Ledger Receipts</span>
                </label>
              </div>

              <div className="divide-y divide-slate-800/80 text-sm">
                <div className="py-2.5 flex justify-between">
                  <span className="text-slate-300">Total Gross Annual Income</span>
                  <span className="font-mono tabular-nums font-medium text-slate-100">
                    {formatMoney(irsSummary.totalGrossIncome, currencyCode)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between text-xs">
                  <span className="text-slate-400">
                    Specific Deduction (Cat. A max €4,462.15 / SS) &amp; Cat. B 25% Coefficient
                  </span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    -{formatMoney(irsSummary.totalGrossIncome - irsSummary.taxableIncome, currencyCode)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="font-medium text-slate-200">Taxable Income (Rendimento Coletável)</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-100">
                    {formatMoney(irsSummary.taxableIncome, currencyCode)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between text-xs">
                  <span className="text-slate-400">
                    2026 Bracket ({irsSummary.bracketLabel} · Divisor {irsSummary.quotientDivisor})
                  </span>
                  <span className="font-mono tabular-nums text-slate-300">
                    Parcela a abater {formatMoney(irsSummary.parcelaAbater, currencyCode)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="text-slate-300">Gross IRS Collect (Coleta Total)</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {formatMoney(irsSummary.grossIrsTax, currencyCode)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between text-xs">
                  <span className="text-slate-400">
                    General Deductions (e-Fatura) &amp; Dependent Credits
                  </span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    -{formatMoney(irsSummary.generalDeductions + irsSummary.dependentCredits, currencyCode)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="font-medium text-slate-200">Net Annual IRS Liability</span>
                  <span className="font-mono tabular-nums font-semibold text-blue-400">
                    {formatMoney(irsSummary.netIrsLiability, currencyCode)}
                  </span>
                </div>
                <div className="py-2.5 flex justify-between">
                  <span className="text-slate-300">Already Withheld Across Jobs (Retenção)</span>
                  <span className="font-mono tabular-nums text-emerald-400">
                    -{formatMoney(irsSummary.totalWithheldAtSource, currencyCode)}
                  </span>
                </div>
                <div className="pt-3 flex justify-between items-center">
                  <span className="font-semibold text-slate-100">
                    {irsSummary.estimatedPayableOrRefund <= 0
                      ? 'Estimated Annual IRS Refund'
                      : 'Estimated Additional IRS Payable'}
                  </span>
                  <span
                    className={`text-lg font-mono tabular-nums font-semibold ${
                      irsSummary.estimatedPayableOrRefund <= 0 ? 'text-emerald-400' : 'text-amber-300'
                    }`}
                  >
                    {formatMoney(Math.abs(irsSummary.estimatedPayableOrRefund), currencyCode)}
                  </span>
                </div>
              </div>
            </section>

            {/* 2026 Brackets Reference */}
            <section className="lg:col-span-5 bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100">Portugal 2026 IRS Brackets</h3>
                <button
                  onClick={() => onNavigate('personal_income')}
                  className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                >
                  Manage Jobs
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-4 font-medium">Escalão</th>
                      <th className="py-2.5 px-3 font-medium text-right">Coletável</th>
                      <th className="py-2.5 px-3 font-medium text-right">Taxa</th>
                      <th className="py-2.5 px-4 font-medium text-right">Abater</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 font-mono tabular-nums">
                    {IRS_2026_TABLE.map((b) => {
                      const active = irsSummary.bracketLabel.startsWith(b.label);
                      return (
                        <tr
                          key={b.label}
                          className={active ? 'bg-blue-950/40 text-blue-300' : 'text-slate-300'}
                        >
                          <td className="py-2 px-4 font-sans font-medium">{b.label}</td>
                          <td className="py-2 px-3 text-right">{b.upTo}</td>
                          <td className="py-2 px-3 text-right">{b.rate}</td>
                          <td className="py-2 px-4 text-right">{b.abater}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {/* Sources Breakdown */}
          <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Contributing Personal Jobs &amp; Income Streams
              </h3>
              <button
                onClick={() => onNavigate('personal_income')}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 cursor-pointer"
              >
                <span>Edit Personal Jobs</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            {irsSummary.sourcesBreakdown.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No active personal income streams flagged for IRS. Add jobs under Personal Income.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th className="py-3 px-6 font-medium">Source</th>
                      <th className="py-3 px-4 font-medium">Category</th>
                      <th className="py-3 px-4 font-medium text-right">Annual Gross</th>
                      <th className="py-3 px-4 font-medium text-right">Taxable Base</th>
                      <th className="py-3 px-4 font-medium text-right">IRS Withheld</th>
                      <th className="py-3 px-6 font-medium text-right">Annual Net Cash</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {irsSummary.sourcesBreakdown.map((src) => (
                      <tr key={src.id} className="hover:bg-slate-800/40">
                        <td className="py-3 px-6 font-medium text-slate-100">{src.title}</td>
                        <td className="py-3 px-4 text-xs text-slate-400">{src.categoryLabel}</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                          {formatMoney(src.annualGross, currencyCode)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                          {formatMoney(src.annualTaxable, currencyCode)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-blue-400">
                          {formatMoney(src.annualWithheld, currencyCode)}
                        </td>
                        <td className="py-3 px-6 text-right font-mono tabular-nums font-medium text-emerald-400">
                          {formatMoney(src.annualNetCash, currencyCode)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 3: IRC */}
      {activeTab === 'irc' && (
        <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800">
            <h2 className="text-base font-semibold text-slate-100">
              Corporate IRC Projection &amp; Derrama Municipal (2026)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Applies PME 15% on the first €50,000 taxable profit + 19% excess (or regional Madeira/Açores rates) plus Derrama minus Pagamentos por Conta
            </p>
          </div>

          {ircSummaries.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No company entities in the current scope.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400">
                    <th className="py-3 px-6 font-medium">Company</th>
                    <th className="py-3 px-3 font-medium text-right">Revenue (Net IVA)</th>
                    <th className="py-3 px-3 font-medium text-right">OpEx + Payroll + Int.</th>
                    <th className="py-3 px-3 font-medium text-right">Taxable Profit</th>
                    <th className="py-3 px-3 font-medium text-right">IRC + Derrama</th>
                    <th className="py-3 px-3 font-medium text-right">On Account</th>
                    <th className="py-3 px-6 font-medium text-right">Net IRC Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {ircSummaries.map((row) => {
                    const ent = companyEntities.find((e) => e.id === row.entityId);
                    const totalDeductions =
                      row.operatingExpensesNetIva + row.payrollEmployerCost + row.loanInterestEstimate;
                    return (
                      <tr key={row.entityId} className="hover:bg-slate-800/40">
                        <td className="py-3.5 px-6">
                          <button
                            onClick={() => ent && openEntitySettings(ent)}
                            className="text-left font-medium text-slate-100 hover:text-blue-400 cursor-pointer"
                          >
                            {row.entityName}
                          </button>
                          <p className="text-xs text-slate-400">
                            {row.isPme ? 'PME Reduced Bracket' : 'Standard Rate'} · Eff.{' '}
                            {row.effectiveRatePct.toFixed(1)}%
                          </p>
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-200">
                          {formatMoney(row.revenueNetIva, currencyCode)}
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums text-slate-400">
                          {formatMoney(totalDeductions, currencyCode)}
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums font-medium text-slate-100">
                          {formatMoney(row.taxableProfit, currencyCode)}
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums text-amber-300">
                          {formatMoney(row.totalIrcLiability, currencyCode)}
                        </td>
                        <td className="py-3.5 px-3 text-right font-mono tabular-nums text-emerald-400">
                          -{formatMoney(row.paymentsOnAccount, currencyCode)}
                        </td>
                        <td className="py-3.5 px-6 text-right font-mono tabular-nums font-semibold text-blue-400">
                          {formatMoney(row.netIrcDue, currencyCode)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Fiscal Parameters Modal */}
      {modalVisible && activeModalEntity && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={handleCloseModal} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await upsertTaxSetting({
                entityId: activeModalEntity.id,
                region: cfgRegion,
                isPme: cfgIsPme,
                ivaPeriodicity: cfgIvaPeriodicity,
                derramaRate: Number(cfgDerrama) || 0,
                ircPaymentsOnAccount: Number(cfgPaymentsOnAccount) || 0,
                irsMaritalStatus: cfgMarital,
                irsDependents: Number(cfgDependents) || 0,
                irsDeductions: Number(cfgDeductions) || 0,
              });
              handleCloseModal();
            }}
            className="relative z-10 max-w-lg w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Entity Fiscal Parameters</h3>
              <button
                type="button"
                onClick={handleCloseModal}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">Entity</label>
              <select
                value={activeModalEntity.id}
                onChange={(e) => {
                  const found = entities.find((ent) => ent.id === e.target.value);
                  if (found) openEntitySettings(found);
                }}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              >
                {entities.map((ent) => (
                  <option key={ent.id} value={ent.id}>
                    {ent.name} ({ent.entityType === 'personal' ? 'Personal' : 'Company'})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Fiscal Region</label>
                <select
                  value={cfgRegion}
                  onChange={(e) => setCfgRegion(e.target.value as FiscalRegion)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {Object.entries(REGION_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">IVA Periodicity</label>
                <select
                  value={cfgIvaPeriodicity}
                  onChange={(e) => setCfgIvaPeriodicity(e.target.value as IvaPeriodicity)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="quarterly">Quarterly (Trimestral)</option>
                  <option value="monthly">Monthly (Mensal)</option>
                  <option value="exempt">Exempt (Art. 53 / Personal)</option>
                </select>
              </div>
            </div>

            {activeModalEntity.entityType === 'company' ? (
              <div className="space-y-3 pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cfgIsPme}
                    onChange={(e) => setCfgIsPme(e.target.checked)}
                    className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                  />
                  <span>Certified PME (15% IRC on first €50,000 taxable profit)</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Derrama Municipal %</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="5"
                      value={cfgDerrama}
                      onChange={(e) => setCfgDerrama(e.target.value)}
                      className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Pagamentos por Conta</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={cfgPaymentsOnAccount}
                      onChange={(e) => setCfgPaymentsOnAccount(e.target.value)}
                      className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3 pt-1">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">IRS Filing</label>
                  <select
                    value={cfgMarital}
                    onChange={(e) => setCfgMarital(e.target.value as IrsMaritalStatus)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                  >
                    <option value="single">Single (/1)</option>
                    <option value="married_joint">Joint (/2)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Dependents</label>
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={cfgDependents}
                    onChange={(e) => setCfgDependents(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">e-Fatura Ded.</label>
                  <input
                    type="number"
                    step="10"
                    min="0"
                    value={cfgDeductions}
                    onChange={(e) => setCfgDeductions(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={handleCloseModal}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                Save Tax Settings
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
