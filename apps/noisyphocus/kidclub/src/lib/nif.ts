/** Strip the spaces people type into a NIF ("123 456 789"). */
export const normalizeNif = (v: string) => v.replace(/\s+/g, '');

/**
 * Portuguese NIF checksum: 9 digits, the first 8 weighted 9..2, and the check
 * digit is 11 − (sum mod 11), or 0 when that comes out as 10 or 11.
 *
 * Vendus rejects an invoice whose client NIF fails this — which is how a
 * paid bill ends up stuck with an invoiceError — so it's checked wherever a
 * NIF is typed, by the parent and by the admin.
 */
export function isValidNif(v: string): boolean {
  const n = normalizeNif(v);
  if (!/^\d{9}$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(n[i]) * (9 - i);
  const check = 11 - (sum % 11);
  return (check >= 10 ? 0 : check) === Number(n[8]);
}

/** The opt-out checkbox next to the NIF field (parent pages). */
export const NIF_OPT_OUT_LABEL = 'Não pretendo NIF na fatura';

/** AT's "Consumidor final" NIF. Billing treats a family storing it as having
 *  no NIF (functions/src/kidclub/vendusClientLogic.ts), so the forms do too. */
export const CONSUMIDOR_FINAL_NIF = '999999990';

/**
 * The NIF field's error on a profile form, or '' when it can be saved: a valid
 * NIF is required unless the parent opted out. Without a NIF, invoices are
 * issued to "Consumidor final" (no name, no NIF on them).
 */
export function nifFieldError(nif: string, optOut: boolean): string {
  if (optOut) return '';
  if (!nif.trim()) return `Indique o NIF ou marque "${NIF_OPT_OUT_LABEL}".`;
  if (normalizeNif(nif) === CONSUMIDOR_FINAL_NIF) return `999999990 é o NIF de Consumidor final: marque "${NIF_OPT_OUT_LABEL}".`;
  return isValidNif(nif) ? '' : 'NIF inválido — confirme os 9 dígitos.';
}

/** A family that has neither a NIF nor the opt-out (e.g. from before the
 *  opt-out existed): the Payments page asks for the NIF, without blocking. */
export function needsNifPrompt(family: { nif?: string; nifOptOut?: boolean } | null | undefined): boolean {
  if (!family || family.nifOptOut) return false;
  const nif = normalizeNif(family.nif ?? '');
  return !nif || nif === CONSUMIDOR_FINAL_NIF;
}
