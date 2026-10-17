import { updateDoc, getDoc } from "firebase/firestore";
import { makeOrgCRUD, orgDoc } from "./base";
import type { InsuranceDoc, InsuranceAttachment, InsuranceType, InsuranceFrequency } from "@shared/models/Insurance";
import { toDate } from "../utils";

type InsuranceSave = Omit<InsuranceDoc, "id" | "createdAt"> & { id?: string };

const from = (raw: any, id: string): InsuranceDoc => ({
  id,
  name: raw?.name ?? "",
  type: (raw?.type ?? "other") as InsuranceType,
  insurer: raw?.insurer ?? "",
  policyNumber: raw?.policyNumber || undefined,
  premiumCents: raw?.premiumCents ?? 0,
  frequency: (raw?.frequency ?? "annual") as InsuranceFrequency,
  startDate: raw?.startDate || undefined,
  renewalDate: raw?.renewalDate || undefined,
  insuredPersons: raw?.insuredPersons || undefined,
  notes: raw?.notes || undefined,
  attachments: Array.isArray(raw?.attachments) ? raw.attachments : [],
  active: raw?.active !== false,
  recurring: raw?.recurring !== false,
  createdAt: toDate(raw?.createdAt) ?? undefined,
});

export function makeInsurancesDomain(getEntityId: () => string) {
  const base = makeOrgCRUD<InsuranceSave, InsuranceDoc>(getEntityId, {
    collectionPath: "insurances",
    from,
    sort: (a, b) => a.name.localeCompare(b.name),
  });

  async function addAttachment(insuranceId: string, attachment: InsuranceAttachment): Promise<void> {
    const docRef = orgDoc(getEntityId(), "insurances", insuranceId);
    const snap = await getDoc(docRef);
    const existing: InsuranceAttachment[] = snap.exists() ? (snap.data()?.attachments ?? []) : [];
    await updateDoc(docRef, { attachments: [...existing, attachment] });
  }

  async function removeAttachment(insuranceId: string, attachmentId: string): Promise<void> {
    const docRef = orgDoc(getEntityId(), "insurances", insuranceId);
    const snap = await getDoc(docRef);
    const existing: InsuranceAttachment[] = snap.exists() ? (snap.data()?.attachments ?? []) : [];
    await updateDoc(docRef, { attachments: existing.filter(a => a.id !== attachmentId) });
  }

  return { ...base, addAttachment, removeAttachment };
}
