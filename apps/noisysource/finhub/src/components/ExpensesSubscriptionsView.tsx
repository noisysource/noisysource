import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Pause,
  Pencil,
  Play,
  Plus,
  Receipt,
  Repeat,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type {
  BillingFrequency,
  ExpenseReimbursement,
  NavSection,
  RecurringExpense,
} from '../types/finance';
import {
  computeReimbursementPairs,
  computeSubscriptionMonthlyEquivalent,
  computeTransactionIva,
  formatMoney,
  getIvaRatesForRegion,
  isVoucherAccountType,
  todayIsoDate,
  type ReimbursementPairSummary,
} from '../utils/financeMath';

interface ExpensesSubscriptionsViewProps {
  createSubModalOpen: boolean;
  onOpenCreateSubModal: () => void;
  onCloseCreateSubModal: () => void;
  onNavigate: (section: NavSection) => void;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function ExpensesSubscriptionsView({
  createSubModalOpen,
  onOpenCreateSubModal,
  onCloseCreateSubModal,
  onNavigate,
}: ExpensesSubscriptionsViewProps) {
  const {
    entities,
    accounts,
    creditFacilities,
    taxSettings,
    filteredFacilities,
    filteredRecurringExpenses,
    filteredReimbursements,
    invoiceDocuments,
    currencyCode,
    entityFilter,
    addRecurringExpense,
    updateRecurringExpense,
    toggleRecurringExpense,
    deleteRecurringExpense,
    postRecurringExpensePayment,
    addCrossEntityExpense,
    settleReimbursements,
    deleteReimbursement,
  } = useTreasury();

  // Subscriptions filtering
  const [subFilter, setSubFilter] = useState<'all' | 'monthly' | 'annual' | 'credit' | 'reimbursable'>('all');
  const [subSearch, setSubSearch] = useState('');

  // Reimbursements view tab
  const [reimbTab, setReimbTab] = useState<'open' | 'settled'>('open');

  // Create / Edit Subscription Modal
  const [editingSub, setEditingSub] = useState<RecurringExpense | null>(null);
  const [subEntityId, setSubEntityId] = useState('');
  const [subPaidByAccountId, setSubPaidByAccountId] = useState('');
  const [subFacilityId, setSubFacilityId] = useState('');
  const [subName, setSubName] = useState('');
  const [subVendor, setSubVendor] = useState('');
  const [subCategory, setSubCategory] = useState('SaaS & Productivity');
  const [subAmount, setSubAmount] = useState('29.90');
  const [subFrequency, setSubFrequency] = useState<BillingFrequency>('monthly');
  const [subBillingDay, setSubBillingDay] = useState('15');
  const [subBillingMonth, setSubBillingMonth] = useState(
    String(new Date().getUTCMonth() + 1)
  );
  const [subIvaRate, setSubIvaRate] = useState('23');
  const [subIvaDeductible, setSubIvaDeductible] = useState(true);
  const [subHasInvoice, setSubHasInvoice] = useState(true);
  const [savingSub, setSavingSub] = useState(false);

  // One-off Cross-Entity Expense Modal
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [expOwnerEntityId, setExpOwnerEntityId] = useState('');
  const [expPaidByAccountId, setExpPaidByAccountId] = useState('');
  const [expFacilityId, setExpFacilityId] = useState('');
  const [expDate, setExpDate] = useState(todayIsoDate());
  const [expVendor, setExpVendor] = useState('');
  const [expDescription, setExpDescription] = useState('');
  const [expCategory, setExpCategory] = useState('Software & Supplies');
  const [expAmount, setExpAmount] = useState('120');
  const [expIvaRate, setExpIvaRate] = useState('23');
  const [expIvaDeductible, setExpIvaDeductible] = useState(true);
  const [expHasInvoice, setExpHasInvoice] = useState(true);
  const [expInvoiceNum, setExpInvoiceNum] = useState('');
  const [expDebitAccount, setExpDebitAccount] = useState(true);
  const [savingExp, setSavingExp] = useState(false);

  // Post Subscription Charge Modal
  const [postingSub, setPostingSub] = useState<RecurringExpense | null>(null);
  const [postDate, setPostDate] = useState(todayIsoDate());
  const [postInvoiceNum, setPostInvoiceNum] = useState('');
  const [postingSaving, setPostingSaving] = useState(false);

  // Settle Reimbursements Modal
  const [settlingClaims, setSettlingClaims] = useState<ExpenseReimbursement[]>([]);
  const [settleTitle, setSettleTitle] = useState('');
  const [settleFromAccId, setSettleFromAccId] = useState('');
  const [settleToAccId, setSettleToAccId] = useState('');
  const [settleDate, setSettleDate] = useState(todayIsoDate());
  const [settlingSaving, setSettlingSaving] = useState(false);

  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const facilityMap = useMemo(
    () => new Map(creditFacilities.map((f) => [f.id, f])),
    [creditFacilities]
  );
  const taxSettingMap = useMemo(
    () => new Map(taxSettings.map((s) => [s.entityId, s])),
    [taxSettings]
  );

  const companyEntities = useMemo(
    () => entities.filter((e) => e.entityType === 'company'),
    [entities]
  );
  const personalEntities = useMemo(
    () => entities.filter((e) => e.entityType === 'personal'),
    [entities]
  );

  const defaultOwnerEntityId =
    entityFilter !== 'all'
      ? entityFilter
      : companyEntities[0]?.id ?? entities[0]?.id ?? '';

  const openClaims = useMemo(
    () => filteredReimbursements.filter((r) => r.status === 'open'),
    [filteredReimbursements]
  );
  const settledClaims = useMemo(
    () => filteredReimbursements.filter((r) => r.status === 'settled'),
    [filteredReimbursements]
  );

  const reimbursementPairs = useMemo(
    () => computeReimbursementPairs(filteredReimbursements, entities),
    [filteredReimbursements, entities]
  );

  const kpis = useMemo(() => {
    const activeSubs = filteredRecurringExpenses.filter((e) => e.active);
    const monthlyEquiv = activeSubs.reduce(
      (s, e) => s + computeSubscriptionMonthlyEquivalent(e),
      0
    );
    const annualSubsTotal = activeSubs
      .filter((e) => e.frequency === 'annual')
      .reduce((s, e) => s + e.amount, 0);
    const openReimbTotal = openClaims.reduce((s, r) => s + r.amount, 0);
    const activeLoanMonthly = filteredFacilities
      .filter((f) => f.status === 'active')
      .reduce((s, f) => s + f.monthlyPayment, 0);

    return {
      monthlyEquiv,
      annualizedSubs: monthlyEquiv * 12,
      annualSubsTotal,
      annualSubsCount: activeSubs.filter((e) => e.frequency === 'annual').length,
      openReimbTotal,
      openReimbCount: openClaims.length,
      activeLoanMonthly,
      activeLoanCount: filteredFacilities.filter((f) => f.status === 'active').length,
    };
  }, [filteredRecurringExpenses, openClaims, filteredFacilities]);

  const visibleSubscriptions = useMemo(() => {
    const q = subSearch.trim().toLowerCase();
    return filteredRecurringExpenses.filter((sub) => {
      if (subFilter === 'monthly' && sub.frequency !== 'monthly') return false;
      if (subFilter === 'annual' && sub.frequency !== 'annual') return false;
      if (subFilter === 'credit' && !sub.creditFacilityId) return false;
      if (subFilter === 'reimbursable' && !sub.requiresReimbursement) return false;
      if (
        q &&
        !sub.name.toLowerCase().includes(q) &&
        !sub.vendor.toLowerCase().includes(q) &&
        !sub.category.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [filteredRecurringExpenses, subFilter, subSearch]);

  const activeCreditLoans = useMemo(
    () => filteredFacilities.filter((f) => f.status === 'active' && f.monthlyPayment > 0),
    [filteredFacilities]
  );

  // Modal helpers
  const initSubFormDefaults = () => {
    const ownerId = defaultOwnerEntityId;
    const ownerEnt = entityMap.get(ownerId);
    const defaultAcc =
      accounts.find((a) => a.entityId === ownerId) ?? accounts[0];
    setEditingSub(null);
    setSubEntityId(ownerId);
    setSubPaidByAccountId(defaultAcc?.id ?? '');
    setSubFacilityId('');
    setSubName('');
    setSubVendor('');
    setSubCategory(
      ownerEnt?.entityType === 'personal' ? 'Personal Subscriptions' : 'SaaS & Productivity'
    );
    setSubAmount('29.90');
    setSubFrequency('monthly');
    setSubBillingDay('15');
    setSubBillingMonth(String(new Date().getUTCMonth() + 1));
    setSubIvaRate(ownerEnt?.entityType === 'company' ? '23' : '0');
    setSubIvaDeductible(ownerEnt?.entityType === 'company');
    setSubHasInvoice(ownerEnt?.entityType === 'company');
  };

  useEffect(() => {
    if (createSubModalOpen && !editingSub) {
      initSubFormDefaults();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSubModalOpen, editingSub]);

  const openEditSub = (sub: RecurringExpense) => {
    setEditingSub(sub);
    setSubEntityId(sub.entityId);
    setSubPaidByAccountId(sub.paidByAccountId);
    setSubFacilityId(sub.creditFacilityId || '');
    setSubName(sub.name);
    setSubVendor(sub.vendor);
    setSubCategory(sub.category);
    setSubAmount(String(sub.amount));
    setSubFrequency(sub.frequency);
    setSubBillingDay(String(sub.billingDay));
    setSubBillingMonth(String(sub.billingMonth));
    setSubIvaRate(String(sub.ivaRate));
    setSubIvaDeductible(sub.ivaDeductible);
    setSubHasInvoice(sub.hasInvoice);
    onOpenCreateSubModal();
  };

  const handleCloseSubModal = () => {
    setEditingSub(null);
    onCloseCreateSubModal();
  };

  const openCrossEntityModal = () => {
    const compId = companyEntities[0]?.id ?? defaultOwnerEntityId;
    const persAcc =
      accounts.find((a) => personalEntities.some((p) => p.id === a.entityId)) ??
      accounts[0];
    setExpOwnerEntityId(compId);
    setExpPaidByAccountId(persAcc?.id ?? '');
    setExpFacilityId('');
    setExpDate(todayIsoDate());
    setExpVendor('');
    setExpDescription('');
    setExpCategory('Software & Supplies');
    setExpAmount('120');
    setExpIvaRate('23');
    setExpIvaDeductible(true);
    setExpHasInvoice(true);
    setExpInvoiceNum('');
    setExpDebitAccount(true);
    setExpenseModalOpen(true);
  };

  const openSettleForPair = (pair: ReimbursementPairSummary) => {
    const claims = openClaims.filter(
      (c) =>
        c.owedByEntityId === pair.owedByEntityId &&
        c.owedToEntityId === pair.owedToEntityId
    );
    if (claims.length === 0) return;
    const fromAcc =
      accounts.find((a) => a.entityId === pair.owedByEntityId) ?? accounts[0];
    const toAcc =
      accounts.find((a) => a.id === claims[0].paidByAccountId) ??
      accounts.find((a) => a.entityId === pair.owedToEntityId) ??
      accounts[0];
    setSettlingClaims(claims);
    setSettleTitle(`${pair.owedByName} → ${pair.owedToName}`);
    setSettleFromAccId(fromAcc?.id ?? '');
    setSettleToAccId(toAcc?.id ?? '');
    setSettleDate(todayIsoDate());
  };

  const openSettleSingle = (claim: ExpenseReimbursement) => {
    const fromAcc =
      accounts.find((a) => a.entityId === claim.owedByEntityId) ?? accounts[0];
    const toAcc =
      accounts.find((a) => a.id === claim.paidByAccountId) ??
      accounts.find((a) => a.entityId === claim.owedToEntityId) ??
      accounts[0];
    setSettlingClaims([claim]);
    setSettleTitle(claim.description);
    setSettleFromAccId(fromAcc?.id ?? '');
    setSettleToAccId(toAcc?.id ?? '');
    setSettleDate(todayIsoDate());
  };

  // Resolved form previews
  const resolvedSubOwnerId = subEntityId || defaultOwnerEntityId;
  const resolvedSubPaidAcc =
    accountMap.get(subPaidByAccountId) ?? accounts[0];
  const subCrossEntity =
    Boolean(resolvedSubPaidAcc) &&
    resolvedSubOwnerId !== resolvedSubPaidAcc.entityId;
  const subRegion =
    taxSettingMap.get(resolvedSubOwnerId)?.region ?? 'continente';
  const subRegionRates = getIvaRatesForRegion(subRegion);

  const resolvedExpOwnerId = expOwnerEntityId || defaultOwnerEntityId;
  const resolvedExpPaidAcc =
    accountMap.get(expPaidByAccountId) ?? accounts[0];
  const expCrossEntity =
    Boolean(resolvedExpPaidAcc) &&
    resolvedExpOwnerId !== resolvedExpPaidAcc.entityId;
  const expRegion =
    taxSettingMap.get(resolvedExpOwnerId)?.region ?? 'continente';
  const expRegionRates = getIvaRatesForRegion(expRegion);

  const settleTotalAmount = useMemo(
    () => settlingClaims.reduce((s, c) => s + c.amount, 0),
    [settlingClaims]
  );

  const visibleClaims = reimbTab === 'open' ? openClaims : settledClaims;

  return (
    <div className="space-y-6">
      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Monthly Subscription Run-Rate</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(kpis.monthlyEquiv, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
            {formatMoney(kpis.annualizedSubs, currencyCode)} / yr annualized
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Annual Renewals Committed</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-blue-400 mt-2">
            {formatMoney(kpis.annualSubsTotal, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {kpis.annualSubsCount} annual {kpis.annualSubsCount === 1 ? 'plan' : 'plans'} scheduled
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Open Inter-Entity Reimbursements</p>
          <p
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              kpis.openReimbTotal > 0 ? 'text-amber-300' : 'text-emerald-400'
            }`}
          >
            {formatMoney(kpis.openReimbTotal, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {kpis.openReimbCount} invoiced {kpis.openReimbCount === 1 ? 'claim' : 'claims'} awaiting return
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Loan &amp; Credit Monthly Obligations</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-100 mt-2">
            {formatMoney(kpis.activeLoanMonthly, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            Across {kpis.activeLoanCount} active credit{' '}
            {kpis.activeLoanCount === 1 ? 'facility' : 'facilities'}
          </p>
        </div>
      </div>

      {/* SECTION 1: Who Owes Whom — Inter-Entity Reimbursements */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Who Owes Whom · Invoiced Cross-Entity Reimbursements
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Company expenses or subscriptions paid from personal accounts with a valid invoice (fatura) stay tracked here for repayment and IVA/IRC credit
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-[#1E293B] border border-slate-700/80 rounded-lg">
              <button
                onClick={() => setReimbTab('open')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  reimbTab === 'open' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Open ({openClaims.length})
              </button>
              <button
                onClick={() => setReimbTab('settled')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  reimbTab === 'settled' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                Settled ({settledClaims.length})
              </button>
            </div>
            <button
              onClick={openCrossEntityModal}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Receipt className="w-3.5 h-3.5" />
              <span>Log Out-of-Pocket Invoice</span>
            </button>
          </div>
        </div>

        {/* Net Pairwise Summary Bar ("Company A owes Personal €365.00") */}
        {reimbursementPairs.length > 0 && (
          <div className="px-6 py-4 bg-[#111827]/70 border-b border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-4">
            {reimbursementPairs.map((pair) => (
              <div
                key={`${pair.owedByEntityId}_${pair.owedToEntityId}`}
                className="flex items-center justify-between gap-4 p-4 bg-[#1E293B]/60 border border-slate-800 rounded-lg"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-100 truncate">
                    {pair.owedByName}{' '}
                    <span className="text-slate-400 font-normal">owes</span>{' '}
                    <span className="text-sky-400">{pair.owedToName}</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
                    {pair.openCount} open {pair.openCount === 1 ? 'invoice' : 'invoices'}
                    {pair.deductibleIvaTotal > 0
                      ? ` · Deductible IVA ${formatMoney(pair.deductibleIvaTotal, currencyCode)}`
                      : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-base font-mono tabular-nums font-semibold text-amber-300">
                    {formatMoney(pair.totalOwed, currencyCode)}
                  </span>
                  <button
                    onClick={() => openSettleForPair(pair)}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Settle All
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {visibleClaims.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            {reimbTab === 'open'
              ? 'No open inter-entity reimbursements. All out-of-pocket company invoices are settled.'
              : 'No settled reimbursement history yet.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Date</th>
                  <th className="py-3 px-4 font-medium">Vendor &amp; Description</th>
                  <th className="py-3 px-4 font-medium">Invoice / IVA</th>
                  <th className="py-3 px-4 font-medium">Paid From</th>
                  <th className="py-3 px-4 font-medium">Owes Whom</th>
                  <th className="py-3 px-4 font-medium text-right">Amount</th>
                  <th className="py-3 px-6 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {visibleClaims.map((claim) => {
                  const debtor = entityMap.get(claim.owedByEntityId)?.name ?? 'Entity';
                  const creditor = entityMap.get(claim.owedToEntityId)?.name ?? 'Entity';
                  const paidAcc = accountMap.get(claim.paidByAccountId)?.name ?? 'Account';
                  const linkedDoc = invoiceDocuments.find(
                    (d) =>
                      d.reimbursementId === claim.id ||
                      (claim.transactionId && d.transactionId === claim.transactionId)
                  );
                  const driveUrl = claim.driveWebViewLink || linkedDoc?.driveWebViewLink || '';
                  const driveFolder = claim.driveFolderPath || linkedDoc?.driveFolderPath || '';
                  return (
                    <tr key={claim.id} className="hover:bg-slate-800/40">
                      <td className="py-3.5 px-6 text-xs font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {claim.date}
                      </td>
                      <td className="py-3.5 px-4">
                        <p className="font-medium text-slate-100">{claim.description}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{claim.vendor}</p>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300 font-mono tabular-nums">
                        <p>{claim.invoiceNumber || 'Invoice attached'}</p>
                        <p className="text-slate-400 mt-0.5">
                          {claim.ivaRate > 0
                            ? `IVA ${claim.ivaRate}% (${formatMoney(claim.ivaAmount, currencyCode)})${
                                claim.ivaDeductible ? ' · Dedutível' : ''
                              }`
                            : 'IVA 0%'}
                        </p>
                        {driveUrl && (
                          <div className="mt-1 space-y-0.5">
                            {driveFolder && (
                              <p className="text-[11px] text-slate-400 truncate max-w-[180px]">
                                {driveFolder}
                              </p>
                            )}
                            <a
                              href={driveUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-sans font-medium"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>Open Invoice PDF</span>
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300">{paidAcc}</td>
                      <td className="py-3.5 px-4 text-xs">
                        <span className="text-amber-300">{debtor}</span>
                        <span className="text-slate-500"> → </span>
                        <span className="text-sky-400">{creditor}</span>
                        {claim.status === 'settled' && claim.settledDate && (
                          <p className="text-[11px] text-emerald-400 font-mono tabular-nums mt-0.5">
                            Settled {claim.settledDate}
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-100">
                        {formatMoney(claim.amount, currencyCode)}
                      </td>
                      <td className="py-3.5 px-6 text-right">
                        <div className="inline-flex items-center gap-2">
                          {claim.status === 'open' ? (
                            <button
                              onClick={() => openSettleSingle(claim)}
                              className="px-2.5 py-1 bg-[#1E293B] hover:bg-emerald-600 border border-slate-700 hover:border-emerald-500 text-xs font-medium text-slate-100 rounded-md whitespace-nowrap cursor-pointer"
                            >
                              Reimburse
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Settled</span>
                            </span>
                          )}
                          <button
                            onClick={() => void deleteReimbursement(claim.id)}
                            aria-label={`Delete ${claim.description}`}
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

      {/* SECTION 2: Subscriptions & Recurring Services */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Subscriptions &amp; Recurring Services
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Monthly and annual plans (e.g. Google Workspace, Netflix) paid from any entity account or credit card, synced to Calendar, Forecast, and Taxes
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Filter service or vendor..."
                value={subSearch}
                onChange={(e) => setSubSearch(e.target.value)}
                className="bg-[#1E293B] border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-100 w-48 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-1 p-1 bg-[#1E293B] border border-slate-700/80 rounded-lg">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'monthly', label: 'Monthly' },
                  { id: 'annual', label: 'Annual' },
                  { id: 'credit', label: 'Credit-Linked' },
                  { id: 'reimbursable', label: 'Reimbursable' },
                ] as Array<{ id: typeof subFilter; label: string }>
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setSubFilter(tab.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    subFilter === tab.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                initSubFormDefaults();
                onOpenCreateSubModal();
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Subscription</span>
            </button>
          </div>
        </div>

        {visibleSubscriptions.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No subscriptions match this filter. Add a monthly or annual service to track renewals and cross-entity billing.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Service &amp; Vendor</th>
                  <th className="py-3 px-4 font-medium">Owner &amp; Paying Account</th>
                  <th className="py-3 px-4 font-medium">Billing Cycle</th>
                  <th className="py-3 px-4 font-medium">IVA &amp; Invoice</th>
                  <th className="py-3 px-4 font-medium text-right">Amount</th>
                  <th className="py-3 px-6 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {visibleSubscriptions.map((sub) => {
                  const ownerName = entityMap.get(sub.entityId)?.name ?? 'Entity';
                  const paidAccount = accountMap.get(sub.paidByAccountId);
                  const payerEntityName = entityMap.get(sub.paidByEntityId)?.name ?? 'Entity';
                  const linkedFac = sub.creditFacilityId
                    ? facilityMap.get(sub.creditFacilityId)
                    : undefined;
                  const monthEquiv = computeSubscriptionMonthlyEquivalent(sub);

                  return (
                    <tr
                      key={sub.id}
                      className={`hover:bg-slate-800/40 transition-colors ${
                        sub.active ? '' : 'opacity-50'
                      }`}
                    >
                      <td className="py-3.5 px-6">
                        <div className="flex items-start gap-2.5">
                          <Repeat className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                          <div>
                            <p className="font-medium text-slate-100">{sub.name}</p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {sub.vendor} · {sub.category}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs">
                        <p className="text-slate-200 font-medium">{ownerName}</p>
                        <p className="text-slate-400 mt-0.5">
                          Paid by {paidAccount?.name ?? 'Account'} ({payerEntityName})
                        </p>
                        {linkedFac && (
                          <p className="text-sky-400 mt-0.5">
                            Via Credit: {linkedFac.name}
                          </p>
                        )}
                        {paidAccount && isVoucherAccountType(paidAccount.accountType) && (
                          <p className="text-sky-400 mt-0.5">
                            Voucher-first · overflows to primary checking if short
                          </p>
                        )}
                        {sub.requiresReimbursement && (
                          <p className="text-amber-300 mt-0.5">
                            Cross-entity · Generates reimbursement claim on post
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-slate-300">
                        <p>
                          {sub.frequency === 'annual'
                            ? `Annual · ${MONTH_NAMES[(sub.billingMonth - 1) % 12]} ${sub.billingDay}`
                            : `Monthly · Day ${sub.billingDay}`}
                        </p>
                        {sub.lastPostedDate && (
                          <p className="text-slate-500 mt-0.5">
                            Last posted {sub.lastPostedDate}
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300">
                        {sub.hasInvoice ? (
                          <p className="text-emerald-400">
                            Invoice (Fatura){sub.ivaRate > 0 ? ` · IVA ${sub.ivaRate}%` : ''}
                          </p>
                        ) : (
                          <p className="text-slate-400">No invoice</p>
                        )}
                        {sub.ivaDeductible && sub.ivaRate > 0 && (
                          <p className="text-slate-400 mt-0.5">IVA Dedutível</p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                        <p className="font-semibold text-slate-100">
                          {formatMoney(sub.amount, currencyCode)}
                          <span className="text-xs font-normal text-slate-400">
                            /{sub.frequency === 'annual' ? 'yr' : 'mo'}
                          </span>
                        </p>
                        {sub.frequency === 'annual' && (
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            {formatMoney(monthEquiv, currencyCode)}/mo eq.
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-6 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            onClick={() => {
                              setPostingSub(sub);
                              setPostDate(todayIsoDate());
                              setPostInvoiceNum('');
                            }}
                            className="px-2.5 py-1 bg-[#1E293B] hover:bg-blue-600 border border-slate-700 hover:border-blue-500 text-xs font-medium text-slate-100 rounded-md whitespace-nowrap cursor-pointer"
                          >
                            Post Charge
                          </button>
                          <button
                            onClick={() => void toggleRecurringExpense(sub.id, !sub.active)}
                            title={sub.active ? 'Pause' : 'Resume'}
                            aria-label={sub.active ? `Pause ${sub.name}` : `Resume ${sub.name}`}
                            className="p-1.5 text-slate-400 hover:text-slate-100 cursor-pointer"
                          >
                            {sub.active ? (
                              <Pause className="w-3.5 h-3.5" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => openEditSub(sub)}
                            aria-label={`Edit ${sub.name}`}
                            className="p-1.5 text-slate-400 hover:text-blue-400 cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => void deleteRecurringExpense(sub.id)}
                            aria-label={`Delete ${sub.name}`}
                            className="p-1.5 text-slate-500 hover:text-rose-400 cursor-pointer"
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

      {/* SECTION 3: Credit & Loan Recurring Expenses */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Loan &amp; Credit Card Recurring Expenses
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Monthly debt service and credit card commitments synced from your active facilities
            </p>
          </div>
          <button
            onClick={() => onNavigate('credits')}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap cursor-pointer"
          >
            <span>Manage Credits &amp; Loans</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {activeCreditLoans.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No active loan or credit card installments in the current entity scope.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Credit Facility</th>
                  <th className="py-3 px-4 font-medium">Entity &amp; Funding Account</th>
                  <th className="py-3 px-4 font-medium">Due Day</th>
                  <th className="py-3 px-4 font-medium text-right">Linked Subscriptions</th>
                  <th className="py-3 px-4 font-medium text-right">Remaining Balance</th>
                  <th className="py-3 px-6 font-medium text-right">Monthly Installment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {activeCreditLoans.map((fac) => {
                  const entName = entityMap.get(fac.entityId)?.name ?? 'Entity';
                  const fundAcc = accountMap.get(fac.fundingAccountId)?.name ?? 'Unassigned';
                  const linkedSubs = filteredRecurringExpenses.filter(
                    (s) => s.active && s.creditFacilityId === fac.id
                  );
                  return (
                    <tr key={fac.id} className="hover:bg-slate-800/40">
                      <td className="py-3.5 px-6">
                        <div className="flex items-start gap-2.5">
                          <CreditCard className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                          <div>
                            <p className="font-medium text-slate-100">{fac.name}</p>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {fac.lender} · {fac.apr.toFixed(2)}% APR
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300">
                        {entName} · {fundAcc}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-slate-400">
                        Day {fac.dueDay}
                      </td>
                      <td className="py-3.5 px-4 text-right text-xs font-mono tabular-nums text-slate-300">
                        {linkedSubs.length > 0
                          ? `${linkedSubs.length} (${formatMoney(
                              linkedSubs.reduce(
                                (s, e) => s + computeSubscriptionMonthlyEquivalent(e),
                                0
                              ),
                              currencyCode
                            )}/mo)`
                          : '—'}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-amber-300">
                        {formatMoney(fac.currentBalance, currencyCode)}
                      </td>
                      <td className="py-3.5 px-6 text-right font-mono tabular-nums font-semibold text-slate-100">
                        {formatMoney(fac.monthlyPayment, currencyCode)}/mo
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* MODAL 1: Add / Edit Subscription */}
      {createSubModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={handleCloseSubModal} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!resolvedSubPaidAcc) return;
              setSavingSub(true);
              try {
                const payload = {
                  entityId: resolvedSubOwnerId,
                  paidByAccountId: resolvedSubPaidAcc.id,
                  paidByEntityId: resolvedSubPaidAcc.entityId,
                  creditFacilityId: subFacilityId,
                  name: subName,
                  vendor: subVendor || subName,
                  category: subCategory,
                  amount: Number(subAmount) || 0,
                  frequency: subFrequency,
                  billingDay: Number(subBillingDay) || 1,
                  billingMonth: Number(subBillingMonth) || 1,
                  ivaRate: Number(subIvaRate) || 0,
                  ivaDeductible: subIvaDeductible,
                  hasInvoice: subHasInvoice,
                };
                if (editingSub) {
                  await updateRecurringExpense(editingSub.id, payload);
                } else {
                  await addRecurringExpense({ ...payload, active: true });
                }
                handleCloseSubModal();
              } finally {
                setSavingSub(false);
              }
            }}
            className="relative z-10 max-w-xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                {editingSub ? 'Edit Subscription / Service' : 'Add Subscription / Recurring Service'}
              </h3>
              <button
                type="button"
                onClick={handleCloseSubModal}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Belongs To (Expense Owner)
                </label>
                <select
                  value={resolvedSubOwnerId}
                  onChange={(e) => {
                    const nextEnt = e.target.value;
                    setSubEntityId(nextEnt);
                    const ent = entityMap.get(nextEnt);
                    if (ent?.entityType === 'personal') {
                      setSubIvaRate('0');
                      setSubIvaDeductible(false);
                      setSubHasInvoice(false);
                    } else {
                      setSubIvaRate('23');
                      setSubIvaDeductible(true);
                      setSubHasInvoice(true);
                    }
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
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Paid From Account (Any Entity)
                </label>
                <select
                  required
                  value={resolvedSubPaidAcc?.id || ''}
                  onChange={(e) => setSubPaidByAccountId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {entityMap.get(a.entityId)?.name ?? 'Entity'}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {subCrossEntity && (
              <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-200">
                Cross-entity payment detected:{' '}
                <span className="font-semibold">
                  {entityMap.get(resolvedSubOwnerId)?.name}
                </span>{' '}
                expense paid by{' '}
                <span className="font-semibold">
                  {entityMap.get(resolvedSubPaidAcc?.entityId || '')?.name}
                </span>
                . When invoice is enabled, posting payments will track the owed balance automatically.
              </div>
            )}

            {resolvedSubPaidAcc && isVoucherAccountType(resolvedSubPaidAcc.accountType) && !subCrossEntity && (
              <div className="p-3 bg-sky-950/30 border border-sky-800/50 rounded-lg text-xs text-sky-200">
                <strong>Voucher-first waterfall:</strong> Charges draw from{' '}
                <span className="font-semibold">{resolvedSubPaidAcc.name}</span> first and automatically debit your primary cash account for any overflow.
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Service Name</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  placeholder="e.g. Google Workspace, Netflix"
                  value={subName}
                  onChange={(e) => setSubName(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Vendor / Provider</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder="e.g. Google Cloud EMEA"
                  value={subVendor}
                  onChange={(e) => setSubVendor(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Category</label>
                <input
                  type="text"
                  required
                  maxLength={60}
                  value={subCategory}
                  onChange={(e) => setSubCategory(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Billing Cycle</label>
                <select
                  value={subFrequency}
                  onChange={(e) => setSubFrequency(e.target.value as BillingFrequency)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual (Yearly)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  {subFrequency === 'annual' ? 'Annual Amount (Gross)' : 'Monthly Amount (Gross)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={subAmount}
                  onChange={(e) => setSubAmount(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Billing Day (1–31)</label>
                <input
                  type="number"
                  min="1"
                  max="31"
                  required
                  value={subBillingDay}
                  onChange={(e) => setSubBillingDay(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              {subFrequency === 'annual' && (
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Renewal Month</label>
                  <select
                    value={subBillingMonth}
                    onChange={(e) => setSubBillingMonth(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                  >
                    {MONTH_NAMES.map((m, idx) => (
                      <option key={m} value={String(idx + 1)}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className={subFrequency === 'annual' ? '' : 'sm:col-span-2'}>
                <label className="block text-xs text-slate-300 mb-1">
                  Linked Credit Card / Loan (Optional)
                </label>
                <select
                  value={subFacilityId}
                  onChange={(e) => setSubFacilityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="">Direct Bank / Cash Debit</option>
                  {creditFacilities.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({entityMap.get(f.entityId)?.name ?? 'Entity'})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="p-3.5 bg-[#1E293B]/60 border border-slate-800 rounded-lg space-y-2.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">IVA Rate</label>
                  <select
                    value={subIvaRate}
                    onChange={(e) => setSubIvaRate(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-100"
                  >
                    {subRegionRates.map((r) => (
                      <option key={r} value={String(r)}>
                        {r === 0 ? '0% (Exempt / Foreign Reverse)' : `${r}% IVA`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="pt-3 space-y-1.5">
                  <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={subHasInvoice}
                      onChange={(e) => setSubHasInvoice(e.target.checked)}
                      className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                    />
                    <span>Has company invoice (fatura)</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-emerald-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={subIvaDeductible}
                      onChange={(e) => setSubIvaDeductible(e.target.checked)}
                      className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                    />
                    <span>IVA Dedutível (company input VAT)</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseSubModal}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingSub}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {savingSub ? 'Saving...' : editingSub ? 'Update Subscription' : 'Save Subscription'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 2: Log One-Off / Out-of-Pocket Invoiced Expense */}
      {expenseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setExpenseModalOpen(false)} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!resolvedExpPaidAcc) return;
              setSavingExp(true);
              try {
                await addCrossEntityExpense({
                  beneficiaryEntityId: resolvedExpOwnerId,
                  paidByAccountId: resolvedExpPaidAcc.id,
                  creditFacilityId: expFacilityId,
                  date: expDate,
                  vendor: expVendor,
                  description: expDescription,
                  category: expCategory,
                  invoiceNumber: expInvoiceNum,
                  hasInvoice: expHasInvoice,
                  amount: Number(expAmount) || 0,
                  ivaRate: Number(expIvaRate) || 0,
                  ivaDeductible: expIvaDeductible,
                  debitPayerAccount: expDebitAccount,
                });
                setExpenseModalOpen(false);
              } finally {
                setSavingExp(false);
              }
            }}
            className="relative z-10 max-w-xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                Log Expense / Out-of-Pocket Invoice
              </h3>
              <button
                type="button"
                onClick={() => setExpenseModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Expense For (Entity Whose Cost It Is)
                </label>
                <select
                  value={resolvedExpOwnerId}
                  onChange={(e) => setExpOwnerEntityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name} ({ent.entityType === 'personal' ? 'Personal' : 'Company'})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Paid By Account
                </label>
                <select
                  required
                  value={resolvedExpPaidAcc?.id || ''}
                  onChange={(e) => setExpPaidByAccountId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {entityMap.get(a.entityId)?.name ?? 'Entity'}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {expCrossEntity && (
              <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-200">
                {expHasInvoice ? (
                  <span>
                    Because this has a valid invoice,{' '}
                    <strong>{entityMap.get(resolvedExpOwnerId)?.name}</strong> will owe{' '}
                    <strong>{entityMap.get(resolvedExpPaidAcc?.entityId || '')?.name}</strong>{' '}
                    <span className="font-mono tabular-nums">
                      {formatMoney(Number(expAmount) || 0, currencyCode)}
                    </span>{' '}
                    and claim the deductible IVA/IRC cost.
                  </span>
                ) : (
                  <span>
                    Check &ldquo;Has company invoice (fatura)&rdquo; below to create a formal reimbursement balance.
                  </span>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Date</label>
                <input
                  type="date"
                  required
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Vendor</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder="e.g. Worten, Amazon EU"
                  value={expVendor}
                  onChange={(e) => setExpVendor(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Gross Amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={expAmount}
                  onChange={(e) => setExpAmount(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Description</label>
                <input
                  type="text"
                  required
                  maxLength={160}
                  placeholder="What was purchased for the company/entity"
                  value={expDescription}
                  onChange={(e) => setExpDescription(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Invoice / Fatura #</label>
                <input
                  type="text"
                  maxLength={60}
                  placeholder="e.g. FT 2026/1042"
                  value={expInvoiceNum}
                  onChange={(e) => setExpInvoiceNum(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Category</label>
                <input
                  type="text"
                  required
                  maxLength={60}
                  value={expCategory}
                  onChange={(e) => setExpCategory(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">IVA Rate</label>
                <select
                  value={expIvaRate}
                  onChange={(e) => setExpIvaRate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                >
                  {expRegionRates.map((r) => (
                    <option key={r} value={String(r)}>
                      {r === 0 ? '0% (Exempt)' : `${r}% IVA`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Credit Card (Optional)</label>
                <select
                  value={expFacilityId}
                  onChange={(e) => setExpFacilityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="">None</option>
                  {creditFacilities.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="p-3 bg-[#1E293B]/60 border border-slate-800 rounded-lg space-y-2 text-xs">
              <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={expHasInvoice}
                  onChange={(e) => setExpHasInvoice(e.target.checked)}
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>Has company invoice (fatura with company NIF/NIPC — creates reimbursement claim)</span>
              </label>
              <label className="flex items-center gap-2 text-emerald-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={expIvaDeductible}
                  onChange={(e) => setExpIvaDeductible(e.target.checked)}
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>
                  IVA Dedutível ({formatMoney(computeTransactionIva(Number(expAmount) || 0, Number(expIvaRate) || 0), currencyCode)} VAT recoverable)
                </span>
              </label>
              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={expDebitAccount}
                  onChange={(e) => setExpDebitAccount(e.target.checked)}
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>Debit {resolvedExpPaidAcc?.name ?? 'paying account'} balance &amp; log in ledger</span>
              </label>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setExpenseModalOpen(false)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingExp}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {savingExp ? 'Saving...' : 'Record Expense'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 3: Post Subscription Charge */}
      {postingSub && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setPostingSub(null)} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setPostingSaving(true);
              try {
                await postRecurringExpensePayment(postingSub, {
                  date: postDate,
                  invoiceNumber: postInvoiceNum,
                });
                setPostingSub(null);
              } finally {
                setPostingSaving(false);
              }
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Post Subscription Charge</h3>
              <button
                type="button"
                onClick={() => setPostingSub(null)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 bg-[#1E293B]/60 border border-slate-800 rounded-lg text-xs space-y-1">
              <p className="text-sm font-medium text-slate-100">{postingSub.name}</p>
              <p className="text-slate-400">
                Debits {accountMap.get(postingSub.paidByAccountId)?.name ?? 'Account'} for{' '}
                <span className="font-mono tabular-nums text-slate-200">
                  {formatMoney(postingSub.amount, currencyCode)}
                </span>
              </p>
              {(() => {
                const acc = accountMap.get(postingSub.paidByAccountId);
                if (!acc || !isVoucherAccountType(acc.accountType) || postingSub.requiresReimbursement) {
                  return null;
                }
                const fallback = accounts.find(
                  (a) => a.entityId === acc.entityId && !isVoucherAccountType(a.accountType)
                );
                if (!fallback || acc.balance >= postingSub.amount) return null;
                const voucherUsed = Math.max(0, acc.balance);
                const overflow = Math.max(0, postingSub.amount - voucherUsed);
                return (
                  <p className="text-sky-300 font-mono tabular-nums">
                    Voucher waterfall: {formatMoney(voucherUsed, currencyCode)} from {acc.name} +{' '}
                    {formatMoney(overflow, currencyCode)} overflow from {fallback.name}
                  </p>
                );
              })()}
              {postingSub.requiresReimbursement && (
                <p className="text-amber-300">
                  Also records open reimbursement: {entityMap.get(postingSub.entityId)?.name} owes{' '}
                  {entityMap.get(postingSub.paidByEntityId)?.name}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">Charge Date</label>
              <input
                type="date"
                required
                value={postDate}
                onChange={(e) => setPostDate(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
              />
            </div>

            {postingSub.hasInvoice && (
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Invoice / Fatura Reference (Optional)
                </label>
                <input
                  type="text"
                  maxLength={60}
                  placeholder="e.g. FAT-2026-901"
                  value={postInvoiceNum}
                  onChange={(e) => setPostInvoiceNum(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            )}

            <div className="pt-2 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPostingSub(null)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={postingSaving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {postingSaving ? 'Posting...' : 'Confirm & Post'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 4: Settle Reimbursements */}
      {settlingClaims.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setSettlingClaims([])} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!settleFromAccId || !settleToAccId) return;
              setSettlingSaving(true);
              try {
                await settleReimbursements({
                  claims: settlingClaims,
                  fromAccountId: settleFromAccId,
                  toAccountId: settleToAccId,
                  date: settleDate,
                });
                setSettlingClaims([]);
              } finally {
                setSettlingSaving(false);
              }
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Settle Reimbursement</h3>
              <button
                type="button"
                onClick={() => setSettlingClaims([])}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 bg-[#1E293B]/60 border border-slate-800 rounded-lg flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-slate-400">
                  {settlingClaims.length}{' '}
                  {settlingClaims.length === 1 ? 'invoiced claim' : 'invoiced claims'}
                </p>
                <p className="text-sm font-medium text-slate-100 truncate">{settleTitle}</p>
              </div>
              <span className="text-lg font-mono tabular-nums font-semibold text-emerald-400 shrink-0">
                {formatMoney(settleTotalAmount, currencyCode)}
              </span>
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">
                From Account (Debtor / Company Pays Back)
              </label>
              <select
                required
                value={settleFromAccId}
                onChange={(e) => setSettleFromAccId(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({entityMap.get(a.entityId)?.name ?? 'Entity'}) ·{' '}
                    {formatMoney(a.balance, currencyCode)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">
                To Account (Personal / Creditor Receives Funds)
              </label>
              <select
                required
                value={settleToAccId}
                onChange={(e) => setSettleToAccId(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({entityMap.get(a.entityId)?.name ?? 'Entity'}) ·{' '}
                    {formatMoney(a.balance, currencyCode)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">Settlement Date</label>
              <input
                type="date"
                required
                value={settleDate}
                onChange={(e) => setSettleDate(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
              />
            </div>

            <div className="pt-2 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setSettlingClaims([])}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={settlingSaving || settleFromAccId === settleToAccId}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {settlingSaving ? 'Settling...' : 'Transfer & Mark Settled'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
