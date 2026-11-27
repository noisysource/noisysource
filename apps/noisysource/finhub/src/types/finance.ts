export type CurrencyCode =
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'CAD'
  | 'AUD'
  | 'CHF'
  | 'JPY'
  | 'PLN'
  | 'SEK'
  | 'NOK';

export interface CurrencyOption {
  code: CurrencyCode;
  symbol: string;
  label: string;
}

export const CURRENCY_OPTIONS: CurrencyOption[] = [
  { code: 'EUR', symbol: '€', label: 'EUR (€) — Euro' },
  { code: 'USD', symbol: '$', label: 'USD ($) — US Dollar' },
  { code: 'GBP', symbol: '£', label: 'GBP (£) — British Pound' },
  { code: 'CAD', symbol: '$', label: 'CAD ($) — Canadian Dollar' },
  { code: 'AUD', symbol: '$', label: 'AUD ($) — Australian Dollar' },
  { code: 'CHF', symbol: 'Fr', label: 'CHF (Fr) — Swiss Franc' },
  { code: 'JPY', symbol: '¥', label: 'JPY (¥) — Japanese Yen' },
  { code: 'PLN', symbol: 'zł', label: 'PLN (zł) — Polish Zloty' },
  { code: 'SEK', symbol: 'kr', label: 'SEK (kr) — Swedish Krona' },
  { code: 'NOK', symbol: 'kr', label: 'NOK (kr) — Norwegian Krone' },
];

export const VALIDATION_BOUNDS = {
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  DATE_PATTERN: /^\d{4}-\d{2}-\d{2}$/,
  MONTH_PATTERN: /^\d{4}-\d{2}$/,
  COLOR_PATTERN: /^#[0-9a-fA-F]{6}$/,
  MAX_NAME_LEN: 80,
  MAX_REG_LEN: 40,
  MAX_ACCT_NUM_LEN: 34,
  MAX_EMP_LEN: 100,
  MAX_DESC_LEN: 160,
  MAX_LINE_DESC_LEN: 200,
  MAX_CATEGORY_LEN: 60,
  MAX_FILENAME_LEN: 140,
  MAX_VENDOR_LEN: 80,
  MAX_INVOICE_LEN: 60,
} as const;

export type EntityType = 'personal' | 'company';
export type AccountType =
  | 'checking'
  | 'savings'
  | 'treasury'
  | 'cash'
  | 'meal_voucher'
  | 'child_voucher';
export type FacilityType = 'term_loan' | 'credit_line' | 'credit_card' | 'mortgage' | 'equipment_loan';
export type FacilityStatus = 'active' | 'paid_off';
export type TransactionType = 'income' | 'expense' | 'transfer' | 'debt_payment' | 'payroll';
export type TransactionStatus = 'cleared' | 'scheduled' | 'reconciled';
export type PayslipPayStatus = 'scheduled' | 'paid';
export type ForecastDirection = 'inflow' | 'outflow';
export type ReconciliationStatus = 'unmatched' | 'suggested' | 'reconciled' | 'discrepancy';
export type StatementDirection = 'credit' | 'debit';
export type ForecastScenario = 'baseline' | 'conservative' | 'growth';

export type PersonalIncomeCategory =
  | 'cat_a_dependent'
  | 'cat_b_independent'
  | 'cat_e_capital'
  | 'cat_f_rental'
  | 'other';

export type PersonalIncomeFrequency = 'monthly' | '14_months' | 'annual' | 'one_off';

export type MealPaymentMethod = 'card' | 'cash' | 'none';
export type ContractPaySchedule = '14_months' | '12_months';

export type FiscalRegion = 'continente' | 'madeira' | 'acores';
export type IvaPeriodicity = 'monthly' | 'quarterly' | 'exempt';
export type IrsMaritalStatus = 'single' | 'married_joint';
export type BillingFrequency = 'monthly' | 'annual';
export type ReimbursementStatus = 'open' | 'settled';

export type NavSection =
  | 'overview'
  | 'accounts'
  | 'expenses'
  | 'personal_income'
  | 'client_contracts'
  | 'taxes'
  | 'credits'
  | 'forecast'
  | 'calendar'
  | 'reconciliation'
  | 'documents'
  | 'ledger';

export interface WorkspaceProfile {
  id: string;
  userId: string;
  currencyCode: CurrencyCode;
  currencySymbol: string;
  fiscalStartMonth: number;
  onboardingComplete: boolean;
}

export interface Entity {
  id: string;
  userId: string;
  name: string;
  entityType: EntityType;
  registrationCode: string;
  colorHex: string;
  archived: boolean;
}

export interface Account {
  id: string;
  userId: string;
  entityId: string;
  name: string;
  institution: string;
  accountType: AccountType;
  accountNumber?: string;
  balance: number;
  lastReconciledDate: string;
}

export interface CreditFacility {
  id: string;
  userId: string;
  entityId: string;
  fundingAccountId: string;
  name: string;
  lender: string;
  facilityType: FacilityType;
  principalOrLimit: number;
  currentBalance: number;
  apr: number;
  monthlyPayment: number;
  dueDay: number;
  maturityDate: string;
  status: FacilityStatus;
}

export interface LedgerTransaction {
  id: string;
  userId: string;
  entityId: string;
  accountId: string;
  facilityId: string;
  payslipId: string;
  date: string;
  description: string;
  category: string;
  type: TransactionType;
  amount: number;
  ivaRate?: number;
  ivaAmount?: number;
  ivaDeductible?: boolean;
  invoiceNumber?: string;
  invoiceDocId?: string;
  driveFileId?: string;
  driveWebViewLink?: string;
  driveFolderPath?: string;
  status: TransactionStatus;
}

export interface PayslipRecord {
  id: string;
  userId: string;
  entityId: string;
  contractId?: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxDueDate: string;
  grossPay: number;
  netPay: number;
  employeeWithholdings: number;
  employerTaxes: number;
  employerContributions: number;
  totalCost: number;
  payStatus: PayslipPayStatus;
  taxStatus: PayslipPayStatus;
  sourceFilename: string;
}

export interface EmploymentContract {
  id: string;
  userId: string;
  entityId: string;
  fundingAccountId: string;
  workerName: string;
  roleTitle: string;
  isOwnerIncome: boolean;
  personalEntityId: string;
  paySchedule: ContractPaySchedule;
  baseGrossMonthly: number;
  irsRate: number;
  employeeSsRate: number;
  employerSsRate: number;
  mealAllowanceDaily: number;
  mealPaymentMethod: MealPaymentMethod;
  childVoucherMonthly: number;
  childVoucherSubjectToIrs: boolean;
  childVoucherSubjectToSs: boolean;
  otherBenefitName: string;
  otherBenefitMonthly: number;
  otherBenefitSubjectToIrs: boolean;
  otherBenefitSubjectToSs: boolean;
  active: boolean;
  /** Terms over time, each from a month on (utils/contractVersions.ts). Absent: the same terms every month. */
  versions?: ContractVersion[];
}

/** The part of a contract that changes over time. */
export type ContractTerms = Pick<
  EmploymentContract,
  | 'paySchedule'
  | 'baseGrossMonthly'
  | 'irsRate'
  | 'employeeSsRate'
  | 'employerSsRate'
  | 'mealAllowanceDaily'
  | 'mealPaymentMethod'
  | 'childVoucherMonthly'
  | 'childVoucherSubjectToIrs'
  | 'childVoucherSubjectToSs'
  | 'otherBenefitName'
  | 'otherBenefitMonthly'
  | 'otherBenefitSubjectToIrs'
  | 'otherBenefitSubjectToSs'
>;

/** A contract's terms from one month on, until the next version. */
export interface ContractVersion {
  /** YYYY-MM */
  effectiveFrom: string;
  /** Why it changed ("raise", "new IRS table"), or where it came from ("Atlas, from the March payslip"). */
  note: string;
  terms: ContractTerms;
}

export interface ContractMonthlyCalculation {
  monthKey: string;
  workDays: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxDueDate: string;
  baseSalary: number;
  subsidyBonus: number;
  grossSalary: number;
  mealTotal: number;
  mealExempt: number;
  mealTaxable: number;
  childTotal: number;
  otherTotal: number;
  totalBenefits: number;
  irsTaxableBase: number;
  ssTaxableBase: number;
  employeeIrs: number;
  employeeSs: number;
  employeeWithholdings: number;
  employerSs: number;
  netCashSalary: number;
  netDisbursement: number;
  grossTotal: number;
  totalTaxRemittance: number;
  totalEmployerCost: number;
}

export interface ForecastItem {
  id: string;
  userId: string;
  entityId: string;
  name: string;
  direction: ForecastDirection;
  category: string;
  monthlyAmount: number;
  startMonth: string;
  endMonth: string;
  annualGrowthRate: number;
  active: boolean;
}

export interface StatementBatch {
  id: string;
  userId: string;
  entityId: string;
  accountId: string;
  filename: string;
  statementPeriod: string;
  openingBalance: number;
  closingBalance: number;
  lineCount: number;
}

export interface StatementLine {
  id: string;
  userId: string;
  batchId: string;
  entityId: string;
  accountId: string;
  date: string;
  description: string;
  amount: number;
  direction: StatementDirection;
  reconciliationStatus: ReconciliationStatus;
  matchedTransactionId: string;
  discrepancyNote: string;
}

export interface PersonalIncome {
  id: string;
  userId: string;
  entityId: string;
  accountId: string;
  title: string;
  payerName: string;
  incomeCategory: PersonalIncomeCategory;
  frequency: PersonalIncomeFrequency;
  grossAmount: number;
  irsWithheldRate: number;
  ssRate: number;
  countsTowardsIrs: boolean;
  active: boolean;
}

export interface TaxSetting {
  id: string;
  userId: string;
  entityId: string;
  region: FiscalRegion;
  isPme: boolean;
  ivaPeriodicity: IvaPeriodicity;
  derramaRate: number;
  ircPaymentsOnAccount: number;
  irsMaritalStatus: IrsMaritalStatus;
  irsDependents: number;
  irsDeductions: number;
}

export interface RecurringExpense {
  id: string;
  userId: string;
  entityId: string;
  paidByAccountId: string;
  paidByEntityId: string;
  creditFacilityId: string;
  name: string;
  vendor: string;
  category: string;
  amount: number;
  frequency: BillingFrequency;
  billingDay: number;
  billingMonth: number;
  ivaRate: number;
  ivaDeductible: boolean;
  hasInvoice: boolean;
  requiresReimbursement: boolean;
  lastPostedDate: string;
  active: boolean;
}

export interface ExpenseReimbursement {
  id: string;
  userId: string;
  owedByEntityId: string;
  owedToEntityId: string;
  paidByAccountId: string;
  recurringExpenseId: string;
  transactionId: string;
  date: string;
  vendor: string;
  description: string;
  invoiceNumber: string;
  hasInvoice: boolean;
  amount: number;
  ivaRate: number;
  ivaAmount: number;
  ivaDeductible: boolean;
  driveFileId?: string;
  driveWebViewLink?: string;
  driveFolderPath?: string;
  status: ReimbursementStatus;
  settledDate: string;
  settledFromAccountId: string;
  settledToAccountId: string;
}

export type InvoiceDocumentSource = 'gmail' | 'drive' | 'upload';
export type InvoiceDocumentStatus = 'inbox' | 'filed' | 'reconciled';

export interface InvoiceDocument {
  id: string;
  userId: string;
  entityId: string;
  accountId: string;
  transactionId: string;
  statementLineId: string;
  reimbursementId: string;
  source: InvoiceDocumentSource;
  vendor: string;
  vendorNif: string;
  invoiceNumber: string;
  date: string;
  amount: number;
  ivaRate: number;
  ivaAmount: number;
  ivaDeductible: boolean;
  filename: string;
  driveFileId: string;
  driveWebViewLink: string;
  driveFolderId: string;
  driveFolderPath: string;
  gmailMessageId: string;
  status: InvoiceDocumentStatus;
}

export interface ParsedInvoiceDraft {
  vendor: string;
  vendorNif: string;
  invoiceNumber: string;
  date: string;
  amount: number;
  ivaRate: number;
  ivaAmount: number;
  ivaDeductible: boolean;
  category: string;
  description: string;
  entityHint: string;
  notes: string;
  filename: string;
}

export interface GmailCandidateMessage {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  dateIso: string;
  snippet: string;
  attachments: Array<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

export interface DriveFolderItem {
  id: string;
  name: string;
  parents?: string[];
  webViewLink?: string;
}

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

export interface AmortizationRow {
  monthIndex: number;
  monthLabel: string;
  beginningBalance: number;
  payment: number;
  principalPaid: number;
  interestPaid: number;
  endingBalance: number;
}

export interface ForecastMonthRow {
  monthKey: string;
  monthLabel: string;
  startingCash: number;
  inflows: number;
  payrollOutflow: number;
  debtService: number;
  operatingOutflow: number;
  netCashFlow: number;
  endingCash: number;
  endingLiquidCash?: number;
  endingVoucherBalance?: number;
  voucherCoveredOutflow?: number;
}

export interface CalendarEvent {
  id: string;
  date: string;
  title: string;
  subtitle: string;
  amount: number;
  kind: 'payslip_net' | 'payslip_tax' | 'loan_due' | 'scheduled_tx' | 'subscription_due';
  entityId: string;
  entityName: string;
  status: 'scheduled' | 'paid' | 'overdue';
  sourceId: string;
}

export interface ParsedPayslipDraft {
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxDueDate: string;
  grossPay: number;
  netPay: number;
  employeeWithholdings: number;
  employerTaxes: number;
  employerContributions: number;
  notes: string;
  sourceFilename: string;
}

export interface ParsedStatementDraft {
  statementPeriod: string;
  openingBalance: number;
  closingBalance: number;
  filename: string;
  lines: Array<{
    date: string;
    description: string;
    amount: number;
    direction: StatementDirection;
  }>;
}

export interface SuggestedContractDraft {
  workerName: string;
  roleTitle: string;
  employerName: string;
  isOwnerHint: boolean;
  paySchedule: ContractPaySchedule;
  baseGrossMonthly: number;
  irsRate: number;
  employeeSsRate: number;
  employerSsRate: number;
  mealAllowanceDaily: number;
  mealPaymentMethod: MealPaymentMethod;
  childVoucherMonthly: number;
  otherBenefitName: string;
  otherBenefitMonthly: number;
  notes: string;
  /** From Atlas's year pass: the terms over time, each from a month on. */
  versions?: ContractVersion[];
}

export interface SuggestedSubscriptionDraft {
  name: string;
  vendor: string;
  category: string;
  amount: number;
  frequency: BillingFrequency;
  billingDay: number;
  billingMonth: number;
  ivaRate: number;
  ivaDeductible: boolean;
  hasInvoice: boolean;
  matchCount: number;
  sampleDates: string[];
  notes: string;
}

export interface SuggestedFacilityDraft {
  name: string;
  lender: string;
  facilityType: FacilityType;
  monthlyPayment: number;
  dueDay: number;
  apr: number;
  matchCount: number;
  notes: string;
}

export interface SuggestedStatementTransactionDraft {
  lineIndex: number;
  date: string;
  description: string;
  vendor: string;
  category: string;
  type: TransactionType;
  amount: number;
  ivaRate: number;
  ivaDeductible: boolean;
  notes: string;
}

export interface IvaSummary {
  entityId: string;
  entityName: string;
  periodicity: IvaPeriodicity;
  salesGross: number;
  salesBaseNet: number;
  ivaLiquidado: number;
  purchasesGross: number;
  ivaDedutivel: number;
  netIvaPayable: number;
  breakdownByRate: Array<{ rate: number; liquidado: number; dedutivel: number }>;
}

export interface IrcSummary {
  entityId: string;
  entityName: string;
  isPme: boolean;
  revenueNetIva: number;
  operatingExpensesNetIva: number;
  payrollEmployerCost: number;
  loanInterestEstimate: number;
  taxableProfit: number;
  ircLowBracketTax: number;
  ircStandardBracketTax: number;
  derramaTax: number;
  totalIrcLiability: number;
  paymentsOnAccount: number;
  netIrcDue: number;
  effectiveRatePct: number;
}

export interface IrsSummary {
  totalGrossIncome: number;
  annualSocialSecurity: number;
  specificDeduction: number;
  taxableIncome: number;
  quotientDivisor: number;
  effectiveBracketRatePct: number;
  parcelaAbater: number;
  grossIrsTax: number;
  generalDeductions: number;
  dependentCredits: number;
  netIrsLiability: number;
  totalWithheldAtSource: number;
  estimatedPayableOrRefund: number;
  bracketLabel: string;
  sourcesBreakdown: Array<{
    id: string;
    title: string;
    categoryLabel: string;
    annualGross: number;
    annualTaxable: number;
    annualWithheld: number;
    annualSs: number;
    annualNetCash: number;
  }>;
}
