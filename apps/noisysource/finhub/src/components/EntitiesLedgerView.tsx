import React, { useMemo, useState } from 'react';
import { ArrowRight, Download, ExternalLink, Plus, Search, Trash2, X } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type { NavSection, TransactionType } from '../types/finance';
import {
  computeTransactionIva,
  formatMoney,
  getIvaRatesForRegion,
  getVoucherCategoryKind,
  isVoucherAccountType,
  todayIsoDate,
} from '../utils/financeMath';

interface EntitiesLedgerViewProps {
  createTxModalOpen: boolean;
  onCloseCreateTxModal: () => void;
  onOpenCreateTxModal: () => void;
  onNavigate?: (section: NavSection) => void;
}

export function EntitiesLedgerView({
  createTxModalOpen,
  onCloseCreateTxModal,
  onOpenCreateTxModal,
  onNavigate,
}: EntitiesLedgerViewProps) {
  const {
    entities,
    accounts,
    filteredAccounts,
    filteredTransactions,
    invoiceDocuments,
    taxSettings,
    currencyCode,
    addTransaction,
    recordVoucherFirstExpense,
    deleteTransaction,
  } = useTreasury();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | TransactionType>('all');

  // Transaction Modal
  const [txAccountId, setTxAccountId] = useState('');
  const [txDate, setTxDate] = useState(todayIsoDate());
  const [txDesc, setTxDesc] = useState('');
  const [txCategory, setTxCategory] = useState('Operating Revenue');
  const [txType, setTxType] = useState<TransactionType>('income');
  const [txAmount, setTxAmount] = useState('1000');
  const [txIvaRate, setTxIvaRate] = useState('23');
  const [txIncludesIva, setTxIncludesIva] = useState(true);
  const [txIvaDeductible, setTxIvaDeductible] = useState(true);
  const [txHistorical, setTxHistorical] = useState(false);
  const [txVoucherWaterfall, setTxVoucherWaterfall] = useState(true);

  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const taxSettingMap = useMemo(
    () => new Map(taxSettings.map((s) => [s.entityId, s])),
    [taxSettings]
  );

  const selectedAccount = accountMap.get(txAccountId) ?? filteredAccounts[0] ?? accounts[0];
  const selectedEntity = selectedAccount ? entityMap.get(selectedAccount.entityId) : undefined;
  const selectedRegion =
    (selectedEntity ? taxSettingMap.get(selectedEntity.id)?.region : undefined) ?? 'continente';
  const regionIvaRates = getIvaRatesForRegion(selectedRegion);

  const parsedAmount = Math.max(0, Number(txAmount) || 0);
  const parsedIvaRate =
    txType === 'income' || txType === 'expense' ? Math.max(0, Number(txIvaRate) || 0) : 0;

  const computedPreview = useMemo(() => {
    if (parsedAmount <= 0 || parsedIvaRate <= 0) {
      return { gross: parsedAmount, net: parsedAmount, iva: 0 };
    }
    if (txIncludesIva) {
      const iva = computeTransactionIva(parsedAmount, parsedIvaRate);
      return { gross: parsedAmount, net: parsedAmount - iva, iva };
    }
    const iva = Number((parsedAmount * (parsedIvaRate / 100)).toFixed(2));
    return { gross: Number((parsedAmount + iva).toFixed(2)), net: parsedAmount, iva };
  }, [parsedAmount, parsedIvaRate, txIncludesIva]);

  const fallbackLiquidAccount = useMemo(() => {
    if (!selectedAccount || !isVoucherAccountType(selectedAccount.accountType)) return undefined;
    return accounts.find(
      (a) => a.entityId === selectedAccount.entityId && !isVoucherAccountType(a.accountType)
    );
  }, [accounts, selectedAccount]);

  const suggestedVoucherAccount = useMemo(() => {
    if (txType !== 'expense' || !selectedAccount || isVoucherAccountType(selectedAccount.accountType)) {
      return undefined;
    }
    const kind = getVoucherCategoryKind(`${txDesc} ${txCategory}`);
    if (!kind) return undefined;
    return accounts.find(
      (a) => a.entityId === selectedAccount.entityId && a.accountType === kind && a.balance > 0
    );
  }, [txType, selectedAccount, txDesc, txCategory, accounts]);

  const visibleTransactions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return filteredTransactions.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (
        q &&
        !t.description.toLowerCase().includes(q) &&
        !t.category.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [filteredTransactions, search, typeFilter]);

  const exportCsv = () => {
    const header =
      'Date,Entity,Account,Description,Category,Type,GrossAmount,IvaRate,IvaAmount,IvaDeductible,Status\n';
    const body = visibleTransactions
      .map((t) => {
        const ent = entityMap.get(t.entityId)?.name ?? '';
        const acc = accountMap.get(t.accountId)?.name ?? '';
        const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
        const ivaRate = t.ivaRate ?? 0;
        const ivaAmt =
          typeof t.ivaAmount === 'number' ? t.ivaAmount : computeTransactionIva(t.amount, ivaRate);
        return [
          t.date,
          esc(ent),
          esc(acc),
          esc(t.description),
          esc(t.category),
          t.type,
          t.amount.toFixed(2),
          String(ivaRate),
          ivaAmt.toFixed(2),
          t.ivaDeductible ? 'yes' : 'no',
          t.status,
        ].join(',');
      })
      .join('\n');
    const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `strata-ledger-${todayIsoDate()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Unified Ledger Table */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold text-slate-100">Unified Ledger Transactions</h2>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search description or category..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-[#1E293B] border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-100 w-56 focus:outline-none focus:border-blue-500"
              />
            </div>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'all' | TransactionType)}
              className="bg-[#1E293B] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
            >
              <option value="all">All Types</option>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
              <option value="debt_payment">Debt Payment</option>
              <option value="payroll">Payroll</option>
              <option value="transfer">Transfer</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onNavigate && (
              <button
                onClick={() => onNavigate('accounts')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 rounded-lg whitespace-nowrap cursor-pointer"
              >
                <span>Accounts</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 rounded-lg whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
            <button
              onClick={() => {
                const defaultAcc = filteredAccounts[0] ?? accounts[0];
                const defaultEnt = defaultAcc ? entityMap.get(defaultAcc.entityId) : undefined;
                setTxAccountId(defaultAcc?.id || '');
                setTxIvaRate(defaultEnt?.entityType === 'company' ? '23' : '0');
                onOpenCreateTxModal();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Entry</span>
            </button>
          </div>
        </div>

        {visibleTransactions.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No transactions recorded for this filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Date</th>
                  <th className="py-3 px-4 font-medium">Description</th>
                  <th className="py-3 px-4 font-medium">Entity / Account</th>
                  <th className="py-3 px-4 font-medium">Category</th>
                  <th className="py-3 px-4 font-medium">IVA</th>
                  <th className="py-3 px-4 font-medium">Invoice / Drive</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium text-right">Amount</th>
                  <th className="py-3 px-6 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {visibleTransactions.map((tx) => {
                  const acc = accountMap.get(tx.accountId);
                  const ent = entityMap.get(tx.entityId);
                  const ivaRate = tx.ivaRate ?? 0;
                  const ivaAmt =
                    typeof tx.ivaAmount === 'number'
                      ? tx.ivaAmount
                      : computeTransactionIva(tx.amount, ivaRate);
                  const linkedDoc = invoiceDocuments.find(
                    (d) => (tx.invoiceDocId && d.id === tx.invoiceDocId) || d.transactionId === tx.id
                  );
                  const driveUrl = tx.driveWebViewLink || linkedDoc?.driveWebViewLink || '';
                  const driveFolder = tx.driveFolderPath || linkedDoc?.driveFolderPath || '';
                  const invRef = tx.invoiceNumber || linkedDoc?.invoiceNumber || '';

                  return (
                    <tr key={tx.id} className="hover:bg-slate-800/40">
                      <td className="py-3 px-6 text-xs font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {tx.date}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-100">{tx.description}</td>
                      <td className="py-3 px-4 text-xs text-slate-400">
                        {ent?.name ?? 'Entity'} · {acc?.name ?? 'Account'}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-300">{tx.category}</td>
                      <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-400 whitespace-nowrap">
                        {ivaRate > 0 ? (
                          <span className={tx.type === 'expense' && tx.ivaDeductible !== false ? 'text-emerald-400' : 'text-amber-300'}>
                            {ivaRate}% · {formatMoney(ivaAmt, currencyCode)}
                          </span>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs">
                        {driveUrl ? (
                          <div className="space-y-0.5">
                            {driveFolder && (
                              <p className="font-mono text-[11px] text-slate-400 truncate max-w-[160px]">
                                {driveFolder}
                              </p>
                            )}
                            <a
                              href={driveUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-medium whitespace-nowrap"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>{invRef || 'PDF'}</span>
                            </a>
                          </div>
                        ) : invRef ? (
                          <span className="font-mono text-slate-300">{invRef}</span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-400 capitalize">{tx.status}</td>
                      <td
                        className={`py-3 px-4 text-right font-mono tabular-nums font-medium ${
                          tx.type === 'income' ? 'text-emerald-400' : 'text-slate-100'
                        }`}
                      >
                        {tx.type === 'income' ? '+' : '-'}
                        {formatMoney(tx.amount, currencyCode)}
                      </td>
                      <td className="py-3 px-6 text-right">
                        {tx.status !== 'reconciled' ? (
                          <button
                            onClick={() => void deleteTransaction(tx)}
                            aria-label={`Delete ${tx.description}`}
                            className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <span className="text-xs text-slate-500">Reconciled</span>
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

      {/* Add Transaction Modal */}
      {createTxModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={onCloseCreateTxModal} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const targetAcc = selectedAccount;
              if (!targetAcc) return;
              if (
                txType === 'expense' &&
                isVoucherAccountType(targetAcc.accountType) &&
                fallbackLiquidAccount &&
                txVoucherWaterfall
              ) {
                await recordVoucherFirstExpense({
                  entityId: targetAcc.entityId,
                  voucherAccountId: targetAcc.id,
                  fallbackAccountId: fallbackLiquidAccount.id,
                  date: txDate,
                  description: txDesc,
                  category: txCategory,
                  amount: computedPreview.gross,
                  ivaRate: parsedIvaRate,
                  ivaAmount: computedPreview.iva,
                  ivaDeductible: parsedIvaRate > 0 ? txIvaDeductible : false,
                  adjustAccountBalance: !txHistorical,
                });
              } else {
                await addTransaction(
                  {
                    entityId: targetAcc.entityId,
                    accountId: targetAcc.id,
                    facilityId: '',
                    payslipId: '',
                    date: txDate,
                    description: txDesc,
                    category: txCategory,
                    type: txType,
                    amount: computedPreview.gross,
                    ivaRate: parsedIvaRate,
                    ivaAmount: computedPreview.iva,
                    ivaDeductible: txType === 'expense' && parsedIvaRate > 0 ? txIvaDeductible : false,
                    status: 'cleared',
                  },
                  { adjustAccountBalance: !txHistorical }
                );
              }
              setTxDesc('');
              setTxHistorical(false);
              onCloseCreateTxModal();
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Log Ledger Transaction</h3>
              <button
                type="button"
                onClick={onCloseCreateTxModal}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Account</label>
              <select
                required
                value={selectedAccount?.id || ''}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setTxAccountId(nextId);
                  const acc = accountMap.get(nextId);
                  const ent = acc ? entityMap.get(acc.entityId) : undefined;
                  if (ent?.entityType === 'personal') setTxIvaRate('0');
                  else if (ent?.entityType === 'company' && txIvaRate === '0') setTxIvaRate('23');
                }}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({entityMap.get(a.entityId)?.name ?? 'Entity'})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Date</label>
                <input
                  type="date"
                  required
                  value={txDate}
                  onChange={(e) => setTxDate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Type</label>
                <select
                  value={txType}
                  onChange={(e) => setTxType(e.target.value as TransactionType)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="income">Income (+)</option>
                  <option value="expense">Expense (-)</option>
                  <option value="debt_payment">Debt Payment (-)</option>
                  <option value="payroll">Payroll (-)</option>
                  <option value="transfer">Transfer (-)</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Description</label>
              <input
                type="text"
                required
                maxLength={160}
                placeholder="Client invoice, vendor bill, etc."
                value={txDesc}
                onChange={(e) => setTxDesc(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Category</label>
                <input
                  type="text"
                  required
                  maxLength={60}
                  value={txCategory}
                  onChange={(e) => setTxCategory(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  {txIncludesIva || parsedIvaRate === 0 ? 'Total Amount' : 'Net Base (Excl. IVA)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={txAmount}
                  onChange={(e) => setTxAmount(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            {(txType === 'income' || txType === 'expense') && (
              <div className="p-3 bg-[#1E293B]/60 border border-slate-800 rounded-lg space-y-2.5">
                <div className="grid grid-cols-2 gap-3 items-center">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">IVA Rate</label>
                    <select
                      value={txIvaRate}
                      onChange={(e) => setTxIvaRate(e.target.value)}
                      className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100"
                    >
                      {regionIvaRates.map((r) => (
                        <option key={r} value={String(r)}>
                          {r === 0 ? '0% (Exempt)' : `${r}% IVA`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="pt-4">
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={txIncludesIva}
                        onChange={(e) => setTxIncludesIva(e.target.checked)}
                        className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                      />
                      <span>Amount includes IVA</span>
                    </label>
                  </div>
                </div>

                {parsedIvaRate > 0 && (
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-300 pt-1 border-t border-slate-800">
                    <span>Net: {formatMoney(computedPreview.net, currencyCode)}</span>
                    <span>IVA: {formatMoney(computedPreview.iva, currencyCode)}</span>
                    <span className="text-slate-100 font-medium">
                      Total: {formatMoney(computedPreview.gross, currencyCode)}
                    </span>
                  </div>
                )}

                {txType === 'expense' && parsedIvaRate > 0 && (
                  <label className="flex items-center gap-2 text-xs text-emerald-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={txIvaDeductible}
                      onChange={(e) => setTxIvaDeductible(e.target.checked)}
                      className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                    />
                    <span>IVA Dedutível (recoverable business input VAT)</span>
                  </label>
                )}
              </div>
            )}

            {txType === 'expense' &&
              selectedAccount &&
              isVoucherAccountType(selectedAccount.accountType) &&
              fallbackLiquidAccount && (
                <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg space-y-2 text-xs">
                  <label className="flex items-start gap-2 text-amber-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={txVoucherWaterfall}
                      onChange={(e) => setTxVoucherWaterfall(e.target.checked)}
                      className="mt-0.5 rounded border-slate-600 bg-[#1E293B] text-amber-500"
                    />
                    <span>
                      <strong>Pay voucher-first:</strong> Spend up to{' '}
                      <span className="font-mono tabular-nums">
                        {formatMoney(Math.max(0, selectedAccount.balance), currencyCode)}
                      </span>{' '}
                      from {selectedAccount.name}, and overflow any remainder to{' '}
                      <strong>{fallbackLiquidAccount.name}</strong>.
                    </span>
                  </label>
                  {txVoucherWaterfall && computedPreview.gross > 0 && (
                    <p className="text-[11px] font-mono tabular-nums text-slate-300 pl-6">
                      Preview: {formatMoney(Math.min(Math.max(0, selectedAccount.balance), computedPreview.gross), currencyCode)}{' '}
                      voucher +{' '}
                      {formatMoney(
                        Math.max(0, computedPreview.gross - Math.max(0, selectedAccount.balance)),
                        currencyCode
                      )}{' '}
                      {fallbackLiquidAccount.name}
                    </p>
                  )}
                </div>
              )}

            {suggestedVoucherAccount && (
              <div className="p-3 bg-sky-950/30 border border-sky-800/50 rounded-lg flex items-center justify-between gap-3 text-xs">
                <span className="text-sky-200">
                  Eligible voucher available:{' '}
                  <strong className="font-mono tabular-nums">
                    {formatMoney(suggestedVoucherAccount.balance, currencyCode)}
                  </strong>{' '}
                  in {suggestedVoucherAccount.name}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setTxAccountId(suggestedVoucherAccount.id);
                    setTxVoucherWaterfall(true);
                  }}
                  className="px-2.5 py-1 bg-sky-600 hover:bg-sky-500 text-white font-medium rounded-md whitespace-nowrap cursor-pointer"
                >
                  Use Voucher First
                </button>
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={txHistorical}
                onChange={(e) => setTxHistorical(e.target.checked)}
                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
              />
              <span>Historical entry — preserve current live account balance</span>
            </label>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onCloseCreateTxModal}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                Save Entry
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
