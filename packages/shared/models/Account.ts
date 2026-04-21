export type OwnerType = "company" | "person";
export type AccountType = "bank" | "wallet" | "cash" | "credit" | "virtual";

interface BaseAccount {
  id: string;            // doc id
  code: string;          // short, unique per org (e.g. "NS:BPI", "AR:CGD")
  name: string;          // display name
  type: AccountType;
  ownerType: OwnerType;  // REQUIRED now
  ownerId: string;       // REQUIRED now (FK to orgs/{org}/companies|people/{id})
  currency: "EUR";       // fix for now
  createdAt: Date | any;
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
export interface VirtualAccount extends BaseAccount { type: "virtual"; }

export type Account =
  | BankAccount
  | WalletAccount
  | CashAccount
  | CreditAccount
  | VirtualAccount;

export const isCashLike = (t: AccountType) =>
  t === "bank" || t === "wallet" || t === "cash" || t === "credit";