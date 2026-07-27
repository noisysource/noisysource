import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../../firebase";
import type { IRSConfigDoc, PersonIncomeSource, IRSDeductions } from "@shared/models/IRSConfig";
import { toDate } from "../utils";

function orgIRSDoc(entityId: string, year: string) {
  return doc(db, "finances_entities", entityId, "irsConfig", year);
}

const emptyDeductions = (): IRSDeductions => ({ healthCents: 0, educationCents: 0, housingCents: 0 });

export function makeIRSConfigDomain(getOrgId: () => string) {
  return {
    async get(year: number): Promise<IRSConfigDoc | null> {
      const snap = await getDoc(orgIRSDoc(getOrgId(), String(year)));
      if (!snap.exists()) return null;
      const raw = snap.data();
      return {
        id: String(year),
        year,
        incomes: (raw?.incomes ?? []) as PersonIncomeSource[],
        deductions: (raw?.deductions ?? emptyDeductions()) as IRSDeductions,
        updatedAt: toDate(raw?.updatedAt) ?? undefined,
      };
    },

    async save(year: number, incomes: PersonIncomeSource[], deductions: IRSDeductions): Promise<void> {
      await setDoc(orgIRSDoc(getOrgId(), String(year)), {
        year,
        incomes,
        deductions,
        updatedAt: serverTimestamp(),
      });
    },
  };
}
