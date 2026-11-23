import React, { useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  Building2,
  GraduationCap,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  User,
  Utensils,
  Wallet,
  X,
} from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type { Account, AccountType, Entity, EntityType } from '../types/finance';
import { formatMoney, isVoucherAccountType, todayIsoDate } from '../utils/financeMath';

interface AccountsViewProps {
  createAccountModalOpen: boolean;
  onOpenCreateAccountModal: () => void;
  onCloseCreateAccountModal: () => void;
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings / Reserve',
  treasury: 'Treasury',
  cash: 'Cash',
  meal_voucher: 'Meal Card (Food Only)',
  child_voucher: 'Child Voucher (School Only)',
};

export function AccountsView({
  createAccountModalOpen,
  onOpenCreateAccountModal,
  onCloseCreateAccountModal,
}: AccountsViewProps) {
  const {
    entities,
    accounts,
    filteredAccounts,
    entityFilter,
    setEntityFilter,
    currencyCode,
    addEntity,
    updateEntity,
    deleteEntity,
    addAccount,
    updateAccountDetails,
    updateAccountBalance,
    transferBetweenAccounts,
    deleteAccount,
    hasSampleData,
    resetWorkspaceData,
  } = useTreasury();

  // Reset / Clear Sample Data modal
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetMode, setResetMode] = useState<'sample_only' | 'all_non_reconciled'>('sample_only');
  const [resetting, setResetting] = useState(false);

  // Entity Add/Edit modal
  const [entityModalOpen, setEntityModalOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState<Entity | null>(null);
  const [entName, setEntName] = useState('');
  const [entType, setEntType] = useState<EntityType>('company');
  const [entReg, setEntReg] = useState('');

  // Account Add/Edit modal
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [accEntityId, setAccEntityId] = useState('');
  const [accName, setAccName] = useState('');
  const [accInstitution, setAccInstitution] = useState('');
  const [accNumber, setAccNumber] = useState('');
  const [accType, setAccType] = useState<AccountType>('checking');
  const [accBalance, setAccBalance] = useState('0');

  // Adjust Balance modal
  const [adjustingAccount, setAdjustingAccount] = useState<Account | null>(null);
  const [adjustValue, setAdjustValue] = useState('0');

  // Transfer modal
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [fromAccId, setFromAccId] = useState('');
  const [toAccId, setToAccId] = useState('');
  const [transferAmt, setTransferAmt] = useState('500');
  const [transferDate, setTransferDate] = useState(todayIsoDate());
  const [transferNote, setTransferNote] = useState('');

  const visibleEntities = useMemo(() => {
    if (entityFilter === 'all') return entities;
    return entities.filter((e) => e.id === entityFilter);
  }, [entities, entityFilter]);

  const metrics = useMemo(() => {
    const entityTypeMap = new Map(entities.map((e) => [e.id, e.entityType]));
    let totalCash = 0;
    let liquidCash = 0;
    let companyCash = 0;
    let personalCash = 0;
    let mealVoucherTotal = 0;
    let childVoucherTotal = 0;
    for (const acc of filteredAccounts) {
      totalCash += acc.balance;
      if (acc.accountType === 'meal_voucher') {
        mealVoucherTotal += acc.balance;
        continue;
      }
      if (acc.accountType === 'child_voucher') {
        childVoucherTotal += acc.balance;
        continue;
      }
      liquidCash += acc.balance;
      if (entityTypeMap.get(acc.entityId) === 'personal') {
        personalCash += acc.balance;
      } else {
        companyCash += acc.balance;
      }
    }
    const voucherTotal = mealVoucherTotal + childVoucherTotal;
    return {
      totalCash,
      liquidCash,
      companyCash,
      personalCash,
      mealVoucherTotal,
      childVoucherTotal,
      voucherTotal,
    };
  }, [entities, filteredAccounts]);

  const liquidAccounts = useMemo(
    () => accounts.filter((a) => !isVoucherAccountType(a.accountType)),
    [accounts]
  );

  const openAddEntity = () => {
    setEditingEntity(null);
    setEntName('');
    setEntType('company');
    setEntReg('');
    setEntityModalOpen(true);
  };

  const openEditEntity = (ent: Entity) => {
    setEditingEntity(ent);
    setEntName(ent.name);
    setEntType(ent.entityType);
    setEntReg(ent.registrationCode);
    setEntityModalOpen(true);
  };

  const openAddEntityWithType = (type: EntityType) => {
    setEditingEntity(null);
    setEntName('');
    setEntType(type);
    setEntReg('');
    setEntityModalOpen(true);
  };

  const openAddAccountForEntity = (entityId: string) => {
    if (entities.length === 0) {
      openAddEntity();
      return;
    }
    setEditingAccount(null);
    setAccEntityId(entityId);
    setAccName('');
    setAccInstitution('');
    setAccNumber('');
    setAccType('checking');
    setAccBalance('0');
    onOpenCreateAccountModal();
  };

  const openEditAccount = (acc: Account) => {
    setEditingAccount(acc);
    setAccEntityId(acc.entityId);
    setAccName(acc.name);
    setAccInstitution(acc.institution);
    setAccNumber(acc.accountNumber || '');
    setAccType(acc.accountType);
    setAccBalance(String(acc.balance));
    onOpenCreateAccountModal();
  };

  const openTransfer = (preferredFromId?: string) => {
    const first =
      (preferredFromId && accounts.find((a) => a.id === preferredFromId && !isVoucherAccountType(a.accountType))?.id) ||
      liquidAccounts[0]?.id ||
      '';
    const second = accounts.find((a) => a.id !== first)?.id || '';
    setFromAccId(first);
    setToAccId(second);
    setTransferAmt('500');
    setTransferDate(todayIsoDate());
    setTransferNote('');
    setTransferModalOpen(true);
  };

  const accountModalVisible = createAccountModalOpen || editingAccount !== null;
  const closeAccountModal = () => {
    setEditingAccount(null);
    onCloseCreateAccountModal();
  };

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Scoped Liquid Cash</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(metrics.liquidCash, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">
            {filteredAccounts.filter((a) => !isVoucherAccountType(a.accountType)).length} spendable bank/cash accounts
          </p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Company Liquid Cash</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-blue-400 mt-2">
            {formatMoney(metrics.companyCash, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">Corporate operating &amp; tax reserves</p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Personal Liquid Cash</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-emerald-400 mt-2">
            {formatMoney(metrics.personalCash, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2">Household checking &amp; savings</p>
        </div>

        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Benefit Vouchers (Non-Withdrawable)</p>
          <p className="text-2xl font-semibold font-mono tabular-nums text-amber-300 mt-2">
            {formatMoney(metrics.voucherTotal, currencyCode)}
          </p>
          <p className="text-xs text-slate-400 mt-2 font-mono tabular-nums">
            Meal {formatMoney(metrics.mealVoucherTotal, currencyCode, true)} · Child{' '}
            {formatMoney(metrics.childVoucherTotal, currencyCode, true)}
          </p>
        </div>
      </div>

      {/* Action Bar */}
      <div className="bg-[#0F172A] border border-slate-800 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Accounts by Company &amp; Personal Entity
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Manage bank, treasury, savings, cash, and non-withdrawable Meal / Child voucher accounts across entities
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              setResetMode(hasSampleData ? 'sample_only' : 'all_non_reconciled');
              setResetModalOpen(true);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-2 border text-xs font-medium rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
              hasSampleData
                ? 'bg-amber-950/40 hover:bg-amber-900/50 border-amber-700/60 text-amber-200'
                : 'bg-[#1E293B] hover:bg-slate-700 border-slate-700 text-slate-300'
            }`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{hasSampleData ? 'Clear Sample Data' : 'Reset Workspace'}</span>
          </button>
          <button
            onClick={openAddEntity}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Entity</span>
          </button>
          {liquidAccounts.length >= 1 && accounts.length >= 2 && (
            <button
              onClick={() => openTransfer()}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              <span>Transfer Funds</span>
            </button>
          )}
          <button
            onClick={() =>
              openAddAccountForEntity(
                entityFilter !== 'all' ? entityFilter : entities[0]?.id || ''
              )
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Account</span>
          </button>
        </div>
      </div>

      {/* Entity Cards with Nested Multiple Accounts */}
      <div className="space-y-5">
        {visibleEntities.length === 0 && (
          <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-8 text-center space-y-4">
            <div className="w-11 h-11 rounded-xl bg-[#1E293B] border border-slate-700 flex items-center justify-center mx-auto">
              <Building2 className="w-5 h-5 text-blue-400" />
            </div>
            <div className="max-w-lg mx-auto space-y-1.5">
              <h3 className="text-base font-semibold text-slate-100">
                Clean Workspace — Ready for Real Data
              </h3>
              <p className="text-xs text-slate-400">
                Add your Personal profile (NIF) and each Company (NIPC), then add your real bank, savings, and treasury accounts with today&rsquo;s live balances.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                onClick={() => openAddEntityWithType('personal')}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap cursor-pointer"
              >
                <User className="w-3.5 h-3.5 text-emerald-400" />
                <span>Add Personal Entity</span>
              </button>
              <button
                onClick={() => openAddEntityWithType('company')}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg whitespace-nowrap cursor-pointer"
              >
                <Building2 className="w-3.5 h-3.5" />
                <span>Add Company Entity</span>
              </button>
            </div>
          </section>
        )}

        {visibleEntities.map((ent) => {
          const entAccounts = accounts.filter((a) => a.entityId === ent.id);
          const entLiquidTotal = entAccounts
            .filter((a) => !isVoucherAccountType(a.accountType))
            .reduce((s, a) => s + a.balance, 0);
          const entVoucherTotal = entAccounts
            .filter((a) => isVoucherAccountType(a.accountType))
            .reduce((s, a) => s + a.balance, 0);
          const isPersonal = ent.entityType === 'personal';

          return (
            <section
              key={ent.id}
              className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-slate-900/40">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-[#1E293B] border border-slate-700 flex items-center justify-center shrink-0">
                    {isPersonal ? (
                      <User className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Building2 className="w-4 h-4 text-blue-400" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-100 truncate">{ent.name}</h3>
                      <span className="text-xs text-slate-400 whitespace-nowrap">
                        · {isPersonal ? 'Personal' : 'Company'}
                        {ent.registrationCode ? ` · ${ent.registrationCode}` : ''}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {entAccounts.length} {entAccounts.length === 1 ? 'account' : 'accounts'} · Liquid{' '}
                      <span className="font-mono tabular-nums text-slate-200 font-medium">
                        {formatMoney(entLiquidTotal, currencyCode)}
                      </span>
                      {entVoucherTotal > 0 && (
                        <span>
                          {' '}
                          +{' '}
                          <span className="font-mono tabular-nums text-amber-300 font-medium">
                            {formatMoney(entVoucherTotal, currencyCode)}
                          </span>{' '}
                          vouchers
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {entityFilter !== ent.id && (
                    <button
                      onClick={() => setEntityFilter(ent.id)}
                      className="px-2.5 py-1.5 text-xs text-slate-300 hover:text-white bg-[#1E293B] hover:bg-slate-700 border border-slate-700 rounded-lg whitespace-nowrap cursor-pointer"
                    >
                      Focus Scope
                    </button>
                  )}
                  <button
                    onClick={() => openAddAccountForEntity(ent.id)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Account</span>
                  </button>
                  <button
                    onClick={() => openEditEntity(ent)}
                    aria-label={`Edit ${ent.name}`}
                    className="p-1.5 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {entities.length > 1 && (
                    <button
                      onClick={() => void deleteEntity(ent.id)}
                      aria-label={`Delete ${ent.name}`}
                      className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-slate-800 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {entAccounts.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  No accounts linked to {ent.name} yet. Click &ldquo;Add Account&rdquo; above to add checking, savings, or treasury accounts.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-800 text-xs text-slate-400">
                        <th className="py-3 px-6 font-medium">Account Name</th>
                        <th className="py-3 px-4 font-medium">Institution</th>
                        <th className="py-3 px-4 font-medium">IBAN / Ref</th>
                        <th className="py-3 px-4 font-medium">Type</th>
                        <th className="py-3 px-4 font-medium">Last Reconciled</th>
                        <th className="py-3 px-4 font-medium text-right">Balance</th>
                        <th className="py-3 px-6 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/80">
                      {entAccounts.map((acc) => {
                        const isVoucher = isVoucherAccountType(acc.accountType);
                        return (
                          <tr key={acc.id} className="hover:bg-slate-800/40 transition-colors">
                            <td className="py-3.5 px-6 font-medium text-slate-100">
                              <div className="flex items-start gap-2">
                                {acc.accountType === 'meal_voucher' ? (
                                  <Utensils className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-1" />
                                ) : acc.accountType === 'child_voucher' ? (
                                  <GraduationCap className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-1" />
                                ) : (
                                  <Wallet className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-1" />
                                )}
                                <div>
                                  <span>{acc.name}</span>
                                  {isVoucher && (
                                    <p className="text-[11px] font-normal text-slate-400 mt-0.5 flex items-center gap-1">
                                      <Lock className="w-3 h-3 text-amber-400/80 shrink-0" />
                                      <span>
                                        {acc.accountType === 'meal_voucher'
                                          ? 'Non-withdrawable · Groceries & food first'
                                          : 'Non-withdrawable · Kids school & creche first'}
                                      </span>
                                    </p>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="py-3.5 px-4 text-xs text-slate-300">{acc.institution}</td>
                            <td className="py-3.5 px-4 text-xs font-mono text-slate-400">
                              {acc.accountNumber || '—'}
                            </td>
                            <td
                              className={`py-3.5 px-4 text-xs ${
                                acc.accountType === 'meal_voucher'
                                  ? 'text-amber-300'
                                  : acc.accountType === 'child_voucher'
                                  ? 'text-sky-300'
                                  : 'text-slate-400'
                              }`}
                            >
                              {ACCOUNT_TYPE_LABELS[acc.accountType]}
                            </td>
                            <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-slate-400">
                              {acc.lastReconciledDate || 'Never'}
                            </td>
                            <td
                              className={`py-3.5 px-4 text-right font-mono tabular-nums font-semibold ${
                                acc.balance < 0
                                  ? 'text-rose-400'
                                  : isVoucher
                                  ? 'text-amber-200'
                                  : 'text-slate-100'
                              }`}
                            >
                              {formatMoney(acc.balance, currencyCode)}
                            </td>
                            <td className="py-3.5 px-6 text-right">
                              <div className="inline-flex items-center gap-2.5">
                                {!isVoucher && accounts.length >= 2 && (
                                  <button
                                    onClick={() => openTransfer(acc.id)}
                                    className="text-xs text-slate-300 hover:text-white cursor-pointer"
                                  >
                                    Transfer
                                  </button>
                                )}
                                <button
                                  onClick={() => {
                                    setAdjustingAccount(acc);
                                    setAdjustValue(String(acc.balance));
                                  }}
                                  className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                                >
                                  Adjust
                                </button>
                                <button
                                  onClick={() => openEditAccount(acc)}
                                  aria-label={`Edit ${acc.name}`}
                                  className="text-slate-400 hover:text-slate-100 p-1 cursor-pointer"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => void deleteAccount(acc.id)}
                                  aria-label={`Delete ${acc.name}`}
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
          );
        })}
      </div>

      {/* Add / Edit Entity Modal */}
      {entityModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setEntityModalOpen(false)} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (editingEntity) {
                await updateEntity(editingEntity.id, {
                  name: entName,
                  entityType: entType,
                  registrationCode: entReg,
                  colorHex: entType === 'personal' ? '#38BDF8' : '#3B82F6',
                });
              } else {
                await addEntity({
                  name: entName,
                  entityType: entType,
                  registrationCode: entReg,
                  colorHex: entType === 'personal' ? '#38BDF8' : '#3B82F6',
                });
              }
              setEntityModalOpen(false);
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                {editingEntity ? 'Edit Entity' : 'Add Company or Personal Entity'}
              </h3>
              <button
                type="button"
                onClick={() => setEntityModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Entity Name</label>
              <input
                type="text"
                required
                maxLength={80}
                placeholder="e.g. Northstar Labs Lda"
                value={entName}
                onChange={(e) => setEntName(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Type</label>
                <select
                  value={entType}
                  onChange={(e) => setEntType(e.target.value as EntityType)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="company">Company</option>
                  <option value="personal">Personal</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">NIF / NIPC / Tax ID</label>
                <input
                  type="text"
                  maxLength={40}
                  placeholder="e.g. NIPC 514829301"
                  value={entReg}
                  onChange={(e) => setEntReg(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEntityModalOpen(false)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {editingEntity ? 'Save Entity' : 'Create Entity'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add / Edit Account Modal */}
      {accountModalVisible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={closeAccountModal} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (editingAccount) {
                await updateAccountDetails(editingAccount.id, {
                  name: accName,
                  institution: accInstitution,
                  accountType: accType,
                  accountNumber: accNumber,
                });
              } else {
                await addAccount({
                  entityId: accEntityId || entities[0]?.id || '',
                  name: accName,
                  institution: accInstitution,
                  accountType: accType,
                  accountNumber: accNumber,
                  balance: Number(accBalance) || 0,
                  lastReconciledDate: '',
                });
              }
              closeAccountModal();
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                {editingAccount ? 'Edit Account Details' : 'Add Bank or Cash Account'}
              </h3>
              <button
                type="button"
                onClick={closeAccountModal}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!editingAccount && (
              <div>
                <label className="block text-xs text-slate-300 mb-1">Owner Entity</label>
                <select
                  value={accEntityId || entities[0]?.id || ''}
                  onChange={(e) => setAccEntityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name} ({ent.entityType === 'personal' ? 'Personal' : 'Company'})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Account Name</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder={
                    accType === 'meal_voucher'
                      ? 'Cartão Refeição Edenred'
                      : accType === 'child_voucher'
                      ? 'Vale Infância / Educação'
                      : 'Operating Checking'
                  }
                  value={accName}
                  onChange={(e) => setAccName(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Bank / Provider</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder={
                    isVoucherAccountType(accType)
                      ? 'Edenred / Coverflex / Pluxee'
                      : 'BPI / Millennium'
                  }
                  value={accInstitution}
                  onChange={(e) => setAccInstitution(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">IBAN / Card Reference (Optional)</label>
              <input
                type="text"
                maxLength={34}
                placeholder={isVoucherAccountType(accType) ? 'e.g. Card ···4821' : 'e.g. PT50 0010 ···4821'}
                value={accNumber}
                onChange={(e) => setAccNumber(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
              />
            </div>

            <div className={editingAccount ? '' : 'grid grid-cols-2 gap-3'}>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Account Type</label>
                <select
                  value={accType}
                  onChange={(e) => setAccType(e.target.value as AccountType)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  <option value="checking">Checking</option>
                  <option value="savings">Savings / Reserve</option>
                  <option value="treasury">Treasury</option>
                  <option value="cash">Cash</option>
                  <option value="meal_voucher">Meal Card / Cartão Refeição (Food Only)</option>
                  <option value="child_voucher">Child / Education Voucher (School Only)</option>
                </select>
              </div>
              {!editingAccount && (
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Opening Balance</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={accBalance}
                    onChange={(e) => setAccBalance(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                  />
                </div>
              )}
            </div>

            {isVoucherAccountType(accType) && (
              <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-200 leading-relaxed">
                <strong>Restricted non-withdrawable voucher:</strong> Cannot be transferred or withdrawn to bank cash. Owner payslips automatically top up this balance, and{' '}
                {accType === 'meal_voucher'
                  ? 'groceries & food expenses'
                  : 'kids school, creche & tuition expenses'}{' '}
                spend from here first before overflowing to primary checking.
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={closeAccountModal}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {editingAccount ? 'Save Changes' : 'Add Account'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Adjust Balance Modal */}
      {adjustingAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setAdjustingAccount(null)} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await updateAccountBalance(adjustingAccount.id, Number(adjustValue) || 0);
              setAdjustingAccount(null);
            }}
            className="relative z-10 max-w-sm w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Adjust Account Balance</h3>
              <button
                type="button"
                onClick={() => setAdjustingAccount(null)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">
              {adjustingAccount.name} ({adjustingAccount.institution})
            </p>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Current Balance</label>
              <input
                type="number"
                step="0.01"
                required
                value={adjustValue}
                onChange={(e) => setAdjustValue(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setAdjustingAccount(null)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                Update Balance
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Inter-Account Transfer Modal */}
      {transferModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setTransferModalOpen(false)} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const fromAcc = accounts.find((a) => a.id === fromAccId);
              const toAcc = accounts.find((a) => a.id === toAccId);
              if (!fromAcc || !toAcc || fromAcc.id === toAcc.id) return;
              await transferBetweenAccounts({
                fromAccount: fromAcc,
                toAccount: toAcc,
                amount: Number(transferAmt) || 0,
                date: transferDate,
                note: transferNote,
              });
              setTransferModalOpen(false);
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">Transfer Between Accounts</h3>
              <button
                type="button"
                onClick={() => setTransferModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">From Account (Liquid Cash Only)</label>
              <select
                value={fromAccId}
                onChange={(e) => setFromAccId(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              >
                {liquidAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({formatMoney(a.balance, currencyCode)})
                  </option>
                ))}
              </select>
              {accounts.some((a) => isVoucherAccountType(a.accountType)) && (
                <p className="text-[11px] text-slate-400 mt-1">
                  Meal &amp; Child voucher balances are non-withdrawable and cannot be transferred out as cash.
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">To Account</label>
              <select
                value={toAccId}
                onChange={(e) => setToAccId(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              >
                {accounts
                  .filter((a) => a.id !== fromAccId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({formatMoney(a.balance, currencyCode)})
                    </option>
                  ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={transferAmt}
                  onChange={(e) => setTransferAmt(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Date</label>
                <input
                  type="date"
                  required
                  value={transferDate}
                  onChange={(e) => setTransferDate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Reference Note (Optional)</label>
              <input
                type="text"
                maxLength={100}
                placeholder="e.g. Tax reserve sweep / dividend distribution"
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setTransferModalOpen(false)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!fromAccId || !toAccId || fromAccId === toAccId}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                Execute Transfer
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Clear Sample Data / Reset Workspace Modal */}
      {resetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => !resetting && setResetModalOpen(false)}
          />
          <div className="relative z-10 max-w-lg w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                <h3 className="text-base font-semibold text-slate-100">
                  Clear Demo Data or Reset Workspace
                </h3>
              </div>
              <button
                type="button"
                disabled={resetting}
                onClick={() => setResetModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Choose how you want to prepare this workspace before inputting your real Portuguese companies, bank accounts, contracts, and 2025/2026 statements.
            </p>

            <div className="space-y-2.5">
              {hasSampleData && (
                <label
                  className={`flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors ${
                    resetMode === 'sample_only'
                      ? 'bg-blue-950/30 border-blue-600/60'
                      : 'bg-[#1E293B]/60 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="resetMode"
                    checked={resetMode === 'sample_only'}
                    onChange={() => setResetMode('sample_only')}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <p className="text-xs font-semibold text-slate-100">
                      Remove Sample / Demo Portfolio Only (Recommended)
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Removes Northstar Labs Lda, Northstar Imobiliária Lda, demo accounts, sample contracts, and sample ledger entries while preserving any real records you already added.
                    </p>
                  </div>
                </label>
              )}

              <label
                className={`flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors ${
                  resetMode === 'all_non_reconciled'
                    ? 'bg-rose-950/30 border-rose-600/60'
                    : 'bg-[#1E293B]/60 border-slate-800 hover:border-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name="resetMode"
                  checked={resetMode === 'all_non_reconciled'}
                  onChange={() => setResetMode('all_non_reconciled')}
                  className="mt-0.5 accent-rose-500"
                />
                <div>
                  <p className="text-xs font-semibold text-slate-100">
                    Wipe All Non-Reconciled Workspace Data
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Clears all entities, accounts, loans, contracts, payslips, subscriptions, statements, and non-reconciled ledger entries so you can start 100% blank. Audit-locked reconciled items are preserved automatically.
                  </p>
                </div>
              </label>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={resetting}
                onClick={() => setResetModalOpen(false)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={resetting}
                onClick={async () => {
                  setResetting(true);
                  try {
                    await resetWorkspaceData(resetMode);
                    setResetModalOpen(false);
                  } finally {
                    setResetting(false);
                  }
                }}
                className={`px-4 py-2 text-xs font-medium text-white rounded-lg cursor-pointer disabled:opacity-50 ${
                  resetMode === 'all_non_reconciled'
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {resetting
                  ? 'Clearing...'
                  : resetMode === 'sample_only'
                  ? 'Clear Sample Data'
                  : 'Wipe & Start Blank'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
