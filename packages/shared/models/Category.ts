// packages/shared/models/Category.ts
export type CategoryType = "EXPENSE" | "INCOME" | "LIABILITY" | "EQUITY";
export type OwnerType = "" | "company" | "person";

/**
 * System roles let features auto-find the right category per company/person.
 * Extend as needed, keep "" first for "no role".
 */
export type CategorySystemRole =
  | ""
  | "PAYROLL_GROSS"
  | "PAYROLL_SS_EMPLOYER_EXPENSE"
  | "PAYROLL_IRS_PAYABLE"
  | "PAYROLL_SS_EMPLOYEE_PAYABLE"
  | "PAYROLL_SS_EMPLOYER_PAYABLE"
  | "PAYROLL_NET_PAYABLE"
  | "PAYROLL_MEAL_ALLOWANCE_EXPENSE"
  | "PAYROLL_CHILDCARE_EXPENSE"
  | "PAYROLL_VOUCHER_FEES_EXPENSE"
  | "INCOME_PARTY_BOOKING";

export type CategoryDoc = {
  id: string;
  name: string;
  code: string;
  type: CategoryType;
  ownerType?: OwnerType;
  ownerId?: string;
  parentCode?: string;
  systemRole?: CategorySystemRole;
  createdAt?: any;
};

export const CATEGORY_SYSTEM_ROLE_OPTIONS: Array<{ value: CategorySystemRole; label: string }> = [
  { value: "", label: "— No role —" },
  { value: "PAYROLL_GROSS", label: "Payroll · Gross (Expense)" },
  { value: "PAYROLL_SS_EMPLOYER_EXPENSE", label: "Payroll · SS Employer (Expense)" },
  { value: "PAYROLL_IRS_PAYABLE", label: "Payroll · IRS (Payable)" },
  { value: "PAYROLL_SS_EMPLOYEE_PAYABLE", label: "Payroll · SS Employee (Payable)" },
  { value: "PAYROLL_SS_EMPLOYER_PAYABLE", label: "Payroll · SS Employer (Payable)" },
  { value: "PAYROLL_NET_PAYABLE", label: "Payroll · Net Wages (Payable)" },
  { value: "PAYROLL_MEAL_ALLOWANCE_EXPENSE", label: "Payroll · Meal Allowance (Expense)" },
  { value: "PAYROLL_CHILDCARE_EXPENSE", label: "Payroll · Childcare (Expense)" },
  { value: "PAYROLL_VOUCHER_FEES_EXPENSE", label: "Payroll · Voucher Provider Fees (Expense)" },
  { value: "INCOME_PARTY_BOOKING", label: "Income · Party Booking" },
];