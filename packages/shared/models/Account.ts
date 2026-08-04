export type OwnerType = "company" | "person";
export type AccountType = "bank" | "wallet" | "cash" | "credit" | "voucher" | "bonds";
export type VoucherType = "meal" | "childcare" | "education";

interface BaseAccount {
  id: string;            // doc id
  code: string;          // short, unique per org (e.g. "NS:BPI", "AR:CGD")
  name: string;          // display name
  type: AccountType;
  ownerType?: OwnerType;
  ownerId?: string;
  jointOwnerIds?: string[]; // additional co-owners (e.g. joint bank accounts)
  currency: "EUR";       // fix for now
  createdAt: Date | any;
  balanceCents?: number;   // current real balance — set manually by user
  balanceAsOf?: string;    // ISO date "YYYY-MM-DD" when balance was recorded
}

/** Bank accounts MUST include full banking details */
export interface BankAccount extends BaseAccount {
  type: "bank";
  bankName: string;      // e.g. BPI, CGD
  iban: string;          // canonical uppercase, no spaces
  bic: string;           // SWIFT
  // optional convenience for PT users
  nib?: string;          // 21-digit NIB (PT), if you want to store it
}

export interface WalletAccount extends BaseAccount { type: "wallet"; }
export interface CashAccount   extends BaseAccount { type: "cash"; }
export interface CreditAccount extends BaseAccount {
  type: "credit";
  issuer?: string;       // e.g. "AMEX"
  last4?: string;        // UI nicety
}
export interface VoucherAccount extends BaseAccount {
  type: "voucher";
  voucherType: VoucherType;
  provider?: string;          // e.g. "Edenred", "Coverflex"
  employerName?: string;      // which employer loads this card, e.g. "NoisySource", "Exquisite Talent"
}

export interface BondsAccount extends BaseAccount {
  type: "bonds";
  provider: string;           // e.g. "CTT"
}

export type Account =
  | BankAccount
  | WalletAccount
  | CashAccount
  | CreditAccount
  | VoucherAccount
  | BondsAccount;

export const isCashLike = (t: AccountType) =>
  t === "bank" || t === "wallet" || t === "cash" || t === "credit";