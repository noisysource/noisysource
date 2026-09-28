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
