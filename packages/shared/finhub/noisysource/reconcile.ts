// packages/shared/finhub/noisysource/reconcile.ts
//
// Bank lines against the plan (HANDOFF-finhub-v2.md, § Acceptance 1–3, screen Mês). What Renato
// confirmed is in the log (`bank.movement.matched`, `bank.movement.classified`,
// `plan.item.explained`); everything else here is a suggestion, computed on load and never stored.
// A suggestion only becomes true when a click appends its event.
//
// Suggestions, each bank line used once, in this order:
//  1. structure: an SS line names its month ("TSU … - 202602");
//  2. lines with a hint (the words of a line Renato already confirmed, the client's or a worker's
//     name, the words of a payment rule or a cost plan, or the same IBAN as a hinted line), within
//     that hint: the same amount, oldest planned item first; several items in one payment (voucher
//     cards with the provider's fee, k months of a cost at once); several lines for one item (a
//     salary or an insurance paid in two);
//  3. lines without a hint: the same amount, a planned item a few days around, oldest first;
//  4. hinted lines still free: the same month at a different amount (costs that vary, a salary
//     that differs from its payslip), shown as an amount difference;
//  5. lines left: an ad hoc category from keywords, never a guess at a planned item.

import { addDays, daysBetween, firstDay, lastDay, monthOf, type IsoDate, type YearMonth } from '../dates';
import type { MatchItem, MatchTarget } from './events';
import { namesCounterparty } from './intercompany';
import { plannedItems, providerFeeCents, type PlanKind, type PlannedItem } from './plan';
import { matchItemId, ruleAt, type MovementState, type NsState } from './state';
import { accountMovements, realBalanceAt } from './treasury';

export const KIND_TARGET: Record<PlanKind, MatchTarget> = {
  ec: 'ec-fatura', salario: 'salario', refeicao: 'refeicao', vales: 'vales', ss: 'ss', irs: 'irs', custo: 'custo', entre: 'entre',
};

/** The match payload entry for a planned item. */
export function toMatchItem(i: PlannedItem): MatchItem {
  return { to: KIND_TARGET[i.kind], ref: i.ref, month: i.month };
}

// ── Ad hoc categories (lines the plan doesn't have) ─────────────────────────

export const ADHOC_CATEGORIES = [
  { id: 'cartao-credito', label: 'Cartão de crédito (pagamento do extrato)' },
  { id: 'financiamento', label: 'Empréstimos e leasing (fora do plano)' },
  { id: 'estado', label: 'Estado (a identificar: IVA, IRC, IUC, coimas…)' },
  { id: 'seguranca-social', label: 'Segurança Social (fora do plano)' },
  { id: 'seguros', label: 'Seguros (indemnizações, outros)' },
  { id: 'viagens', label: 'Viagens (alojamento, voos, aluguer de carro)' },
  { id: 'viaturas', label: 'Viaturas (portagens fora do plano, oficina, inspeção)' },
  { id: 'coimas', label: 'Coimas e multas' },
  { id: 'registos', label: 'Registos e taxas' },
  { id: 'compras', label: 'Compras (material, equipamento)' },
  { id: 'intragrupo', label: 'Empresas do grupo' },
  { id: 'socios', label: 'Sócios e trabalhadores (fora do salário)' },
  { id: 'anterior', label: 'De antes do histórico (pago em 2026)' },
  { id: 'transferencias', label: 'Transferências (a identificar)' },
  { id: 'receitas', label: 'Outras receitas' },
  { id: 'outro', label: 'Outro' },
] as const;
export type AdhocCategoryId = (typeof ADHOC_CATEGORIES)[number]['id'];

export function categoryLabel(id: string): string {
  return ADHOC_CATEGORIES.find(c => c.id === id)?.label ?? id;
}

/** Keywords → category, first hit wins. Public institutions and merchant chains only. */
const CATEGORY_WORDS: [AdhocCategoryId, RegExp][] = [
  ['cartao-credito', /PAG\.?AUT\.?CARTAO/],
  ['financiamento', /UTILIZACAO DE CAPITAL|SELO S\/ UTILIZACAO|LEASING|LOCACAO FINANCEIRA/],
  ['coimas', /SEGURANCA RODOVIARIA|\bANSR\b|COIMA/],
  ['estado', /PAGAMENTO AO ESTADO|AUTORIDADE TRIBUTARIA|REEMBOLSOS? (IRC|IRS|IVA)/],
  ['seguranca-social', /SEG(URAN[CÇ]?A)? SOC|\bTSU\b/],
  ['seguros', /AGEAS|GENERALI|ALLIANZ|FIDELIDADE|TRANQUILIDADE|SEGUROS/],
  ['viagens', /HOTEL|BOOKING|FLIGHTS|AIRBNB|HERTZ|EUROPCAR|\bAVIS\b|\bSIXT\b|RUMBO|FERRIES|RYANAIR|EASYJET|HOSTEL/],
  ['viaturas', /NORAUTO|CONTROLAUTO|MIDAS|PNEU|INSPEC|PORTAGEM|\bA\d{1,2}\b|\b[0-9A-Z]{2}-[0-9A-Z]{2}-[0-9A-Z]{2}\b/],
  ['registos', /REGISTOS|NOTARIADO/],
  ['intragrupo', /NOISY ?PHOCUS/],
];

// ── Words ────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const words = (s: string) => norm(s).split(/[\s/.,;:()+=*&'"—–]+/).filter(Boolean);

/** Bank and legal boilerplate: never evidence of what a line is. */
const GENERIC = new Set([
  'TRF', 'CR', 'SEPA', 'INST', 'INTRAB', 'DE', 'DO', 'DA', 'DOS', 'DAS', 'AO', 'AOS', 'DD', 'PAG', 'PAGSERV', 'PAGAMENTO',
  'PAGAMENTOS', 'COMPRA', 'EL-E', 'SA', 'LDA', 'UNIP', 'ESTADO', 'CONTA', 'CARTAO', 'BPI', 'DEBITO', 'DIRETO', 'DIRECTO',
  'VALOR', 'PORTUGAL', 'PORTUGUESA', 'COMP', 'COMPANHIA', 'INSTITUICAO', 'POR', 'PARA', 'COM', 'SEM', 'IMPOSTO', 'NAO',
  'VIDA', 'INC', 'TELEF', 'PUBL', 'OUT', 'VIA', 'MENSAL', 'ANUAL', 'TAXA', 'SERVICOS', 'INSTITUTO', 'COBRANCA', 'NIF',
]);

const significant = (s: string) => words(s).filter(w => w.length >= 3 && !GENERIC.has(w) && !/^\d{1,5}$/.test(w));

/** Same word, or one a short variation of the other (PORTAGEM ~ PORTAGENS, CONTABIL ~ CONTABILISTA). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 5) return false;
  let p = 0;
  while (p < min && a[p] === b[p]) p++;
  return p >= Math.max(5, min - 1);
}

function overlap(lineWords: string[], ofWords: string[]): number {
  let n = 0;
  for (const w of ofWords) if (lineWords.some(l => sameWord(l, w))) n++;
  return n;
}

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

/** A line's description without what changes from one month to the next (sequence numbers, dates). */
export function descriptionKey(description: string): string {
  return words(description).filter(w => !/^\d+$/.test(w) && w !== '-').join(' ');
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export type LineState = 'confirmado' | 'classificado' | 'sugerido' | 'classificacao-sugerida' | 'por-explicar';
export type ItemState = 'confirmado' | 'sugerido' | 'explicado' | 'sem-movimento' | 'futuro';

export interface LineStatus {
  movement: MovementState;
  state: LineState;
  /** Planned items the line pays (confirmed or suggested). */
  itemIds: string[];
  /** How a suggestion was found, or the basis stored with a confirmed match. */
  basis?: string;
  /** Suggestion: the amounts add up to the cent. */
  exact?: boolean;
  /** Classification (confirmed or suggested). */
  category?: string;
  description?: string;
  /** The confirmed match / classification event (to undo it). */
  eventId?: string;
  /** Confirmed match pointing at items the plan no longer has. */
  missingItemIds?: string[];
}

export interface ItemStatus {
  item: PlannedItem;
  state: ItemState;
  lineIds: string[];
  reason?: string;
  /** The `plan.item.explained` event (to undo it). */
  reasonEventId?: string;
}

export interface MatchGroup {
  lineIds: string[];
  itemIds: string[];
  linesCents: number;
  itemsCents: number;
  /** lines − items: the amount difference of the group. */
  diffCents: number;
  confirmed: boolean;
}

export interface Reconciliation {
  accountId: string;
  /** Date of the last imported line: items after it are still to come. */
  lastLineDate: IsoDate | null;
  lines: Map<string, LineStatus>;
  items: Map<string, ItemStatus>;
  groups: MatchGroup[];
  groupOfLine: Map<string, number>;
  groupOfItem: Map<string, number>;
}

interface Family {
  kind: PlanKind;
  /** A specific contract, worker or cost; undefined = any of that kind. */
  ref?: string;
}

interface Hint {
  family: Family;
  basis: string;
  score: number;
}

interface Suggestion {
  itemIds: string[];
  basis: string;
  exact: boolean;
}

const WINDOW = {
  hinted: [-45, 60] as const,
  unhinted: [-10, 30] as const,
  multiItems: [-60, 90] as const,
  multiLines: [-20, 45] as const,
  approx: [-20, 45] as const,
};

/** Days from the item's planned day to the line (positive: paid after it). */
const lag = (item: PlannedItem, line: MovementState) => daysBetween(item.date, line.date);
const inWindow = (item: PlannedItem, line: MovementState, w: readonly [number, number]) => {
  const d = lag(item, line);
  return d >= w[0] && d <= w[1];
};
const byDate = (a: PlannedItem, b: PlannedItem) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

export function reconcile(state: NsState, opts: { accountId: string }): Reconciliation {
  const movements = accountMovements(state, opts.accountId);
  const lastLineDate = movements.length ? movements[movements.length - 1].date : null;
  const lines = new Map<string, LineStatus>();
  const items = new Map<string, ItemStatus>();
  if (!movements.length || !lastLineDate) {
    return { accountId: opts.accountId, lastLineDate, lines, items, groups: [], groupOfLine: new Map(), groupOfItem: new Map() };
  }

  const planned = plannedItems(state, {
    from: firstDay(monthOf(movements[0].date)), to: addDays(lastLineDate, 120), mainAccount: opts.accountId,
  }).filter(i => !i.account || i.account === opts.accountId);
  const itemById = new Map(planned.map(i => [i.id, i]));
  const firstPlanMonth = planned.length ? planned.reduce((m, i) => (i.month < m ? i.month : m), planned[0].month) : null;

  // ── 0. What's confirmed ──
  const lineItems = new Map<string, string[]>();
  const itemLines = new Map<string, string[]>();
  const link = (lineId: string, itemId: string) => {
    lineItems.set(lineId, [...(lineItems.get(lineId) ?? []), itemId]);
    itemLines.set(itemId, [...(itemLines.get(itemId) ?? []), lineId]);
  };
  /** Items paid in full by an exact match: no other line goes to them. */
  const full = new Set<string>();
  const confirmedLines = new Set<string>();

  for (const m of movements) {
    const match = state.matches[m.id];
    const cls = state.classifications[m.id];
    if (match) {
      const ids = match.items.map(matchItemId);
      const known = ids.filter(id => itemById.has(id));
      for (const id of known) { link(m.id, id); full.add(id); }
      confirmedLines.add(m.id);
      lines.set(m.id, {
        movement: m, state: 'confirmado', itemIds: known, basis: match.basis, eventId: match.eventId,
        ...(known.length < ids.length ? { missingItemIds: ids.filter(id => !itemById.has(id)) } : {}),
      });
    } else if (cls) {
      confirmedLines.add(m.id);
      lines.set(m.id, {
        movement: m, state: 'classificado', itemIds: [], category: cls.category, description: cls.description, eventId: cls.eventId,
      });
    }
  }

  // ── Hints ──
  const suggestions = new Map<string, Suggestion>();
  const free = (m: MovementState) => !confirmedLines.has(m.id) && !suggestions.has(m.id);
  const taken = (id: string) => (itemLines.get(id)?.length ?? 0) > 0;
  const suggest = (m: MovementState, its: PlannedItem[], basis: string, exact: boolean) => {
    suggestions.set(m.id, { itemIds: its.map(i => i.id), basis, exact });
    for (const i of its) {
      link(m.id, i.id);
      if (exact) full.add(i.id);
    }
  };

  // Learned: descriptions Renato already confirmed.
  const learned = new Map<string, Family | null>();
  for (const m of movements) {
    const match = state.matches[m.id];
    if (!match) continue;
    const key = descriptionKey(m.description);
    if (!significant(key).length) continue;
    const its = match.items.map(matchItemId).map(id => itemById.get(id)).filter((i): i is PlannedItem => !!i);
    if (!its.length) continue;
    const kinds = new Set(its.map(i => i.kind));
    const refs = new Set(its.map(i => i.ref));
    const fam: Family | null = kinds.size === 1 ? { kind: its[0].kind, ref: refs.size === 1 ? its[0].ref : undefined } : null;
    const prev = learned.get(key);
    learned.set(key, prev === undefined ? fam : prev && fam && prev.kind === fam.kind && prev.ref === fam.ref ? fam : null);
  }
  const learnedCategory = new Map<string, string>();
  for (const m of movements) {
    const cls = state.classifications[m.id];
    if (!cls) continue;
    const key = descriptionKey(m.description);
    if (significant(key).length) learnedCategory.set(key, cls.category);
  }

  const ruleWords: { kind: PlanKind; words: string[]; label: string }[] = [];
  const RULE_KIND: Record<string, PlanKind> = { salarios: 'salario', refeicao: 'refeicao', vales: 'vales', ss: 'ss', irs: 'irs', 'ec-fatura': 'ec' };
  for (const r of state.rules) {
    ruleWords.push({ kind: RULE_KIND[r.what], words: significant(`${r.label} ${r.fee?.label ?? ''}`), label: r.label });
  }
  const costWords = new Map<string, { words: string[]; direction: 'saida' | 'entrada'; description: string }>();
  for (const c of state.costPlans) costWords.set(c.key, { words: significant(c.description), direction: c.direction, description: c.description });
  const personWords = state.people.map(p => ({ id: p.id, name: p.name, words: significant(p.name) }));

  const hintsOf = (m: MovementState): Hint[] => {
    const lw = words(m.description);
    const out: Hint[] = [];
    const fam = learned.get(descriptionKey(m.description));
    if (fam) out.push({ family: fam, basis: 'como linhas iguais já confirmadas', score: 100 });
    if (m.amountCents > 0) {
      for (const c of state.contracts) {
        if (overlap(lw, significant(c.client)) > 0) out.push({ family: { kind: 'ec' }, basis: `nome do cliente (${c.client})`, score: 10 });
      }
    } else {
      for (const p of personWords) {
        if (p.words.length && overlap(lw, p.words) > 0) out.push({ family: { kind: 'salario', ref: p.id }, basis: `nome (${p.name})`, score: 10 });
      }
    }
    for (const ic of state.intercompany) {
      if (namesCounterparty(ic, m.description)) out.push({ family: { kind: 'entre', ref: ic.key }, basis: `nome (${ic.counterparty})`, score: 10 });
    }
    for (const r of ruleWords) {
      const n = overlap(lw, r.words);
      if (n > 0 && (r.kind === 'ec') === (m.amountCents > 0)) out.push({ family: { kind: r.kind }, basis: `palavras da regra "${r.label}"`, score: n });
    }
    for (const [key, c] of costWords) {
      if ((c.direction === 'entrada') !== (m.amountCents > 0)) continue;
      const n = overlap(lw, c.words);
      if (n > 0) out.push({ family: { kind: 'custo', ref: key }, basis: `palavras do custo "${c.description}"`, score: n });
    }
    const seen = new Set<string>();
    return out.sort((a, b) => b.score - a.score).filter(h => {
      const k = `${h.family.kind}:${h.family.ref ?? '*'}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const hints = new Map<string, Hint[]>();
  for (const m of movements) if (!confirmedLines.has(m.id)) hints.set(m.id, hintsOf(m));
  // Same IBAN as a hinted line (a transfer without the payee's name).
  const ibanHints = new Map<string, Hint[]>();
  for (const m of movements) {
    const h = hints.get(m.id);
    if (!h?.length) continue;
    for (const w of words(m.description)) if (IBAN_RE.test(w) && !ibanHints.has(w)) ibanHints.set(w, h);
  }
  for (const m of movements) {
    if (confirmedLines.has(m.id) || hints.get(m.id)?.length) continue;
    const iban = words(m.description).find(w => IBAN_RE.test(w));
    const h = iban ? ibanHints.get(iban) : undefined;
    if (h) hints.set(m.id, h.map(x => ({ ...x, basis: `mesmo IBAN de uma linha com ${x.basis}`, score: x.score - 1 })));
  }

  const inFamily = (i: PlannedItem, f: Family) => i.kind === f.kind && (f.ref === undefined || i.ref === f.ref);
  const pending = movements.filter(free);

  // ── 1. SS lines name their month ──
  for (const m of pending) {
    const tsu = /\bTSU\b.*?(\d{4})(\d{2})\s*$/.exec(norm(m.description));
    if (!tsu || m.amountCents >= 0) continue;
    const month = `${tsu[1]}-${tsu[2]}`;
    const item = itemById.get(`ss:all:${month}`);
    if (item && !taken(item.id)) {
      const exact = item.amountCents === m.amountCents;
      suggest(m, [item], exact ? `TSU de ${month}` : `TSU de ${month}, valor diferente do plano`, exact);
    } else if (!item && firstPlanMonth && month < firstPlanMonth) {
      lines.set(m.id, { movement: m, state: 'classificacao-sugerida', itemIds: [], category: 'anterior', description: `TSU de ${month}`, basis: `TSU de ${month}, antes do histórico` });
    }
  }
  const stillFree = (m: MovementState) => free(m) && !lines.has(m.id);

  // ── 2. Hinted lines, in date order: the same amount, else one line for several items ──
  // Costs are direct debits on a fixed day: the nearest item. The rest (salaries, taxes, cards)
  // can be paid late or in a lump: the oldest item still open.
  const exactPick = (m: MovementState, f: Family | null, w: readonly [number, number]) =>
    planned.filter(i => !taken(i.id) && (!f || inFamily(i, f)) && i.amountCents === m.amountCents && inWindow(i, m, w))
      .sort((a, b) => (a.kind === 'custo' && b.kind === 'custo' ? Math.abs(lag(a, m)) - Math.abs(lag(b, m)) : 0) || byDate(a, b))[0];
  const multiItems = (m: MovementState, f: Family, basis: string): boolean => {
    const target = -m.amountCents;
    if (target <= 0) return false;
    const cands = planned.filter(i => !taken(i.id) && inFamily(i, f) && i.amountCents < 0 && inWindow(i, m, WINDOW.multiItems)).sort(byDate);
    if (f.kind === 'vales') {
      const fee = ruleAt(state, 'vales', m.date)?.fee;
      const bases = cands.slice(0, 14).map(i => -(i.baseCents ?? i.amountCents));
      const pick = subsetSum(bases, { maxSize: 8, limit: target, ok: sum => (fee ? sum + providerFeeCents(sum, fee) : sum) === target });
      if (pick) { suggest(m, pick.map(k => cands[k]), `${basis}; cartões${fee ? ` + ${fee.label}` : ''} somam o valor`, true); return true; }
      return false;
    }
    if (f.kind === 'custo' && f.ref) {
      const unit = cands[0] ? -cands[0].amountCents : 0;
      if (unit > 0 && target % unit === 0 && target / unit >= 2 && cands.filter(i => i.amountCents === -unit).length >= target / unit) {
        const k = target / unit;
        suggest(m, cands.filter(i => i.amountCents === -unit).slice(0, k), `${basis}; ${k} meses de uma vez`, true);
        return true;
      }
    }
    return false;
  };
  for (const m of pending) {
    if (!stillFree(m)) continue;
    for (const h of hints.get(m.id) ?? []) {
      const i = exactPick(m, h.family, WINDOW.hinted);
      if (i) { suggest(m, [i], `${h.basis}; mesmo valor`, true); break; }
      if (multiItems(m, h.family, h.basis)) break;
    }
  }

  // ── 2b. Several lines, one item ──
  for (const item of [...planned].sort(byDate)) {
    if (taken(item.id) || item.date > lastLineDate) continue;
    // A cost's lines are in its own month (else small lines of other months add up by chance).
    const cands = pending.filter(m => stillFree(m) && Math.sign(m.amountCents) === Math.sign(item.amountCents)
      && (item.kind === 'custo' ? monthOf(m.date) === monthOf(item.date) : inWindow(item, m, WINDOW.multiLines))
      && (hints.get(m.id) ?? []).some(h => inFamily(item, h.family)));
    if (cands.length < 2) continue;
    const want = Math.abs(item.amountCents);
    const pick = subsetSum(cands.slice(0, 12).map(m => Math.abs(m.amountCents)), { maxSize: 4, minSize: 2, limit: want, ok: sum => sum === want });
    if (!pick) continue;
    const basis = (hints.get(cands[pick[0]].id) ?? []).find(h => inFamily(item, h.family))?.basis ?? '';
    for (const k of pick) suggest(cands[k], [item], `${basis}; ${pick.length} linhas somam o previsto`, true);
  }

  // ── 3. No hint: same amount, a few days around ──
  for (const m of pending) {
    if (!stillFree(m) || hints.get(m.id)?.length) continue;
    const i = exactPick(m, null, WINDOW.unhinted);
    if (i) suggest(m, [i], 'mesmo valor, data próxima', true);
  }
  for (const m of pending) {
    if (!stillFree(m) || hints.get(m.id)?.length || m.amountCents >= 0) continue;
    multiItems(m, { kind: 'vales' }, 'sem nome');
  }

  // ── 4. Hinted lines still free: another amount ──
  // A salary, EC payment or tax that differs from the plan: per item, the free line of its family
  // closest in amount, from a few days before to six weeks after (taxes paid late, with interest).
  for (const item of [...planned].sort(byDate)) {
    if (item.kind === 'custo' || item.kind === 'vales' || taken(item.id) || item.date > lastLineDate) continue;
    const want = Math.abs(item.amountCents);
    const line = pending.filter(m => stillFree(m) && Math.sign(m.amountCents) === Math.sign(item.amountCents)
      && inWindow(item, m, WINDOW.approx) && Math.abs(m.amountCents) >= want / 2 && Math.abs(m.amountCents) <= 2 * want
      && (hints.get(m.id) ?? []).some(h => inFamily(item, h.family)))
      .sort((a, b) => Math.abs(Math.abs(a.amountCents) - want) - Math.abs(Math.abs(b.amountCents) - want))[0];
    if (!line) continue;
    const h = hints.get(line.id)!.find(x => inFamily(item, x.family))!;
    suggest(line, [item], `${h.basis}; valor diferente do previsto`, false);
  }
  // Costs that vary (tolls, charging, phone…): every line of the month goes to the month's item.
  for (const m of pending) {
    if (!stillFree(m)) continue;
    for (const h of hints.get(m.id) ?? []) {
      if (h.family.kind !== 'custo') continue;
      const i = planned.filter(c => inFamily(c, h.family) && !full.has(c.id) && monthOf(c.date) === monthOf(m.date)
        && Math.sign(c.amountCents) === Math.sign(m.amountCents)
        && (c.amountCents === 0 || Math.abs(m.amountCents) <= 3 * Math.abs(c.amountCents)))
        .sort((a, b) => Math.abs(lag(a, m)) - Math.abs(lag(b, m)))[0];
      if (i) { suggest(m, [i], `${h.basis}; valor diferente do previsto`, false); break; }
    }
  }

  // ── 5. Ad hoc categories ──
  for (const m of movements) {
    if (lines.has(m.id)) continue;
    const s = suggestions.get(m.id);
    if (s) {
      lines.set(m.id, { movement: m, state: 'sugerido', itemIds: s.itemIds, basis: s.basis, exact: s.exact });
      continue;
    }
    const cat = categorize(m, learnedCategory, personWords, state.intercompany);
    lines.set(m.id, cat
      ? { movement: m, state: 'classificacao-sugerida', itemIds: [], category: cat.id, description: m.description, basis: cat.basis }
      : { movement: m, state: 'por-explicar', itemIds: [] });
  }

  // ── Items ──
  for (const i of planned) {
    const ls = itemLines.get(i.id) ?? [];
    const confirmed = ls.some(l => confirmedLines.has(l));
    const reason = state.explained[i.id];
    const st: ItemState = ls.length ? (confirmed ? 'confirmado' : 'sugerido')
      : reason ? 'explicado'
      : i.date > lastLineDate ? 'futuro' : 'sem-movimento';
    items.set(i.id, { item: i, state: st, lineIds: ls, ...(reason && !ls.length ? { reason: reason.reason, reasonEventId: reason.eventId } : {}) });
  }

  // ── Groups (lines and items joined by matches) ──
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const [l, its] of lineItems) for (const i of its) union(`L${l}`, `I${i}`);
  const byRoot = new Map<string, MatchGroup>();
  for (const node of parent.keys()) {
    const root = find(node);
    const g = byRoot.get(root) ?? { lineIds: [], itemIds: [], linesCents: 0, itemsCents: 0, diffCents: 0, confirmed: true };
    if (node[0] === 'L') {
      const id = node.slice(1);
      g.lineIds.push(id);
      g.linesCents += lines.get(id)!.movement.amountCents;
      if (!confirmedLines.has(id)) g.confirmed = false;
    } else {
      const id = node.slice(1);
      g.itemIds.push(id);
      g.itemsCents += itemById.get(id)!.amountCents;
    }
    byRoot.set(root, g);
  }
  const groups = [...byRoot.values()].map(g => ({ ...g, diffCents: g.linesCents - g.itemsCents }));
  const groupOfLine = new Map<string, number>();
  const groupOfItem = new Map<string, number>();
  groups.forEach((g, k) => {
    for (const l of g.lineIds) groupOfLine.set(l, k);
    for (const i of g.itemIds) groupOfItem.set(i, k);
  });

  return { accountId: opts.accountId, lastLineDate, lines, items, groups, groupOfLine, groupOfItem };
}

function categorize(
  m: MovementState,
  learnedCategory: Map<string, string>,
  people: { id: string; name: string; words: string[] }[],
  intercompany: NsState['intercompany'],
): { id: string; basis: string } | null {
  const key = descriptionKey(m.description);
  const learned = learnedCategory.get(key);
  if (learned) return { id: learned, basis: 'como linhas iguais já classificadas' };
  const ic = intercompany.find(p => namesCounterparty(p, m.description));
  if (ic) return { id: 'intragrupo', basis: `nome (${ic.counterparty})` };
  const d = norm(m.description);
  for (const [id, re] of CATEGORY_WORDS) if (re.test(d)) return { id, basis: 'palavras da linha' };
  const lw = words(m.description);
  const person = people.find(p => p.words.length && overlap(lw, p.words) > 0);
  if (person) return { id: 'socios', basis: `nome (${person.name})` };
  if (/\bCOMPRA\b/.test(d) && m.amountCents < 0) return { id: 'compras', basis: 'compra com cartão' };
  if (/\bTRF\b/.test(d)) return { id: 'transferencias', basis: 'transferência' };
  return null;
}

/**
 * Indices of a subset of `values` (each > 0, sum at most `limit`) whose sum passes `ok`, with
 * `minSize`–`maxSize` elements; earlier indices first (the caller sorts oldest first). Null if none.
 */
export function subsetSum(
  values: number[],
  o: { maxSize: number; minSize?: number; limit: number; ok: (sum: number) => boolean },
): number[] | null {
  const picked: number[] = [];
  let found: number[] | null = null;
  const dfs = (start: number, sum: number) => {
    if (found || sum > o.limit) return;
    if (picked.length >= (o.minSize ?? 1) && o.ok(sum)) { found = [...picked]; return; }
    if (picked.length === o.maxSize) return;
    for (let k = start; k < values.length && !found; k++) {
      picked.push(k);
      dfs(k + 1, sum + values[k]);
      picked.pop();
    }
  };
  dfs(0, 0);
  return found;
}

// ── Month report (§ Acceptance 1–3) ──────────────────────────────────────────

export interface MonthBuckets {
  /** Lines classified as ad hoc (confirmed or suggested). */
  adhocCents: number;
  /** Groups wholly in the month: lines − planned (estimates, rounding, fees not planned). */
  amountDiffCents: number;
  /** Groups that cross months: what this month's lines/items add (paid early or late). */
  otherMonthCents: number;
  /** Planned items without a bank line, with a written reason (their effect on real − planned). */
  explainedMissingCents: number;
  /** Planned items without a bank line and without a reason. */
  missingCents: number;
  /** Lines nobody explained yet. */
  unexplainedCents: number;
}

export interface MonthRecon {
  month: YearMonth;
  openingCents: number;
  plannedInCents: number;
  plannedOutCents: number;
  plannedEndCents: number;
  realInCents: number;
  realOutCents: number;
  realEndCents: number;
  /** real − planned. Equals the sum of the buckets. */
  diffCents: number;
  buckets: MonthBuckets;
  lines: LineStatus[];
  items: ItemStatus[];
  /** Groups touching the month with a difference, for the list of amount differences. */
  diffGroups: MatchGroup[];
}

/** One calendar month: planned vs real, and the difference explained bucket by bucket. */
export function monthRecon(state: NsState, rec: Reconciliation, month: YearMonth): MonthRecon | null {
  const all = accountMovements(state, rec.accountId);
  if (!all.length) return null;
  const opening = realBalanceAt(state, rec.accountId, addDays(firstDay(month), -1))
    ?? (monthOf(all[0].date) === month ? all[0].balanceAfterCents - all[0].amountCents : null);
  const realEnd = realBalanceAt(state, rec.accountId, lastDay(month));
  if (opening == null || realEnd == null) return null;

  const lines = [...rec.lines.values()].filter(l => monthOf(l.movement.date) === month);
  const items = [...rec.items.values()].filter(i => monthOf(i.item.date) === month).sort((a, b) => byDate(a.item, b.item));
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const plannedIn = sum(items.map(i => i.item.amountCents).filter(a => a > 0));
  const plannedOut = sum(items.map(i => i.item.amountCents).filter(a => a < 0));

  const buckets: MonthBuckets = { adhocCents: 0, amountDiffCents: 0, otherMonthCents: 0, explainedMissingCents: 0, missingCents: 0, unexplainedCents: 0 };
  for (const l of lines) {
    if (l.state === 'classificado' || l.state === 'classificacao-sugerida') buckets.adhocCents += l.movement.amountCents;
    if (l.state === 'por-explicar') buckets.unexplainedCents += l.movement.amountCents;
  }
  for (const i of items) {
    if (i.state === 'explicado') buckets.explainedMissingCents -= i.item.amountCents;
    if (i.state === 'sem-movimento' || i.state === 'futuro') buckets.missingCents -= i.item.amountCents;
  }
  const touched = new Set<number>();
  for (const l of lines) { const g = rec.groupOfLine.get(l.movement.id); if (g !== undefined) touched.add(g); }
  for (const i of items) { const g = rec.groupOfItem.get(i.item.id); if (g !== undefined) touched.add(g); }
  const diffGroups: MatchGroup[] = [];
  for (const k of touched) {
    const g = rec.groups[k];
    const lIn = g.lineIds.filter(id => monthOf(rec.lines.get(id)!.movement.date) === month);
    const iIn = g.itemIds.filter(id => monthOf(rec.items.get(id)!.item.date) === month);
    const delta = sum(lIn.map(id => rec.lines.get(id)!.movement.amountCents)) - sum(iIn.map(id => rec.items.get(id)!.item.amountCents));
    if (lIn.length === g.lineIds.length && iIn.length === g.itemIds.length) {
      buckets.amountDiffCents += delta;
      if (delta !== 0) diffGroups.push(g);
    } else {
      buckets.otherMonthCents += delta;
    }
  }

  return {
    month,
    openingCents: opening,
    plannedInCents: plannedIn,
    plannedOutCents: plannedOut,
    plannedEndCents: opening + plannedIn + plannedOut,
    realInCents: sum(lines.map(l => l.movement.amountCents).filter(a => a > 0)),
    realOutCents: sum(lines.map(l => l.movement.amountCents).filter(a => a < 0)),
    realEndCents: realEnd,
    diffCents: realEnd - (opening + plannedIn + plannedOut),
    buckets,
    lines: lines.sort((a, b) => a.movement.date.localeCompare(b.movement.date) || a.movement.seq - b.movement.seq),
    items,
    diffGroups,
  };
}

export const bucketsTotal = (b: MonthBuckets) =>
  b.adhocCents + b.amountDiffCents + b.otherMonthCents + b.explainedMissingCents + b.missingCents + b.unexplainedCents;
