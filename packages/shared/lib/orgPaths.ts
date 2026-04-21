// packages/shared/lib/orgPaths.ts
import {
  Firestore,
  collection,
  doc,
  CollectionReference,
  DocumentReference,
} from "firebase/firestore";

export type OrgPaths = {
  // collections
  colAccounts(): CollectionReference;
  colCompanies(): CollectionReference;
  colPeople(): CollectionReference;
  colCategories(): CollectionReference;
  colTemplates(): CollectionReference;
  colPlannedInstances(): CollectionReference;
  colLedger(): CollectionReference;

  // singletons / docs
  settingsDoc(): DocumentReference;
  docAccount(id: string): DocumentReference;
  docCompany(id: string): DocumentReference;
  docPerson(id: string): DocumentReference;
  docTemplate(id: string): DocumentReference;
  docPlannedInstance(id: string): DocumentReference;
  docLedger(id: string): DocumentReference;
  docCategory(id: string): DocumentReference;
};

/**
 * Path builder scoped to an org. Falls back to "personal" if orgId is missing.
 */
export function makeOrgPaths(db: Firestore, orgId?: string): OrgPaths {
  const org = orgId || "personal";

  const col = (...segments: string[]) => collection(db, "orgs", org, ...segments);
  const d   = (...segments: string[]) => doc(db, "orgs", org, ...segments);

  return {
    // collections
    colAccounts: () => col("accounts"),
    colCompanies: () => col("companies"),
    colPeople: () => col("people"),
    colCategories: () => col("categories"),
    colTemplates: () => col("templates"),
    colPlannedInstances: () => col("plannedInstances"),
    colLedger: () => col("ledgerTransactions"),

    // singletons / docs
    settingsDoc: () => d("settings", "globals"),
    docAccount: (id) => d("accounts", id),
    docCompany: (id) => d("companies", id),
    docPerson: (id) => d("people"),
    docTemplate: (id) => d("templates"),
    docPlannedInstance: (id) => d("plannedInstances"),
    docLedger: (id) => d("ledgerTransactions"),
    docCategory: (id) => d("categories", id),
  };
}