import type {
  Account,
  AccountType,
  AmortizationRow,
  CalendarEvent,
  ContractMonthlyCalculation,
  CreditFacility,
  CurrencyCode,
  EmploymentContract,
  Entity,
  ExpenseReimbursement,
  FiscalRegion,
  ForecastItem,
  ForecastMonthRow,
  ForecastScenario,
  IrcSummary,
  IrsSummary,
  IvaSummary,
  LedgerTransaction,
  ParsedStatementDraft,
  PayslipRecord,
  PersonalIncome,
  PersonalIncomeCategory,
  RecurringExpense,
  StatementLine,
  TaxSetting,
} from '../types/finance';

export function formatMoney(
  amount: number,
  currencyCode: CurrencyCode = 'EUR',
  compact = false
): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      notation: compact && Math.abs(safe) >= 100000 ? 'compact' : 'standard',
      minimumFractionDigits: compact && Math.abs(safe) >= 100000 ? 1 : 2,
      maximumFractionDigits: compact && Math.abs(safe) >= 100000 ? 1 : 2,
    }).format(safe);
  } catch {
    return `€${safe.toFixed(2)}`;
  }
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export function addMonths(monthKey: string, delta: number): string {
  const [yStr, mStr] = monthKey.split('-');
  const y = Number(yStr);
  const m = Number(mStr) - 1;
  const d = new Date(Date.UTC(y, m + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatMonthLabel(monthKey: string): string {
  const [yStr, mStr] = monthKey.split('-');
  const d = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, 1));
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function clampString(value: string, maxLen: number): string {
  return value.trim().slice(0, maxLen);
}

export function getIvaRatesForRegion(region: FiscalRegion): number[] {
  if (region === 'madeira') return [22, 12, 4, 0];
  if (region === 'acores') return [16, 9, 4, 0];
  return [23, 13, 6, 0];
}

export const PERSONAL_INCOME_CATEGORY_LABELS: Record<PersonalIncomeCategory, string> = {
  cat_a_dependent: 'Cat. A · Dependent Employment',
  cat_b_independent: 'Cat. B · Freelance / Recibos Verdes',
  cat_e_capital: 'Cat. E · Capital & Dividends',
  cat_f_rental: 'Cat. F · Rental Income',
  other: 'Other Taxable Income',
};

export const PT_MEAL_EXEMPT_CARD = 10.46;
export const PT_MEAL_EXEMPT_CASH = 6.15;

export function isVoucherAccountType(accountType: AccountType): boolean {
  return accountType === 'meal_voucher' || accountType === 'child_voucher';
}

export function getVoucherCategoryKind(
  categoryOrText: string
): 'meal_voucher' | 'child_voucher' | null {
  const lower = categoryOrText.toLowerCase();
  if (
    /school|child|creche|infant|kinderg|tuition|educa|escola|col[eé]g|inf[aâ]ncia|ensino|daycare|nursery|ber[cç][aá]rio/.test(
      lower
    )
  ) {
    return 'child_voucher';
  }
  if (
    /meal|grocer|supermerc|food|restaur|dining|alimenta|refei|continente|pingo\s*doce|auchan|lidl|mercadona|edenred|coverflex|lunch|dinner/.test(
      lower
    )
  ) {
    return 'meal_voucher';
  }
  return null;
}

const PT_FIXED_HOLIDAYS = new Set([
  '01-01', // Ano Novo
  '04-25', // Dia da Liberdade
  '05-01', // Dia do Trabalhador
  '06-10', // Dia de Portugal
  '08-15', // Assunção de Nossa Senhora
  '10-05', // Implantação da República
  '11-01', // Todos os Santos
  '12-01', // Restauração da Independência
  '12-08', // Imaculada Conceição
  '12-25', // Natal
]);

function getEasterUtcDate(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysUtcIso(base: Date, days: number): string {
  const dt = new Date(base.getTime() + days * 86400000);
  return dt.toISOString().slice(0, 10);
}

export function isPortugueseHoliday(isoDate: string): boolean {
  if (PT_FIXED_HOLIDAYS.has(isoDate.slice(5, 10))) return true;
  const year = Number(isoDate.slice(0, 4));
  if (!Number.isFinite(year)) return false;
  const easter = getEasterUtcDate(year);
  const goodFriday = addDaysUtcIso(easter, -2);
  const corpusChristi = addDaysUtcIso(easter, 60);
  return isoDate === goodFriday || isoDate === corpusChristi;
}

export function isWorkableDay(isoDate: string): boolean {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isPortugueseHoliday(isoDate);
}

export function getWorkingDaysInMonth(monthKey: string): number {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${monthKey}-${String(d).padStart(2, '0')}`;
    if (isWorkableDay(iso)) count += 1;
  }
  return count;
}

export function getLastWorkableDayOfMonth(monthKey: string): string {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = daysInMonth; d >= 1; d--) {
    const iso = `${monthKey}-${String(d).padStart(2, '0')}`;
    if (isWorkableDay(iso)) return iso;
  }
  return `${monthKey}-${String(daysInMonth).padStart(2, '0')}`;
}

export function getNextMonthTaxDueDate(monthKey: string, dueDay = 20): string {
  const nextMonth = addMonths(monthKey, 1);
  return `${nextMonth}-${String(dueDay).padStart(2, '0')}`;
}

export function computeContractMonthlyBreakdown(
  contract: EmploymentContract,
  monthKey: string
): ContractMonthlyCalculation {
  const [yStr, mStr] = monthKey.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const periodStart = `${monthKey}-01`;
  const periodEnd = `${monthKey}-${String(daysInMonth).padStart(2, '0')}`;
  const payDate = getLastWorkableDayOfMonth(monthKey);
  const taxDueDate = getNextMonthTaxDueDate(monthKey, 20);
  const workDays = getWorkingDaysInMonth(monthKey);

  const baseSalary = Math.max(0, contract.baseGrossMonthly);
  // 14-month Portuguese statutory schedule: Subsídio de Férias (Jun) & Subsídio de Natal (Nov)
  const subsidyBonus =
    contract.paySchedule === '14_months' && (month === 6 || month === 11) ? baseSalary : 0;
  const grossSalary = baseSalary + subsidyBonus;

  let mealTotal = 0;
  let mealExempt = 0;
  let mealTaxable = 0;
  if (contract.mealPaymentMethod !== 'none' && contract.mealAllowanceDaily > 0) {
    const dailyLimit =
      contract.mealPaymentMethod === 'card' ? PT_MEAL_EXEMPT_CARD : PT_MEAL_EXEMPT_CASH;
    const exemptDaily = Math.min(contract.mealAllowanceDaily, dailyLimit);
    const taxableDaily = Math.max(0, contract.mealAllowanceDaily - dailyLimit);
    mealTotal = Number((contract.mealAllowanceDaily * workDays).toFixed(2));
    mealExempt = Number((exemptDaily * workDays).toFixed(2));
    mealTaxable = Number((taxableDaily * workDays).toFixed(2));
  }

  const childTotal = Math.max(0, contract.childVoucherMonthly);
  const childTaxableIrs = contract.childVoucherSubjectToIrs ? childTotal : 0;
  const childTaxableSs = contract.childVoucherSubjectToSs ? childTotal : 0;

  const otherTotal = Math.max(0, contract.otherBenefitMonthly);
  const otherTaxableIrs = contract.otherBenefitSubjectToIrs ? otherTotal : 0;
  const otherTaxableSs = contract.otherBenefitSubjectToSs ? otherTotal : 0;

  const totalBenefits = Number((mealTotal + childTotal + otherTotal).toFixed(2));
  const irsTaxableBase = Number(
    (grossSalary + mealTaxable + childTaxableIrs + otherTaxableIrs).toFixed(2)
  );
  const ssTaxableBase = Number(
    (grossSalary + mealTaxable + childTaxableSs + otherTaxableSs).toFixed(2)
  );

  const employeeIrs = Number((irsTaxableBase * (contract.irsRate / 100)).toFixed(2));
  const employeeSs = Number((ssTaxableBase * (contract.employeeSsRate / 100)).toFixed(2));
  const employeeWithholdings = Number((employeeIrs + employeeSs).toFixed(2));
  const employerSs = Number((ssTaxableBase * (contract.employerSsRate / 100)).toFixed(2));

  const netCashSalary = Number(Math.max(0, grossSalary - employeeWithholdings).toFixed(2));
  const netDisbursement = Number((netCashSalary + totalBenefits).toFixed(2));
  const grossTotal = Number((grossSalary + totalBenefits).toFixed(2));
  const totalTaxRemittance = Number((employeeWithholdings + employerSs).toFixed(2));
  const totalEmployerCost = Number((netDisbursement + totalTaxRemittance).toFixed(2));

  return {
    monthKey,
    workDays,
    periodStart,
    periodEnd,
    payDate,
    taxDueDate,
    baseSalary,
    subsidyBonus,
    grossSalary,
    mealTotal,
    mealExempt,
    mealTaxable,
    childTotal,
    otherTotal,
    totalBenefits,
    irsTaxableBase,
    ssTaxableBase,
    employeeIrs,
    employeeSs,
    employeeWithholdings,
    employerSs,
    netCashSalary,
    netDisbursement,
    grossTotal,
    totalTaxRemittance,
    totalEmployerCost,
  };
}

export function computeContractAnnualTotals(
  contract: EmploymentContract,
  year = Number(currentMonthKey().slice(0, 4))
) {
  let annualGross = 0;
  let annualIrsTaxable = 0;
  let annualIrsWithheld = 0;
  let annualEmployeeSs = 0;
  let annualEmployerSs = 0;
  let annualNetCash = 0;
  let annualCashToBank = 0;
  let annualMealCard = 0;
  let annualChildVoucher = 0;
  let annualTotalCost = 0;

  for (let m = 1; m <= 12; m++) {
    const mKey = `${year}-${String(m).padStart(2, '0')}`;
    const b = computeContractMonthlyBreakdown(contract, mKey);
    annualGross += b.grossTotal;
    annualIrsTaxable += b.irsTaxableBase;
    annualIrsWithheld += b.employeeIrs;
    annualEmployeeSs += b.employeeSs;
    annualEmployerSs += b.employerSs;
    annualNetCash += b.netDisbursement;
    const mealCardThisMonth = contract.mealPaymentMethod === 'card' ? b.mealTotal : 0;
    const childThisMonth = b.childTotal;
    annualMealCard += mealCardThisMonth;
    annualChildVoucher += childThisMonth;
    annualCashToBank += Math.max(0, b.netDisbursement - mealCardThisMonth - childThisMonth);
    annualTotalCost += b.totalEmployerCost;
  }

  return {
    annualGross,
    annualIrsTaxable,
    annualIrsWithheld,
    annualEmployeeSs,
    annualEmployerSs,
    annualNetCash,
    annualCashToBank,
    annualMealCard,
    annualChildVoucher,
    annualTotalCost,
  };
}

export function getAnnualGrossForPersonalIncome(item: PersonalIncome): number {
  if (!item.active) return 0;
  if (item.frequency === 'monthly') return item.grossAmount * 12;
  if (item.frequency === '14_months') return item.grossAmount * 14;
  return item.grossAmount;
}

export function getMonthlyNetCashForPersonalIncome(item: PersonalIncome): number {
  if (!item.active) return 0;
  const annualGross = getAnnualGrossForPersonalIncome(item);
  const withheldPct = (item.irsWithheldRate + item.ssRate) / 100;
  const annualNet = Math.max(0, annualGross * (1 - withheldPct));
  return annualNet / 12;
}

export function buildAmortizationSchedule(
  facility: CreditFacility,
  months = 12
): AmortizationRow[] {
  const rows: AmortizationRow[] = [];
  let balance = Math.max(0, facility.currentBalance);
  const monthlyRate = Math.max(0, facility.apr) / 100 / 12;
  const baseMonth = currentMonthKey();

  for (let i = 0; i < months; i++) {
    if (balance <= 0.01) {
      rows.push({
        monthIndex: i + 1,
        monthLabel: formatMonthLabel(addMonths(baseMonth, i)),
        beginningBalance: 0,
        payment: 0,
        principalPaid: 0,
        interestPaid: 0,
        endingBalance: 0,
      });
      continue;
    }

    const interest = balance * monthlyRate;
    const targetPay =
      facility.monthlyPayment > 0
        ? facility.monthlyPayment
        : Math.max(25, balance * 0.03 + interest);
    const actualPayment = Math.min(balance + interest, targetPay);
    const principal = Math.max(0, actualPayment - interest);
    const ending = Math.max(0, balance - principal);

    rows.push({
      monthIndex: i + 1,
      monthLabel: formatMonthLabel(addMonths(baseMonth, i)),
      beginningBalance: balance,
      payment: actualPayment,
      principalPaid: principal,
      interestPaid: interest,
      endingBalance: ending,
    });

    balance = ending;
  }

  return rows;
}

export function computeSubscriptionMonthlyEquivalent(exp: RecurringExpense): number {
  if (!exp.active) return 0;
  return exp.frequency === 'annual' ? exp.amount / 12 : exp.amount;
}

export interface ReimbursementPairSummary {
  owedByEntityId: string;
  owedByName: string;
  owedToEntityId: string;
  owedToName: string;
  openCount: number;
  totalOwed: number;
  deductibleIvaTotal: number;
  claimIds: string[];
}

export function computeReimbursementPairs(
  reimbursements: ExpenseReimbursement[],
  entities: Entity[]
): ReimbursementPairSummary[] {
  const entMap = new Map(entities.map((e) => [e.id, e.name]));
  const pairMap = new Map<string, ReimbursementPairSummary>();

  for (const r of reimbursements) {
    if (r.status !== 'open') continue;
    const key = `${r.owedByEntityId}__${r.owedToEntityId}`;
    const existing = pairMap.get(key);
    const ivaCredit = r.hasInvoice && r.ivaDeductible ? r.ivaAmount : 0;
    if (existing) {
      existing.openCount += 1;
      existing.totalOwed += r.amount;
      existing.deductibleIvaTotal += ivaCredit;
      existing.claimIds.push(r.id);
    } else {
      pairMap.set(key, {
        owedByEntityId: r.owedByEntityId,
        owedByName: entMap.get(r.owedByEntityId) ?? 'Entity',
        owedToEntityId: r.owedToEntityId,
        owedToName: entMap.get(r.owedToEntityId) ?? 'Entity',
        openCount: 1,
        totalOwed: r.amount,
        deductibleIvaTotal: ivaCredit,
        claimIds: [r.id],
      });
    }
  }

  return Array.from(pairMap.values()).sort((a, b) => b.totalOwed - a.totalOwed);
}

export function build12MonthForecast(params: {
  accounts: Account[];
  creditFacilities: CreditFacility[];
  payslips: PayslipRecord[];
  forecastItems: ForecastItem[];
  personalIncomes?: PersonalIncome[];
  employmentContracts?: EmploymentContract[];
  recurringExpenses?: RecurringExpense[];
  includeOwnerContractInflows?: boolean;
  scenario: ForecastScenario;
  startMonth?: string;
}): ForecastMonthRow[] {
  const {
    accounts,
    creditFacilities,
    payslips,
    forecastItems,
    personalIncomes = [],
    employmentContracts = [],
    recurringExpenses = [],
    includeOwnerContractInflows = true,
    scenario,
  } = params;
  const startMonth = params.startMonth || currentMonthKey();

  const scenarioInflowMult =
    scenario === 'conservative' ? 0.85 : scenario === 'growth' ? 1.18 : 1.0;
  const scenarioOutflowMult =
    scenario === 'conservative' ? 1.1 : scenario === 'growth' ? 1.04 : 1.0;

  const scopedEntityIds = new Set(accounts.map((a) => a.entityId));

  const latestByEmployee = new Map<string, PayslipRecord>();
  for (const p of payslips) {
    if (p.contractId) continue; // Contract-backed payroll is calculated directly per month below
    const key = `${p.entityId}::${p.employeeName.toLowerCase()}`;
    const existing = latestByEmployee.get(key);
    if (!existing || p.payDate > existing.payDate) {
      latestByEmployee.set(key, p);
    }
  }
  const adhocPayrollRunRate = Array.from(latestByEmployee.values()).reduce(
    (sum, p) => sum + p.totalCost,
    0
  );

  const monthlyPersonalNetJobs = personalIncomes
    .filter((inc) => inc.active && inc.frequency !== 'one_off')
    .reduce((sum, inc) => sum + getMonthlyNetCashForPersonalIncome(inc), 0);

  const ownerContracts = includeOwnerContractInflows
    ? employmentContracts.filter(
        (c) =>
          c.active &&
          c.isOwnerIncome &&
          (scopedEntityIds.size === 0 ||
            !c.personalEntityId ||
            scopedEntityIds.has(c.personalEntityId))
      )
    : [];

  const scopedCompanyContracts = employmentContracts.filter(
    (c) => c.active && (scopedEntityIds.size === 0 || scopedEntityIds.has(c.entityId))
  );

  const facilitySchedules = creditFacilities
    .filter((f) => f.status === 'active' && f.currentBalance > 0)
    .map((f) => buildAmortizationSchedule(f, 12));

  const accountTypeMap = new Map(accounts.map((a) => [a.id, a.accountType]));
  let runningLiquidCash = accounts
    .filter((a) => !isVoucherAccountType(a.accountType))
    .reduce((sum, a) => sum + a.balance, 0);
  let runningMealVoucher = accounts
    .filter((a) => a.accountType === 'meal_voucher')
    .reduce((sum, a) => sum + a.balance, 0);
  let runningChildVoucher = accounts
    .filter((a) => a.accountType === 'child_voucher')
    .reduce((sum, a) => sum + a.balance, 0);

  const rows: ForecastMonthRow[] = [];

  for (let i = 0; i < 12; i++) {
    const monthKey = addMonths(startMonth, i);
    const startingCash = runningLiquidCash + runningMealVoucher + runningChildVoucher;

    let ownerCashInflow = 0;
    let ownerMealInflow = 0;
    let ownerChildInflow = 0;
    for (const c of ownerContracts) {
      const brk = computeContractMonthlyBreakdown(c, monthKey);
      const mealCardAmt = c.mealPaymentMethod === 'card' ? brk.mealTotal : 0;
      const childAmt = brk.childTotal;
      ownerMealInflow += mealCardAmt;
      ownerChildInflow += childAmt;
      ownerCashInflow += Math.max(0, brk.netDisbursement - mealCardAmt - childAmt);
    }

    const scaledCashInflow = (monthlyPersonalNetJobs + ownerCashInflow) * scenarioInflowMult;
    const scaledMealInflow = ownerMealInflow * scenarioInflowMult;
    const scaledChildInflow = ownerChildInflow * scenarioInflowMult;

    runningMealVoucher += scaledMealInflow;
    runningChildVoucher += scaledChildInflow;

    let inflows = scaledCashInflow + scaledMealInflow + scaledChildInflow;
    let forecastLiquidInflows = 0;
    let operatingOutflow = 0;
    let mealEligibleOutflow = 0;
    let childEligibleOutflow = 0;

    for (const item of forecastItems) {
      if (!item.active) continue;
      if (monthKey < item.startMonth) continue;
      if (item.endMonth && monthKey > item.endMonth) continue;

      const growthFactor = Math.pow(1 + item.annualGrowthRate / 100 / 12, i);
      const val = item.monthlyAmount * growthFactor;
      if (item.direction === 'inflow') {
        const adj = val * scenarioInflowMult;
        inflows += adj;
        forecastLiquidInflows += adj;
      } else {
        const adj = val * scenarioOutflowMult;
        operatingOutflow += adj;
        const kind = getVoucherCategoryKind(`${item.name} ${item.category}`);
        if (kind === 'meal_voucher') mealEligibleOutflow += adj;
        else if (kind === 'child_voucher') childEligibleOutflow += adj;
      }
    }

    const monthNum = Number(monthKey.slice(5, 7));
    for (const exp of recurringExpenses) {
      if (!exp.active) continue;
      const inScope =
        scopedEntityIds.size === 0 ||
        scopedEntityIds.has(exp.entityId) ||
        (!exp.requiresReimbursement && scopedEntityIds.has(exp.paidByEntityId));
      if (!inScope) continue;
      const occurs =
        exp.frequency === 'monthly' ||
        (exp.frequency === 'annual' && exp.billingMonth === monthNum);
      if (!occurs) continue;

      const adj = exp.amount * scenarioOutflowMult;
      operatingOutflow += adj;
      const accType = accountTypeMap.get(exp.paidByAccountId);
      const kind =
        accType === 'meal_voucher' || accType === 'child_voucher'
          ? accType
          : getVoucherCategoryKind(`${exp.name} ${exp.category}`);
      if (kind === 'meal_voucher') mealEligibleOutflow += adj;
      else if (kind === 'child_voucher') childEligibleOutflow += adj;
    }

    // Voucher-first waterfall: spend Meal Card on food/groceries first, Child Voucher on school first, overflow to liquid cash
    const mealCovered = Math.min(runningMealVoucher, mealEligibleOutflow);
    runningMealVoucher = Math.max(0, runningMealVoucher - mealCovered);

    const childCovered = Math.min(runningChildVoucher, childEligibleOutflow);
    runningChildVoucher = Math.max(0, runningChildVoucher - childCovered);

    const voucherCoveredOutflow = mealCovered + childCovered;

    // Payroll outflow: scheduled payslips in monthKey + active contracts not yet generated for monthKey
    let payrollOutflow = 0;
    const generatedContractIdsThisMonth = new Set<string>();
    const monthPayslips = payslips.filter(
      (p) => p.payDate.slice(0, 7) === monthKey || p.taxDueDate.slice(0, 7) === monthKey
    );

    for (const p of payslips) {
      if (p.payDate.slice(0, 7) === monthKey) {
        if (p.contractId) generatedContractIdsThisMonth.add(p.contractId);
        if (p.payStatus === 'scheduled') payrollOutflow += p.netPay;
      }
      if (p.taxDueDate.slice(0, 7) === monthKey && p.taxStatus === 'scheduled') {
        payrollOutflow += p.employeeWithholdings + p.employerTaxes + p.employerContributions;
      }
    }

    if (scopedCompanyContracts.length > 0) {
      for (const c of scopedCompanyContracts) {
        if (!generatedContractIdsThisMonth.has(c.id)) {
          payrollOutflow += computeContractMonthlyBreakdown(c, monthKey).totalEmployerCost;
        }
      }
    } else if (monthPayslips.length === 0 || (payrollOutflow === 0 && i > 0)) {
      payrollOutflow += adhocPayrollRunRate;
    }

    let debtService = 0;
    for (const sched of facilitySchedules) {
      debtService += sched[i]?.payment ?? 0;
    }

    const liquidOutflow = payrollOutflow + debtService + (operatingOutflow - voucherCoveredOutflow);
    runningLiquidCash += scaledCashInflow + forecastLiquidInflows - liquidOutflow;

    const netCashFlow = inflows - payrollOutflow - debtService - operatingOutflow;
    const endingVoucherBalance = runningMealVoucher + runningChildVoucher;
    const endingCash = runningLiquidCash + endingVoucherBalance;

    rows.push({
      monthKey,
      monthLabel: formatMonthLabel(monthKey),
      startingCash,
      inflows,
      payrollOutflow,
      debtService,
      operatingOutflow,
      netCashFlow,
      endingCash,
      endingLiquidCash: runningLiquidCash,
      endingVoucherBalance,
      voucherCoveredOutflow,
    });
  }

  return rows;
}

export function buildCalendarEvents(params: {
  monthKey: string;
  payslips: PayslipRecord[];
  creditFacilities: CreditFacility[];
  transactions: LedgerTransaction[];
  recurringExpenses?: RecurringExpense[];
  entities: Entity[];
}): CalendarEvent[] {
  const {
    monthKey,
    payslips,
    creditFacilities,
    transactions,
    recurringExpenses = [],
    entities,
  } = params;
  const entityMap = new Map(entities.map((e) => [e.id, e.name]));
  const events: CalendarEvent[] = [];
  const today = todayIsoDate();

  for (const p of payslips) {
    const entityName = entityMap.get(p.entityId) ?? 'Entity';
    if (p.payDate.startsWith(monthKey)) {
      events.push({
        id: `pay-${p.id}`,
        date: p.payDate,
        title: `Net Pay · ${p.employeeName}`,
        subtitle: `Gross ${p.grossPay.toFixed(2)} · Net disbursement`,
        amount: p.netPay,
        kind: 'payslip_net',
        entityId: p.entityId,
        entityName,
        status: p.payStatus === 'paid' ? 'paid' : p.payDate < today ? 'overdue' : 'scheduled',
        sourceId: p.id,
      });
    }
    if (p.taxDueDate.startsWith(monthKey)) {
      const taxTotal = p.employeeWithholdings + p.employerTaxes + p.employerContributions;
      events.push({
        id: `tax-${p.id}`,
        date: p.taxDueDate,
        title: `Payroll Taxes · ${p.employeeName}`,
        subtitle: `Withholdings + Employer Tax & Social`,
        amount: taxTotal,
        kind: 'payslip_tax',
        entityId: p.entityId,
        entityName,
        status: p.taxStatus === 'paid' ? 'paid' : p.taxDueDate < today ? 'overdue' : 'scheduled',
        sourceId: p.id,
      });
    }
  }

  const [yStr, mStr] = monthKey.split('-');
  const daysInMonth = new Date(Date.UTC(Number(yStr), Number(mStr), 0)).getUTCDate();
  const monthNumber = Number(mStr);

  for (const f of creditFacilities) {
    if (f.status !== 'active' || f.currentBalance <= 0) continue;
    const clampedDay = Math.min(Math.max(1, f.dueDay), daysInMonth);
    const dueDate = `${monthKey}-${String(clampedDay).padStart(2, '0')}`;
    const entityName = entityMap.get(f.entityId) ?? 'Entity';
    const paymentDue = Math.min(f.currentBalance, f.monthlyPayment);

    events.push({
      id: `loan-${f.id}-${monthKey}`,
      date: dueDate,
      title: `Installment · ${f.name}`,
      subtitle: `${f.lender} (${f.apr.toFixed(2)}% APR)`,
      amount: paymentDue,
      kind: 'loan_due',
      entityId: f.entityId,
      entityName,
      status: dueDate < today ? 'overdue' : 'scheduled',
      sourceId: f.id,
    });
  }

  for (const exp of recurringExpenses) {
    if (!exp.active) continue;
    if (exp.frequency === 'annual' && exp.billingMonth !== monthNumber) continue;
    const clampedDay = Math.min(Math.max(1, exp.billingDay), daysInMonth);
    const dueDate = `${monthKey}-${String(clampedDay).padStart(2, '0')}`;
    const entityName = entityMap.get(exp.entityId) ?? 'Entity';
    const alreadyPostedThisMonth = Boolean(exp.lastPostedDate && exp.lastPostedDate.startsWith(monthKey));

    events.push({
      id: `sub-${exp.id}-${monthKey}`,
      date: dueDate,
      title: `${exp.frequency === 'annual' ? 'Annual' : 'Sub'} · ${exp.name}`,
      subtitle: `${exp.vendor}${exp.requiresReimbursement ? ' · Reimbursable' : ''}`,
      amount: exp.amount,
      kind: 'subscription_due',
      entityId: exp.entityId,
      entityName,
      status: alreadyPostedThisMonth ? 'paid' : dueDate < today ? 'overdue' : 'scheduled',
      sourceId: exp.id,
    });
  }

  for (const tx of transactions) {
    if (tx.status === 'scheduled' && tx.date.startsWith(monthKey)) {
      events.push({
        id: `tx-${tx.id}`,
        date: tx.date,
        title: tx.description,
        subtitle: tx.category,
        amount: tx.amount,
        kind: 'scheduled_tx',
        entityId: tx.entityId,
        entityName: entityMap.get(tx.entityId) ?? 'Entity',
        status: tx.date < today ? 'overdue' : 'scheduled',
        sourceId: tx.id,
      });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

export function findDeterministicMatches(
  lines: StatementLine[],
  transactions: LedgerTransaction[]
): Array<{ lineId: string; transactionId: string; score: number }> {
  const results: Array<{ lineId: string; transactionId: string; score: number }> = [];
  const usedTxIds = new Set<string>(
    lines
      .filter((l) => l.reconciliationStatus === 'reconciled' && l.matchedTransactionId)
      .map((l) => l.matchedTransactionId)
  );

  for (const line of lines) {
    if (line.reconciliationStatus === 'reconciled') continue;
    let bestTx: LedgerTransaction | null = null;
    let bestScore = 0;

    for (const tx of transactions) {
      if (tx.accountId !== line.accountId) continue;
      if (tx.status === 'reconciled' || usedTxIds.has(tx.id)) continue;

      const isCreditMatch = line.direction === 'credit' && tx.type === 'income';
      const isDebitMatch = line.direction === 'debit' && tx.type !== 'income';
      if (!isCreditMatch && !isDebitMatch) continue;

      const amountDiff = Math.abs(line.amount - tx.amount);
      if (amountDiff > 0.05) continue;

      const lineTime = Date.parse(line.date);
      const txTime = Date.parse(tx.date);
      const daysDiff = Math.abs(lineTime - txTime) / (1000 * 60 * 60 * 24);
      if (daysDiff > 7) continue;

      let score = 0.7;
      if (amountDiff < 0.01) score += 0.15;
      if (daysDiff <= 2) score += 0.1;

      const lWords = line.description
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2);
      const tDesc = tx.description.toLowerCase();
      if (lWords.some((w) => tDesc.includes(w))) {
        score += 0.05;
      }

      if (score > bestScore) {
        bestScore = score;
        bestTx = tx;
      }
    }

    if (bestTx && bestScore >= 0.75) {
      usedTxIds.add(bestTx.id);
      results.push({ lineId: line.id, transactionId: bestTx.id, score: bestScore });
    }
  }

  return results;
}

export async function readUploadPayload(file: File): Promise<{
  filename: string;
  mimeType: string;
  base64Data?: string;
  textContent?: string;
}> {
  const filename = file.name.slice(0, 140);
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const isTextLike =
    file.type.startsWith('text/') ||
    ext === 'csv' ||
    ext === 'tsv' ||
    ext === 'txt' ||
    file.type === 'application/vnd.ms-excel';

  if (isTextLike) {
    const textContent = await file.text();
    return {
      filename,
      mimeType: file.type || 'text/csv',
      textContent,
    };
  }

  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read uploaded file.'));
    reader.readAsDataURL(file);
  });

  return {
    filename,
    mimeType: file.type || (ext === 'pdf' ? 'application/pdf' : 'image/png'),
    base64Data,
  };
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseFlexibleNumber(raw: string): number | null {
  let cleaned = raw.replace(/[€$£\s]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseFlexibleDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{4}\/\d{2}\/\d{2}/.test(s)) return s.slice(0, 10).replace(/\//g, '-');
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

export function parseLocalBankCsv(text: string, filename: string): ParsedStatementDraft {
  const rawLines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (rawLines.length < 2) {
    throw new Error('CSV file must contain a header row and at least one transaction row.');
  }

  let headerIdx = 0;
  let delimiter = ',';
  for (let i = 0; i < Math.min(10, rawLines.length); i++) {
    const line = rawLines[i];
    const semi = (line.match(/;/g) || []).length;
    const comma = (line.match(/,/g) || []).length;
    const tab = (line.match(/\t/g) || []).length;
    const lower = line.toLowerCase();
    if (
      (semi >= 2 || comma >= 2 || tab >= 2) &&
      (lower.includes('data') || lower.includes('date') || lower.includes('descri') || lower.includes('valor') || lower.includes('amount'))
    ) {
      headerIdx = i;
      delimiter = semi >= comma && semi >= tab ? ';' : tab > comma ? '\t' : ',';
      break;
    }
  }

  if (headerIdx === 0) {
    const h = rawLines[0];
    const semi = (h.match(/;/g) || []).length;
    const comma = (h.match(/,/g) || []).length;
    const tab = (h.match(/\t/g) || []).length;
    delimiter = semi >= comma && semi >= tab ? ';' : tab > comma ? '\t' : ',';
  }

  const headers = splitDelimitedLine(rawLines[headerIdx], delimiter).map((h) => h.toLowerCase());
  const findCol = (keywords: string[]) =>
    headers.findIndex((h) => keywords.some((kw) => h.includes(kw)));

  const dateCol = findCol(['data mov', 'data valor', 'date', 'data']);
  const descCol = findCol(['descri', 'descritivo', 'movimento', 'memo', 'detail', 'concept', 'merchant']);
  const amountCol = findCol(['montante', 'valor', 'amount', 'import']);
  const debitCol = findCol(['débito', 'debito', 'debit', 'saída', 'saida']);
  const creditCol = findCol(['crédito', 'credito', 'credit', 'entrada']);
  const balanceCol = findCol(['saldo', 'balance']);

  if (dateCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) {
    throw new Error('Could not detect Date and Amount/Debit/Credit columns locally. Switch to AI Parse for unstructured files.');
  }

  const parsedLines: ParsedStatementDraft['lines'] = [];
  const balances: number[] = [];

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const cols = splitDelimitedLine(rawLines[i], delimiter);
    const isoDate = parseFlexibleDate(cols[dateCol] || '');
    if (!isoDate) continue;

    const desc = (descCol >= 0 ? cols[descCol] : cols.find((c, idx) => idx !== dateCol && c.length > 2)) || 'Bank Movement';
    let amount = 0;
    let direction: 'credit' | 'debit' = 'debit';

    if (debitCol >= 0 || creditCol >= 0) {
      const debVal = debitCol >= 0 ? parseFlexibleNumber(cols[debitCol] || '') : null;
      const credVal = creditCol >= 0 ? parseFlexibleNumber(cols[creditCol] || '') : null;
      if (credVal !== null && Math.abs(credVal) > 0) {
        amount = Math.abs(credVal);
        direction = 'credit';
      } else if (debVal !== null && Math.abs(debVal) > 0) {
        amount = Math.abs(debVal);
        direction = 'debit';
      } else if (amountCol >= 0) {
        const val = parseFlexibleNumber(cols[amountCol] || '');
        if (val === null || val === 0) continue;
        amount = Math.abs(val);
        direction = val >= 0 ? 'credit' : 'debit';
      } else {
        continue;
      }
    } else if (amountCol >= 0) {
      const val = parseFlexibleNumber(cols[amountCol] || '');
      if (val === null || val === 0) continue;
      amount = Math.abs(val);
      direction = val >= 0 ? 'credit' : 'debit';
    }

    if (balanceCol >= 0) {
      const bal = parseFlexibleNumber(cols[balanceCol] || '');
      if (bal !== null) balances.push(bal);
    }

    parsedLines.push({
      date: isoDate,
      description: desc.slice(0, 180),
      amount: Number(amount.toFixed(2)),
      direction,
    });
  }

  if (parsedLines.length === 0) {
    throw new Error('No valid bank transactions found in CSV rows.');
  }

  const sortedDates = parsedLines.map((l) => l.date).sort();
  return {
    filename,
    statementPeriod: `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`,
    openingBalance: balances.length > 0 ? balances[0] : 0,
    closingBalance: balances.length > 0 ? balances[balances.length - 1] : 0,
    lines: parsedLines,
  };
}

export function findMatchingStatementLines(
  invoice: { date: string; amount: number; vendor: string; entityId?: string },
  lines: StatementLine[]
): Array<{ line: StatementLine; score: number }> {
  const vendorWords = invoice.vendor
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const invTime = Date.parse(invoice.date);

  const scored: Array<{ line: StatementLine; score: number }> = [];
  for (const l of lines) {
    if (invoice.entityId && l.entityId !== invoice.entityId) continue;
    const diffAmt = Math.abs(l.amount - invoice.amount);
    if (diffAmt > Math.max(0.5, invoice.amount * 0.02)) continue;
    const lineTime = Date.parse(l.date);
    const days = Number.isFinite(invTime) && Number.isFinite(lineTime)
      ? Math.abs(invTime - lineTime) / 86400000
      : 99;
    if (days > 45) continue;

    let score = 0.5;
    if (diffAmt < 0.02) score += 0.25;
    if (days <= 7) score += 0.15;
    else if (days <= 15) score += 0.08;
    const lowerDesc = l.description.toLowerCase();
    if (vendorWords.some((w) => lowerDesc.includes(w))) score += 0.1;

    scored.push({ line: l, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}

// -----------------------------------------------------------------------------
// Portuguese Tax Engines: IVA, IRC, IRS (2026 Rules)
// -----------------------------------------------------------------------------

export function computeTransactionIva(
  grossAmount: number,
  ivaRate: number
): number {
  if (!ivaRate || ivaRate <= 0 || grossAmount <= 0) return 0;
  return Number((grossAmount - grossAmount / (1 + ivaRate / 100)).toFixed(2));
}

export function computeEntityIvaSummary(params: {
  entity: Entity;
  transactions: LedgerTransaction[];
  reimbursements?: ExpenseReimbursement[];
  taxSetting?: TaxSetting;
  monthPrefix?: string; // e.g. '2026-11' or '' for all
}): IvaSummary {
  const { entity, transactions, reimbursements = [], taxSetting, monthPrefix } = params;
  const periodicity = taxSetting?.ivaPeriodicity ?? 'quarterly';

  let salesGross = 0;
  let salesBaseNet = 0;
  let ivaLiquidado = 0;
  let purchasesGross = 0;
  let ivaDedutivel = 0;

  const rateMap = new Map<number, { liquidado: number; dedutivel: number }>();
  const entityTxIds = new Set<string>();

  for (const tx of transactions) {
    if (tx.entityId !== entity.id) continue;
    entityTxIds.add(tx.id);
    if (monthPrefix && !tx.date.startsWith(monthPrefix)) continue;

    const rate = tx.ivaRate ?? 0;
    const ivaAmt =
      typeof tx.ivaAmount === 'number'
        ? tx.ivaAmount
        : computeTransactionIva(tx.amount, rate);

    if (tx.type === 'income') {
      salesGross += tx.amount;
      salesBaseNet += Math.max(0, tx.amount - ivaAmt);
      if (periodicity !== 'exempt') {
        ivaLiquidado += ivaAmt;
        const entry = rateMap.get(rate) ?? { liquidado: 0, dedutivel: 0 };
        entry.liquidado += ivaAmt;
        rateMap.set(rate, entry);
      }
    } else if (tx.type === 'expense') {
      purchasesGross += tx.amount;
      if (periodicity !== 'exempt' && tx.ivaDeductible !== false && ivaAmt > 0) {
        ivaDedutivel += ivaAmt;
        const entry = rateMap.get(rate) ?? { liquidado: 0, dedutivel: 0 };
        entry.dedutivel += ivaAmt;
        rateMap.set(rate, entry);
      }
    }
  }

  // Include invoiced company expenses paid out-of-pocket from another entity (e.g. personal account)
  for (const r of reimbursements) {
    if (r.owedByEntityId !== entity.id || !r.hasInvoice) continue;
    if (r.transactionId && entityTxIds.has(r.transactionId)) continue;
    if (monthPrefix && !r.date.startsWith(monthPrefix)) continue;

    const rate = r.ivaRate ?? 0;
    const ivaAmt =
      typeof r.ivaAmount === 'number' ? r.ivaAmount : computeTransactionIva(r.amount, rate);
    purchasesGross += r.amount;
    if (periodicity !== 'exempt' && r.ivaDeductible && ivaAmt > 0) {
      ivaDedutivel += ivaAmt;
      const entry = rateMap.get(rate) ?? { liquidado: 0, dedutivel: 0 };
      entry.dedutivel += ivaAmt;
      rateMap.set(rate, entry);
    }
  }

  const breakdownByRate = Array.from(rateMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([rate, vals]) => ({ rate, ...vals }));

  return {
    entityId: entity.id,
    entityName: entity.name,
    periodicity,
    salesGross,
    salesBaseNet,
    ivaLiquidado,
    purchasesGross,
    ivaDedutivel,
    netIvaPayable: ivaLiquidado - ivaDedutivel,
    breakdownByRate,
  };
}

export function computeEntityIrcSummary(params: {
  entity: Entity;
  transactions: LedgerTransaction[];
  payslips: PayslipRecord[];
  creditFacilities: CreditFacility[];
  forecastItems: ForecastItem[];
  employmentContracts?: EmploymentContract[];
  recurringExpenses?: RecurringExpense[];
  reimbursements?: ExpenseReimbursement[];
  taxSetting?: TaxSetting;
  mode: 'actual' | 'annualized';
}): IrcSummary {
  const {
    entity,
    transactions,
    payslips,
    creditFacilities,
    forecastItems,
    employmentContracts = [],
    recurringExpenses = [],
    reimbursements = [],
    taxSetting,
    mode,
  } = params;

  const isPme = taxSetting?.isPme ?? true;
  const region = taxSetting?.region ?? 'continente';
  const derramaRate = taxSetting?.derramaRate ?? 0;
  const paymentsOnAccount = taxSetting?.ircPaymentsOnAccount ?? 0;

  let revenueNetIva = 0;
  let operatingExpensesNetIva = 0;
  let payrollEmployerCost = 0;
  let loanInterestEstimate = 0;

  if (mode === 'actual') {
    const entityTxIds = new Set<string>();
    for (const tx of transactions) {
      if (tx.entityId !== entity.id) continue;
      entityTxIds.add(tx.id);
      const ivaAmt =
        typeof tx.ivaAmount === 'number'
          ? tx.ivaAmount
          : computeTransactionIva(tx.amount, tx.ivaRate ?? 0);
      if (tx.type === 'income') {
        revenueNetIva += Math.max(0, tx.amount - ivaAmt);
      } else if (tx.type === 'expense') {
        operatingExpensesNetIva += Math.max(0, tx.amount - (tx.ivaDeductible !== false ? ivaAmt : 0));
      }
    }
    for (const r of reimbursements) {
      if (r.owedByEntityId !== entity.id || !r.hasInvoice) continue;
      if (r.transactionId && entityTxIds.has(r.transactionId)) continue;
      const ivaAmt =
        typeof r.ivaAmount === 'number'
          ? r.ivaAmount
          : computeTransactionIva(r.amount, r.ivaRate ?? 0);
      operatingExpensesNetIva += Math.max(0, r.amount - (r.ivaDeductible ? ivaAmt : 0));
    }
    for (const p of payslips) {
      if (p.entityId !== entity.id) continue;
      payrollEmployerCost += p.totalCost;
    }
    for (const f of creditFacilities) {
      if (f.entityId !== entity.id || f.status !== 'active') continue;
      const sched = buildAmortizationSchedule(f, 12);
      loanInterestEstimate += sched[0]?.interestPaid ?? 0;
    }
  } else {
    for (const item of forecastItems) {
      if (item.entityId !== entity.id || !item.active) continue;
      if (item.direction === 'inflow') {
        revenueNetIva += item.monthlyAmount * 12;
      } else {
        operatingExpensesNetIva += item.monthlyAmount * 12;
      }
    }
    for (const exp of recurringExpenses) {
      if (exp.entityId !== entity.id || !exp.active) continue;
      const ivaAmt = exp.ivaDeductible ? computeTransactionIva(exp.amount, exp.ivaRate) : 0;
      const netCycle = Math.max(0, exp.amount - ivaAmt);
      operatingExpensesNetIva += exp.frequency === 'monthly' ? netCycle * 12 : netCycle;
    }
    const entityContracts = employmentContracts.filter((c) => c.entityId === entity.id && c.active);
    if (entityContracts.length > 0) {
      payrollEmployerCost = entityContracts.reduce(
        (s, c) => s + computeContractAnnualTotals(c).annualTotalCost,
        0
      );
    } else {
      const latestByEmp = new Map<string, PayslipRecord>();
      for (const p of payslips) {
        if (p.entityId !== entity.id) continue;
        const key = p.employeeName.toLowerCase();
        const ex = latestByEmp.get(key);
        if (!ex || p.payDate > ex.payDate) latestByEmp.set(key, p);
      }
      payrollEmployerCost = Array.from(latestByEmp.values()).reduce(
        (s, p) => s + p.totalCost * 12,
        0
      );
    }
    for (const f of creditFacilities) {
      if (f.entityId !== entity.id || f.status !== 'active') continue;
      const sched = buildAmortizationSchedule(f, 12);
      loanInterestEstimate += sched.reduce((s, r) => s + r.interestPaid, 0);
    }
  }

  const taxableProfit = Math.max(
    0,
    revenueNetIva - operatingExpensesNetIva - payrollEmployerCost - loanInterestEstimate
  );

  // Portugal 2026 IRC rates: Continente 15% PME first 50k / 19% standard (Madeira & Açores reduced)
  const lowRate = region === 'continente' ? 0.15 : 0.119;
  const standardRate = region === 'continente' ? 0.19 : 0.147;

  let ircLowBracketTax = 0;
  let ircStandardBracketTax = 0;

  if (isPme) {
    const lowSlice = Math.min(50000, taxableProfit);
    const highSlice = Math.max(0, taxableProfit - 50000);
    ircLowBracketTax = lowSlice * lowRate;
    ircStandardBracketTax = highSlice * standardRate;
  } else {
    ircStandardBracketTax = taxableProfit * standardRate;
  }

  const derramaTax = taxableProfit * (derramaRate / 100);
  const totalIrcLiability = ircLowBracketTax + ircStandardBracketTax + derramaTax;
  const netIrcDue = totalIrcLiability - paymentsOnAccount;
  const effectiveRatePct = taxableProfit > 0 ? (totalIrcLiability / taxableProfit) * 100 : 0;

  return {
    entityId: entity.id,
    entityName: entity.name,
    isPme,
    revenueNetIva,
    operatingExpensesNetIva,
    payrollEmployerCost,
    loanInterestEstimate,
    taxableProfit,
    ircLowBracketTax,
    ircStandardBracketTax,
    derramaTax,
    totalIrcLiability,
    paymentsOnAccount,
    netIrcDue,
    effectiveRatePct,
  };
}

// Portugal 2026 IRS Continente 9 Brackets
const IRS_BRACKETS_2026: Array<{
  limit: number;
  rate: number;
  abater: number;
  label: string;
}> = [
  { limit: 8342, rate: 0.125, abater: 0, label: '1.º Escalão (12.50%)' },
  { limit: 12587, rate: 0.157, abater: 266.94, label: '2.º Escalão (15.70%)' },
  { limit: 17838, rate: 0.212, abater: 959.26, label: '3.º Escalão (21.20%)' },
  { limit: 23089, rate: 0.241, abater: 1476.45, label: '4.º Escalão (24.10%)' },
  { limit: 29397, rate: 0.311, abater: 3092.77, label: '5.º Escalão (31.10%)' },
  { limit: 43090, rate: 0.349, abater: 4209.94, label: '6.º Escalão (34.90%)' },
  { limit: 46566, rate: 0.431, abater: 7743.27, label: '7.º Escalão (43.10%)' },
  { limit: 86634, rate: 0.446, abater: 8441.48, label: '8.º Escalão (44.60%)' },
  { limit: Infinity, rate: 0.48, abater: 11387.17, label: '9.º Escalão (48.00%)' },
];

export function computePersonalIrsSummary(params: {
  personalIncomes: PersonalIncome[];
  employmentContracts?: EmploymentContract[];
  entities?: Entity[];
  personalEntityIds: string[];
  transactions: LedgerTransaction[];
  taxSetting?: TaxSetting;
  includeLedgerPersonalIncome?: boolean;
}): IrsSummary {
  const {
    personalIncomes,
    employmentContracts = [],
    entities = [],
    personalEntityIds,
    transactions,
    taxSetting,
    includeLedgerPersonalIncome = false,
  } = params;

  const region = taxSetting?.region ?? 'continente';
  const marital = taxSetting?.irsMaritalStatus ?? 'single';
  const dependents = taxSetting?.irsDependents ?? 0;
  const generalDeductions = taxSetting?.irsDeductions ?? 0;
  const entityNameMap = new Map(entities.map((e) => [e.id, e.name]));

  let totalGrossIncome = 0;
  let annualSocialSecurity = 0;
  let catAGross = 0;
  let catASs = 0;
  let otherTaxable = 0;
  let totalWithheldAtSource = 0;

  const sourcesBreakdown: IrsSummary['sourcesBreakdown'] = [];

  for (const inc of personalIncomes) {
    if (!inc.active || !inc.countsTowardsIrs) continue;
    const annualGross = getAnnualGrossForPersonalIncome(inc);
    const annualWithheld = annualGross * (inc.irsWithheldRate / 100);
    const annualSs = annualGross * (inc.ssRate / 100);

    totalGrossIncome += annualGross;
    annualSocialSecurity += annualSs;
    totalWithheldAtSource += annualWithheld;

    let annualTaxable = annualGross;
    if (inc.incomeCategory === 'cat_a_dependent') {
      catAGross += annualGross;
      catASs += annualSs;
    } else if (inc.incomeCategory === 'cat_b_independent') {
      annualTaxable = annualGross * 0.75;
      otherTaxable += annualTaxable;
    } else {
      otherTaxable += annualGross;
    }

    sourcesBreakdown.push({
      id: inc.id,
      title: `${inc.title} · ${inc.payerName}`,
      categoryLabel: PERSONAL_INCOME_CATEGORY_LABELS[inc.incomeCategory],
      annualGross,
      annualTaxable,
      annualWithheld,
      annualSs,
      annualNetCash: Math.max(0, annualGross - annualWithheld - annualSs),
    });
  }

  for (const c of employmentContracts) {
    if (!c.active || !c.isOwnerIncome) continue;
    const annual = computeContractAnnualTotals(c);
    totalGrossIncome += annual.annualGross;
    annualSocialSecurity += annual.annualEmployeeSs;
    totalWithheldAtSource += annual.annualIrsWithheld;
    catAGross += annual.annualIrsTaxable;
    catASs += annual.annualEmployeeSs;

    const compName = entityNameMap.get(c.entityId) ?? 'Owned Company';
    sourcesBreakdown.push({
      id: `contract-${c.id}`,
      title: `${c.roleTitle} (${c.workerName}) · ${compName}`,
      categoryLabel: 'Cat. A · Owned Company Contract (w/ Exempt Benefits)',
      annualGross: annual.annualGross,
      annualTaxable: annual.annualIrsTaxable,
      annualWithheld: annual.annualIrsWithheld,
      annualSs: annual.annualEmployeeSs,
      annualNetCash: annual.annualNetCash,
    });
  }

  if (includeLedgerPersonalIncome && personalEntityIds.length > 0) {
    const pSet = new Set(personalEntityIds);
    const ledgerSum = transactions
      .filter((t) => pSet.has(t.entityId) && t.type === 'income')
      .reduce((s, t) => s + t.amount, 0);
    if (ledgerSum > 0) {
      totalGrossIncome += ledgerSum;
      otherTaxable += ledgerSum;
      sourcesBreakdown.push({
        id: 'ledger-personal',
        title: 'Personal Ledger Income Entries',
        categoryLabel: 'Direct Ledger Receipts',
        annualGross: ledgerSum,
        annualTaxable: ledgerSum,
        annualWithheld: 0,
        annualSs: 0,
        annualNetCash: ledgerSum,
      });
    }
  }

  // Dedução específica for Cat A: €4,462.15 or total Cat A SS if higher (capped at Cat A gross)
  const specificDeduction =
    catAGross > 0 ? Math.min(catAGross, Math.max(4462.15, catASs)) : 0;

  const taxableIncome = Math.max(0, catAGross - specificDeduction + otherTaxable);
  const quotientDivisor = marital === 'married_joint' ? 2 : 1;
  const quotientIncome = taxableIncome / quotientDivisor;

  const bracket =
    IRS_BRACKETS_2026.find((b) => quotientIncome <= b.limit) ??
    IRS_BRACKETS_2026[IRS_BRACKETS_2026.length - 1];

  // Regional reduction (Madeira / Açores apply statutory reductions up to ~30%)
  const regionMultiplier = region === 'acores' ? 0.7 : region === 'madeira' ? 0.78 : 1.0;

  const taxPerQuotient = Math.max(0, quotientIncome * bracket.rate - bracket.abater) * regionMultiplier;
  const grossIrsTax = taxPerQuotient * quotientDivisor;
  const dependentCredits = dependents * 600;
  const netIrsLiability = Math.max(0, grossIrsTax - generalDeductions - dependentCredits);
  const estimatedPayableOrRefund = netIrsLiability - totalWithheldAtSource;

  return {
    totalGrossIncome,
    annualSocialSecurity,
    specificDeduction,
    taxableIncome,
    quotientDivisor,
    effectiveBracketRatePct: bracket.rate * 100 * regionMultiplier,
    parcelaAbater: bracket.abater,
    grossIrsTax,
    generalDeductions,
    dependentCredits,
    netIrsLiability,
    totalWithheldAtSource,
    estimatedPayableOrRefund,
    bracketLabel: bracket.label,
    sourcesBreakdown,
  };
}
