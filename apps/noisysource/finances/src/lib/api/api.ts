// apps/finhub/src/lib/api/index.ts
import {
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  setDoc,
  collection,
  doc as fsDoc,
  query,
  where,
} from "firebase/firestore";
import { makeOrgPaths } from "@shared/lib/orgPaths";

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

import type { EmploymentContractDoc, BenefitConfig } from "@shared/models/Employment";
import { db } from "../firebase";
import { cleanUndefined, cleanUndefinedShallow } from "@shared/lib/clean";

/** ---------- Local simple types for master data ---------- */
export type Company = { id: string; name: string; shortCode?: string };
export type Person = { id: string; name: string };

/** ---------- Account save input (discriminated by `type`) ---------- */
type AccountBaseSave = {
  id?: string;
  code?: string;
  name: string;
  ownerType: OwnerType;
  ownerId: string;
  currency?: "EUR";
  active?: boolean;
};

export type BankSave = AccountBaseSave & { type: "bank"; bankName?: string; iban?: string; bic?: string; nib?: string };
export type WalletSave = AccountBaseSave & { type: "wallet" };
export type CashSave = AccountBaseSave & { type: "cash" };
export type CreditSave = AccountBaseSave & { type: "credit"; issuer?: string; last4?: string };
export type VirtualSave = AccountBaseSave & { type: "virtual"; provider?: string };

export type AccountSaveInput = BankSave | WalletSave | CashSave | CreditSave | VirtualSave;

/** ---------- Helpers ---------- */

// Prefer orgPaths; fall back to raw paths if a helper is missing
const colFallback = {
  categories(orgId: string) { return collection(db, "orgs", orgId, "categories"); },
  templates(orgId: string) { return collection(db, "orgs", orgId, "templates"); },
  planned(orgId: string) { return collection(db, "orgs", orgId, "planned"); }, // adjust if your collection is named differently
};

function colCategories(P: any, orgId: string) {
  return typeof P.colCategories === "function" ? P.colCategories() : colFallback.categories(orgId);
}
function colTemplates(P: any, orgId: string) {
  return typeof P.colTemplates === "function" ? P.colTemplates() : colFallback.templates(orgId);
}
function colPlanned(P: any, orgId: string) {
  return typeof P.colPlanned === "function" ? P.colPlanned() : colFallback.planned(orgId);
}

function isMealLike(t?: string) {
  const k = (t || "").toUpperCase();
  return k === "MEAL" || k === "MEAL_CARD" || k === "MEAL_VOUCHER";
}

const n = (x: any) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);

function normalizeBenefitForSave(b: any) {
  const type = b?.type;
  let perMonthCents = n(b?.perMonthCents);
  let perDayCents = n(b?.perDayCents ?? b?.dailyAmountCents);
  let daysPerMonth = typeof b?.daysPerMonth === "number" ? b.daysPerMonth : undefined;

  const benefitAccountId = b?.benefitAccountId || b?.providerAccountId || "";

  if (isMealLike(type)) {
    // Meal benefits are stored per-day; default to 22 working days.
    if (!perDayCents && perMonthCents) {
      perDayCents = perMonthCents;   // user typed a monthly-looking number in the wrong field
      perMonthCents = 0;
    }
    if (daysPerMonth == null || daysPerMonth <= 0) daysPerMonth = 22;
  } else {
    // Non-meal: prefer monthly. If only per-day was filled *and* days given, lift it to monthly.
    if (!perMonthCents && perDayCents && Number.isFinite(daysPerMonth)) {
      perMonthCents = perDayCents * (daysPerMonth as number);
      perDayCents = 0;
    }
  }

  return cleanUndefinedShallow({
    type,
    perMonthCents: perMonthCents || undefined,
    perDayCents: perDayCents || undefined,
    daysPerMonth,
    subjectToIRS: !!b?.subjectToIRS,
    subjectToSS: !!b?.subjectToSS,
    benefitAccountId,
    expenseCategoryId: b?.expenseCategoryId,
    payableCategoryId: b?.payableCategoryId,
    providerFeePct: typeof b?.providerFeePct === "number" ? b.providerFeePct : undefined,
    providerFeeCents: typeof b?.providerFeeCents === "number" ? b.providerFeeCents : undefined,
  });
}

// Firestore → Account model (light normalization)
function mapAccountDoc(d: any): Account {
  const x = d.data() as any;

  const createdAt =
    x.createdAt?.toDate ? x.createdAt.toDate()
      : typeof x.createdAt === "string" ? new Date(x.createdAt)
        : x.createdAt;

  switch (x.type as AccountType) {
    case "bank":
      return {
        id: d.id,
        code: x.code,
        name: x.name,
        type: "bank",
        ownerType: x.ownerType,
        ownerId: x.ownerId,
        currency: "EUR",
        createdAt,
        bankName: x.bankName,
        iban: x.iban,
        bic: x.bic,
        nib: x.nib,
      } as BankAccount;
    case "wallet":
      return {
        id: d.id, code: x.code, name: x.name, type: "wallet",
        ownerType: x.ownerType, ownerId: x.ownerId, currency: "EUR", createdAt,
      } as WalletAccount;
    case "cash":
      return {
        id: d.id, code: x.code, name: x.name, type: "cash",
        ownerType: x.ownerType, ownerId: x.ownerId, currency: "EUR", createdAt,
      } as CashAccount;
    case "credit":
      return {
        id: d.id, code: x.code, name: x.name, type: "credit",
        ownerType: x.ownerType, ownerId: x.ownerId, currency: "EUR", createdAt,
        issuer: x.issuer, last4: x.last4,
      } as CreditAccount;
    case "virtual":
    default:
      return {
        id: d.id, code: x.code, name: x.name, type: "virtual",
        ownerType: x.ownerType, ownerId: x.ownerId, currency: "EUR", createdAt,
      } as VirtualAccount;
  }
}

// Firestore → EmploymentContractDoc (light normalization)
function mapContractDoc(id: string, raw: any): EmploymentContractDoc {
  const benefits: BenefitConfig[] = Array.isArray(raw.benefits)
    ? raw.benefits.map((b: any) => ({
      type: b?.type,
      perMonthCents: b?.perMonthCents ?? 0,     // STRICT
      perDayCents: b?.perDayCents ?? 0,     // STRICT
      daysPerMonth: typeof b?.daysPerMonth === "number" ? b.daysPerMonth : undefined,
      subjectToIRS: !!b?.subjectToIRS,
      subjectToSS: !!b?.subjectToSS,
      benefitAccountId: b?.benefitAccountId || "", // STRICT (no providerAccountId)
      expenseCategoryId: b?.expenseCategoryId,
      payableCategoryId: b?.payableCategoryId,
      providerFeePct: typeof b?.providerFeePct === "number" ? b.providerFeePct : undefined,
      providerFeeCents: typeof b?.providerFeeCents === "number" ? b.providerFeeCents : undefined,
    }))
    : [];

  return {
    id,
    orgId: raw.orgId,
    companyId: raw.companyId,
    personId: raw.personId,
    active: raw.active !== false,
    grossMonthlyCents: raw.grossMonthlyCents ?? 0,
    irsRatePct: raw.irsRatePct ?? 0,
    ssEmpPct: raw.ssEmpPct ?? 0,
    ssErPct: raw.ssErPct ?? 0,
    payDay: typeof raw.payDay === "number" ? raw.payDay : 25,
    startDate: raw.startDate?.toDate ? raw.startDate.toDate() : raw.startDate,
    endDate: raw.endDate?.toDate ? raw.endDate.toDate() : raw.endDate,
    benefits,
    netPayAccountId: raw.netPayAccountId || "",
  };
}

// JSON-safe export: convert Firestore Timestamps, Dates to ISO strings recursively
function toPlainJSON(value: any): any {
  if (value == null) return value;
  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      try { return value.toDate().toISOString(); } catch { return String(value); }
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(toPlainJSON);
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = toPlainJSON(v);
    return out;
  }
  return value;
}

/** ---------- API (org-aware) ---------- */
export const api = {
  orgId: "personal" as string,
  setOrg(orgId: string): void { this.orgId = orgId; },
  P() { return makeOrgPaths(db, this.orgId); },

  /** -------- Companies -------- */
  companies: {
    async list(): Promise<Company[]> {
      const P = api.P();
      const snap = await getDocs(P.colCompanies());
      return snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }) as Company)
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    },
    async get(id: string): Promise<Company | undefined> {
      const P = api.P();
      const doc = await getDoc(P.docCompany(id));
      if (!doc.exists()) return undefined;
      return { id: doc.id, ...(doc.data() as any) } as Company;
    },
    async save(doc: { id?: string; name: string; shortCode?: string }): Promise<string> {
      const P = api.P();
      const payload = cleanUndefined({
        name: doc.name?.trim(),
        shortCode: doc.shortCode?.trim(),
      });
      if (doc.id) { await updateDoc(P.docCompany(doc.id), payload); return doc.id; }
      const ref = await addDoc(P.colCompanies(), { ...payload, createdAt: new Date() });
      return ref.id;
    },
    async delete(id: string): Promise<void> {
      const P = api.P();
      await deleteDoc(P.docCompany(id));
    },
  },

  /** -------- People -------- */
  people: {
    async list(): Promise<Person[]> {
      const P = api.P();
      const snap = await getDocs(P.colPeople());
      return snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }) as Person)
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    },
    async get(id: string): Promise<Person | undefined> {
      const P = api.P();
      const doc = await getDoc(P.docPerson(id));
      if (!doc.exists()) return undefined;
      return { id: doc.id, ...(doc.data() as any) } as Person;
    },
    async save(doc: { id?: string; name: string }): Promise<string> {
      const P = api.P();
      const payload = cleanUndefined({ name: doc.name?.trim() });
      if (doc.id) { await updateDoc(P.docPerson(doc.id), payload); return doc.id; }
      const ref = await addDoc(P.colPeople(), { ...payload, createdAt: new Date() });
      return ref.id;
    },
    async delete(id: string): Promise<void> {
      const P = api.P();
      await deleteDoc(P.docPerson(id));
    },
  },

  /** -------- Accounts -------- */
  accounts: {
    async list(): Promise<Account[]> {
      const P = api.P();
      const snap = await getDocs(P.colAccounts());
      return snap.docs.map(mapAccountDoc).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    },
    async listForOwner(ownerType: OwnerType, ownerId: string, types?: AccountType[]): Promise<Account[]> {
      const P = api.P();
      const snap = await getDocs(
        query(P.colAccounts(), where("ownerType", "==", ownerType), where("ownerId", "==", ownerId))
      );
      let rows = snap.docs.map(mapAccountDoc);
      if (types?.length) {
        const set = new Set(types);
        rows = rows.filter(a => set.has(a.type));
      }
      return rows.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    },
    async listCashLike(): Promise<Account[]> {
      const rows = await this.list();
      return rows.filter(a => isCashLike(a.type));
    },
    async get(id: string): Promise<Account | undefined> {
      const P = api.P();
      const d = await getDoc(P.docAccount(id));
      if (!d.exists()) return undefined;
      return mapAccountDoc(d);
    },

    async save(doc: AccountSaveInput): Promise<string> {
      const P = api.P();

      const base = {
        code: doc.code || undefined,
        name: doc.name,
        type: doc.type,
        ownerType: doc.ownerType,
        ownerId: doc.ownerId,
        currency: doc.currency ?? "EUR",
        active: doc.active ?? true,
      };

      // build type-specific fields and scrub undefineds as we go
      let payload: any = cleanUndefined(base);

      if (doc.type === "bank") {
        Object.assign(
          payload,
          cleanUndefined({
            bankName: doc.bankName,
            iban: doc.iban,
            bic: doc.bic,
            nib: doc.nib,
          })
        );
      } else if (doc.type === "credit") {
        Object.assign(
          payload,
          cleanUndefined({
            issuer: doc.issuer,
            last4: doc.last4,
          })
        );
      } else if (doc.type === "virtual") {
        Object.assign(
          payload,
          cleanUndefined({
            provider: doc.provider,
          })
        );
      }
      // for wallet/cash we add nothing more

      if (doc.id) {
        await updateDoc(P.docAccount(doc.id), payload);
        return doc.id;
      } else {
        const ref = await addDoc(P.colAccounts(), { ...payload, createdAt: new Date() });
        return ref.id;
      }
    },

    async delete(id: string): Promise<void> {
      const P = api.P();
      await deleteDoc(P.docAccount(id));
    },
  },

  /** -------- Employment Contracts -------- */
  contracts: {
    async list(companyId: string): Promise<EmploymentContractDoc[]> {
      const P = api.P();
      const snap = await getDocs(
        query(P.colEmploymentContracts(), where("companyId", "==", companyId))
      );
      return snap.docs.map(d => mapContractDoc(d.id, d.data())).sort((a, b) => {
        // sort by person then start date desc for a stable list
        const p = (a.personId ?? "").localeCompare(b.personId ?? "");
        if (p !== 0) return p;
        const ad = a.startDate ? new Date(a.startDate as any).getTime() : 0;
        const bd = b.startDate ? new Date(b.startDate as any).getTime() : 0;
        return bd - ad;
      });
    },
    async get(id: string): Promise<EmploymentContractDoc | undefined> {
      const P = api.P();
      const d = await getDoc(P.docEmploymentContract(id));
      if (!d.exists()) return undefined;
      return mapContractDoc(d.id, d.data());
    },
    async save(doc: EmploymentContractDoc): Promise<string> {
      const P = api.P();

      const payload = cleanUndefined({
        orgId: api.orgId,
        companyId: doc.companyId,
        personId: doc.personId,
        grossMonthlyCents: doc.grossMonthlyCents ?? 0,
        irsRatePct: doc.irsRatePct ?? 0,
        ssEmpPct: doc.ssEmpPct ?? 0,
        ssErPct: doc.ssErPct ?? 0,
        payDay: doc.payDay ?? 25,
        startDate: doc.startDate ?? undefined,
        endDate: doc.endDate ?? undefined,
        active: doc.active !== false,
        netPayAccountId: doc.netPayAccountId ?? "",
        benefits: Array.isArray(doc.benefits) ? doc.benefits.map(normalizeBenefitForSave) : [],
      });

      if (doc.id) { await updateDoc(P.docEmploymentContract(doc.id), payload as any); return doc.id; }
      const ref = await addDoc(P.colEmploymentContracts(), { ...payload, createdAt: new Date() });
      return ref.id;
    },

    async delete(id: string): Promise<void> {
      const P = api.P();
      await deleteDoc(P.docEmploymentContract(id));
    },
  },

  /** -------- Categories -------- */
  categories: {
    async list(): Promise<Array<{ id: string;[k: string]: any }>> {
      const P = api.P();
      const snap = await getDocs(colCategories(P, api.orgId));
      return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
        .sort((a, b) => (a.name ?? a.title ?? a.code ?? a.id).localeCompare(b.name ?? b.title ?? b.code ?? b.id));
    },
    async get(id: string): Promise<{ id: string;[k: string]: any } | undefined> {
      const P = api.P();
      const c = await getDoc(fsDoc(db, `orgs/${api.orgId}/categories/${id}`));
      if (!c.exists()) return undefined;
      return { id: c.id, ...(c.data() as any) };
    },
    async save(docIn: { id?: string; name?: string; code?: string;[k: string]: any }): Promise<string> {
      const P = api.P();
      const coll = colCategories(P, api.orgId);
      const payload = { ...docIn }; delete (payload as any).id;
      if (docIn.id) {
        await setDoc(fsDoc(coll, docIn.id), payload, { merge: true });
        return docIn.id;
      } else {
        const ref = await addDoc(coll, { ...payload, createdAt: new Date() });
        return ref.id;
      }
    },
    async delete(id: string): Promise<void> {
      const P = api.P();
      await deleteDoc(fsDoc(colCategories(P, api.orgId), id));
    },
  },

  /** -------- Templates -------- */
  templates: {
    async list(): Promise<Array<{ id: string;[k: string]: any }>> {
      const P = api.P();
      const snap = await getDocs(colTemplates(P, api.orgId));
      return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
        .sort((a, b) => (a.name ?? a.title ?? a.type ?? a.id).localeCompare(b.name ?? b.title ?? b.type ?? b.id));
    },
    async get(id: string): Promise<{ id: string;[k: string]: any } | undefined> {
      const P = api.P();
      const c = await getDoc(fsDoc(db, `orgs/${api.orgId}/templates/${id}`));
      if (!c.exists()) return undefined;
      return { id: c.id, ...(c.data() as any) };
    },
    async save(docIn: { id?: string; name?: string; type?: string;[k: string]: any }): Promise<string> {
      const P = api.P();
      const coll = colTemplates(P, api.orgId);
      const payload = { ...docIn }; delete (payload as any).id;
      if (docIn.id) {
        await setDoc(fsDoc(coll, docIn.id), payload, { merge: true });
        return docIn.id;
      } else {
        const ref = await addDoc(coll, { ...payload, createdAt: new Date() });
        return ref.id;
      }
    },
    async delete(id: string): Promise<void> {
      const P = api.P();
      await deleteDoc(fsDoc(colTemplates(P, api.orgId), id));
    },
  },

  /** -------- Planned -------- */
  planned: {
    async list(): Promise<Array<{ id: string;[k: string]: any }>> {
      const P = api.P();
      const snap = await getDocs(colPlanned(P, api.orgId));
      return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
        .sort((a, b) => (String(a.date ?? "")).localeCompare(String(b.date ?? "")));
    },
    async get(id: string): Promise<{ id: string;[k: string]: any } | undefined> {
      const P = api.P();
      const c = await getDoc(fsDoc(db, `orgs/${api.orgId}/planned/${id}`));
      if (!c.exists()) return undefined;
      return { id: c.id, ...(c.data() as any) };
    },
    async save(docIn: { id?: string;[k: string]: any }): Promise<string> {
      const P = api.P();
      const coll = colPlanned(P, api.orgId);
      const payload = { ...docIn }; delete (payload as any).id;
      if (docIn.id) {
        await setDoc(fsDoc(coll, docIn.id), payload, { merge: true });
        return docIn.id;
      } else {
        const ref = await addDoc(coll, { ...payload, createdAt: new Date() });
        return ref.id;
      }
    },
    async delete(id: string): Promise<void> {
      const P = api.P();
      await deleteDoc(fsDoc(colPlanned(P, api.orgId), id));
    },
  },

  /** -------- Backup / Restore -------- */
  backup: {
    // Shape of the dump (all keys optional—only export what exists)
    async export(): Promise<{
      orgId: string;
      exportedAt: string;
      companies?: any[];
      people?: any[];
      accounts?: any[];
      categories?: any[];
      templates?: any[];
      planned?: any[];
      contracts?: any[];
    }> {
      const P = api.P();
      const orgId = api.orgId;

      const [cs, ps, as, cats, tpls, pln, cts] = await Promise.all([
        getDocs(P.colCompanies()),
        getDocs(P.colPeople()),
        getDocs(P.colAccounts()),
        getDocs(colCategories(P, orgId)),
        getDocs(colTemplates(P, orgId)),
        getDocs(colPlanned(P, orgId)),
        getDocs(P.colEmploymentContracts()),
      ]);

      const pack = (snap: any) => snap.docs.map((d: any) => ({ id: d.id, ...toPlainJSON(d.data()) }));

      return {
        orgId,
        exportedAt: new Date().toISOString(),
        companies: pack(cs),
        people: pack(ps),
        accounts: pack(as),
        categories: pack(cats),
        templates: pack(tpls),
        planned: pack(pln),
        contracts: pack(cts),
      };
    },

    // Upsert everything by id if provided; otherwise add new doc ids.
    // Does not delete anything not present in the dump.
    async import(dump: {
      companies?: Array<{ id?: string;[k: string]: any }>;
      people?: Array<{ id?: string;[k: string]: any }>;
      accounts?: Array<{ id?: string;[k: string]: any }>;
      categories?: Array<{ id?: string;[k: string]: any }>;
      templates?: Array<{ id?: string;[k: string]: any }>;
      planned?: Array<{ id?: string;[k: string]: any }>;
      contracts?: Array<{ id?: string;[k: string]: any }>;
    }): Promise<void> {
      const P = api.P();
      const orgId = api.orgId;

      // helper: write array to a collection with optional id preservation
      const writeAll = async (items: Array<any> | undefined, coll: any) => {
        if (!items?.length) return;
        for (const it of items) {
          const { id, ...rest } = it || {};
          if (id) {
            await setDoc(fsDoc(coll, id), rest, { merge: true });
          } else {
            await addDoc(coll, rest);
          }
        }
      };

      await writeAll(dump.companies, P.colCompanies());
      await writeAll(dump.people, P.colPeople());
      await writeAll(dump.accounts, P.colAccounts());
      await writeAll(dump.categories, colCategories(P, orgId));
      await writeAll(dump.templates, colTemplates(P, orgId));
      await writeAll(dump.planned, colPlanned(P, orgId));
      await writeAll(dump.contracts, P.colEmploymentContracts());
    },
  },
};