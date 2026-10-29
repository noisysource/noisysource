import { formatEUR } from '@shared/lib/money';

export const eur = (cents: number) => formatEUR(cents);

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** '2026-10-29' → '29 out 2026' */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** '2026-10-29' → 'qui 29 out' */
export function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[w]} ${d} ${MONTHS[m - 1]}`;
}

/** '2026-10' → 'outubro 2026' */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}

export function fmtDays(n: number): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
  return `${s} ${n === 1 ? 'dia' : 'dias'}`;
}

export const amountClass = (cents: number) => (cents < 0 ? 'text-red-300' : cents > 0 ? 'text-emerald-300' : 'text-zinc-400');
