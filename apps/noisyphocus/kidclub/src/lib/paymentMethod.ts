import type { Family } from '@shared/models';

/**
 * The family's chosen payment method. `paymentMethod` is the one field billing
 * reads; `defaultPaymentMethod` is what the profile pages wrote until 2026-10
 * (billing never saw it). Mirrors familyPaymentMethod in functions/src/kidclub/billing.ts.
 */
export function familyPaymentMethod(fam: Pick<Family, 'paymentMethod' | 'defaultPaymentMethod'> | null | undefined): string | undefined {
  return fam?.paymentMethod ?? fam?.defaultPaymentMethod ?? undefined;
}

/** The two choices the profile pages offer; anything else shows as bank transfer (the default). */
export function profilePaymentChoice(fam: Pick<Family, 'paymentMethod' | 'defaultPaymentMethod'> | null | undefined): 'bank_transfer' | 'mbway' {
  return familyPaymentMethod(fam) === 'mbway' ? 'mbway' : 'bank_transfer';
}
