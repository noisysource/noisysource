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

/** '1 234,56' or '1234.5' → cents. Throws with the text it couldn't read. */
export function parseCents(text: string): number {
  return Math.round(parseNumber(text) * 100);
}

/** A decimal typed the Portuguese way ('1,375') or with a point. Throws with the text it couldn't read. */
export function parseNumber(text: string): number {
  const t = text.replace(/[\s€%]/g, '').replace(/\.(?=\d{3}(,|$))/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`Número inválido: "${text}"`);
  return Number(t);
}

/** Cents as a form shows them: 123456 → '1234,56'. */
export const centsInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
