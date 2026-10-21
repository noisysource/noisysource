import { appCol } from "./db";

// Family-level billing facts shared by billing.ts (monthly bills) and
// partyDeposit.ts (party deposits). Lives in its own module so partyDeposit.ts
// doesn't have to import billing.ts, which imports it back.

// Methods a family can choose / a bill can carry. `bank_transfer` is paid
// outside Easypay and confirmed by an admin (markBillingPaid).
export const FAMILY_PAYMENT_METHODS = ["mbway", "multibanco", "card", "subscription", "bank_transfer"] as const;

// The family's chosen payment method, or undefined if it never chose one.
// `paymentMethod` is the one field going forward; `defaultPaymentMethod` is
// what the profile pages wrote until 2026-10 (billing never read it, so every
// bill said "mbway" whatever the parent chose) — read as a fallback only.
export function familyPaymentMethod(fam: FirebaseFirestore.DocumentData | undefined): string | undefined {
  const m = fam?.paymentMethod ?? fam?.defaultPaymentMethod;
  return typeof m === "string" && (FAMILY_PAYMENT_METHODS as readonly string[]).includes(m) ? m : undefined;
}

export interface FamilyBillingInfo {
  ownerUid: string;
  paymentMethod?: string;
  contactEmail: string;
  contactName: string;
}

// Who owns a family's billing records (ownerUid).
// families/{id}.primaryContact.userId is the single source of truth: billing.userId used to be copied from whichever
// subscription triggered the write, and admin-created subscriptions often have
// no userId, so records were written with "" and the parent could neither see
// (rules match on billing.userId) nor pay (callables check billing.userId) them.
export async function familyBillingInfo(familyId: string): Promise<FamilyBillingInfo> {
  const fam = (await appCol("families").doc(familyId).get()).data();
  return {
    ownerUid: fam?.primaryContact?.userId ?? "",
    paymentMethod: familyPaymentMethod(fam),
    contactEmail: fam?.primaryContact?.email ?? "",
    contactName: fam?.primaryContact?.name ?? "",
  };
}
