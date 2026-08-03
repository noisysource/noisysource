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
  VoucherAccount,
  BondsAccount,
  VoucherType,
} from "@shared/models/Account";
import { isCashLike } from "@shared/models/Account";
import { toDate } from "../utils";
import { stripUndefined } from "../crud";


/** ----- Save input (discriminated) ----- */
type BaseSave = {
  id?: string;
  code?: string;
  name: string;
  ownerType?: OwnerType;
  ownerId?: string;
  jointOwnerIds?: string[];
  currency?: "EUR";
  active?: boolean;
  createdAt?: Date;
  balanceCents?: number;
  balanceAsOf?: string;
};

export type BankSave    = BaseSave & { type: "bank";    bankName?: string; iban?: string; bic?: string; nib?: string };
export type WalletSave  = BaseSave & { type: "wallet" };
export type CashSave    = BaseSave & { type: "cash" };
export type CreditSave  = BaseSave & { type: "credit";  issuer?: string; last4?: string };
export type VoucherSave = BaseSave & { type: "voucher"; voucherType: VoucherType; provider?: string; issuingEmployer?: string; monthlyTopUpCents?: number };
export type BondsSave   = BaseSave & { type: "bonds";   provider?: string };

export type AccountSaveInput = BankSave | WalletSave | CashSave | CreditSave | VoucherSave | BondsSave;

/** ----- mappers ----- */
const from = (raw: any, id: string): Account => {
  const createdAt = toDate(raw?.createdAt);
  const base = {
    id,
    code: raw?.code,
    name: raw?.name,
    ownerType: raw?.ownerType,
    ownerId: raw?.ownerId,
    jointOwnerIds: Array.isArray(raw?.jointOwnerIds) ? raw.jointOwnerIds : undefined,
    currency: "EUR" as const,
    createdAt,
    type: raw?.type as AccountType,
    balanceCents: raw?.balanceCents ?? undefined,
    balanceAsOf: raw?.balanceAsOf ?? undefined,
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
    case "voucher":
      return {
        ...base,
        type: "voucher",
        voucherType: raw?.voucherType,
        provider: raw?.provider,
        issuingEmployer: raw?.issuingEmployer,
        monthlyTopUpCents: raw?.monthlyTopUpCents,
      } as VoucherAccount;
    case "bonds":
      return {
        ...base,
        type: "bonds",
        provider: raw?.provider,
      } as BondsAccount;
    default:
      return { ...base, type: "bank", bankName: raw?.bankName ?? "", iban: raw?.iban ?? "", bic: raw?.bic ?? "" } as BankAccount;
  }
};

const to = (input: AccountSaveInput) => {
  const common = {
    code: input.code || undefined,
    name: input.name,
    type: input.type,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    jointOwnerIds: input.jointOwnerIds?.length ? input.jointOwnerIds : undefined,
    currency: input.currency ?? "EUR",
    active: input.active ?? true,
    balanceCents: input.balanceCents ?? undefined,
    balanceAsOf: input.balanceAsOf ?? undefined,
  };

  const payload =
    input.type === "bank"
      ? { ...common, bankName: input.bankName || undefined, iban: input.iban || undefined, bic: input.bic || undefined, nib: input.nib || undefined }
      : input.type === "credit"
      ? { ...common, issuer: input.issuer || undefined, last4: input.last4 || undefined }
      : input.type === "voucher"
      ? { ...common, voucherType: input.voucherType, provider: input.provider || undefined, issuingEmployer: input.issuingEmployer || undefined, monthlyTopUpCents: input.monthlyTopUpCents }
      : input.type === "bonds"
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

    async setBalance(id: string, balanceCents: number, asOf: string): Promise<void> {
      await base.update(id, { balanceCents, balanceAsOf: asOf } as any);
    },
  };
}

export type { Account };