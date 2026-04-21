import { where } from "firebase/firestore";
import { makeOrgCRUD } from "./base";
import type {
  Account,
  AccountType,
  OwnerType,
  BankAccount,
  WalletAccount,
  CashAccount,
  CreditAccount,
  VirtualAccount,
} from "@shared/models/Account";
import { isCashLike } from "@shared/models/Account";
import { toDate } from "../utils";
import { stripUndefined } from "../crud";


/** ----- Save input (discriminated) ----- */
type BaseSave = {
  id?: string;
  code?: string;
  name: string;
  ownerType: OwnerType;
  ownerId: string;
  currency?: "EUR";
  active?: boolean;
  createdAt?: Date; // ignored on update; auto-set on create in base
};

export type BankSave    = BaseSave & { type: "bank";    bankName?: string; iban?: string; bic?: string; nib?: string };
export type WalletSave  = BaseSave & { type: "wallet" };
export type CashSave    = BaseSave & { type: "cash" };
export type CreditSave  = BaseSave & { type: "credit";  issuer?: string; last4?: string };
export type VirtualSave = BaseSave & { type: "virtual"; provider?: string };

export type AccountSaveInput = BankSave | WalletSave | CashSave | CreditSave | VirtualSave;

/** ----- mappers ----- */
const from = (raw: any, id: string): Account => {
  const createdAt = toDate(raw?.createdAt);
  const base = {
    id,
    code: raw?.code,
    name: raw?.name,
    ownerType: raw?.ownerType,
    ownerId: raw?.ownerId,
    currency: "EUR" as const,
    createdAt,
    type: raw?.type as AccountType,
  };

  switch (raw?.type as AccountType) {
    case "bank":
      return {
        ...base,
        type: "bank",
        bankName: raw?.bankName,
        iban: raw?.iban,
        bic: raw?.bic,
        nib: raw?.nib,
      } as BankAccount;
    case "wallet":
      return { ...base, type: "wallet" } as WalletAccount;
    case "cash":
      return { ...base, type: "cash" } as CashAccount;
    case "credit":
      return {
        ...base,
        type: "credit",
        issuer: raw?.issuer,
        last4: raw?.last4,
      } as CreditAccount;
    case "virtual":
    default:
      return {
        ...base,
        type: "virtual",
        provider: raw?.provider,
      } as VirtualAccount;
  }
};

const to = (input: AccountSaveInput) => {
  const common = {
    code: input.code || undefined,
    name: input.name,
    type: input.type,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    currency: input.currency ?? "EUR",
    active: input.active ?? true,
  };

  const payload =
    input.type === "bank"
      ? { ...common, bankName: input.bankName || undefined, iban: input.iban || undefined, bic: input.bic || undefined, nib: input.nib || undefined }
      : input.type === "credit"
      ? { ...common, issuer: input.issuer || undefined, last4: input.last4 || undefined }
      : input.type === "virtual"
      ? { ...common, provider: input.provider || undefined }
      : common;

  return stripUndefined(payload);
};

/** ----- domain factory ----- */
export function makeAccountsDomain(getOrgId: () => string) {
  const base = makeOrgCRUD<AccountSaveInput, Account>(getOrgId, {
    collectionPath: "accounts",
    from,
    to,
    sort: (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id),
  });

  return {
    ...base,

    async listForOwner(ownerType: OwnerType, ownerId: string, types?: AccountType[]): Promise<Account[]> {
      const rows = await base.list([where("ownerType", "==", ownerType), where("ownerId", "==", ownerId)]);
      if (!types?.length) return rows;
      const set = new Set(types);
      return rows.filter(a => set.has(a.type));
    },

    async listCashLike(): Promise<Account[]> {
      const rows = await base.list();
      return rows.filter(a => isCashLike(a.type));
    },
  };
}

export type { Account };