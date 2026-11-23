import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  CURRENCY_OPTIONS,
  VALIDATION_BOUNDS,
  type Account,
  type CreditFacility,
  type CurrencyCode,
  type EmploymentContract,
  type Entity,
  type ExpenseReimbursement,
  type ForecastItem,
  type InvoiceDocument,
  type LedgerTransaction,
  type PayslipRecord,
  type PersonalIncome,
  type RecurringExpense,
  type StatementBatch,
  type StatementLine,
  type SuggestedContractDraft,
  type SuggestedFacilityDraft,
  type SuggestedSubscriptionDraft,
  type TaxSetting,
  type WorkspaceProfile,
} from '../types/finance';
import {
  addMonths,
  clampString,
  computeContractMonthlyBreakdown,
  computeTransactionIva,
  currentMonthKey,
  isVoucherAccountType,
  todayIsoDate,
} from '../utils/financeMath';
import { useAuth } from './AuthContext';

export interface ToastItem {
  id: string;
  title: string;
  detail?: string;
  tone: 'info' | 'success' | 'error';
}

interface TreasuryContextValue {
  loading: boolean;
  profile: WorkspaceProfile | null;
  entities: Entity[];
  accounts: Account[];
  creditFacilities: CreditFacility[];
  transactions: LedgerTransaction[];
  payslips: PayslipRecord[];
  forecastItems: ForecastItem[];
  statementBatches: StatementBatch[];
  statementLines: StatementLine[];
  personalIncomes: PersonalIncome[];
  taxSettings: TaxSetting[];
  employmentContracts: EmploymentContract[];
  recurringExpenses: RecurringExpense[];
  reimbursements: ExpenseReimbursement[];
  invoiceDocuments: InvoiceDocument[];
  entityFilter: string;
  setEntityFilter: (id: string) => void;
  filteredAccounts: Account[];
  filteredFacilities: CreditFacility[];
  filteredTransactions: LedgerTransaction[];
  filteredPayslips: PayslipRecord[];
  filteredForecastItems: ForecastItem[];
  filteredStatementBatches: StatementBatch[];
  filteredStatementLines: StatementLine[];
  filteredPersonalIncomes: PersonalIncome[];
  filteredEmploymentContracts: EmploymentContract[];
  filteredRecurringExpenses: RecurringExpense[];
  filteredReimbursements: ExpenseReimbursement[];
  filteredInvoiceDocuments: InvoiceDocument[];
  currencyCode: CurrencyCode;
  currencySymbol: string;
  toasts: ToastItem[];
  pushToast: (title: string, detail?: string, tone?: ToastItem['tone']) => void;
  dismissToast: (id: string) => void;
  completeOnboarding: (opts: {
    currencyCode: CurrencyCode;
    fiscalStartMonth: number;
    loadSampleData: boolean;
  }) => Promise<void>;
  updateCurrencyPreference: (currencyCode: CurrencyCode) => Promise<void>;
  addEntity: (input: Omit<Entity, 'id' | 'userId' | 'archived'>) => Promise<string>;
  updateEntity: (
    id: string,
    input: Pick<Entity, 'name' | 'entityType' | 'registrationCode' | 'colorHex'>
  ) => Promise<void>;
  deleteEntity: (id: string) => Promise<void>;
  addAccount: (input: Omit<Account, 'id' | 'userId'>) => Promise<string>;
  updateAccountDetails: (
    id: string,
    input: Pick<Account, 'name' | 'institution' | 'accountType' | 'accountNumber'>
  ) => Promise<void>;
  updateAccountBalance: (id: string, balance: number) => Promise<void>;
  transferBetweenAccounts: (opts: {
    fromAccount: Account;
    toAccount: Account;
    amount: number;
    date: string;
    note: string;
  }) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  addCreditFacility: (input: Omit<CreditFacility, 'id' | 'userId' | 'status'>) => Promise<string>;
  recordLoanPayment: (opts: {
    facility: CreditFacility;
    amount: number;
    accountId: string;
    date: string;
  }) => Promise<void>;
  deleteCreditFacility: (id: string) => Promise<void>;
  addTransaction: (
    input: Omit<LedgerTransaction, 'id' | 'userId'>,
    opts?: { adjustAccountBalance?: boolean }
  ) => Promise<string>;
  recordVoucherFirstExpense: (opts: {
    entityId: string;
    voucherAccountId: string;
    fallbackAccountId: string;
    date: string;
    description: string;
    category: string;
    amount: number;
    ivaRate: number;
    ivaAmount: number;
    ivaDeductible: boolean;
    adjustAccountBalance: boolean;
  }) => Promise<{ voucherPaid: number; primaryPaid: number }>;
  deleteTransaction: (tx: LedgerTransaction) => Promise<void>;
  addPayslip: (input: Omit<PayslipRecord, 'id' | 'userId' | 'totalCost'>) => Promise<string>;
  markPayslipStatus: (
    payslip: PayslipRecord,
    field: 'payStatus' | 'taxStatus',
    accountId?: string
  ) => Promise<void>;
  deletePayslip: (id: string) => Promise<void>;
  addForecastItem: (input: Omit<ForecastItem, 'id' | 'userId'>) => Promise<string>;
  toggleForecastItem: (id: string, active: boolean) => Promise<void>;
  deleteForecastItem: (id: string) => Promise<void>;
  addPersonalIncome: (input: Omit<PersonalIncome, 'id' | 'userId'>) => Promise<string>;
  updatePersonalIncome: (
    id: string,
    input: Omit<PersonalIncome, 'id' | 'userId' | 'active'>
  ) => Promise<void>;
  togglePersonalIncome: (id: string, active: boolean) => Promise<void>;
  deletePersonalIncome: (id: string) => Promise<void>;
  addEmploymentContract: (input: Omit<EmploymentContract, 'id' | 'userId'>) => Promise<string>;
  updateEmploymentContract: (
    id: string,
    input: Omit<EmploymentContract, 'id' | 'userId' | 'active'>
  ) => Promise<void>;
  toggleEmploymentContract: (id: string, active: boolean) => Promise<void>;
  deleteEmploymentContract: (id: string) => Promise<void>;
  generatePayslipsFromContracts: (opts: {
    monthKeys: string[];
    entityId?: string;
    contractId?: string;
  }) => Promise<number>;
  importNoisysourceUploadedPayslips: () => Promise<{
    createdPayslips: number;
    createdContracts: number;
    entityName: string;
  }>;
  upsertTaxSetting: (input: Omit<TaxSetting, 'id' | 'userId'>) => Promise<void>;
  importStatementBatch: (opts: {
    entityId: string;
    accountId: string;
    filename: string;
    statementPeriod: string;
    openingBalance: number;
    closingBalance: number;
    lines: Array<{
      date: string;
      description: string;
      amount: number;
      direction: 'credit' | 'debit';
    }>;
  }) => Promise<string>;
  confirmReconciliationMatch: (
    line: StatementLine,
    transaction: LedgerTransaction,
    invoiceDoc?: InvoiceDocument
  ) => Promise<void>;
  createLedgerFromStatementLine: (
    line: StatementLine,
    category: string,
    txType: LedgerTransaction['type'],
    opts?: {
      adjustAccountBalance?: boolean;
      ivaRate?: number;
      ivaDeductible?: boolean;
      invoiceDoc?: InvoiceDocument;
    }
  ) => Promise<void>;
  markLineSuggested: (lineId: string, matchedTransactionId: string) => Promise<void>;
  flagLineDiscrepancy: (lineId: string, note: string) => Promise<void>;
  deleteStatementBatch: (batchId: string) => Promise<void>;
  addRecurringExpense: (
    input: Omit<RecurringExpense, 'id' | 'userId' | 'requiresReimbursement' | 'lastPostedDate'>
  ) => Promise<string>;
  updateRecurringExpense: (
    id: string,
    input: Omit<RecurringExpense, 'id' | 'userId' | 'active' | 'requiresReimbursement' | 'lastPostedDate'>
  ) => Promise<void>;
  toggleRecurringExpense: (id: string, active: boolean) => Promise<void>;
  deleteRecurringExpense: (id: string) => Promise<void>;
  postRecurringExpensePayment: (
    expense: RecurringExpense,
    opts?: { date?: string; invoiceNumber?: string }
  ) => Promise<void>;
  addCrossEntityExpense: (opts: {
    beneficiaryEntityId: string;
    paidByAccountId: string;
    creditFacilityId?: string;
    date: string;
    vendor: string;
    description: string;
    category: string;
    invoiceNumber: string;
    hasInvoice: boolean;
    amount: number;
    ivaRate: number;
    ivaDeductible: boolean;
    debitPayerAccount: boolean;
  }) => Promise<void>;
  settleReimbursements: (opts: {
    claims: ExpenseReimbursement[];
    fromAccountId: string;
    toAccountId: string;
    date: string;
  }) => Promise<void>;
  deleteReimbursement: (id: string) => Promise<void>;
  addInvoiceDocument: (input: Omit<InvoiceDocument, 'id' | 'userId'>) => Promise<string>;
  attachInvoiceToRecords: (opts: {
    invoiceDoc: InvoiceDocument;
    transactionId?: string;
    statementLineId?: string;
    reimbursementId?: string;
  }) => Promise<void>;
  createLedgerAndFileInvoice: (opts: {
    invoiceInput: Omit<InvoiceDocument, 'id' | 'userId'>;
    accountId: string;
    category: string;
    description: string;
    createReimbursementToEntityId?: string;
    adjustAccountBalance?: boolean;
    matchedStatementLine?: StatementLine;
  }) => Promise<{ docId: string; txId: string }>;
  deleteInvoiceDocument: (id: string) => Promise<void>;
  bulkImportHistoricalTransactions: (opts: {
    items: Array<{
      entityId: string;
      accountId: string;
      date: string;
      description: string;
      category: string;
      type: LedgerTransaction['type'];
      amount: number;
      ivaRate?: number;
      ivaAmount?: number;
      ivaDeductible?: boolean;
      invoiceNumber?: string;
    }>;
    adjustAccountBalance: boolean;
  }) => Promise<number>;
  importDriveGeneratedBundle: (opts: {
    entityId: string;
    accountId: string;
    adjustAccountBalance: boolean;
    markPayslipsPaid?: boolean;
    statements?: Array<{
      filename: string;
      statementPeriod: string;
      openingBalance: number;
      closingBalance: number;
      lines: Array<{
        date: string;
        description: string;
        amount: number;
        direction: 'credit' | 'debit';
        generatedTx?: {
          vendor: string;
          category: string;
          type: LedgerTransaction['type'];
          ivaRate: number;
          ivaDeductible: boolean;
        };
      }>;
    }>;
    payslips?: Array<Omit<PayslipRecord, 'id' | 'userId' | 'totalCost'>>;
    contracts?: SuggestedContractDraft[];
    subscriptions?: SuggestedSubscriptionDraft[];
    facilities?: SuggestedFacilityDraft[];
  }) => Promise<{
    statements: number;
    statementLines: number;
    transactions: number;
    subscriptions: number;
    facilities: number;
    contracts: number;
    payslips: number;
  }>;
  hasSampleData: boolean;
  resetWorkspaceData: (
    mode: 'sample_only' | 'all_non_reconciled'
  ) => Promise<{ deleted: number; lockedCount: number }>;
}

const SAMPLE_ENTITY_HOLDINGS = 'ent_northstar_holdings';
const SAMPLE_ACCOUNT_IDS = new Set([
  'acc_personal_chk',
  'acc_personal_sav',
  'acc_labs_operating',
  'acc_labs_tax_res',
  'acc_holdings_res',
]);
const SAMPLE_FACILITY_IDS = new Set([
  'fac_sba_term',
  'fac_corp_revolver',
  'fac_personal_mortgage',
]);
const SAMPLE_CONTRACT_IDS = new Set([
  'ctr_owner_director',
  'ctr_elena_eng',
  'ctr_tiago_ops',
]);
const SAMPLE_PERSONAL_INCOME_IDS = new Set(['pinc_job_consulting']);
const SAMPLE_FORECAST_IDS = new Set([
  'fc_labs_retainers',
  'fc_labs_cloud',
  'fc_holdings_rent',
  'fc_personal_living',
]);
const SAMPLE_STATEMENT_BATCH_IDS = new Set(['stmt_bpi_sample']);
const SAMPLE_STATEMENT_LINE_IDS = new Set(['sline_1', 'sline_2', 'sline_3']);
const SAMPLE_SUBSCRIPTION_IDS = new Set([
  'sub_google_ws',
  'sub_figma_org',
  'sub_netflix_personal',
]);
const SAMPLE_REIMBURSEMENT_IDS = new Set([
  'reimb_google_ws',
  'reimb_office_hardware',
]);

function isSamplePayslipId(id: string): boolean {
  return (
    id.startsWith('pay_ctr_owner_director_') ||
    id.startsWith('pay_ctr_elena_eng_') ||
    id.startsWith('pay_ctr_tiago_ops_')
  );
}

function isSampleTxId(id: string): boolean {
  return id.startsWith('tx_sample_');
}

const TreasuryContext = createContext<TreasuryContextValue | null>(null);

function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function safeDateStr(val: string, fallback: string): string {
  return VALIDATION_BOUNDS.DATE_PATTERN.test(val) ? val : fallback;
}

function safeMonthStr(val: string, fallback: string): string {
  return VALIDATION_BOUNDS.MONTH_PATTERN.test(val) ? val : fallback;
}

export function TreasuryProvider({ children }: { children: React.ReactNode }) {
  const { user, authReady } = useAuth();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [creditFacilities, setCreditFacilities] = useState<CreditFacility[]>([]);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [payslips, setPayslips] = useState<PayslipRecord[]>([]);
  const [forecastItems, setForecastItems] = useState<ForecastItem[]>([]);
  const [statementBatches, setStatementBatches] = useState<StatementBatch[]>([]);
  const [statementLines, setStatementLines] = useState<StatementLine[]>([]);
  const [personalIncomes, setPersonalIncomes] = useState<PersonalIncome[]>([]);
  const [taxSettings, setTaxSettings] = useState<TaxSetting[]>([]);
  const [employmentContracts, setEmploymentContracts] = useState<EmploymentContract[]>([]);
  const [recurringExpenses, setRecurringExpenses] = useState<RecurringExpense[]>([]);
  const [reimbursements, setReimbursements] = useState<ExpenseReimbursement[]>([]);
  const [invoiceDocuments, setInvoiceDocuments] = useState<InvoiceDocument[]>([]);
  const [entityFilter, setEntityFilter] = useState<string>('all');
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback(
    (title: string, detail?: string, tone: ToastItem['tone'] = 'info') => {
      const id = makeId('toast');
      setToasts((prev) => [...prev.slice(-3), { id, title, detail, tone }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4500);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      setProfile(null);
      setEntities([]);
      setAccounts([]);
      setCreditFacilities([]);
      setTransactions([]);
      setPayslips([]);
      setForecastItems([]);
      setStatementBatches([]);
      setStatementLines([]);
      setPersonalIncomes([]);
      setTaxSettings([]);
      setEmploymentContracts([]);
      setRecurringExpenses([]);
      setReimbursements([]);
      setInvoiceDocuments([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const uid = user.uid;
    let profileLoaded = false;

    const unsubProfile = onSnapshot(
      doc(db, 'finhub_users', uid),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setProfile({
            id: snap.id,
            userId: data.userId,
            currencyCode: data.currencyCode,
            currencySymbol: data.currencySymbol,
            fiscalStartMonth: data.fiscalStartMonth,
            onboardingComplete: Boolean(data.onboardingComplete),
          });
        } else {
          setProfile(null);
        }
        profileLoaded = true;
        setLoading(false);
      },
      (err) => {
        if (!profileLoaded) setLoading(false);
        handleFirestoreError(err, OperationType.GET, `finhub_users/${uid}`);
      }
    );

    const sub = <T,>(
      colName: string,
      setter: React.Dispatch<React.SetStateAction<T[]>>,
      sortFn?: (a: T, b: T) => number
    ) => {
      const path = `finhub_users/${uid}/${colName}`;
      const q = query(collection(db, path), where('userId', '==', uid));
      return onSnapshot(
        q,
        (snap) => {
          const items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<T, 'id'>) }) as T);
          if (sortFn) items.sort(sortFn);
          setter(items);
        },
        (err) => handleFirestoreError(err, OperationType.LIST, path)
      );
    };

    const unsubs = [
      unsubProfile,
      sub<Entity>('entities', setEntities, (a, b) => a.name.localeCompare(b.name)),
      sub<Account>('accounts', setAccounts, (a, b) => a.name.localeCompare(b.name)),
      sub<CreditFacility>('creditFacilities', setCreditFacilities, (a, b) =>
        b.currentBalance - a.currentBalance
      ),
      sub<LedgerTransaction>('transactions', setTransactions, (a, b) =>
        b.date.localeCompare(a.date)
      ),
      sub<PayslipRecord>('payslips', setPayslips, (a, b) => b.payDate.localeCompare(a.payDate)),
      sub<ForecastItem>('forecastItems', setForecastItems, (a, b) =>
        a.name.localeCompare(b.name)
      ),
      sub<StatementBatch>('statementBatches', setStatementBatches, (a, b) =>
        b.filename.localeCompare(a.filename)
      ),
      sub<StatementLine>('statementLines', setStatementLines, (a, b) =>
        b.date.localeCompare(a.date)
      ),
      sub<PersonalIncome>('personalIncomes', setPersonalIncomes, (a, b) =>
        a.title.localeCompare(b.title)
      ),
      sub<TaxSetting>('taxSettings', setTaxSettings),
      sub<EmploymentContract>('employmentContracts', setEmploymentContracts, (a, b) =>
        a.workerName.localeCompare(b.workerName)
      ),
      sub<RecurringExpense>('recurringExpenses', setRecurringExpenses, (a, b) =>
        a.name.localeCompare(b.name)
      ),
      sub<ExpenseReimbursement>('reimbursements', setReimbursements, (a, b) =>
        b.date.localeCompare(a.date)
      ),
      sub<InvoiceDocument>('invoiceDocuments', setInvoiceDocuments, (a, b) =>
        b.date.localeCompare(a.date)
      ),
    ];

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [authReady, user]);

  useEffect(() => {
    if (entityFilter !== 'all' && !entities.some((e) => e.id === entityFilter)) {
      setEntityFilter('all');
    }
  }, [entities, entityFilter]);

  const byEntity = useCallback(
    <T extends { entityId: string }>(items: T[]) =>
      entityFilter === 'all' ? items : items.filter((item) => item.entityId === entityFilter),
    [entityFilter]
  );

  const filteredAccounts = useMemo(() => byEntity(accounts), [accounts, byEntity]);
  const filteredFacilities = useMemo(() => byEntity(creditFacilities), [creditFacilities, byEntity]);
  const filteredTransactions = useMemo(() => byEntity(transactions), [transactions, byEntity]);
  const filteredPayslips = useMemo(() => byEntity(payslips), [payslips, byEntity]);
  const filteredForecastItems = useMemo(() => byEntity(forecastItems), [forecastItems, byEntity]);
  const filteredStatementBatches = useMemo(() => byEntity(statementBatches), [statementBatches, byEntity]);
  const filteredStatementLines = useMemo(() => byEntity(statementLines), [statementLines, byEntity]);
  const filteredPersonalIncomes = useMemo(() => byEntity(personalIncomes), [personalIncomes, byEntity]);
  const filteredEmploymentContracts = useMemo(
    () => byEntity(employmentContracts),
    [employmentContracts, byEntity]
  );
  const filteredRecurringExpenses = useMemo(
    () =>
      entityFilter === 'all'
        ? recurringExpenses
        : recurringExpenses.filter(
            (e) => e.entityId === entityFilter || e.paidByEntityId === entityFilter
          ),
    [recurringExpenses, entityFilter]
  );
  const filteredReimbursements = useMemo(
    () =>
      entityFilter === 'all'
        ? reimbursements
        : reimbursements.filter(
            (r) => r.owedByEntityId === entityFilter || r.owedToEntityId === entityFilter
          ),
    [reimbursements, entityFilter]
  );
  const filteredInvoiceDocuments = useMemo(
    () => byEntity(invoiceDocuments),
    [invoiceDocuments, byEntity]
  );

  const currencyCode: CurrencyCode = profile?.currencyCode ?? 'EUR';
  const currencySymbol: string = profile?.currencySymbol ?? '€';

  const requireUid = () => {
    if (!user) throw new Error('Not authenticated');
    return user.uid;
  };

  const completeOnboarding = async ({
    currencyCode: chosenCode,
    fiscalStartMonth,
    loadSampleData,
  }: {
    currencyCode: CurrencyCode;
    fiscalStartMonth: number;
    loadSampleData: boolean;
  }) => {
    const uid = requireUid();
    const curOpt = CURRENCY_OPTIONS.find((c) => c.code === chosenCode) ?? CURRENCY_OPTIONS[0];
    const profilePath = `finhub_users/${uid}`;

    try {
      await setDoc(doc(db, 'finhub_users', uid), {
        userId: uid,
        currencyCode: curOpt.code,
        currencySymbol: curOpt.symbol,
        fiscalStartMonth,
        onboardingComplete: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, profilePath);
    }

    const entPersonalId = 'ent_personal';
    const entAlphaId = 'ent_northstar_labs';
    const entHoldingsId = 'ent_northstar_holdings';

    try {
      const entBatch = writeBatch(db);
      entBatch.set(doc(db, `finhub_users/${uid}/entities`, entPersonalId), {
        userId: uid,
        name: 'Personal Household',
        entityType: 'personal',
        registrationCode: 'NIF 248190312',
        colorHex: '#38BDF8',
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      entBatch.set(doc(db, `finhub_users/${uid}/entities`, entAlphaId), {
        userId: uid,
        name: loadSampleData ? 'Northstar Labs Lda' : 'Primary Operating Co',
        entityType: 'company',
        registrationCode: loadSampleData ? 'NIPC 514829301' : '',
        colorHex: '#3B82F6',
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (loadSampleData) {
        entBatch.set(doc(db, `finhub_users/${uid}/entities`, entHoldingsId), {
          userId: uid,
          name: 'Northstar Imobiliária Lda',
          entityType: 'company',
          registrationCode: 'NIPC 516902114',
          colorHex: '#818CF8',
          archived: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await entBatch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/entities`);
    }

    if (!loadSampleData) {
      pushToast('Workspace initialized', 'Personal and company entities are ready.', 'success');
      return;
    }

    const thisMonth = currentMonthKey();
    const today = todayIsoDate();

    const accPersonalChk = 'acc_personal_chk';
    const accPersonalSav = 'acc_personal_sav';
    const accLabsOp = 'acc_labs_operating';
    const accLabsTax = 'acc_labs_tax_res';
    const accHoldings = 'acc_holdings_res';

    try {
      const accBatch = writeBatch(db);
      accBatch.set(doc(db, `finhub_users/${uid}/accounts`, accPersonalChk), {
        userId: uid,
        entityId: entPersonalId,
        name: 'Conta Ordem Pessoal',
        institution: 'Millennium bcp',
        accountType: 'checking',
        accountNumber: 'PT50 ···4821',
        balance: 18450,
        lastReconciledDate: `${thisMonth}-01`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      accBatch.set(doc(db, `finhub_users/${uid}/accounts`, accPersonalSav), {
        userId: uid,
        entityId: entPersonalId,
        name: 'Poupança & Reserva IRS',
        institution: 'ActivoBank',
        accountType: 'savings',
        accountNumber: 'PT50 ···9910',
        balance: 24400,
        lastReconciledDate: `${thisMonth}-01`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      accBatch.set(doc(db, `finhub_users/${uid}/accounts`, accLabsOp), {
        userId: uid,
        entityId: entAlphaId,
        name: 'Operating Treasury',
        institution: 'BPI Empresas',
        accountType: 'treasury',
        accountNumber: 'PT50 ···1042',
        balance: 142600,
        lastReconciledDate: `${thisMonth}-01`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      accBatch.set(doc(db, `finhub_users/${uid}/accounts`, accLabsTax), {
        userId: uid,
        entityId: entAlphaId,
        name: 'IVA & IRC Tax Reserve',
        institution: 'Santander Totta',
        accountType: 'savings',
        accountNumber: 'PT50 ···7731',
        balance: 42000,
        lastReconciledDate: `${thisMonth}-01`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      accBatch.set(doc(db, `finhub_users/${uid}/accounts`, accHoldings), {
        userId: uid,
        entityId: entHoldingsId,
        name: 'Rental Escrow & Reserve',
        institution: 'Novo Banco',
        accountType: 'checking',
        accountNumber: 'PT50 ···3309',
        balance: 68200,
        lastReconciledDate: `${thisMonth}-01`,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await accBatch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/accounts`);
    }

    try {
      const dataBatch = writeBatch(db);
      // Credit Facilities
      dataBatch.set(doc(db, `finhub_users/${uid}/creditFacilities`, 'fac_sba_term'), {
        userId: uid,
        entityId: entAlphaId,
        fundingAccountId: accLabsOp,
        name: 'Linha PME Crescimento',
        lender: 'Banco BPI',
        facilityType: 'term_loan',
        principalOrLimit: 150000,
        currentBalance: 96400,
        apr: 5.25,
        monthlyPayment: 3120,
        dueDay: 18,
        maturityDate: '2029-06-18',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/creditFacilities`, 'fac_corp_revolver'), {
        userId: uid,
        entityId: entAlphaId,
        fundingAccountId: accLabsOp,
        name: 'Corporate Credit Line',
        lender: 'Santander Empresas',
        facilityType: 'credit_card',
        principalOrLimit: 50000,
        currentBalance: 11200,
        apr: 12.9,
        monthlyPayment: 1800,
        dueDay: 24,
        maturityDate: '2028-12-31',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/creditFacilities`, 'fac_personal_mortgage'), {
        userId: uid,
        entityId: entPersonalId,
        fundingAccountId: accPersonalChk,
        name: 'Crédito Habitação',
        lender: 'Millennium bcp',
        facilityType: 'mortgage',
        principalOrLimit: 320000,
        currentBalance: 248500,
        apr: 3.65,
        monthlyPayment: 1420,
        dueDay: 5,
        maturityDate: '2048-05-05',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Employment Contracts (Portuguese Payroll & Benefits)
      const sampleContracts: EmploymentContract[] = [
        {
          id: 'ctr_owner_director',
          userId: uid,
          entityId: entAlphaId,
          fundingAccountId: accLabsOp,
          workerName: 'André Martins',
          roleTitle: 'Managing Director',
          isOwnerIncome: true,
          personalEntityId: entPersonalId,
          paySchedule: '14_months',
          baseGrossMonthly: 3200,
          irsRate: 21.5,
          employeeSsRate: 11,
          employerSsRate: 23.75,
          mealAllowanceDaily: 10.46,
          mealPaymentMethod: 'card',
          childVoucherMonthly: 250,
          childVoucherSubjectToIrs: false,
          childVoucherSubjectToSs: false,
          otherBenefitName: 'Seguro de Saúde',
          otherBenefitMonthly: 85,
          otherBenefitSubjectToIrs: false,
          otherBenefitSubjectToSs: false,
          active: true,
        },
        {
          id: 'ctr_elena_eng',
          userId: uid,
          entityId: entAlphaId,
          fundingAccountId: accLabsOp,
          workerName: 'Elena Vance',
          roleTitle: 'Lead Engineer',
          isOwnerIncome: false,
          personalEntityId: '',
          paySchedule: '14_months',
          baseGrossMonthly: 4200,
          irsRate: 24.5,
          employeeSsRate: 11,
          employerSsRate: 23.75,
          mealAllowanceDaily: 10.46,
          mealPaymentMethod: 'card',
          childVoucherMonthly: 0,
          childVoucherSubjectToIrs: false,
          childVoucherSubjectToSs: false,
          otherBenefitName: '',
          otherBenefitMonthly: 0,
          otherBenefitSubjectToIrs: false,
          otherBenefitSubjectToSs: false,
          active: true,
        },
        {
          id: 'ctr_tiago_ops',
          userId: uid,
          entityId: entAlphaId,
          fundingAccountId: accLabsOp,
          workerName: 'Tiago Silva',
          roleTitle: 'Operations Specialist',
          isOwnerIncome: false,
          personalEntityId: '',
          paySchedule: '14_months',
          baseGrossMonthly: 2400,
          irsRate: 16.5,
          employeeSsRate: 11,
          employerSsRate: 23.75,
          mealAllowanceDaily: 8.5,
          mealPaymentMethod: 'cash',
          childVoucherMonthly: 150,
          childVoucherSubjectToIrs: false,
          childVoucherSubjectToSs: false,
          otherBenefitName: '',
          otherBenefitMonthly: 0,
          otherBenefitSubjectToIrs: false,
          otherBenefitSubjectToSs: false,
          active: true,
        },
      ];

      for (const ctr of sampleContracts) {
        const { id: ctrId, ...ctrFields } = ctr;
        dataBatch.set(doc(db, `finhub_users/${uid}/employmentContracts`, ctrId), {
          ...ctrFields,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const brk = computeContractMonthlyBreakdown(ctr, thisMonth);
        dataBatch.set(doc(db, `finhub_users/${uid}/payslips`, `pay_${ctrId}_${thisMonth}`), {
          userId: uid,
          entityId: ctr.entityId,
          contractId: ctrId,
          employeeName: `${ctr.workerName} (${ctr.roleTitle})`,
          periodStart: brk.periodStart,
          periodEnd: brk.periodEnd,
          payDate: brk.payDate,
          taxDueDate: brk.taxDueDate,
          grossPay: brk.grossTotal,
          netPay: brk.netDisbursement,
          employeeWithholdings: brk.employeeWithholdings,
          employerTaxes: brk.employerSs,
          employerContributions: 0,
          totalCost: brk.totalEmployerCost,
          payStatus: 'scheduled',
          taxStatus: 'scheduled',
          sourceFilename: 'Auto-generated from Contract',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      // External Personal Jobs & Side Incomes counting toward IRS
      dataBatch.set(doc(db, `finhub_users/${uid}/personalIncomes`, 'pinc_job_consulting'), {
        userId: uid,
        entityId: entPersonalId,
        accountId: accPersonalChk,
        title: 'Technical Advisory (Recibos Verdes)',
        payerName: 'External Clients',
        incomeCategory: 'cat_b_independent',
        frequency: 'monthly',
        grossAmount: 1450,
        irsWithheldRate: 25,
        ssRate: 14.98,
        countsTowardsIrs: true,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Tax Settings per Entity
      dataBatch.set(doc(db, `finhub_users/${uid}/taxSettings`, `tax_${entPersonalId}`), {
        userId: uid,
        entityId: entPersonalId,
        region: 'continente',
        isPme: true,
        ivaPeriodicity: 'exempt',
        derramaRate: 0,
        ircPaymentsOnAccount: 0,
        irsMaritalStatus: 'single',
        irsDependents: 1,
        irsDeductions: 950,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/taxSettings`, `tax_${entAlphaId}`), {
        userId: uid,
        entityId: entAlphaId,
        region: 'continente',
        isPme: true,
        ivaPeriodicity: 'quarterly',
        derramaRate: 1.5,
        ircPaymentsOnAccount: 2400,
        irsMaritalStatus: 'single',
        irsDependents: 0,
        irsDeductions: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Forecast Assumptions
      dataBatch.set(doc(db, `finhub_users/${uid}/forecastItems`, 'fc_labs_retainers'), {
        userId: uid,
        entityId: entAlphaId,
        name: 'B2B Software & Retainers (Net)',
        direction: 'inflow',
        category: 'Operating Revenue',
        monthlyAmount: 34500,
        startMonth: thisMonth,
        endMonth: '',
        annualGrowthRate: 8,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/forecastItems`, 'fc_labs_cloud'), {
        userId: uid,
        entityId: entAlphaId,
        name: 'Cloud Infrastructure & Suppliers',
        direction: 'outflow',
        category: 'Infrastructure',
        monthlyAmount: 5400,
        startMonth: thisMonth,
        endMonth: '',
        annualGrowthRate: 3,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/forecastItems`, 'fc_holdings_rent'), {
        userId: uid,
        entityId: entHoldingsId,
        name: 'Commercial Suite Lease',
        direction: 'inflow',
        category: 'Rental Income',
        monthlyAmount: 4800,
        startMonth: thisMonth,
        endMonth: '',
        annualGrowthRate: 3,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/forecastItems`, 'fc_personal_living'), {
        userId: uid,
        entityId: entPersonalId,
        name: 'Household Living & Utilities',
        direction: 'outflow',
        category: 'Living Expenses',
        monthlyAmount: 2350,
        startMonth: thisMonth,
        endMonth: '',
        annualGrowthRate: 2,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Ledger Transactions with Portuguese IVA tags
      dataBatch.set(doc(db, `finhub_users/${uid}/transactions`, 'tx_sample_1'), {
        userId: uid,
        entityId: entAlphaId,
        accountId: accLabsOp,
        facilityId: '',
        payslipId: '',
        date: `${thisMonth}-04`,
        description: 'Fatura #2026-104 · Cliente Enterprise PT',
        category: 'Operating Revenue',
        type: 'income',
        amount: 30504,
        ivaRate: 23,
        ivaAmount: computeTransactionIva(30504, 23),
        ivaDeductible: false,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/transactions`, 'tx_sample_2'), {
        userId: uid,
        entityId: entAlphaId,
        accountId: accLabsOp,
        facilityId: '',
        payslipId: '',
        date: `${thisMonth}-07`,
        description: 'Equipamento & Cloud Services PT',
        category: 'Infrastructure',
        type: 'expense',
        amount: 4920,
        ivaRate: 23,
        ivaAmount: computeTransactionIva(4920, 23),
        ivaDeductible: true,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/transactions`, 'tx_sample_3'), {
        userId: uid,
        entityId: entPersonalId,
        accountId: accPersonalChk,
        facilityId: 'fac_personal_mortgage',
        payslipId: '',
        date: `${thisMonth}-05`,
        description: 'Millennium Crédito Habitação',
        category: 'Debt Service',
        type: 'debt_payment',
        amount: 1420,
        ivaRate: 0,
        ivaAmount: 0,
        ivaDeductible: false,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      dataBatch.set(doc(db, `finhub_users/${uid}/transactions`, 'tx_sample_4'), {
        userId: uid,
        entityId: entAlphaId,
        accountId: accLabsOp,
        facilityId: '',
        payslipId: '',
        date: today,
        description: 'Literatura Técnica & Formação (IVA 6%)',
        category: 'Training',
        type: 'expense',
        amount: 636,
        ivaRate: 6,
        ivaAmount: computeTransactionIva(636, 6),
        ivaDeductible: true,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const batchId = 'stmt_bpi_sample';
      dataBatch.set(doc(db, `finhub_users/${uid}/statementBatches`, batchId), {
        userId: uid,
        entityId: entAlphaId,
        accountId: accLabsOp,
        filename: 'bpi_empresas_nov_2026.csv',
        statementPeriod: `${thisMonth}-01 to ${today}`,
        openingBalance: 117016,
        closingBalance: 142600,
        lineCount: 3,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await dataBatch.commit();

      const lineBatch = writeBatch(db);
      lineBatch.set(doc(db, `finhub_users/${uid}/statementLines`, 'sline_1'), {
        userId: uid,
        batchId,
        entityId: entAlphaId,
        accountId: accLabsOp,
        date: `${thisMonth}-04`,
        description: 'TRF RECEBIDA CLIENTE ENTERPRISE 2026-104',
        amount: 30504,
        direction: 'credit',
        reconciliationStatus: 'unmatched',
        matchedTransactionId: '',
        discrepancyNote: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      lineBatch.set(doc(db, `finhub_users/${uid}/statementLines`, 'sline_2'), {
        userId: uid,
        batchId,
        entityId: entAlphaId,
        accountId: accLabsOp,
        date: `${thisMonth}-07`,
        description: 'PAG SERVICOS CLOUD & EQUIPAMENTO',
        amount: 4920,
        direction: 'debit',
        reconciliationStatus: 'unmatched',
        matchedTransactionId: '',
        discrepancyNote: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      lineBatch.set(doc(db, `finhub_users/${uid}/statementLines`, 'sline_3'), {
        userId: uid,
        batchId,
        entityId: entAlphaId,
        accountId: accLabsOp,
        date: `${thisMonth}-11`,
        description: 'COMISSAO MANUTENCAO CONTA BPI',
        amount: 24.5,
        direction: 'debit',
        reconciliationStatus: 'unmatched',
        matchedTransactionId: '',
        discrepancyNote: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const currentMonthNum = Number(thisMonth.slice(5, 7));
      // Recurring Subscriptions (Monthly, Annual, Credit-linked, Cross-entity Invoiced)
      lineBatch.set(doc(db, `finhub_users/${uid}/recurringExpenses`, 'sub_google_ws'), {
        userId: uid,
        entityId: entAlphaId,
        paidByAccountId: accPersonalChk,
        paidByEntityId: entPersonalId,
        creditFacilityId: '',
        name: 'Google Workspace Business',
        vendor: 'Google Cloud EMEA',
        category: 'SaaS & Productivity',
        amount: 216,
        frequency: 'annual',
        billingDay: 15,
        billingMonth: currentMonthNum,
        ivaRate: 23,
        ivaDeductible: true,
        hasInvoice: true,
        requiresReimbursement: true,
        lastPostedDate: today,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      lineBatch.set(doc(db, `finhub_users/${uid}/recurringExpenses`, 'sub_figma_org'), {
        userId: uid,
        entityId: entAlphaId,
        paidByAccountId: accLabsOp,
        paidByEntityId: entAlphaId,
        creditFacilityId: 'fac_corp_revolver',
        name: 'Figma Organization',
        vendor: 'Figma Inc',
        category: 'Design & SaaS',
        amount: 165,
        frequency: 'monthly',
        billingDay: 12,
        billingMonth: 1,
        ivaRate: 23,
        ivaDeductible: true,
        hasInvoice: true,
        requiresReimbursement: false,
        lastPostedDate: '',
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      lineBatch.set(doc(db, `finhub_users/${uid}/recurringExpenses`, 'sub_netflix_personal'), {
        userId: uid,
        entityId: entPersonalId,
        paidByAccountId: accPersonalChk,
        paidByEntityId: entPersonalId,
        creditFacilityId: '',
        name: 'Netflix & iCloud Family',
        vendor: 'Netflix / Apple',
        category: 'Personal Subscriptions',
        amount: 27.98,
        frequency: 'monthly',
        billingDay: 19,
        billingMonth: 1,
        ivaRate: 0,
        ivaDeductible: false,
        hasInvoice: false,
        requiresReimbursement: false,
        lastPostedDate: '',
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Open Inter-Entity Reimbursements (Company owes Personal for Invoiced Outlays)
      lineBatch.set(doc(db, `finhub_users/${uid}/reimbursements`, 'reimb_google_ws'), {
        userId: uid,
        owedByEntityId: entAlphaId,
        owedToEntityId: entPersonalId,
        paidByAccountId: accPersonalChk,
        recurringExpenseId: 'sub_google_ws',
        transactionId: '',
        date: today,
        vendor: 'Google Cloud EMEA',
        description: 'Google Workspace Business (Annual Renewal)',
        invoiceNumber: 'FAT-GW-2026-114',
        hasInvoice: true,
        amount: 216,
        ivaRate: 23,
        ivaAmount: computeTransactionIva(216, 23),
        ivaDeductible: true,
        status: 'open',
        settledDate: '',
        settledFromAccountId: '',
        settledToAccountId: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      lineBatch.set(doc(db, `finhub_users/${uid}/reimbursements`, 'reimb_office_hardware'), {
        userId: uid,
        owedByEntityId: entAlphaId,
        owedToEntityId: entPersonalId,
        paidByAccountId: accPersonalChk,
        recurringExpenseId: '',
        transactionId: '',
        date: `${thisMonth}-06`,
        vendor: 'Worten Empresas',
        description: 'USB-C Dock & Monitor Cable (Paid on Personal Card)',
        invoiceNumber: 'FT 2026/8831',
        hasInvoice: true,
        amount: 149,
        ivaRate: 23,
        ivaAmount: computeTransactionIva(149, 23),
        ivaDeductible: true,
        status: 'open',
        settledDate: '',
        settledFromAccountId: '',
        settledToAccountId: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await lineBatch.commit();

      pushToast(
        'Demo portfolio loaded',
        'Multi-account entities, personal jobs, IVA/IRS/IRC settings, and forecasts are ready.',
        'success'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}`);
    }
  };

  const updateCurrencyPreference = async (nextCode: CurrencyCode) => {
    const uid = requireUid();
    const curOpt = CURRENCY_OPTIONS.find((c) => c.code === nextCode) ?? CURRENCY_OPTIONS[0];
    const path = `finhub_users/${uid}`;
    try {
      await updateDoc(doc(db, 'finhub_users', uid), {
        currencyCode: curOpt.code,
        currencySymbol: curOpt.symbol,
        updatedAt: serverTimestamp(),
      });
      pushToast('Currency updated', `Workspace now displays all accounts in ${curOpt.code}.`, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const addEntity = async (input: Omit<Entity, 'id' | 'userId' | 'archived'>) => {
    const uid = requireUid();
    const id = makeId('ent');
    const path = `finhub_users/${uid}/entities/${id}`;
    const color = VALIDATION_BOUNDS.COLOR_PATTERN.test(input.colorHex) ? input.colorHex : '#3B82F6';
    try {
      await setDoc(doc(db, path), {
        userId: uid,
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'New Entity',
        entityType: input.entityType,
        registrationCode: clampString(input.registrationCode, VALIDATION_BOUNDS.MAX_REG_LEN),
        colorHex: color,
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Entity created', input.name, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const updateEntity = async (
    id: string,
    input: Pick<Entity, 'name' | 'entityType' | 'registrationCode' | 'colorHex'>
  ) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/entities/${id}`;
    const color = VALIDATION_BOUNDS.COLOR_PATTERN.test(input.colorHex) ? input.colorHex : '#3B82F6';
    try {
      await updateDoc(doc(db, path), {
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Entity',
        entityType: input.entityType,
        registrationCode: clampString(input.registrationCode, VALIDATION_BOUNDS.MAX_REG_LEN),
        colorHex: color,
        updatedAt: serverTimestamp(),
      });
      pushToast('Entity updated', input.name, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deleteEntity = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/entities/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Entity removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addAccount = async (input: Omit<Account, 'id' | 'userId'>) => {
    const uid = requireUid();
    const id = makeId('acc');
    const path = `finhub_users/${uid}/accounts/${id}`;
    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Account',
        institution: clampString(input.institution, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Bank',
        accountType: input.accountType,
        accountNumber: clampString(input.accountNumber || '', VALIDATION_BOUNDS.MAX_ACCT_NUM_LEN),
        balance: Number(input.balance) || 0,
        lastReconciledDate: clampString(input.lastReconciledDate, 20),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Account added', input.name, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const updateAccountDetails = async (
    id: string,
    input: Pick<Account, 'name' | 'institution' | 'accountType' | 'accountNumber'>
  ) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/accounts/${id}`;
    try {
      await updateDoc(doc(db, path), {
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Account',
        institution: clampString(input.institution, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Bank',
        accountType: input.accountType,
        accountNumber: clampString(input.accountNumber || '', VALIDATION_BOUNDS.MAX_ACCT_NUM_LEN),
        updatedAt: serverTimestamp(),
      });
      pushToast('Account updated', input.name, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const updateAccountBalance = async (id: string, balance: number) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/accounts/${id}`;
    try {
      await updateDoc(doc(db, path), {
        balance: Number(balance) || 0,
        updatedAt: serverTimestamp(),
      });
      pushToast('Balance adjusted', undefined, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const transferBetweenAccounts = async ({
    fromAccount,
    toAccount,
    amount,
    date,
    note,
  }: {
    fromAccount: Account;
    toAccount: Account;
    amount: number;
    date: string;
    note: string;
  }) => {
    const uid = requireUid();
    const amt = Math.max(0, Number(amount) || 0);
    if (amt <= 0 || fromAccount.id === toAccount.id) return;

    if (
      isVoucherAccountType(fromAccount.accountType) &&
      fromAccount.accountType !== toAccount.accountType
    ) {
      pushToast(
        'Restricted voucher account',
        'Meal and Child vouchers cannot be withdrawn or transferred to general cash.',
        'error'
      );
      return;
    }

    const txOutId = makeId('tx');
    const txInId = makeId('tx');
    const safeDate = safeDateStr(date, todayIsoDate());

    try {
      const wb = writeBatch(db);
      wb.update(doc(db, `finhub_users/${uid}/accounts`, fromAccount.id), {
        balance: Number((fromAccount.balance - amt).toFixed(2)),
        updatedAt: serverTimestamp(),
      });
      wb.update(doc(db, `finhub_users/${uid}/accounts`, toAccount.id), {
        balance: Number((toAccount.balance + amt).toFixed(2)),
        updatedAt: serverTimestamp(),
      });
      wb.set(doc(db, `finhub_users/${uid}/transactions`, txOutId), {
        userId: uid,
        entityId: fromAccount.entityId,
        accountId: fromAccount.id,
        facilityId: '',
        payslipId: '',
        date: safeDate,
        description: clampString(
          note ? `Transfer to ${toAccount.name} (${note})` : `Transfer to ${toAccount.name}`,
          VALIDATION_BOUNDS.MAX_DESC_LEN
        ),
        category: 'Internal Transfer',
        type: 'transfer',
        amount: amt,
        ivaRate: 0,
        ivaAmount: 0,
        ivaDeductible: false,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      wb.set(doc(db, `finhub_users/${uid}/transactions`, txInId), {
        userId: uid,
        entityId: toAccount.entityId,
        accountId: toAccount.id,
        facilityId: '',
        payslipId: '',
        date: safeDate,
        description: clampString(
          note ? `Transfer from ${fromAccount.name} (${note})` : `Transfer from ${fromAccount.name}`,
          VALIDATION_BOUNDS.MAX_DESC_LEN
        ),
        category: 'Internal Transfer',
        type: 'income',
        amount: amt,
        ivaRate: 0,
        ivaAmount: 0,
        ivaDeductible: false,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await wb.commit();
      pushToast('Transfer completed', `${fromAccount.name} → ${toAccount.name}`, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/accounts`);
    }
  };

  const deleteAccount = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/accounts/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Account removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addCreditFacility = async (input: Omit<CreditFacility, 'id' | 'userId' | 'status'>) => {
    const uid = requireUid();
    const id = makeId('fac');
    const path = `finhub_users/${uid}/creditFacilities/${id}`;
    const bal = Math.max(0, Number(input.currentBalance) || 0);
    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        fundingAccountId: input.fundingAccountId || '',
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Credit Facility',
        lender: clampString(input.lender, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Lender',
        facilityType: input.facilityType,
        principalOrLimit: Math.max(0, Number(input.principalOrLimit) || 0),
        currentBalance: bal,
        apr: Math.min(100, Math.max(0, Number(input.apr) || 0)),
        monthlyPayment: Math.max(0, Number(input.monthlyPayment) || 0),
        dueDay: Math.min(31, Math.max(1, Math.round(Number(input.dueDay) || 1))),
        maturityDate: clampString(input.maturityDate, 20),
        status: bal <= 0 ? 'paid_off' : 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Credit facility added', input.name, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const recordLoanPayment = async ({
    facility,
    amount,
    accountId,
    date,
  }: {
    facility: CreditFacility;
    amount: number;
    accountId: string;
    date: string;
  }) => {
    const uid = requireUid();
    const payAmt = Math.max(0, Number(amount) || 0);
    if (payAmt <= 0) return;

    const monthlyInterest = facility.currentBalance * (facility.apr / 100 / 12);
    const principalReduction = Math.max(0, payAmt - monthlyInterest);
    const nextBalance = Math.max(0, Number((facility.currentBalance - principalReduction).toFixed(2)));
    const nextStatus: CreditFacility['status'] = nextBalance <= 0.01 ? 'paid_off' : 'active';
    const txId = makeId('tx');

    const account = accounts.find((a) => a.id === accountId);

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, `finhub_users/${uid}/creditFacilities`, facility.id), {
        currentBalance: nextBalance,
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
      if (account) {
        batch.update(doc(db, `finhub_users/${uid}/accounts`, account.id), {
          balance: Number((account.balance - payAmt).toFixed(2)),
          updatedAt: serverTimestamp(),
        });
        batch.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: facility.entityId,
          accountId: account.id,
          facilityId: facility.id,
          payslipId: '',
          date: safeDateStr(date, todayIsoDate()),
          description: clampString(`Payment · ${facility.name}`, VALIDATION_BOUNDS.MAX_DESC_LEN),
          category: 'Debt Service',
          type: 'debt_payment',
          amount: payAmt,
          ivaRate: 0,
          ivaAmount: 0,
          ivaDeductible: false,
          status: 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      pushToast(
        'Payment recorded',
        nextStatus === 'paid_off' ? `${facility.name} paid in full.` : `${facility.name} updated.`,
        'success'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/creditFacilities/${facility.id}`);
    }
  };

  const deleteCreditFacility = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/creditFacilities/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Facility removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addTransaction = async (
    input: Omit<LedgerTransaction, 'id' | 'userId'>,
    opts?: { adjustAccountBalance?: boolean }
  ) => {
    const uid = requireUid();
    const id = makeId('tx');
    const path = `finhub_users/${uid}/transactions/${id}`;
    const amt = Math.max(0, Number(input.amount) || 0);
    const ivaRate = Math.min(30, Math.max(0, Number(input.ivaRate) || 0));
    const ivaAmount =
      typeof input.ivaAmount === 'number'
        ? Math.max(0, Number(input.ivaAmount))
        : computeTransactionIva(amt, ivaRate);
    const ivaDeductible = Boolean(input.ivaDeductible);
    const account = accounts.find((a) => a.id === input.accountId);
    const shouldAdjust = opts?.adjustAccountBalance !== false;

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        accountId: input.accountId,
        facilityId: input.facilityId || '',
        payslipId: input.payslipId || '',
        date: safeDateStr(input.date, todayIsoDate()),
        description: clampString(input.description, VALIDATION_BOUNDS.MAX_DESC_LEN) || 'Transaction',
        category: clampString(input.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'General',
        type: input.type,
        amount: amt,
        ivaRate,
        ivaAmount,
        ivaDeductible,
        invoiceNumber: clampString(input.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
        invoiceDocId: input.invoiceDocId || '',
        driveFileId: clampString(input.driveFileId || '', 160),
        driveWebViewLink: clampString(input.driveWebViewLink || '', 512),
        driveFolderPath: clampString(input.driveFolderPath || '', 240),
        status: input.status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (shouldAdjust && account && input.status === 'cleared') {
        const delta = input.type === 'income' ? amt : -amt;
        batch.update(doc(db, `finhub_users/${uid}/accounts`, account.id), {
          balance: Number((account.balance + delta).toFixed(2)),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      pushToast('Transaction logged', input.description, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const recordVoucherFirstExpense = async ({
    entityId,
    voucherAccountId,
    fallbackAccountId,
    date,
    description,
    category,
    amount,
    ivaRate,
    ivaAmount,
    ivaDeductible,
    adjustAccountBalance,
  }: {
    entityId: string;
    voucherAccountId: string;
    fallbackAccountId: string;
    date: string;
    description: string;
    category: string;
    amount: number;
    ivaRate: number;
    ivaAmount: number;
    ivaDeductible: boolean;
    adjustAccountBalance: boolean;
  }): Promise<{ voucherPaid: number; primaryPaid: number }> => {
    const uid = requireUid();
    const amt = Math.max(0, Number(amount) || 0);
    if (amt <= 0) return { voucherPaid: 0, primaryPaid: 0 };

    const voucherAcc = accounts.find((a) => a.id === voucherAccountId);
    const fallbackAcc = accounts.find((a) => a.id === fallbackAccountId);
    const safeDate = safeDateStr(date, todayIsoDate());
    const cleanRate = Math.min(30, Math.max(0, Number(ivaRate) || 0));
    const cleanIva = Math.max(0, Number(ivaAmount) || 0);

    const voucherPaid =
      voucherAcc && voucherAcc.balance > 0
        ? Number(Math.min(voucherAcc.balance, amt).toFixed(2))
        : 0;
    const primaryPaid = Number(Math.max(0, amt - voucherPaid).toFixed(2));
    const voucherIva =
      voucherPaid > 0 && amt > 0 ? Number((cleanIva * (voucherPaid / amt)).toFixed(2)) : 0;
    const primaryIva = Number(Math.max(0, cleanIva - voucherIva).toFixed(2));

    try {
      const batch = writeBatch(db);
      const baseDesc = clampString(description, VALIDATION_BOUNDS.MAX_DESC_LEN) || 'Expense';
      const cleanCat = clampString(category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'General';

      if (voucherAcc && voucherPaid > 0) {
        const txId = makeId('tx');
        batch.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: voucherAcc.entityId || entityId,
          accountId: voucherAcc.id,
          facilityId: '',
          payslipId: '',
          date: safeDate,
          description: clampString(
            primaryPaid > 0 ? `${baseDesc} (Voucher First)` : baseDesc,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          category: cleanCat,
          type: 'expense',
          amount: voucherPaid,
          ivaRate: cleanRate,
          ivaAmount: voucherIva,
          ivaDeductible: Boolean(ivaDeductible),
          invoiceNumber: '',
          invoiceDocId: '',
          driveFileId: '',
          driveWebViewLink: '',
          driveFolderPath: '',
          status: 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        if (adjustAccountBalance) {
          batch.update(doc(db, `finhub_users/${uid}/accounts`, voucherAcc.id), {
            balance: Number((voucherAcc.balance - voucherPaid).toFixed(2)),
            updatedAt: serverTimestamp(),
          });
        }
      }

      if (fallbackAcc && primaryPaid > 0) {
        const txId = makeId('tx');
        batch.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: fallbackAcc.entityId || entityId,
          accountId: fallbackAcc.id,
          facilityId: '',
          payslipId: '',
          date: safeDate,
          description: clampString(
            voucherPaid > 0 ? `${baseDesc} (Primary Overflow)` : baseDesc,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          category: cleanCat,
          type: 'expense',
          amount: primaryPaid,
          ivaRate: cleanRate,
          ivaAmount: primaryIva,
          ivaDeductible: Boolean(ivaDeductible),
          invoiceNumber: '',
          invoiceDocId: '',
          driveFileId: '',
          driveWebViewLink: '',
          driveFolderPath: '',
          status: 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        if (adjustAccountBalance) {
          batch.update(doc(db, `finhub_users/${uid}/accounts`, fallbackAcc.id), {
            balance: Number((fallbackAcc.balance - primaryPaid).toFixed(2)),
            updatedAt: serverTimestamp(),
          });
        }
      } else if (!fallbackAcc && primaryPaid > 0 && voucherAcc) {
        // No liquid fallback account configured; charge remainder to selected voucher account
        const txId = makeId('tx');
        batch.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: voucherAcc.entityId || entityId,
          accountId: voucherAcc.id,
          facilityId: '',
          payslipId: '',
          date: safeDate,
          description: baseDesc,
          category: cleanCat,
          type: 'expense',
          amount: primaryPaid,
          ivaRate: cleanRate,
          ivaAmount: primaryIva,
          ivaDeductible: Boolean(ivaDeductible),
          invoiceNumber: '',
          invoiceDocId: '',
          driveFileId: '',
          driveWebViewLink: '',
          driveFolderPath: '',
          status: 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        if (adjustAccountBalance) {
          batch.update(doc(db, `finhub_users/${uid}/accounts`, voucherAcc.id), {
            balance: Number((voucherAcc.balance - voucherPaid - primaryPaid).toFixed(2)),
            updatedAt: serverTimestamp(),
          });
        }
      }

      await batch.commit();
      if (voucherPaid > 0 && primaryPaid > 0 && fallbackAcc) {
        pushToast(
          'Voucher-first expense split',
          `${voucherPaid.toFixed(2)} from ${voucherAcc?.name ?? 'Voucher'} + ${primaryPaid.toFixed(2)} overflow from ${fallbackAcc.name}.`,
          'success'
        );
      } else {
        pushToast('Expense logged', description, 'success');
      }
      return { voucherPaid, primaryPaid };
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `finhub_users/${uid}/transactions`);
      return { voucherPaid: 0, primaryPaid: 0 };
    }
  };

  const deleteTransaction = async (tx: LedgerTransaction) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/transactions/${tx.id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Transaction deleted', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addPayslip = async (input: Omit<PayslipRecord, 'id' | 'userId' | 'totalCost'>) => {
    const uid = requireUid();
    const id = makeId('pay');
    const path = `finhub_users/${uid}/payslips/${id}`;
    const today = todayIsoDate();
    const netPay = Math.max(0, Number(input.netPay) || 0);
    const empWith = Math.max(0, Number(input.employeeWithholdings) || 0);
    const erTax = Math.max(0, Number(input.employerTaxes) || 0);
    const erContrib = Math.max(0, Number(input.employerContributions) || 0);
    const grossPay = Math.max(0, Number(input.grossPay) || netPay + empWith);
    const totalCost = Number((netPay + empWith + erTax + erContrib).toFixed(2));

    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        contractId: input.contractId ? clampString(input.contractId, 128) : '',
        employeeName: clampString(input.employeeName, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Employee',
        periodStart: safeDateStr(input.periodStart, today),
        periodEnd: safeDateStr(input.periodEnd, today),
        payDate: safeDateStr(input.payDate, today),
        taxDueDate: safeDateStr(input.taxDueDate, today),
        grossPay,
        netPay,
        employeeWithholdings: empWith,
        employerTaxes: erTax,
        employerContributions: erContrib,
        totalCost,
        payStatus: input.payStatus,
        taxStatus: input.taxStatus,
        sourceFilename: clampString(input.sourceFilename, VALIDATION_BOUNDS.MAX_FILENAME_LEN),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Payslip scheduled', `${input.employeeName} added to payroll calendar.`, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const markPayslipStatus = async (
    payslip: PayslipRecord,
    field: 'payStatus' | 'taxStatus',
    accountId?: string
  ) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/payslips/${payslip.id}`;
    const nextVal = 'paid';
    const amount =
      field === 'payStatus'
        ? payslip.netPay
        : payslip.employeeWithholdings + payslip.employerTaxes + payslip.employerContributions;
    const contract = payslip.contractId
      ? employmentContracts.find((c) => c.id === payslip.contractId)
      : undefined;
    const contractFundingId = contract?.fundingAccountId;
    const resolvedAccountId = accountId || contractFundingId;
    const account = resolvedAccountId
      ? accounts.find((a) => a.id === resolvedAccountId)
      : accounts.find((a) => a.entityId === payslip.entityId && !isVoucherAccountType(a.accountType)) ||
        accounts.find((a) => a.entityId === payslip.entityId);

    try {
      const batch = writeBatch(db);
      const balanceDeltas = new Map<string, { acc: Account; delta: number }>();
      const queueBalanceDelta = (acc: Account, delta: number) => {
        const prev = balanceDeltas.get(acc.id);
        balanceDeltas.set(acc.id, {
          acc,
          delta: (prev?.delta ?? 0) + delta,
        });
      };

      batch.update(doc(db, path), {
        [field]: nextVal,
        updatedAt: serverTimestamp(),
      });

      if (account && amount > 0) {
        const txId = makeId('tx');
        batch.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: payslip.entityId,
          accountId: account.id,
          facilityId: '',
          payslipId: payslip.id,
          date: field === 'payStatus' ? payslip.payDate : payslip.taxDueDate,
          description: clampString(
            field === 'payStatus'
              ? `Net Payroll · ${payslip.employeeName}`
              : `Payroll Tax & Social · ${payslip.employeeName}`,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          category: field === 'payStatus' ? 'Payroll Net Pay' : 'Payroll Taxes',
          type: 'payroll',
          amount: Number(amount.toFixed(2)),
          ivaRate: 0,
          ivaAmount: 0,
          ivaDeductible: false,
          status: 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        queueBalanceDelta(account, -amount);
      }

      // Sync owner net pay & non-withdrawable benefits into Personal Cash + Meal Card + Child Voucher accounts
      let voucherSyncedNote = '';
      if (
        field === 'payStatus' &&
        contract?.isOwnerIncome &&
        contract.personalEntityId &&
        payslip.netPay > 0
      ) {
        const personalAccs = accounts.filter((a) => a.entityId === contract.personalEntityId);
        if (personalAccs.length > 0) {
          const brk = computeContractMonthlyBreakdown(contract, payslip.payDate.slice(0, 7));
          const mealTarget = contract.mealPaymentMethod === 'card' ? brk.mealTotal : 0;
          const childTarget = brk.childTotal;
          const mealAcc = personalAccs.find((a) => a.accountType === 'meal_voucher');
          const childAcc = personalAccs.find((a) => a.accountType === 'child_voucher');
          const primaryCashAcc = personalAccs.find((a) => !isVoucherAccountType(a.accountType));

          const mealCredited =
            mealAcc && mealTarget > 0
              ? Number(Math.min(payslip.netPay, mealTarget).toFixed(2))
              : 0;
          const childCredited =
            childAcc && childTarget > 0
              ? Number(Math.min(Math.max(0, payslip.netPay - mealCredited), childTarget).toFixed(2))
              : 0;
          const cashCredited = primaryCashAcc
            ? Number(Math.max(0, payslip.netPay - mealCredited - childCredited).toFixed(2))
            : 0;

          if (mealAcc && mealCredited > 0) {
            batch.set(doc(db, `finhub_users/${uid}/transactions`, makeId('tx')), {
              userId: uid,
              entityId: contract.personalEntityId,
              accountId: mealAcc.id,
              facilityId: '',
              payslipId: payslip.id,
              date: payslip.payDate,
              description: clampString(
                `Benefit Top-Up · Meal Card (${payslip.employeeName})`,
                VALIDATION_BOUNDS.MAX_DESC_LEN
              ),
              category: 'Meal Voucher Benefit',
              type: 'income',
              amount: mealCredited,
              ivaRate: 0,
              ivaAmount: 0,
              ivaDeductible: false,
              status: 'cleared',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            queueBalanceDelta(mealAcc, mealCredited);
          }

          if (childAcc && childCredited > 0) {
            batch.set(doc(db, `finhub_users/${uid}/transactions`, makeId('tx')), {
              userId: uid,
              entityId: contract.personalEntityId,
              accountId: childAcc.id,
              facilityId: '',
              payslipId: payslip.id,
              date: payslip.payDate,
              description: clampString(
                `Benefit Top-Up · Child Voucher (${payslip.employeeName})`,
                VALIDATION_BOUNDS.MAX_DESC_LEN
              ),
              category: 'Child Voucher Benefit',
              type: 'income',
              amount: childCredited,
              ivaRate: 0,
              ivaAmount: 0,
              ivaDeductible: false,
              status: 'cleared',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            queueBalanceDelta(childAcc, childCredited);
          }

          if (primaryCashAcc && cashCredited > 0) {
            batch.set(doc(db, `finhub_users/${uid}/transactions`, makeId('tx')), {
              userId: uid,
              entityId: contract.personalEntityId,
              accountId: primaryCashAcc.id,
              facilityId: '',
              payslipId: payslip.id,
              date: payslip.payDate,
              description: clampString(
                `Owner Salary Deposit · ${payslip.employeeName}`,
                VALIDATION_BOUNDS.MAX_DESC_LEN
              ),
              category: 'Owner Salary',
              type: 'income',
              amount: cashCredited,
              ivaRate: 0,
              ivaAmount: 0,
              ivaDeductible: false,
              status: 'cleared',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            queueBalanceDelta(primaryCashAcc, cashCredited);
          }

          if (mealCredited > 0 || childCredited > 0) {
            voucherSyncedNote = ' (cash & voucher accounts credited)';
          }
        }
      }

      for (const { acc, delta } of balanceDeltas.values()) {
        if (Math.abs(delta) < 0.001) continue;
        batch.update(doc(db, `finhub_users/${uid}/accounts`, acc.id), {
          balance: Number((acc.balance + delta).toFixed(2)),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
      pushToast(
        field === 'payStatus' ? 'Net payroll marked paid' : 'Tax remittance marked paid',
        `${payslip.employeeName}${voucherSyncedNote}`,
        'success'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deletePayslip = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/payslips/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Payslip removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addForecastItem = async (input: Omit<ForecastItem, 'id' | 'userId'>) => {
    const uid = requireUid();
    const id = makeId('fc');
    const path = `finhub_users/${uid}/forecastItems/${id}`;
    const curMonth = currentMonthKey();
    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Forecast Item',
        direction: input.direction,
        category: clampString(input.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'Operating',
        monthlyAmount: Math.max(0, Number(input.monthlyAmount) || 0),
        startMonth: safeMonthStr(input.startMonth, curMonth),
        endMonth: input.endMonth && VALIDATION_BOUNDS.MONTH_PATTERN.test(input.endMonth) ? input.endMonth : '',
        annualGrowthRate: Math.min(500, Math.max(-100, Number(input.annualGrowthRate) || 0)),
        active: Boolean(input.active),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Forecast driver saved', input.name, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const toggleForecastItem = async (id: string, active: boolean) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/forecastItems/${id}`;
    try {
      await updateDoc(doc(db, path), {
        active,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deleteForecastItem = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/forecastItems/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Forecast driver removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addPersonalIncome = async (input: Omit<PersonalIncome, 'id' | 'userId'>) => {
    const uid = requireUid();
    const id = makeId('pinc');
    const path = `finhub_users/${uid}/personalIncomes/${id}`;
    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        accountId: input.accountId || '',
        title: clampString(input.title, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Income Source',
        payerName: clampString(input.payerName, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Employer',
        incomeCategory: input.incomeCategory,
        frequency: input.frequency,
        grossAmount: Math.max(0, Number(input.grossAmount) || 0),
        irsWithheldRate: Math.min(100, Math.max(0, Number(input.irsWithheldRate) || 0)),
        ssRate: Math.min(100, Math.max(0, Number(input.ssRate) || 0)),
        countsTowardsIrs: Boolean(input.countsTowardsIrs),
        active: Boolean(input.active),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Personal income added', input.title, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const updatePersonalIncome = async (
    id: string,
    input: Omit<PersonalIncome, 'id' | 'userId' | 'active'>
  ) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/personalIncomes/${id}`;
    try {
      await updateDoc(doc(db, path), {
        entityId: input.entityId,
        accountId: input.accountId || '',
        title: clampString(input.title, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Income Source',
        payerName: clampString(input.payerName, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Employer',
        incomeCategory: input.incomeCategory,
        frequency: input.frequency,
        grossAmount: Math.max(0, Number(input.grossAmount) || 0),
        irsWithheldRate: Math.min(100, Math.max(0, Number(input.irsWithheldRate) || 0)),
        ssRate: Math.min(100, Math.max(0, Number(input.ssRate) || 0)),
        countsTowardsIrs: Boolean(input.countsTowardsIrs),
        updatedAt: serverTimestamp(),
      });
      pushToast('Income source updated', input.title, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const togglePersonalIncome = async (id: string, active: boolean) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/personalIncomes/${id}`;
    try {
      await updateDoc(doc(db, path), {
        active,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deletePersonalIncome = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/personalIncomes/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Income source removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addEmploymentContract = async (input: Omit<EmploymentContract, 'id' | 'userId'>) => {
    const uid = requireUid();
    const id = makeId('ctr');
    const path = `finhub_users/${uid}/employmentContracts/${id}`;
    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        fundingAccountId: input.fundingAccountId || '',
        workerName: clampString(input.workerName, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Worker',
        roleTitle: clampString(input.roleTitle, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Employee',
        isOwnerIncome: Boolean(input.isOwnerIncome),
        personalEntityId: input.isOwnerIncome ? input.personalEntityId || '' : '',
        paySchedule: input.paySchedule,
        baseGrossMonthly: Math.max(0, Number(input.baseGrossMonthly) || 0),
        irsRate: Math.min(100, Math.max(0, Number(input.irsRate) || 0)),
        employeeSsRate: Math.min(100, Math.max(0, Number(input.employeeSsRate) || 0)),
        employerSsRate: Math.min(100, Math.max(0, Number(input.employerSsRate) || 0)),
        mealAllowanceDaily: Math.max(0, Number(input.mealAllowanceDaily) || 0),
        mealPaymentMethod: input.mealPaymentMethod,
        childVoucherMonthly: Math.max(0, Number(input.childVoucherMonthly) || 0),
        childVoucherSubjectToIrs: Boolean(input.childVoucherSubjectToIrs),
        childVoucherSubjectToSs: Boolean(input.childVoucherSubjectToSs),
        otherBenefitName: clampString(input.otherBenefitName || '', 60),
        otherBenefitMonthly: Math.max(0, Number(input.otherBenefitMonthly) || 0),
        otherBenefitSubjectToIrs: Boolean(input.otherBenefitSubjectToIrs),
        otherBenefitSubjectToSs: Boolean(input.otherBenefitSubjectToSs),
        active: Boolean(input.active),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Employment contract saved', input.workerName, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const updateEmploymentContract = async (
    id: string,
    input: Omit<EmploymentContract, 'id' | 'userId' | 'active'>
  ) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/employmentContracts/${id}`;
    try {
      await updateDoc(doc(db, path), {
        entityId: input.entityId,
        fundingAccountId: input.fundingAccountId || '',
        workerName: clampString(input.workerName, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Worker',
        roleTitle: clampString(input.roleTitle, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Employee',
        isOwnerIncome: Boolean(input.isOwnerIncome),
        personalEntityId: input.isOwnerIncome ? input.personalEntityId || '' : '',
        paySchedule: input.paySchedule,
        baseGrossMonthly: Math.max(0, Number(input.baseGrossMonthly) || 0),
        irsRate: Math.min(100, Math.max(0, Number(input.irsRate) || 0)),
        employeeSsRate: Math.min(100, Math.max(0, Number(input.employeeSsRate) || 0)),
        employerSsRate: Math.min(100, Math.max(0, Number(input.employerSsRate) || 0)),
        mealAllowanceDaily: Math.max(0, Number(input.mealAllowanceDaily) || 0),
        mealPaymentMethod: input.mealPaymentMethod,
        childVoucherMonthly: Math.max(0, Number(input.childVoucherMonthly) || 0),
        childVoucherSubjectToIrs: Boolean(input.childVoucherSubjectToIrs),
        childVoucherSubjectToSs: Boolean(input.childVoucherSubjectToSs),
        otherBenefitName: clampString(input.otherBenefitName || '', 60),
        otherBenefitMonthly: Math.max(0, Number(input.otherBenefitMonthly) || 0),
        otherBenefitSubjectToIrs: Boolean(input.otherBenefitSubjectToIrs),
        otherBenefitSubjectToSs: Boolean(input.otherBenefitSubjectToSs),
        updatedAt: serverTimestamp(),
      });
      pushToast('Contract updated', input.workerName, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const toggleEmploymentContract = async (id: string, active: boolean) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/employmentContracts/${id}`;
    try {
      await updateDoc(doc(db, path), {
        active,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deleteEmploymentContract = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/employmentContracts/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Employment contract removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const generatePayslipsFromContracts = async (opts: {
    monthKeys: string[];
    entityId?: string;
    contractId?: string;
  }) => {
    const uid = requireUid();
    const targets = employmentContracts.filter(
      (c) =>
        c.active &&
        (!opts.entityId || c.entityId === opts.entityId) &&
        (!opts.contractId || c.id === opts.contractId)
    );

    if (targets.length === 0) {
      pushToast('No active contracts', 'Add or enable an employment contract first.', 'info');
      return 0;
    }

    const toCreate: Array<{ id: string; payload: Record<string, unknown> }> = [];
    for (const c of targets) {
      const displayName = clampString(`${c.workerName} (${c.roleTitle})`, VALIDATION_BOUNDS.MAX_EMP_LEN);
      for (const mKey of opts.monthKeys) {
        const exists = payslips.some(
          (p) =>
            (p.contractId === c.id && p.payDate.startsWith(mKey)) ||
            (p.entityId === c.entityId && p.employeeName === displayName && p.payDate.startsWith(mKey))
        );
        if (exists) continue;

        const brk = computeContractMonthlyBreakdown(c, mKey);
        toCreate.push({
          id: makeId('pay'),
          payload: {
            userId: uid,
            entityId: c.entityId,
            contractId: c.id,
            employeeName: displayName,
            periodStart: brk.periodStart,
            periodEnd: brk.periodEnd,
            payDate: brk.payDate,
            taxDueDate: brk.taxDueDate,
            grossPay: brk.grossTotal,
            netPay: brk.netDisbursement,
            employeeWithholdings: brk.employeeWithholdings,
            employerTaxes: brk.employerSs,
            employerContributions: 0,
            totalCost: brk.totalEmployerCost,
            payStatus: 'scheduled',
            taxStatus: 'scheduled',
            sourceFilename: 'Auto-generated from Contract',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }
    }

    if (toCreate.length === 0) {
      pushToast(
        'Calendar already up to date',
        'All selected months already have scheduled events for these contracts.',
        'info'
      );
      return 0;
    }

    try {
      const chunkSize = 400;
      for (let i = 0; i < toCreate.length; i += chunkSize) {
        const chunk = toCreate.slice(i, i + chunkSize);
        const wb = writeBatch(db);
        for (const item of chunk) {
          wb.set(doc(db, `finhub_users/${uid}/payslips`, item.id), item.payload);
        }
        await wb.commit();
      }
      pushToast(
        'Payroll & tax calendar generated',
        `${toCreate.length} payroll event${toCreate.length === 1 ? '' : 's'} scheduled (last workday + 20th next month).`,
        'success'
      );
      return toCreate.length;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/payslips`);
    }
  };

  const importNoisysourceUploadedPayslips = async (): Promise<{
    createdPayslips: number;
    createdContracts: number;
    entityName: string;
  }> => {
    const uid = requireUid();
    const today = todayIsoDate();

    const existingCompany =
      entities.find(
        (e) =>
          !e.archived &&
          (e.name.toLowerCase().includes('noisysource') ||
            e.registrationCode.replace(/\s+/g, '').includes('517010585'))
      ) || entities.find((e) => e.id === 'ent_noisysource_lda');
    const companyId = existingCompany?.id ?? 'ent_noisysource_lda';
    const companyName = existingCompany?.name ?? 'NOISYSOURCE - LDA';

    const existingPersonal =
      entities.find((e) => !e.archived && e.entityType === 'personal') ||
      entities.find((e) => e.id === 'ent_renato_personal');
    const personalId = existingPersonal?.id ?? 'ent_renato_personal';

    const existingCompanyAcc =
      accounts.find((a) => a.entityId === companyId && !isVoucherAccountType(a.accountType)) ||
      accounts.find((a) => a.entityId === companyId) ||
      accounts.find((a) => a.id === 'acc_noisysource_chk');
    const companyAccountId = existingCompanyAcc?.id ?? 'acc_noisysource_chk';

    const existingPersonalChk =
      accounts.find((a) => a.entityId === personalId && !isVoucherAccountType(a.accountType)) ||
      accounts.find((a) => a.id === 'acc_renato_chk');
    const existingPersonalChildVoucher =
      accounts.find((a) => a.entityId === personalId && a.accountType === 'child_voucher') ||
      accounts.find((a) => a.id === 'acc_renato_child_voucher');

    const wb = writeBatch(db);
    let hasWrites = false;

    if (!existingCompany) {
      wb.set(doc(db, `finhub_users/${uid}/entities`, companyId), {
        userId: uid,
        name: 'NOISYSOURCE - LDA',
        entityType: 'company',
        registrationCode: 'NIPC 517010585',
        colorHex: '#2563EB',
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      hasWrites = true;
    }

    if (!existingCompanyAcc) {
      wb.set(doc(db, `finhub_users/${uid}/accounts`, companyAccountId), {
        userId: uid,
        entityId: companyId,
        name: 'Noisysource Operating',
        institution: 'Millennium BCP',
        accountType: 'checking',
        accountNumber: '',
        balance: 0,
        lastReconciledDate: today,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      hasWrites = true;
    }

    if (!existingPersonal) {
      wb.set(doc(db, `finhub_users/${uid}/entities`, personalId), {
        userId: uid,
        name: 'Renato Simão dos Santos Lopes',
        entityType: 'personal',
        registrationCode: 'NIF 238924505',
        colorHex: '#0EA5E9',
        archived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      hasWrites = true;
    }

    if (!existingPersonalChk) {
      wb.set(doc(db, `finhub_users/${uid}/accounts`, 'acc_renato_chk'), {
        userId: uid,
        entityId: personalId,
        name: 'Renato Primary Checking',
        institution: 'Personal Bank',
        accountType: 'checking',
        accountNumber: '',
        balance: 0,
        lastReconciledDate: today,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      hasWrites = true;
    }

    if (!existingPersonalChildVoucher) {
      wb.set(doc(db, `finhub_users/${uid}/accounts`, 'acc_renato_child_voucher'), {
        userId: uid,
        entityId: personalId,
        name: 'Renato Child Voucher (Vale Infância)',
        institution: 'Ticket Infância / Coverflex',
        accountType: 'child_voucher',
        accountNumber: '',
        balance: 0,
        lastReconciledDate: today,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      hasWrites = true;
    }

    if (!taxSettings.some((s) => s.entityId === companyId)) {
      const taxCompanyId = `tax_${companyId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      wb.set(doc(db, `finhub_users/${uid}/taxSettings`, taxCompanyId), {
        userId: uid,
        entityId: companyId,
        region: 'continente',
        isPme: true,
        ivaPeriodicity: 'quarterly',
        derramaRate: 1.5,
        ircPaymentsOnAccount: 0,
        irsMaritalStatus: 'married_joint',
        irsDependents: 3,
        irsDeductions: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      hasWrites = true;
    }

    if (!taxSettings.some((s) => s.entityId === personalId)) {
      const taxPersonalId = `tax_${personalId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      wb.set(doc(db, `finhub_users/${uid}/taxSettings`, taxPersonalId), {
        userId: uid,
        entityId: personalId,
        region: 'continente',
        isPme: true,
        ivaPeriodicity: 'exempt',
        derramaRate: 0,
        ircPaymentsOnAccount: 0,
        irsMaritalStatus: 'married_joint',
        irsDependents: 3,
        irsDeductions: 1200,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      hasWrites = true;
    }

    const matchContract = (firstToken: string, defaultId: string) =>
      employmentContracts.find(
        (c) =>
          c.entityId === companyId &&
          c.workerName.toLowerCase().includes(firstToken.toLowerCase())
      )?.id ?? defaultId;

    const renatoCtrId = matchContract('renato', 'ctr_ns_renato');
    const marisaCtrId = matchContract('marisa', 'ctr_ns_marisa');
    const bernardoCtrId = matchContract('bernardo', 'ctr_ns_bernardo');

    const contractSpecs = [
      {
        id: renatoCtrId,
        exists: employmentContracts.some((c) => c.id === renatoCtrId),
        payload: {
          userId: uid,
          entityId: companyId,
          fundingAccountId: companyAccountId,
          workerName: 'Renato Simão dos Santos Lopes',
          roleTitle: 'Gerente',
          isOwnerIncome: true,
          personalEntityId: personalId,
          paySchedule: '14_months',
          baseGrossMonthly: 2000,
          irsRate: 13.45,
          employeeSsRate: 11,
          employerSsRate: 23.75,
          mealAllowanceDaily: 0,
          mealPaymentMethod: 'none',
          childVoucherMonthly: 0,
          childVoucherSubjectToIrs: false,
          childVoucherSubjectToSs: false,
          otherBenefitName: '',
          otherBenefitMonthly: 0,
          otherBenefitSubjectToIrs: false,
          otherBenefitSubjectToSs: false,
          active: true,
        },
      },
      {
        id: marisaCtrId,
        exists: employmentContracts.some((c) => c.id === marisaCtrId),
        payload: {
          userId: uid,
          entityId: companyId,
          fundingAccountId: companyAccountId,
          workerName: 'Marisa Rodrigues Folhas Lopes',
          roleTitle: 'Administrativa (20h/sem)',
          isOwnerIncome: false,
          personalEntityId: '',
          paySchedule: '14_months',
          baseGrossMonthly: 950,
          irsRate: 16.11,
          employeeSsRate: 11,
          employerSsRate: 23.75,
          mealAllowanceDaily: 0,
          mealPaymentMethod: 'none',
          childVoucherMonthly: 312.5,
          childVoucherSubjectToIrs: false,
          childVoucherSubjectToSs: false,
          otherBenefitName: '',
          otherBenefitMonthly: 0,
          otherBenefitSubjectToIrs: false,
          otherBenefitSubjectToSs: false,
          active: true,
        },
      },
      {
        id: bernardoCtrId,
        exists: employmentContracts.some((c) => c.id === bernardoCtrId),
        payload: {
          userId: uid,
          entityId: companyId,
          fundingAccountId: companyAccountId,
          workerName: 'Bernardo José Andrade Mendonça',
          roleTitle: 'Técnico Gestão Projectos (20h/sem)',
          isOwnerIncome: false,
          personalEntityId: '',
          paySchedule: '14_months',
          baseGrossMonthly: 1200,
          irsRate: 1.58,
          employeeSsRate: 11,
          employerSsRate: 23.75,
          mealAllowanceDaily: 0,
          mealPaymentMethod: 'none',
          childVoucherMonthly: 420,
          childVoucherSubjectToIrs: false,
          childVoucherSubjectToSs: false,
          otherBenefitName: '',
          otherBenefitMonthly: 0,
          otherBenefitSubjectToIrs: false,
          otherBenefitSubjectToSs: false,
          active: true,
        },
      },
    ];

    let createdContracts = 0;
    for (const spec of contractSpecs) {
      if (!spec.exists) {
        wb.set(doc(db, `finhub_users/${uid}/employmentContracts`, spec.id), {
          ...spec.payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        createdContracts += 1;
        hasWrites = true;
      }
    }

    const existingSlipKeys = new Set(
      payslips.map((p) => `${p.entityId}::${p.payDate.slice(0, 7)}::${p.employeeName.toLowerCase()}`)
    );

    const slipSpecs = [
      {
        id: 'pay_ns_2025_12_renato',
        contractId: renatoCtrId,
        employeeName: 'Renato Simão dos Santos Lopes',
        periodStart: '2025-12-01',
        periodEnd: '2025-12-31',
        payDate: '2025-12-31',
        taxDueDate: '2026-01-20',
        grossPay: 0,
        netPay: 0,
        employeeWithholdings: 0,
        employerTaxes: 0,
        employerContributions: 0,
        totalCost: 0,
        sourceFilename: '517010585_RC_2025_M12P1_F_82845ab9.pdf',
      },
      {
        id: 'pay_ns_2025_12_marisa',
        contractId: marisaCtrId,
        employeeName: 'Marisa Rodrigues Folhas Lopes',
        periodStart: '2025-12-01',
        periodEnd: '2025-12-31',
        payDate: '2025-12-31',
        taxDueDate: '2026-01-20',
        grossPay: 1262.5,
        netPay: 984.0,
        employeeWithholdings: 278.5,
        employerTaxes: 225.63,
        employerContributions: 0,
        totalCost: 1488.13,
        sourceFilename: '517010585_RC_2025_M12P1_F_82845ab9.pdf',
      },
      {
        id: 'pay_ns_2025_12_bernardo',
        contractId: bernardoCtrId,
        employeeName: 'Bernardo José Andrade Mendonça',
        periodStart: '2025-12-01',
        periodEnd: '2025-12-31',
        payDate: '2025-12-31',
        taxDueDate: '2026-01-20',
        grossPay: 1620.0,
        netPay: 1457.0,
        employeeWithholdings: 163.0,
        employerTaxes: 285.0,
        employerContributions: 0,
        totalCost: 1905.0,
        sourceFilename: '517010585_RC_2025_M12P1_F_82845ab9.pdf',
      },
      {
        id: 'pay_ns_2026_01_renato',
        contractId: renatoCtrId,
        employeeName: 'Renato Simão dos Santos Lopes',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        payDate: '2026-01-30',
        taxDueDate: '2026-02-20',
        grossPay: 0,
        netPay: 0,
        employeeWithholdings: 0,
        employerTaxes: 0,
        employerContributions: 0,
        totalCost: 0,
        sourceFilename: '517010585_RC_2026_M01P1_F_f214f177.pdf',
      },
      {
        id: 'pay_ns_2026_01_marisa',
        contractId: marisaCtrId,
        employeeName: 'Marisa Rodrigues Folhas Lopes',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        payDate: '2026-01-30',
        taxDueDate: '2026-02-20',
        grossPay: 1262.5,
        netPay: 1005.0,
        employeeWithholdings: 257.5,
        employerTaxes: 225.63,
        employerContributions: 0,
        totalCost: 1488.13,
        sourceFilename: '517010585_RC_2026_M01P1_F_f214f177.pdf',
      },
      {
        id: 'pay_ns_2026_01_bernardo',
        contractId: bernardoCtrId,
        employeeName: 'Bernardo José Andrade Mendonça',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        payDate: '2026-01-30',
        taxDueDate: '2026-02-20',
        grossPay: 1620.0,
        netPay: 1469.0,
        employeeWithholdings: 151.0,
        employerTaxes: 285.0,
        employerContributions: 0,
        totalCost: 1905.0,
        sourceFilename: '517010585_RC_2026_M01P1_F_f214f177.pdf',
      },
    ];

    let createdPayslips = 0;
    for (const s of slipSpecs) {
      const dupKey = `${companyId}::${s.payDate.slice(0, 7)}::${s.employeeName.toLowerCase()}`;
      if (payslips.some((p) => p.id === s.id) || existingSlipKeys.has(dupKey)) continue;
      wb.set(doc(db, `finhub_users/${uid}/payslips`, s.id), {
        userId: uid,
        entityId: companyId,
        contractId: s.contractId,
        employeeName: s.employeeName,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        payDate: s.payDate,
        taxDueDate: s.taxDueDate,
        grossPay: s.grossPay,
        netPay: s.netPay,
        employeeWithholdings: s.employeeWithholdings,
        employerTaxes: s.employerTaxes,
        employerContributions: s.employerContributions,
        totalCost: s.totalCost,
        payStatus: 'paid',
        taxStatus: 'paid',
        sourceFilename: s.sourceFilename,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      createdPayslips += 1;
      hasWrites = true;
    }

    try {
      if (hasWrites) {
        await wb.commit();
      }
      if (entityFilter !== 'all' && entityFilter !== companyId) {
        setEntityFilter('all');
      }
      pushToast(
        createdPayslips > 0 ? 'Noisysource payslips created' : 'Noisysource already up to date',
        `${companyName}: ${createdPayslips} payslips and ${createdContracts} contracts added (Dec 2025 & Jan 2026).`,
        createdPayslips > 0 ? 'success' : 'info'
      );
      return { createdPayslips, createdContracts, entityName: companyName };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/payslips`);
    }
  };

  const upsertTaxSetting = async (input: Omit<TaxSetting, 'id' | 'userId'>) => {
    const uid = requireUid();
    const existingSetting = taxSettings.find((s) => s.entityId === input.entityId);
    const id = existingSetting?.id || `tax_${input.entityId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = `finhub_users/${uid}/taxSettings/${id}`;

    try {
      if (existingSetting) {
        await updateDoc(doc(db, path), {
          region: input.region,
          isPme: Boolean(input.isPme),
          ivaPeriodicity: input.ivaPeriodicity,
          derramaRate: Math.min(5, Math.max(0, Number(input.derramaRate) || 0)),
          ircPaymentsOnAccount: Math.max(0, Number(input.ircPaymentsOnAccount) || 0),
          irsMaritalStatus: input.irsMaritalStatus,
          irsDependents: Math.min(20, Math.max(0, Math.round(Number(input.irsDependents) || 0))),
          irsDeductions: Math.max(0, Number(input.irsDeductions) || 0),
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, path), {
          userId: uid,
          entityId: input.entityId,
          region: input.region,
          isPme: Boolean(input.isPme),
          ivaPeriodicity: input.ivaPeriodicity,
          derramaRate: Math.min(5, Math.max(0, Number(input.derramaRate) || 0)),
          ircPaymentsOnAccount: Math.max(0, Number(input.ircPaymentsOnAccount) || 0),
          irsMaritalStatus: input.irsMaritalStatus,
          irsDependents: Math.min(20, Math.max(0, Math.round(Number(input.irsDependents) || 0))),
          irsDeductions: Math.max(0, Number(input.irsDeductions) || 0),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      pushToast('Tax parameters saved', 'IVA, IRS, and IRC figures updated.', 'success');
    } catch (err) {
      handleFirestoreError(err, existingSetting ? OperationType.UPDATE : OperationType.CREATE, path);
    }
  };

  const importStatementBatch = async ({
    entityId,
    accountId,
    filename,
    statementPeriod,
    openingBalance,
    closingBalance,
    lines,
  }: {
    entityId: string;
    accountId: string;
    filename: string;
    statementPeriod: string;
    openingBalance: number;
    closingBalance: number;
    lines: Array<{
      date: string;
      description: string;
      amount: number;
      direction: 'credit' | 'debit';
    }>;
  }) => {
    const uid = requireUid();
    const batchId = makeId('stmt');
    const batchPath = `finhub_users/${uid}/statementBatches/${batchId}`;
    const today = todayIsoDate();

    try {
      await setDoc(doc(db, batchPath), {
        userId: uid,
        entityId,
        accountId,
        filename: clampString(filename, VALIDATION_BOUNDS.MAX_FILENAME_LEN) || 'statement.csv',
        statementPeriod: clampString(statementPeriod, 60) || today,
        openingBalance: Number(openingBalance) || 0,
        closingBalance: Number(closingBalance) || 0,
        lineCount: lines.length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const chunkSize = 400;
      for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize);
        const wb = writeBatch(db);
        for (const line of chunk) {
          const lineId = makeId('sline');
          wb.set(doc(db, `finhub_users/${uid}/statementLines`, lineId), {
            userId: uid,
            batchId,
            entityId,
            accountId,
            date: safeDateStr(line.date, today),
            description: clampString(line.description, VALIDATION_BOUNDS.MAX_LINE_DESC_LEN) || 'Bank entry',
            amount: Math.max(0, Number(line.amount) || 0),
            direction: line.direction === 'credit' ? 'credit' : 'debit',
            reconciliationStatus: 'unmatched',
            matchedTransactionId: '',
            discrepancyNote: '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        await wb.commit();
      }

      pushToast('Statement imported', `${lines.length} statement lines queued for reconciliation.`, 'success');
      return batchId;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, batchPath);
    }
  };

  const confirmReconciliationMatch = async (
    line: StatementLine,
    transaction: LedgerTransaction,
    invoiceDoc?: InvoiceDocument
  ) => {
    const uid = requireUid();
    const account = accounts.find((a) => a.id === line.accountId);
    const linkedDoc =
      invoiceDoc ??
      invoiceDocuments.find(
        (d) =>
          (d.transactionId && d.transactionId === transaction.id) ||
          (transaction.invoiceDocId && d.id === transaction.invoiceDocId)
      );

    try {
      const wb = writeBatch(db);
      wb.update(doc(db, `finhub_users/${uid}/statementLines`, line.id), {
        reconciliationStatus: 'reconciled',
        matchedTransactionId: transaction.id,
        updatedAt: serverTimestamp(),
      });
      if (transaction.status !== 'reconciled') {
        wb.update(doc(db, `finhub_users/${uid}/transactions`, transaction.id), {
          status: 'reconciled',
          ...(linkedDoc
            ? {
                invoiceNumber: clampString(linkedDoc.invoiceNumber, VALIDATION_BOUNDS.MAX_INVOICE_LEN),
                invoiceDocId: linkedDoc.id,
                driveFileId: clampString(linkedDoc.driveFileId, 160),
                driveWebViewLink: clampString(linkedDoc.driveWebViewLink, 512),
                driveFolderPath: clampString(linkedDoc.driveFolderPath, 240),
              }
            : {}),
          updatedAt: serverTimestamp(),
        });
      } else if (linkedDoc) {
        wb.update(doc(db, `finhub_users/${uid}/transactions`, transaction.id), {
          invoiceNumber: clampString(linkedDoc.invoiceNumber, VALIDATION_BOUNDS.MAX_INVOICE_LEN),
          invoiceDocId: linkedDoc.id,
          driveFileId: clampString(linkedDoc.driveFileId, 160),
          driveWebViewLink: clampString(linkedDoc.driveWebViewLink, 512),
          driveFolderPath: clampString(linkedDoc.driveFolderPath, 240),
          updatedAt: serverTimestamp(),
        });
      }
      if (linkedDoc && linkedDoc.status !== 'reconciled') {
        wb.update(doc(db, `finhub_users/${uid}/invoiceDocuments`, linkedDoc.id), {
          transactionId: transaction.id,
          statementLineId: line.id,
          reimbursementId: linkedDoc.reimbursementId || '',
          status: 'reconciled',
          updatedAt: serverTimestamp(),
        });
      }
      if (account && (!account.lastReconciledDate || line.date > account.lastReconciledDate)) {
        wb.update(doc(db, `finhub_users/${uid}/accounts`, account.id), {
          lastReconciledDate: line.date,
          balance: account.balance,
          updatedAt: serverTimestamp(),
        });
      }
      await wb.commit();
      pushToast('Line reconciled', line.description, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `finhub_users/${uid}/statementLines/${line.id}`);
    }
  };

  const createLedgerFromStatementLine = async (
    line: StatementLine,
    category: string,
    txType: LedgerTransaction['type'],
    opts?: {
      adjustAccountBalance?: boolean;
      ivaRate?: number;
      ivaDeductible?: boolean;
      invoiceDoc?: InvoiceDocument;
    }
  ) => {
    const uid = requireUid();
    const txId = makeId('tx');
    const account = accounts.find((a) => a.id === line.accountId);
    const shouldAdjust = opts?.adjustAccountBalance !== false;
    const ivaRate = Math.min(30, Math.max(0, Number(opts?.ivaRate ?? opts?.invoiceDoc?.ivaRate ?? 0) || 0));
    const ivaAmount =
      opts?.invoiceDoc && ivaRate === opts.invoiceDoc.ivaRate
        ? opts.invoiceDoc.ivaAmount
        : computeTransactionIva(line.amount, ivaRate);
    const ivaDeductible = Boolean(opts?.ivaDeductible ?? opts?.invoiceDoc?.ivaDeductible ?? false);
    const invDoc = opts?.invoiceDoc;

    try {
      const wb = writeBatch(db);
      wb.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
        userId: uid,
        entityId: line.entityId,
        accountId: line.accountId,
        facilityId: '',
        payslipId: '',
        date: line.date,
        description: clampString(line.description, VALIDATION_BOUNDS.MAX_DESC_LEN),
        category: clampString(category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'Bank Import',
        type: txType,
        amount: line.amount,
        ivaRate,
        ivaAmount,
        ivaDeductible,
        invoiceNumber: clampString(invDoc?.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
        invoiceDocId: invDoc?.id || '',
        driveFileId: clampString(invDoc?.driveFileId || '', 160),
        driveWebViewLink: clampString(invDoc?.driveWebViewLink || '', 512),
        driveFolderPath: clampString(invDoc?.driveFolderPath || '', 240),
        status: 'reconciled',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      wb.update(doc(db, `finhub_users/${uid}/statementLines`, line.id), {
        reconciliationStatus: 'reconciled',
        matchedTransactionId: txId,
        updatedAt: serverTimestamp(),
      });
      if (invDoc && invDoc.status !== 'reconciled') {
        wb.update(doc(db, `finhub_users/${uid}/invoiceDocuments`, invDoc.id), {
          transactionId: txId,
          statementLineId: line.id,
          reimbursementId: invDoc.reimbursementId || '',
          status: 'reconciled',
          updatedAt: serverTimestamp(),
        });
      }
      if (account) {
        const nextReconciled =
          !account.lastReconciledDate || line.date > account.lastReconciledDate
            ? line.date
            : account.lastReconciledDate;
        if (shouldAdjust) {
          const delta = line.direction === 'credit' ? line.amount : -line.amount;
          wb.update(doc(db, `finhub_users/${uid}/accounts`, account.id), {
            balance: Number((account.balance + delta).toFixed(2)),
            lastReconciledDate: nextReconciled,
            updatedAt: serverTimestamp(),
          });
        } else if (nextReconciled !== account.lastReconciledDate) {
          wb.update(doc(db, `finhub_users/${uid}/accounts`, account.id), {
            lastReconciledDate: nextReconciled,
            balance: account.balance,
            updatedAt: serverTimestamp(),
          });
        }
      }
      await wb.commit();
      pushToast('Entry created & reconciled', line.description, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/transactions/${txId}`);
    }
  };

  const markLineSuggested = async (lineId: string, matchedTransactionId: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/statementLines/${lineId}`;
    try {
      await updateDoc(doc(db, path), {
        reconciliationStatus: 'suggested',
        matchedTransactionId,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const flagLineDiscrepancy = async (lineId: string, note: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/statementLines/${lineId}`;
    try {
      await updateDoc(doc(db, path), {
        reconciliationStatus: 'discrepancy',
        discrepancyNote: clampString(note, 200) || 'Flagged for manual review',
        updatedAt: serverTimestamp(),
      });
      pushToast('Discrepancy flagged', note, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deleteStatementBatch = async (batchId: string) => {
    const uid = requireUid();
    const lines = statementLines.filter((l) => l.batchId === batchId && l.reconciliationStatus !== 'reconciled');
    try {
      const wb = writeBatch(db);
      for (const l of lines) {
        wb.delete(doc(db, `finhub_users/${uid}/statementLines`, l.id));
      }
      wb.delete(doc(db, `finhub_users/${uid}/statementBatches`, batchId));
      await wb.commit();
      pushToast('Statement batch removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `finhub_users/${uid}/statementBatches/${batchId}`);
    }
  };

  const addRecurringExpense = async (
    input: Omit<RecurringExpense, 'id' | 'userId' | 'requiresReimbursement' | 'lastPostedDate'>
  ) => {
    const uid = requireUid();
    const id = makeId('sub');
    const path = `finhub_users/${uid}/recurringExpenses/${id}`;
    const requiresReimbursement =
      input.entityId !== input.paidByEntityId && Boolean(input.hasInvoice);
    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        paidByAccountId: input.paidByAccountId,
        paidByEntityId: input.paidByEntityId,
        creditFacilityId: input.creditFacilityId || '',
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Subscription',
        vendor: clampString(input.vendor, VALIDATION_BOUNDS.MAX_VENDOR_LEN) || 'Vendor',
        category: clampString(input.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'Subscriptions',
        amount: Math.max(0, Number(input.amount) || 0),
        frequency: input.frequency === 'annual' ? 'annual' : 'monthly',
        billingDay: Math.min(31, Math.max(1, Math.round(Number(input.billingDay) || 1))),
        billingMonth: Math.min(12, Math.max(1, Math.round(Number(input.billingMonth) || 1))),
        ivaRate: Math.min(30, Math.max(0, Number(input.ivaRate) || 0)),
        ivaDeductible: Boolean(input.ivaDeductible),
        hasInvoice: Boolean(input.hasInvoice),
        requiresReimbursement,
        lastPostedDate: '',
        active: Boolean(input.active),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Subscription saved', input.name, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const updateRecurringExpense = async (
    id: string,
    input: Omit<RecurringExpense, 'id' | 'userId' | 'active' | 'requiresReimbursement' | 'lastPostedDate'>
  ) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/recurringExpenses/${id}`;
    const requiresReimbursement =
      input.entityId !== input.paidByEntityId && Boolean(input.hasInvoice);
    try {
      await updateDoc(doc(db, path), {
        entityId: input.entityId,
        paidByAccountId: input.paidByAccountId,
        paidByEntityId: input.paidByEntityId,
        creditFacilityId: input.creditFacilityId || '',
        name: clampString(input.name, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Subscription',
        vendor: clampString(input.vendor, VALIDATION_BOUNDS.MAX_VENDOR_LEN) || 'Vendor',
        category: clampString(input.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'Subscriptions',
        amount: Math.max(0, Number(input.amount) || 0),
        frequency: input.frequency === 'annual' ? 'annual' : 'monthly',
        billingDay: Math.min(31, Math.max(1, Math.round(Number(input.billingDay) || 1))),
        billingMonth: Math.min(12, Math.max(1, Math.round(Number(input.billingMonth) || 1))),
        ivaRate: Math.min(30, Math.max(0, Number(input.ivaRate) || 0)),
        ivaDeductible: Boolean(input.ivaDeductible),
        hasInvoice: Boolean(input.hasInvoice),
        requiresReimbursement,
        updatedAt: serverTimestamp(),
      });
      pushToast('Subscription updated', input.name, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const toggleRecurringExpense = async (id: string, active: boolean) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/recurringExpenses/${id}`;
    try {
      await updateDoc(doc(db, path), {
        active,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const deleteRecurringExpense = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/recurringExpenses/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Subscription removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const postRecurringExpensePayment = async (
    expense: RecurringExpense,
    opts?: { date?: string; invoiceNumber?: string }
  ) => {
    const uid = requireUid();
    const postDate = safeDateStr(opts?.date || todayIsoDate(), todayIsoDate());
    const payerAccount = accounts.find((a) => a.id === expense.paidByAccountId);
    const txId = makeId('tx');
    const isCrossEntityInvoiced =
      expense.entityId !== expense.paidByEntityId && expense.hasInvoice;
    const ivaAmt = computeTransactionIva(expense.amount, expense.ivaRate);

    const fallbackAccount =
      payerAccount &&
      isVoucherAccountType(payerAccount.accountType) &&
      !isCrossEntityInvoiced &&
      payerAccount.balance < expense.amount
        ? accounts.find(
            (a) => a.entityId === payerAccount.entityId && !isVoucherAccountType(a.accountType)
          )
        : undefined;

    let splitMessage = '';

    try {
      const wb = writeBatch(db);
      wb.update(doc(db, `finhub_users/${uid}/recurringExpenses`, expense.id), {
        lastPostedDate: postDate,
        updatedAt: serverTimestamp(),
      });

      if (payerAccount && fallbackAccount) {
        const voucherPaid = Number(
          Math.max(0, Math.min(payerAccount.balance, expense.amount)).toFixed(2)
        );
        const primaryPaid = Number(Math.max(0, expense.amount - voucherPaid).toFixed(2));
        const voucherIva =
          voucherPaid > 0 && expense.amount > 0
            ? Number((ivaAmt * (voucherPaid / expense.amount)).toFixed(2))
            : 0;
        const primaryIva = Number(Math.max(0, ivaAmt - voucherIva).toFixed(2));

        if (voucherPaid > 0) {
          wb.update(doc(db, `finhub_users/${uid}/accounts`, payerAccount.id), {
            balance: Number((payerAccount.balance - voucherPaid).toFixed(2)),
            updatedAt: serverTimestamp(),
          });
          wb.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
            userId: uid,
            entityId: payerAccount.entityId,
            accountId: payerAccount.id,
            facilityId: expense.creditFacilityId || '',
            payslipId: '',
            date: postDate,
            description: clampString(
              `${expense.name} · ${expense.vendor} (Voucher Portion)`,
              VALIDATION_BOUNDS.MAX_DESC_LEN
            ),
            category: clampString(expense.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN),
            type: 'expense',
            amount: voucherPaid,
            ivaRate: expense.ivaRate,
            ivaAmount: voucherIva,
            ivaDeductible: expense.ivaDeductible,
            status: 'cleared',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        if (primaryPaid > 0) {
          wb.update(doc(db, `finhub_users/${uid}/accounts`, fallbackAccount.id), {
            balance: Number((fallbackAccount.balance - primaryPaid).toFixed(2)),
            updatedAt: serverTimestamp(),
          });
          wb.set(doc(db, `finhub_users/${uid}/transactions`, makeId('tx')), {
            userId: uid,
            entityId: fallbackAccount.entityId,
            accountId: fallbackAccount.id,
            facilityId: expense.creditFacilityId || '',
            payslipId: '',
            date: postDate,
            description: clampString(
              voucherPaid > 0
                ? `${expense.name} · ${expense.vendor} (Primary Overflow)`
                : `${expense.name} · ${expense.vendor}`,
              VALIDATION_BOUNDS.MAX_DESC_LEN
            ),
            category: clampString(expense.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN),
            type: 'expense',
            amount: primaryPaid,
            ivaRate: expense.ivaRate,
            ivaAmount: primaryIva,
            ivaDeductible: expense.ivaDeductible,
            status: 'cleared',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        if (voucherPaid > 0 && primaryPaid > 0) {
          splitMessage = ` (${voucherPaid.toFixed(2)} voucher + ${primaryPaid.toFixed(2)} from ${fallbackAccount.name})`;
        } else if (primaryPaid > 0) {
          splitMessage = ` (voucher empty — debited ${fallbackAccount.name})`;
        }
      } else if (payerAccount) {
        wb.update(doc(db, `finhub_users/${uid}/accounts`, payerAccount.id), {
          balance: Number((payerAccount.balance - expense.amount).toFixed(2)),
          updatedAt: serverTimestamp(),
        });
        wb.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: payerAccount.entityId,
          accountId: payerAccount.id,
          facilityId: expense.creditFacilityId || '',
          payslipId: '',
          date: postDate,
          description: clampString(
            `${expense.name} · ${expense.vendor}${isCrossEntityInvoiced ? ' (Paid on Behalf)' : ''}`,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          category: clampString(expense.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN),
          type: 'expense',
          amount: expense.amount,
          ivaRate: isCrossEntityInvoiced ? 0 : expense.ivaRate,
          ivaAmount: isCrossEntityInvoiced ? 0 : ivaAmt,
          ivaDeductible: isCrossEntityInvoiced ? false : expense.ivaDeductible,
          status: 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      if (isCrossEntityInvoiced) {
        const reimbId = makeId('reimb');
        wb.set(doc(db, `finhub_users/${uid}/reimbursements`, reimbId), {
          userId: uid,
          owedByEntityId: expense.entityId,
          owedToEntityId: expense.paidByEntityId,
          paidByAccountId: expense.paidByAccountId,
          recurringExpenseId: expense.id,
          transactionId: payerAccount ? txId : '',
          date: postDate,
          vendor: clampString(expense.vendor, VALIDATION_BOUNDS.MAX_VENDOR_LEN),
          description: clampString(
            `${expense.name} (${expense.frequency === 'annual' ? 'Annual' : 'Monthly'})`,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          invoiceNumber: clampString(opts?.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
          hasInvoice: true,
          amount: expense.amount,
          ivaRate: expense.ivaRate,
          ivaAmount: ivaAmt,
          ivaDeductible: expense.ivaDeductible,
          status: 'open',
          settledDate: '',
          settledFromAccountId: '',
          settledToAccountId: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await wb.commit();
      pushToast(
        isCrossEntityInvoiced ? 'Charge posted & reimbursement logged' : 'Subscription charge posted',
        `${expense.name}${splitMessage}`,
        'success'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/recurringExpenses/${expense.id}`);
    }
  };

  const addCrossEntityExpense = async ({
    beneficiaryEntityId,
    paidByAccountId,
    creditFacilityId = '',
    date,
    vendor,
    description,
    category,
    invoiceNumber,
    hasInvoice,
    amount,
    ivaRate,
    ivaDeductible,
    debitPayerAccount,
  }: {
    beneficiaryEntityId: string;
    paidByAccountId: string;
    creditFacilityId?: string;
    date: string;
    vendor: string;
    description: string;
    category: string;
    invoiceNumber: string;
    hasInvoice: boolean;
    amount: number;
    ivaRate: number;
    ivaDeductible: boolean;
    debitPayerAccount: boolean;
  }) => {
    const uid = requireUid();
    const payerAccount = accounts.find((a) => a.id === paidByAccountId);
    if (!payerAccount) return;

    const amt = Math.max(0, Number(amount) || 0);
    const safeRate = Math.min(30, Math.max(0, Number(ivaRate) || 0));
    const ivaAmt = computeTransactionIva(amt, safeRate);
    const safeDate = safeDateStr(date, todayIsoDate());
    const isCrossEntity = beneficiaryEntityId !== payerAccount.entityId;
    const createClaim = isCrossEntity && hasInvoice;
    const txId = makeId('tx');

    try {
      const wb = writeBatch(db);

      if (debitPayerAccount) {
        wb.update(doc(db, `finhub_users/${uid}/accounts`, payerAccount.id), {
          balance: Number((payerAccount.balance - amt).toFixed(2)),
          updatedAt: serverTimestamp(),
        });
        wb.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: payerAccount.entityId,
          accountId: payerAccount.id,
          facilityId: creditFacilityId || '',
          payslipId: '',
          date: safeDate,
          description: clampString(
            `${vendor} · ${description}${createClaim ? ' (Paid on Behalf)' : ''}`,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          category: clampString(category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'Operating Expense',
          type: 'expense',
          amount: amt,
          ivaRate: createClaim ? 0 : safeRate,
          ivaAmount: createClaim ? 0 : ivaAmt,
          ivaDeductible: createClaim ? false : ivaDeductible,
          status: 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      if (createClaim) {
        const reimbId = makeId('reimb');
        wb.set(doc(db, `finhub_users/${uid}/reimbursements`, reimbId), {
          userId: uid,
          owedByEntityId: beneficiaryEntityId,
          owedToEntityId: payerAccount.entityId,
          paidByAccountId: payerAccount.id,
          recurringExpenseId: '',
          transactionId: debitPayerAccount ? txId : '',
          date: safeDate,
          vendor: clampString(vendor, VALIDATION_BOUNDS.MAX_VENDOR_LEN) || 'Vendor',
          description: clampString(description, VALIDATION_BOUNDS.MAX_DESC_LEN) || 'Invoiced Expense',
          invoiceNumber: clampString(invoiceNumber, VALIDATION_BOUNDS.MAX_INVOICE_LEN),
          hasInvoice: true,
          amount: amt,
          ivaRate: safeRate,
          ivaAmount: ivaAmt,
          ivaDeductible: Boolean(ivaDeductible),
          status: 'open',
          settledDate: '',
          settledFromAccountId: '',
          settledToAccountId: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await wb.commit();
      pushToast(
        createClaim ? 'Reimbursement claim created' : 'Expense recorded',
        description,
        'success'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/reimbursements`);
    }
  };

  const settleReimbursements = async ({
    claims,
    fromAccountId,
    toAccountId,
    date,
  }: {
    claims: ExpenseReimbursement[];
    fromAccountId: string;
    toAccountId: string;
    date: string;
  }) => {
    const uid = requireUid();
    const openClaims = claims.filter((c) => c.status === 'open');
    if (openClaims.length === 0) return;

    const fromAccount = accounts.find((a) => a.id === fromAccountId);
    const toAccount = accounts.find((a) => a.id === toAccountId);
    if (!fromAccount || !toAccount) return;

    const totalAmount = Number(
      openClaims.reduce((s, c) => s + c.amount, 0).toFixed(2)
    );
    const safeDate = safeDateStr(date, todayIsoDate());
    const txOutId = makeId('tx');
    const txInId = makeId('tx');

    try {
      const wb = writeBatch(db);
      for (const claim of openClaims) {
        wb.update(doc(db, `finhub_users/${uid}/reimbursements`, claim.id), {
          status: 'settled',
          settledDate: safeDate,
          settledFromAccountId: fromAccount.id,
          settledToAccountId: toAccount.id,
          updatedAt: serverTimestamp(),
        });
      }

      wb.update(doc(db, `finhub_users/${uid}/accounts`, fromAccount.id), {
        balance: Number((fromAccount.balance - totalAmount).toFixed(2)),
        updatedAt: serverTimestamp(),
      });
      wb.update(doc(db, `finhub_users/${uid}/accounts`, toAccount.id), {
        balance: Number((toAccount.balance + totalAmount).toFixed(2)),
        updatedAt: serverTimestamp(),
      });

      const summaryNote =
        openClaims.length === 1
          ? openClaims[0].description
          : `${openClaims.length} invoiced claims settled`;

      wb.set(doc(db, `finhub_users/${uid}/transactions`, txOutId), {
        userId: uid,
        entityId: fromAccount.entityId,
        accountId: fromAccount.id,
        facilityId: '',
        payslipId: '',
        date: safeDate,
        description: clampString(
          `Reimbursement to ${toAccount.name} · ${summaryNote}`,
          VALIDATION_BOUNDS.MAX_DESC_LEN
        ),
        category: 'Reimbursement Settlement',
        type: 'transfer',
        amount: totalAmount,
        ivaRate: 0,
        ivaAmount: 0,
        ivaDeductible: false,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      wb.set(doc(db, `finhub_users/${uid}/transactions`, txInId), {
        userId: uid,
        entityId: toAccount.entityId,
        accountId: toAccount.id,
        facilityId: '',
        payslipId: '',
        date: safeDate,
        description: clampString(
          `Reimbursement from ${fromAccount.name} · ${summaryNote}`,
          VALIDATION_BOUNDS.MAX_DESC_LEN
        ),
        category: 'Reimbursement Settlement',
        type: 'income',
        amount: totalAmount,
        ivaRate: 0,
        ivaAmount: 0,
        ivaDeductible: false,
        status: 'cleared',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await wb.commit();
      pushToast(
        'Reimbursement settled',
        `${openClaims.length} claim${openClaims.length === 1 ? '' : 's'} · ${fromAccount.name} → ${toAccount.name}`,
        'success'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/reimbursements`);
    }
  };

  const deleteReimbursement = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/reimbursements/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Reimbursement claim removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const addInvoiceDocument = async (input: Omit<InvoiceDocument, 'id' | 'userId'>) => {
    const uid = requireUid();
    const id = makeId('inv');
    const path = `finhub_users/${uid}/invoiceDocuments/${id}`;
    const amt = Math.max(0, Number(input.amount) || 0);
    const ivaRate = Math.min(30, Math.max(0, Number(input.ivaRate) || 0));
    const ivaAmount =
      typeof input.ivaAmount === 'number'
        ? Math.max(0, Number(input.ivaAmount))
        : computeTransactionIva(amt, ivaRate);

    try {
      await setDoc(doc(db, path), {
        userId: uid,
        entityId: input.entityId,
        accountId: input.accountId || '',
        transactionId: input.transactionId || '',
        statementLineId: input.statementLineId || '',
        reimbursementId: input.reimbursementId || '',
        source: input.source,
        vendor: clampString(input.vendor, VALIDATION_BOUNDS.MAX_VENDOR_LEN) || 'Vendor',
        vendorNif: clampString(input.vendorNif || '', VALIDATION_BOUNDS.MAX_REG_LEN),
        invoiceNumber: clampString(input.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
        date: safeDateStr(input.date, todayIsoDate()),
        amount: amt,
        ivaRate,
        ivaAmount,
        ivaDeductible: Boolean(input.ivaDeductible),
        filename: clampString(input.filename, VALIDATION_BOUNDS.MAX_FILENAME_LEN) || 'invoice.pdf',
        driveFileId: clampString(input.driveFileId || '', 160),
        driveWebViewLink: clampString(input.driveWebViewLink || '', 512),
        driveFolderId: clampString(input.driveFolderId || '', 160),
        driveFolderPath: clampString(input.driveFolderPath || '', 240),
        gmailMessageId: clampString(input.gmailMessageId || '', 160),
        status: input.status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pushToast('Invoice registered', `${input.vendor} (${input.filename})`, 'success');
      return id;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const attachInvoiceToRecords = async ({
    invoiceDoc,
    transactionId,
    statementLineId,
    reimbursementId,
  }: {
    invoiceDoc: InvoiceDocument;
    transactionId?: string;
    statementLineId?: string;
    reimbursementId?: string;
  }) => {
    const uid = requireUid();
    const targetTxId = transactionId ?? invoiceDoc.transactionId;
    const targetLineId = statementLineId ?? invoiceDoc.statementLineId;
    const targetReimbId = reimbursementId ?? invoiceDoc.reimbursementId;
    const targetLine = targetLineId
      ? statementLines.find((l) => l.id === targetLineId)
      : undefined;
    const effectiveTxId = targetTxId || targetLine?.matchedTransactionId || '';
    const isReconciled =
      Boolean(targetLineId) || targetLine?.reconciliationStatus === 'reconciled';
    const nextDocStatus: InvoiceDocument['status'] = isReconciled
      ? 'reconciled'
      : invoiceDoc.driveFileId
      ? 'filed'
      : invoiceDoc.status;

    try {
      const wb = writeBatch(db);
      if (invoiceDoc.status !== 'reconciled') {
        wb.update(doc(db, `finhub_users/${uid}/invoiceDocuments`, invoiceDoc.id), {
          transactionId: effectiveTxId || '',
          statementLineId: targetLineId || '',
          reimbursementId: targetReimbId || '',
          status: nextDocStatus,
          updatedAt: serverTimestamp(),
        });
      }
      if (effectiveTxId) {
        wb.update(doc(db, `finhub_users/${uid}/transactions`, effectiveTxId), {
          invoiceNumber: clampString(invoiceDoc.invoiceNumber, VALIDATION_BOUNDS.MAX_INVOICE_LEN),
          invoiceDocId: invoiceDoc.id,
          driveFileId: clampString(invoiceDoc.driveFileId, 160),
          driveWebViewLink: clampString(invoiceDoc.driveWebViewLink, 512),
          driveFolderPath: clampString(invoiceDoc.driveFolderPath, 240),
          updatedAt: serverTimestamp(),
        });
      }
      if (targetReimbId) {
        wb.update(doc(db, `finhub_users/${uid}/reimbursements`, targetReimbId), {
          driveFileId: clampString(invoiceDoc.driveFileId, 160),
          driveWebViewLink: clampString(invoiceDoc.driveWebViewLink, 512),
          driveFolderPath: clampString(invoiceDoc.driveFolderPath, 240),
          invoiceNumber: clampString(invoiceDoc.invoiceNumber, VALIDATION_BOUNDS.MAX_INVOICE_LEN),
          hasInvoice: true,
          updatedAt: serverTimestamp(),
        });
      }
      await wb.commit();
      pushToast('Invoice PDF linked', invoiceDoc.filename, 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `finhub_users/${uid}/invoiceDocuments/${invoiceDoc.id}`);
    }
  };

  const createLedgerAndFileInvoice = async ({
    invoiceInput,
    accountId,
    category,
    description,
    createReimbursementToEntityId,
    adjustAccountBalance = true,
    matchedStatementLine,
  }: {
    invoiceInput: Omit<InvoiceDocument, 'id' | 'userId'>;
    accountId: string;
    category: string;
    description: string;
    createReimbursementToEntityId?: string;
    adjustAccountBalance?: boolean;
    matchedStatementLine?: StatementLine;
  }) => {
    const uid = requireUid();
    const docId = makeId('inv');
    const txId = makeId('tx');
    const account = accounts.find((a) => a.id === accountId);
    const amt = Math.max(0, Number(invoiceInput.amount) || 0);
    const ivaRate = Math.min(30, Math.max(0, Number(invoiceInput.ivaRate) || 0));
    const ivaAmount =
      typeof invoiceInput.ivaAmount === 'number'
        ? Math.max(0, Number(invoiceInput.ivaAmount))
        : computeTransactionIva(amt, ivaRate);
    const safeDate = safeDateStr(invoiceInput.date, todayIsoDate());

    const isCrossEntityReimb = Boolean(
      createReimbursementToEntityId && createReimbursementToEntityId !== invoiceInput.entityId
    );
    const reimbId = isCrossEntityReimb ? makeId('reimb') : '';
    const isReconciled = Boolean(matchedStatementLine);
    const docStatus: InvoiceDocument['status'] = isReconciled
      ? 'reconciled'
      : invoiceInput.driveFileId
      ? 'filed'
      : 'inbox';

    try {
      const wb = writeBatch(db);
      wb.set(doc(db, `finhub_users/${uid}/invoiceDocuments`, docId), {
        userId: uid,
        entityId: invoiceInput.entityId,
        accountId: account?.id || accountId || '',
        transactionId: account ? txId : '',
        statementLineId: matchedStatementLine?.id || '',
        reimbursementId: reimbId,
        source: invoiceInput.source,
        vendor: clampString(invoiceInput.vendor, VALIDATION_BOUNDS.MAX_VENDOR_LEN) || 'Vendor',
        vendorNif: clampString(invoiceInput.vendorNif || '', VALIDATION_BOUNDS.MAX_REG_LEN),
        invoiceNumber: clampString(invoiceInput.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
        date: safeDate,
        amount: amt,
        ivaRate,
        ivaAmount,
        ivaDeductible: Boolean(invoiceInput.ivaDeductible),
        filename: clampString(invoiceInput.filename, VALIDATION_BOUNDS.MAX_FILENAME_LEN) || 'invoice.pdf',
        driveFileId: clampString(invoiceInput.driveFileId || '', 160),
        driveWebViewLink: clampString(invoiceInput.driveWebViewLink || '', 512),
        driveFolderId: clampString(invoiceInput.driveFolderId || '', 160),
        driveFolderPath: clampString(invoiceInput.driveFolderPath || '', 240),
        gmailMessageId: clampString(invoiceInput.gmailMessageId || '', 160),
        status: docStatus,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (account) {
        wb.set(doc(db, `finhub_users/${uid}/transactions`, txId), {
          userId: uid,
          entityId: account.entityId,
          accountId: account.id,
          facilityId: '',
          payslipId: '',
          date: safeDate,
          description: clampString(
            description || `${invoiceInput.vendor} · ${invoiceInput.invoiceNumber || invoiceInput.filename}`,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          category: clampString(category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'Operating Expense',
          type: 'expense',
          amount: amt,
          ivaRate: isCrossEntityReimb ? 0 : ivaRate,
          ivaAmount: isCrossEntityReimb ? 0 : ivaAmount,
          ivaDeductible: isCrossEntityReimb ? false : Boolean(invoiceInput.ivaDeductible),
          invoiceNumber: clampString(invoiceInput.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
          invoiceDocId: docId,
          driveFileId: clampString(invoiceInput.driveFileId || '', 160),
          driveWebViewLink: clampString(invoiceInput.driveWebViewLink || '', 512),
          driveFolderPath: clampString(invoiceInput.driveFolderPath || '', 240),
          status: isReconciled ? 'reconciled' : 'cleared',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (adjustAccountBalance) {
          wb.update(doc(db, `finhub_users/${uid}/accounts`, account.id), {
            balance: Number((account.balance - amt).toFixed(2)),
            updatedAt: serverTimestamp(),
          });
        }
      }

      if (matchedStatementLine && matchedStatementLine.reconciliationStatus !== 'reconciled') {
        wb.update(doc(db, `finhub_users/${uid}/statementLines`, matchedStatementLine.id), {
          reconciliationStatus: 'reconciled',
          matchedTransactionId: account ? txId : '',
          updatedAt: serverTimestamp(),
        });
      }

      if (isCrossEntityReimb && createReimbursementToEntityId) {
        wb.set(doc(db, `finhub_users/${uid}/reimbursements`, reimbId), {
          userId: uid,
          owedByEntityId: invoiceInput.entityId,
          owedToEntityId: createReimbursementToEntityId,
          paidByAccountId: account?.id || '',
          recurringExpenseId: '',
          transactionId: account ? txId : '',
          date: safeDate,
          vendor: clampString(invoiceInput.vendor, VALIDATION_BOUNDS.MAX_VENDOR_LEN) || 'Vendor',
          description: clampString(
            description || invoiceInput.filename,
            VALIDATION_BOUNDS.MAX_DESC_LEN
          ),
          invoiceNumber: clampString(invoiceInput.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
          hasInvoice: true,
          amount: amt,
          ivaRate,
          ivaAmount,
          ivaDeductible: Boolean(invoiceInput.ivaDeductible),
          driveFileId: clampString(invoiceInput.driveFileId || '', 160),
          driveWebViewLink: clampString(invoiceInput.driveWebViewLink || '', 512),
          driveFolderPath: clampString(invoiceInput.driveFolderPath || '', 240),
          status: 'open',
          settledDate: '',
          settledFromAccountId: '',
          settledToAccountId: '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await wb.commit();
      pushToast(
        isReconciled
          ? 'Invoice filed & reconciled'
          : isCrossEntityReimb
          ? 'Invoice filed & reimbursement logged'
          : 'Invoice filed to ledger',
        invoiceInput.filename,
        'success'
      );
      return { docId, txId };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/invoiceDocuments/${docId}`);
    }
  };

  const deleteInvoiceDocument = async (id: string) => {
    const uid = requireUid();
    const path = `finhub_users/${uid}/invoiceDocuments/${id}`;
    try {
      await deleteDoc(doc(db, path));
      pushToast('Invoice document removed', undefined, 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const bulkImportHistoricalTransactions = async ({
    items,
    adjustAccountBalance,
  }: {
    items: Array<{
      entityId: string;
      accountId: string;
      date: string;
      description: string;
      category: string;
      type: LedgerTransaction['type'];
      amount: number;
      ivaRate?: number;
      ivaAmount?: number;
      ivaDeductible?: boolean;
      invoiceNumber?: string;
    }>;
    adjustAccountBalance: boolean;
  }) => {
    const uid = requireUid();
    if (items.length === 0) return 0;

    try {
      const accountDeltas = new Map<string, number>();
      const chunkSize = 380;
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const wb = writeBatch(db);
        for (const item of chunk) {
          const id = makeId('tx');
          const amt = Math.max(0, Number(item.amount) || 0);
          const ivaRate = Math.min(30, Math.max(0, Number(item.ivaRate) || 0));
          const ivaAmount =
            typeof item.ivaAmount === 'number'
              ? Math.max(0, Number(item.ivaAmount))
              : computeTransactionIva(amt, ivaRate);
          wb.set(doc(db, `finhub_users/${uid}/transactions`, id), {
            userId: uid,
            entityId: item.entityId,
            accountId: item.accountId,
            facilityId: '',
            payslipId: '',
            date: safeDateStr(item.date, todayIsoDate()),
            description: clampString(item.description, VALIDATION_BOUNDS.MAX_DESC_LEN) || 'Historical Entry',
            category: clampString(item.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) || 'General',
            type: item.type,
            amount: amt,
            ivaRate,
            ivaAmount,
            ivaDeductible: Boolean(item.ivaDeductible),
            invoiceNumber: clampString(item.invoiceNumber || '', VALIDATION_BOUNDS.MAX_INVOICE_LEN),
            invoiceDocId: '',
            driveFileId: '',
            driveWebViewLink: '',
            driveFolderPath: '',
            status: 'cleared',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          if (adjustAccountBalance) {
            const delta = item.type === 'income' ? amt : -amt;
            accountDeltas.set(item.accountId, (accountDeltas.get(item.accountId) || 0) + delta);
          }
        }
        await wb.commit();
      }

      if (adjustAccountBalance && accountDeltas.size > 0) {
        const balBatch = writeBatch(db);
        for (const [accId, delta] of accountDeltas.entries()) {
          const acc = accounts.find((a) => a.id === accId);
          if (acc) {
            balBatch.update(doc(db, `finhub_users/${uid}/accounts`, acc.id), {
              balance: Number((acc.balance + delta).toFixed(2)),
              updatedAt: serverTimestamp(),
            });
          }
        }
        await balBatch.commit();
      }

      pushToast(
        'Historical batch imported',
        `${items.length} ledger transactions added${adjustAccountBalance ? '' : ' (live balances preserved)'}.`,
        'success'
      );
      return items.length;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}/transactions`);
    }
  };

  const importDriveGeneratedBundle = async ({
    entityId,
    accountId,
    adjustAccountBalance,
    markPayslipsPaid = true,
    statements = [],
    payslips: incomingPayslips = [],
    contracts = [],
    subscriptions = [],
    facilities = [],
  }: {
    entityId: string;
    accountId: string;
    adjustAccountBalance: boolean;
    markPayslipsPaid?: boolean;
    statements?: Array<{
      filename: string;
      statementPeriod: string;
      openingBalance: number;
      closingBalance: number;
      lines: Array<{
        date: string;
        description: string;
        amount: number;
        direction: 'credit' | 'debit';
        generatedTx?: {
          vendor: string;
          category: string;
          type: LedgerTransaction['type'];
          ivaRate: number;
          ivaDeductible: boolean;
        };
      }>;
    }>;
    payslips?: Array<Omit<PayslipRecord, 'id' | 'userId' | 'totalCost'>>;
    contracts?: SuggestedContractDraft[];
    subscriptions?: SuggestedSubscriptionDraft[];
    facilities?: SuggestedFacilityDraft[];
  }) => {
    const uid = requireUid();
    const today = todayIsoDate();
    const account = accounts.find((a) => a.id === accountId);
    const resolvedEntityId = entityId || account?.entityId || '';
    const resolvedAccountId = account?.id || accountId || '';
    const paidByEntityId = account?.entityId || resolvedEntityId;
    const personalEntity = entities.find((e) => !e.archived && e.entityType === 'personal');

    const counts = {
      statements: 0,
      statementLines: 0,
      transactions: 0,
      subscriptions: 0,
      facilities: 0,
      contracts: 0,
      payslips: 0,
    };

    try {
      // 1. Contracts (deduplicated by entityId + lowercase workerName)
      const contractIdByWorker = new Map<string, string>();
      for (const existing of employmentContracts) {
        if (existing.entityId === resolvedEntityId) {
          contractIdByWorker.set(existing.workerName.trim().toLowerCase(), existing.id);
        }
      }

      const setupWb = writeBatch(db);
      let setupWrites = 0;

      for (const c of contracts) {
        const cleanName = clampString(c.workerName, VALIDATION_BOUNDS.MAX_EMP_LEN);
        if (!cleanName) continue;
        const key = cleanName.toLowerCase();
        if (contractIdByWorker.has(key)) continue;

        const cid = makeId('ctr');
        const isOwner = Boolean(c.isOwnerHint && personalEntity);
        setupWb.set(doc(db, `finhub_users/${uid}/employmentContracts`, cid), {
          userId: uid,
          entityId: resolvedEntityId,
          fundingAccountId: resolvedAccountId,
          workerName: cleanName,
          roleTitle: clampString(c.roleTitle || 'Employee', VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Employee',
          isOwnerIncome: isOwner,
          personalEntityId: isOwner && personalEntity ? personalEntity.id : '',
          paySchedule: c.paySchedule === '12_months' ? '12_months' : '14_months',
          baseGrossMonthly: Math.max(0, Number(c.baseGrossMonthly) || 0),
          irsRate: Math.min(100, Math.max(0, Number(c.irsRate) || 0)),
          employeeSsRate: Math.min(100, Math.max(0, Number(c.employeeSsRate) || 11)),
          employerSsRate: Math.min(100, Math.max(0, Number(c.employerSsRate) || 23.75)),
          mealAllowanceDaily: Math.max(0, Number(c.mealAllowanceDaily) || 0),
          mealPaymentMethod:
            c.mealPaymentMethod === 'card' || c.mealPaymentMethod === 'cash'
              ? c.mealPaymentMethod
              : 'none',
          childVoucherMonthly: Math.max(0, Number(c.childVoucherMonthly) || 0),
          childVoucherSubjectToIrs: false,
          childVoucherSubjectToSs: false,
          otherBenefitName: clampString(c.otherBenefitName || '', 60),
          otherBenefitMonthly: Math.max(0, Number(c.otherBenefitMonthly) || 0),
          otherBenefitSubjectToIrs: false,
          otherBenefitSubjectToSs: false,
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        contractIdByWorker.set(key, cid);
        counts.contracts += 1;
        setupWrites += 1;
      }

      // 2. Recurring Expenses & Subscriptions (deduplicated)
      const existingSubKeys = new Set(
        recurringExpenses
          .filter((r) => r.entityId === resolvedEntityId)
          .map((r) => `${r.vendor.trim().toLowerCase()}::${r.name.trim().toLowerCase()}`)
      );

      for (const s of subscriptions) {
        const name = clampString(s.name || s.vendor, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Subscription';
        const vendor = clampString(s.vendor || s.name, VALIDATION_BOUNDS.MAX_VENDOR_LEN) || 'Vendor';
        const key = `${vendor.toLowerCase()}::${name.toLowerCase()}`;
        if (existingSubKeys.has(key)) continue;
        existingSubKeys.add(key);

        const sid = makeId('sub');
        const freq = s.frequency === 'annual' ? 'annual' : 'monthly';
        const bDay = Math.min(31, Math.max(1, Math.round(Number(s.billingDay) || 1)));
        const bMonth =
          freq === 'annual' ? Math.min(12, Math.max(1, Math.round(Number(s.billingMonth) || 1))) : 1;
        const ivaRate = Math.min(30, Math.max(0, Number(s.ivaRate) || 0));

        setupWb.set(doc(db, `finhub_users/${uid}/recurringExpenses`, sid), {
          userId: uid,
          entityId: resolvedEntityId,
          paidByAccountId: resolvedAccountId,
          paidByEntityId,
          creditFacilityId: '',
          name,
          vendor,
          category: clampString(s.category || 'SaaS & Subscriptions', VALIDATION_BOUNDS.MAX_CATEGORY_LEN),
          amount: Math.max(0, Number(s.amount) || 0),
          frequency: freq,
          billingDay: bDay,
          billingMonth: bMonth,
          ivaRate,
          ivaDeductible: Boolean(s.ivaDeductible),
          hasInvoice: Boolean(s.hasInvoice),
          requiresReimbursement: Boolean(paidByEntityId && paidByEntityId !== resolvedEntityId),
          lastPostedDate: '',
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        counts.subscriptions += 1;
        setupWrites += 1;
      }

      // 3. Credit Facilities & Loans (deduplicated)
      const existingFacKeys = new Set(
        creditFacilities
          .filter((f) => f.entityId === resolvedEntityId)
          .map((f) => `${f.name.trim().toLowerCase()}::${f.lender.trim().toLowerCase()}`)
      );

      for (const f of facilities) {
        const name = clampString(f.name || f.lender, VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Credit Facility';
        const lender = clampString(f.lender || 'Bank', VALIDATION_BOUNDS.MAX_NAME_LEN) || 'Bank';
        const key = `${name.toLowerCase()}::${lender.toLowerCase()}`;
        if (existingFacKeys.has(key)) continue;
        existingFacKeys.add(key);

        const fid = makeId('fac');
        const allowedTypes: CreditFacility['facilityType'][] = [
          'term_loan',
          'credit_line',
          'credit_card',
          'mortgage',
          'equipment_loan',
        ];
        const fType = allowedTypes.includes(f.facilityType) ? f.facilityType : 'term_loan';
        const monthlyPayment = Math.max(0, Number(f.monthlyPayment) || 0);

        setupWb.set(doc(db, `finhub_users/${uid}/creditFacilities`, fid), {
          userId: uid,
          entityId: resolvedEntityId,
          fundingAccountId: resolvedAccountId,
          name,
          lender,
          facilityType: fType,
          principalOrLimit: 0,
          currentBalance: 0,
          apr: Math.min(100, Math.max(0, Number(f.apr) || 0)),
          monthlyPayment,
          dueDay: Math.min(31, Math.max(1, Math.round(Number(f.dueDay) || 1))),
          maturityDate: '',
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        counts.facilities += 1;
        setupWrites += 1;
      }

      if (setupWrites > 0) {
        await setupWb.commit();
      }

      // 4. Payslips (deduplicated, chunked)
      const existingSlipKeys = new Set(
        payslips.map((p) => `${p.entityId}::${p.payDate.slice(0, 7)}::${p.employeeName.trim().toLowerCase()}`)
      );
      const slipsToCreate: Array<{ id: string; payload: Record<string, unknown> }> = [];
      for (const p of incomingPayslips) {
        const empName = clampString(p.employeeName, VALIDATION_BOUNDS.MAX_EMP_LEN) || 'Employee';
        const safePayDate = safeDateStr(p.payDate, today);
        const dupKey = `${resolvedEntityId}::${safePayDate.slice(0, 7)}::${empName.toLowerCase()}`;
        if (existingSlipKeys.has(dupKey)) continue;
        existingSlipKeys.add(dupKey);

        const netPay = Math.max(0, Number(p.netPay) || 0);
        const empWith = Math.max(0, Number(p.employeeWithholdings) || 0);
        const erTax = Math.max(0, Number(p.employerTaxes) || 0);
        const erContrib = Math.max(0, Number(p.employerContributions) || 0);
        const grossPay = Math.max(0, Number(p.grossPay) || netPay + empWith);
        const totalCost = Number((netPay + empWith + erTax + erContrib).toFixed(2));
        const linkedCtrId = p.contractId || contractIdByWorker.get(empName.toLowerCase()) || '';

        slipsToCreate.push({
          id: makeId('pay'),
          payload: {
            userId: uid,
            entityId: resolvedEntityId,
            contractId: linkedCtrId,
            employeeName: empName,
            periodStart: safeDateStr(p.periodStart, today),
            periodEnd: safeDateStr(p.periodEnd, today),
            payDate: safePayDate,
            taxDueDate: safeDateStr(p.taxDueDate, today),
            grossPay,
            netPay,
            employeeWithholdings: empWith,
            employerTaxes: erTax,
            employerContributions: erContrib,
            totalCost,
            payStatus: markPayslipsPaid ? 'paid' : 'scheduled',
            taxStatus: markPayslipsPaid ? 'paid' : 'scheduled',
            sourceFilename: clampString(p.sourceFilename, VALIDATION_BOUNDS.MAX_FILENAME_LEN),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }

      for (let i = 0; i < slipsToCreate.length; i += 350) {
        const chunk = slipsToCreate.slice(i, i + 350);
        const pWb = writeBatch(db);
        for (const item of chunk) {
          pWb.set(doc(db, `finhub_users/${uid}/payslips`, item.id), item.payload);
        }
        await pWb.commit();
        counts.payslips += chunk.length;
      }

      // 5. Statements + Auto-Generated Reconciled Transactions
      let netBalanceDelta = 0;
      let latestStatementDate = account?.lastReconciledDate || '';

      for (const stmt of statements) {
        if (!resolvedAccountId) continue;
        const batchId = makeId('stmt');
        await setDoc(doc(db, `finhub_users/${uid}/statementBatches`, batchId), {
          userId: uid,
          entityId: resolvedEntityId,
          accountId: resolvedAccountId,
          filename: clampString(stmt.filename, VALIDATION_BOUNDS.MAX_FILENAME_LEN) || 'statement.pdf',
          statementPeriod: clampString(stmt.statementPeriod, 60) || today,
          openingBalance: Number(stmt.openingBalance) || 0,
          closingBalance: Number(stmt.closingBalance) || 0,
          lineCount: stmt.lines.length,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        counts.statements += 1;

        for (let i = 0; i < stmt.lines.length; i += 175) {
          const chunk = stmt.lines.slice(i, i + 175);
          const sWb = writeBatch(db);
          for (const line of chunk) {
            const safeLineDate = safeDateStr(line.date, today);
            const amt = Math.max(0, Number(line.amount) || 0);
            const direction = line.direction === 'credit' ? 'credit' : 'debit';
            const lineId = makeId('sline');

            if (safeLineDate > latestStatementDate) {
              latestStatementDate = safeLineDate;
            }

            let matchedTxId = '';
            if (line.generatedTx) {
              matchedTxId = makeId('tx');
              const txType = line.generatedTx.type;
              const ivaRate = Math.min(30, Math.max(0, Number(line.generatedTx.ivaRate) || 0));
              const ivaAmount = computeTransactionIva(amt, ivaRate);
              const vendorPrefix = line.generatedTx.vendor?.trim()
                ? `${line.generatedTx.vendor.trim()} · `
                : '';

              sWb.set(doc(db, `finhub_users/${uid}/transactions`, matchedTxId), {
                userId: uid,
                entityId: resolvedEntityId,
                accountId: resolvedAccountId,
                facilityId: '',
                payslipId: '',
                date: safeLineDate,
                description:
                  clampString(`${vendorPrefix}${line.description}`, VALIDATION_BOUNDS.MAX_DESC_LEN) ||
                  'Bank Entry',
                category:
                  clampString(line.generatedTx.category, VALIDATION_BOUNDS.MAX_CATEGORY_LEN) ||
                  'General',
                type: txType,
                amount: amt,
                ivaRate,
                ivaAmount,
                ivaDeductible: Boolean(line.generatedTx.ivaDeductible),
                invoiceNumber: '',
                invoiceDocId: '',
                driveFileId: '',
                driveWebViewLink: '',
                driveFolderPath: '',
                status: 'reconciled',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
              counts.transactions += 1;

              if (adjustAccountBalance) {
                netBalanceDelta += direction === 'credit' ? amt : -amt;
              }
            }

            sWb.set(doc(db, `finhub_users/${uid}/statementLines`, lineId), {
              userId: uid,
              batchId,
              entityId: resolvedEntityId,
              accountId: resolvedAccountId,
              date: safeLineDate,
              description:
                clampString(line.description, VALIDATION_BOUNDS.MAX_LINE_DESC_LEN) || 'Bank entry',
              amount: amt,
              direction,
              reconciliationStatus: matchedTxId ? 'reconciled' : 'unmatched',
              matchedTransactionId: matchedTxId,
              discrepancyNote: '',
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            counts.statementLines += 1;
          }
          await sWb.commit();
        }
      }

      if (account && (Math.abs(netBalanceDelta) > 0.001 || (latestStatementDate && latestStatementDate > account.lastReconciledDate))) {
        await updateDoc(doc(db, `finhub_users/${uid}/accounts`, account.id), {
          balance: adjustAccountBalance
            ? Number((account.balance + netBalanceDelta).toFixed(2))
            : account.balance,
          lastReconciledDate: latestStatementDate || account.lastReconciledDate,
          updatedAt: serverTimestamp(),
        });
      }

      pushToast(
        'Drive records saved to Firebase',
        `Created ${counts.contracts} contracts, ${counts.payslips} payslips, ${counts.subscriptions} subscriptions, ${counts.facilities} loans, ${counts.transactions} expenses/entries across ${counts.statements} statements.`,
        'success'
      );
      return counts;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `finhub_users/${uid}`);
    }
  };

  const hasSampleData = useMemo(
    () =>
      entities.some(
        (e) =>
          e.id === SAMPLE_ENTITY_HOLDINGS ||
          (e.id === 'ent_northstar_labs' && e.name === 'Northstar Labs Lda') ||
          (e.id === 'ent_personal' && e.registrationCode === 'NIF 248190312')
      ) ||
      accounts.some((a) => SAMPLE_ACCOUNT_IDS.has(a.id)) ||
      creditFacilities.some((f) => SAMPLE_FACILITY_IDS.has(f.id)) ||
      employmentContracts.some((c) => SAMPLE_CONTRACT_IDS.has(c.id)) ||
      payslips.some((p) => isSamplePayslipId(p.id)) ||
      personalIncomes.some((p) => SAMPLE_PERSONAL_INCOME_IDS.has(p.id)) ||
      forecastItems.some((f) => SAMPLE_FORECAST_IDS.has(f.id)) ||
      transactions.some((t) => isSampleTxId(t.id)) ||
      statementBatches.some((b) => SAMPLE_STATEMENT_BATCH_IDS.has(b.id)) ||
      statementLines.some((l) => SAMPLE_STATEMENT_LINE_IDS.has(l.id)) ||
      recurringExpenses.some((s) => SAMPLE_SUBSCRIPTION_IDS.has(s.id)) ||
      reimbursements.some((r) => SAMPLE_REIMBURSEMENT_IDS.has(r.id)),
    [
      entities,
      accounts,
      creditFacilities,
      employmentContracts,
      payslips,
      personalIncomes,
      forecastItems,
      transactions,
      statementBatches,
      statementLines,
      recurringExpenses,
      reimbursements,
    ]
  );

  const resetWorkspaceData = async (mode: 'sample_only' | 'all_non_reconciled') => {
    const uid = requireUid();
    const deletePaths: string[] = [];
    let lockedCount = 0;

    const protectedEntityIds = new Set<string>();
    const protectedAccountIds = new Set<string>();
    const protectedBatchIds = new Set<string>();

    if (mode === 'all_non_reconciled') {
      for (const inv of invoiceDocuments) {
        if (inv.status === 'reconciled') {
          lockedCount++;
          if (inv.entityId) protectedEntityIds.add(inv.entityId);
          if (inv.accountId) protectedAccountIds.add(inv.accountId);
        } else {
          deletePaths.push(`finhub_users/${uid}/invoiceDocuments/${inv.id}`);
        }
      }
      for (const l of statementLines) {
        if (l.reconciliationStatus === 'reconciled') {
          lockedCount++;
          protectedEntityIds.add(l.entityId);
          protectedAccountIds.add(l.accountId);
          protectedBatchIds.add(l.batchId);
        } else {
          deletePaths.push(`finhub_users/${uid}/statementLines/${l.id}`);
        }
      }
      for (const tx of transactions) {
        if (tx.status === 'reconciled') {
          lockedCount++;
          protectedEntityIds.add(tx.entityId);
          protectedAccountIds.add(tx.accountId);
        } else {
          deletePaths.push(`finhub_users/${uid}/transactions/${tx.id}`);
        }
      }
      for (const r of reimbursements) {
        deletePaths.push(`finhub_users/${uid}/reimbursements/${r.id}`);
      }
      for (const s of recurringExpenses) {
        deletePaths.push(`finhub_users/${uid}/recurringExpenses/${s.id}`);
      }
      for (const p of payslips) {
        deletePaths.push(`finhub_users/${uid}/payslips/${p.id}`);
      }
      for (const c of employmentContracts) {
        deletePaths.push(`finhub_users/${uid}/employmentContracts/${c.id}`);
      }
      for (const pi of personalIncomes) {
        deletePaths.push(`finhub_users/${uid}/personalIncomes/${pi.id}`);
      }
      for (const f of forecastItems) {
        deletePaths.push(`finhub_users/${uid}/forecastItems/${f.id}`);
      }
      for (const fac of creditFacilities) {
        deletePaths.push(`finhub_users/${uid}/creditFacilities/${fac.id}`);
      }
      for (const b of statementBatches) {
        if (!protectedBatchIds.has(b.id)) {
          deletePaths.push(`finhub_users/${uid}/statementBatches/${b.id}`);
        }
      }
      for (const acc of accounts) {
        if (!protectedAccountIds.has(acc.id)) {
          deletePaths.push(`finhub_users/${uid}/accounts/${acc.id}`);
        }
      }
      for (const ts of taxSettings) {
        if (!protectedEntityIds.has(ts.entityId)) {
          deletePaths.push(`finhub_users/${uid}/taxSettings/${ts.id}`);
        }
      }
      for (const ent of entities) {
        if (!protectedEntityIds.has(ent.id)) {
          deletePaths.push(`finhub_users/${uid}/entities/${ent.id}`);
        }
      }
    } else {
      // sample_only: delete seeded demo artifacts, preserving any real records created by the user
      for (const r of reimbursements) {
        if (SAMPLE_REIMBURSEMENT_IDS.has(r.id)) {
          deletePaths.push(`finhub_users/${uid}/reimbursements/${r.id}`);
        } else {
          protectedEntityIds.add(r.owedByEntityId);
          protectedEntityIds.add(r.owedToEntityId);
          if (r.paidByAccountId) protectedAccountIds.add(r.paidByAccountId);
        }
      }
      for (const s of recurringExpenses) {
        if (SAMPLE_SUBSCRIPTION_IDS.has(s.id)) {
          deletePaths.push(`finhub_users/${uid}/recurringExpenses/${s.id}`);
        } else {
          protectedEntityIds.add(s.entityId);
          protectedEntityIds.add(s.paidByEntityId);
          protectedAccountIds.add(s.paidByAccountId);
        }
      }
      for (const l of statementLines) {
        if (SAMPLE_STATEMENT_LINE_IDS.has(l.id)) {
          if (l.reconciliationStatus === 'reconciled') {
            lockedCount++;
            protectedEntityIds.add(l.entityId);
            protectedAccountIds.add(l.accountId);
            protectedBatchIds.add(l.batchId);
          } else {
            deletePaths.push(`finhub_users/${uid}/statementLines/${l.id}`);
          }
        } else {
          protectedEntityIds.add(l.entityId);
          protectedAccountIds.add(l.accountId);
          protectedBatchIds.add(l.batchId);
        }
      }
      for (const b of statementBatches) {
        if (SAMPLE_STATEMENT_BATCH_IDS.has(b.id) && !protectedBatchIds.has(b.id)) {
          deletePaths.push(`finhub_users/${uid}/statementBatches/${b.id}`);
        } else {
          protectedEntityIds.add(b.entityId);
          protectedAccountIds.add(b.accountId);
        }
      }
      for (const tx of transactions) {
        if (isSampleTxId(tx.id)) {
          if (tx.status === 'reconciled') {
            lockedCount++;
            protectedEntityIds.add(tx.entityId);
            protectedAccountIds.add(tx.accountId);
          } else {
            deletePaths.push(`finhub_users/${uid}/transactions/${tx.id}`);
          }
        } else {
          protectedEntityIds.add(tx.entityId);
          protectedAccountIds.add(tx.accountId);
        }
      }
      for (const inv of invoiceDocuments) {
        protectedEntityIds.add(inv.entityId);
        if (inv.accountId) protectedAccountIds.add(inv.accountId);
      }
      for (const p of payslips) {
        if (isSamplePayslipId(p.id)) {
          deletePaths.push(`finhub_users/${uid}/payslips/${p.id}`);
        } else {
          protectedEntityIds.add(p.entityId);
        }
      }
      for (const c of employmentContracts) {
        if (SAMPLE_CONTRACT_IDS.has(c.id)) {
          deletePaths.push(`finhub_users/${uid}/employmentContracts/${c.id}`);
        } else {
          protectedEntityIds.add(c.entityId);
          if (c.fundingAccountId) protectedAccountIds.add(c.fundingAccountId);
        }
      }
      for (const pi of personalIncomes) {
        if (SAMPLE_PERSONAL_INCOME_IDS.has(pi.id)) {
          deletePaths.push(`finhub_users/${uid}/personalIncomes/${pi.id}`);
        } else {
          protectedEntityIds.add(pi.entityId);
          if (pi.accountId) protectedAccountIds.add(pi.accountId);
        }
      }
      for (const f of forecastItems) {
        if (SAMPLE_FORECAST_IDS.has(f.id)) {
          deletePaths.push(`finhub_users/${uid}/forecastItems/${f.id}`);
        } else {
          protectedEntityIds.add(f.entityId);
        }
      }
      for (const fac of creditFacilities) {
        if (SAMPLE_FACILITY_IDS.has(fac.id)) {
          deletePaths.push(`finhub_users/${uid}/creditFacilities/${fac.id}`);
        } else {
          protectedEntityIds.add(fac.entityId);
          if (fac.fundingAccountId) protectedAccountIds.add(fac.fundingAccountId);
        }
      }
      for (const acc of accounts) {
        if (SAMPLE_ACCOUNT_IDS.has(acc.id) && !protectedAccountIds.has(acc.id)) {
          deletePaths.push(`finhub_users/${uid}/accounts/${acc.id}`);
        } else {
          protectedEntityIds.add(acc.entityId);
        }
      }

      const deletedDemoEntityIds = new Set<string>();
      for (const ent of entities) {
        const isDemoEnt =
          ent.id === SAMPLE_ENTITY_HOLDINGS ||
          (ent.id === 'ent_northstar_labs' && ent.name === 'Northstar Labs Lda') ||
          (ent.id === 'ent_personal' &&
            ent.name === 'Personal Household' &&
            ent.registrationCode === 'NIF 248190312');
        if (isDemoEnt && !protectedEntityIds.has(ent.id)) {
          deletedDemoEntityIds.add(ent.id);
          deletePaths.push(`finhub_users/${uid}/entities/${ent.id}`);
        }
      }
      for (const ts of taxSettings) {
        if (deletedDemoEntityIds.has(ts.entityId)) {
          deletePaths.push(`finhub_users/${uid}/taxSettings/${ts.id}`);
        }
      }
    }

    if (deletePaths.length === 0) {
      pushToast(
        lockedCount > 0 ? 'Only reconciled records remain' : 'Workspace already clean',
        lockedCount > 0
          ? `${lockedCount} reconciled item(s) are audit-locked.`
          : 'No removable sample or draft records found.',
        'info'
      );
      return { deleted: 0, lockedCount };
    }

    try {
      const chunkSize = 400;
      for (let i = 0; i < deletePaths.length; i += chunkSize) {
        const chunk = deletePaths.slice(i, i + chunkSize);
        const wb = writeBatch(db);
        for (const path of chunk) {
          wb.delete(doc(db, path));
        }
        await wb.commit();
      }
      setEntityFilter('all');
      pushToast(
        mode === 'sample_only' ? 'Sample data cleared' : 'Workspace reset',
        lockedCount > 0
          ? `Removed ${deletePaths.length} records (${lockedCount} reconciled items audit-locked).`
          : `Removed ${deletePaths.length} records. Ready for real data.`,
        'success'
      );
      return { deleted: deletePaths.length, lockedCount };
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `finhub_users/${uid}`);
    }
  };

  return (
    <TreasuryContext.Provider
      value={{
        loading,
        profile,
        entities,
        accounts,
        creditFacilities,
        transactions,
        payslips,
        forecastItems,
        statementBatches,
        statementLines,
        personalIncomes,
        taxSettings,
        employmentContracts,
        recurringExpenses,
        reimbursements,
        invoiceDocuments,
        entityFilter,
        setEntityFilter,
        filteredAccounts,
        filteredFacilities,
        filteredTransactions,
        filteredPayslips,
        filteredForecastItems,
        filteredStatementBatches,
        filteredStatementLines,
        filteredPersonalIncomes,
        filteredEmploymentContracts,
        filteredRecurringExpenses,
        filteredReimbursements,
        filteredInvoiceDocuments,
        currencyCode,
        currencySymbol,
        toasts,
        pushToast,
        dismissToast,
        completeOnboarding,
        updateCurrencyPreference,
        addEntity,
        updateEntity,
        deleteEntity,
        addAccount,
        updateAccountDetails,
        updateAccountBalance,
        transferBetweenAccounts,
        deleteAccount,
        addCreditFacility,
        recordLoanPayment,
        deleteCreditFacility,
        addTransaction,
        recordVoucherFirstExpense,
        deleteTransaction,
        addPayslip,
        markPayslipStatus,
        deletePayslip,
        addForecastItem,
        toggleForecastItem,
        deleteForecastItem,
        addPersonalIncome,
        updatePersonalIncome,
        togglePersonalIncome,
        deletePersonalIncome,
        addEmploymentContract,
        updateEmploymentContract,
        toggleEmploymentContract,
        deleteEmploymentContract,
        generatePayslipsFromContracts,
        importNoisysourceUploadedPayslips,
        upsertTaxSetting,
        importStatementBatch,
        confirmReconciliationMatch,
        createLedgerFromStatementLine,
        markLineSuggested,
        flagLineDiscrepancy,
        deleteStatementBatch,
        addRecurringExpense,
        updateRecurringExpense,
        toggleRecurringExpense,
        deleteRecurringExpense,
        postRecurringExpensePayment,
        addCrossEntityExpense,
        settleReimbursements,
        deleteReimbursement,
        addInvoiceDocument,
        attachInvoiceToRecords,
        createLedgerAndFileInvoice,
        deleteInvoiceDocument,
        bulkImportHistoricalTransactions,
        importDriveGeneratedBundle,
        hasSampleData,
        resetWorkspaceData,
      }}
    >
      {children}
    </TreasuryContext.Provider>
  );
}

export function useTreasury(): TreasuryContextValue {
  const ctx = useContext(TreasuryContext);
  if (!ctx) {
    throw new Error('useTreasury must be used inside TreasuryProvider');
  }
  return ctx;
}
