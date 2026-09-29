import { FamilyGroup, isUnpaid, isOverdue } from '../subscriptions/model';

/**
 * The variables an admin can put in an email. One email goes to each family,
 * so child/subscription values are lists ("Ana e Rui").
 *
 * Child and subscription variables describe the family's subscriptions that
 * matched the audience filters (an email "to the parents at Escola X" names the
 * child at Escola X, not a sibling elsewhere). Family and billing variables
 * always describe the whole family.
 */
export type VariableKey =
  | 'encarregado' | 'primeiroNome' | 'email' | 'telefone' | 'morada' | 'nif'
  | 'criancas' | 'criancasPrimeiroNome' | 'escolas' | 'anosEscolares' | 'moradaCasa'
  | 'servicos' | 'mensalidadeTotal'
  | 'valorEmDivida' | 'mesesEmAtraso' | 'proximaMensalidade' | 'proximaMensalidadeValor' | 'proximaMensalidadeData';

export interface VariableDef { key: VariableKey; label: string; group: string; example: string }

export const VARIABLES: VariableDef[] = [
  { key: 'encarregado', label: 'Nome do encarregado', group: 'Encarregado', example: 'Maria Silva' },
  { key: 'primeiroNome', label: 'Primeiro nome do encarregado', group: 'Encarregado', example: 'Maria' },
  { key: 'email', label: 'Email', group: 'Encarregado', example: 'maria@exemplo.pt' },
  { key: 'telefone', label: 'Telefone', group: 'Encarregado', example: '912 345 678' },
  { key: 'morada', label: 'Morada de faturação', group: 'Encarregado', example: 'Rua A 1, 3000-000 Coimbra' },
  { key: 'nif', label: 'NIF', group: 'Encarregado', example: '123456789' },

  { key: 'criancas', label: 'Nome das crianças', group: 'Crianças', example: 'Ana Silva e Rui Silva' },
  { key: 'criancasPrimeiroNome', label: 'Primeiro nome das crianças', group: 'Crianças', example: 'Ana e Rui' },
  { key: 'escolas', label: 'Escola', group: 'Crianças', example: 'Escola Quinta das Flores' },
  { key: 'anosEscolares', label: 'Ano escolar', group: 'Crianças', example: '3.º ano' },
  { key: 'moradaCasa', label: 'Morada de casa', group: 'Crianças', example: 'Rua B 2, Coimbra' },

  { key: 'servicos', label: 'Serviços', group: 'Inscrições', example: 'Sala de Estudo e Transporte' },
  { key: 'mensalidadeTotal', label: 'Mensalidade total', group: 'Inscrições', example: '€150.00' },

  { key: 'valorEmDivida', label: 'Valor em atraso', group: 'Pagamentos', example: '€150.00' },
  { key: 'mesesEmAtraso', label: 'Meses em atraso', group: 'Pagamentos', example: 'Setembro 2026' },
  { key: 'proximaMensalidade', label: 'Próxima mensalidade (mês)', group: 'Pagamentos', example: 'Outubro 2026' },
  { key: 'proximaMensalidadeValor', label: 'Próxima mensalidade (valor)', group: 'Pagamentos', example: '€150.00' },
  { key: 'proximaMensalidadeData', label: 'Próxima mensalidade (vence)', group: 'Pagamentos', example: '08/10/2026' },
];

export const VARIABLE_LABEL = Object.fromEntries(VARIABLES.map(v => [v.key, v.label])) as Record<VariableKey, string>;
const KNOWN = new Set<string>(VARIABLES.map(v => v.key));

export type VariableValues = Partial<Record<VariableKey, string>>;

/** "A", "A e B", "A, B e C". */
export function joinPt(list: (string | undefined | null)[]): string {
  const xs = Array.from(new Set(list.map(s => (s ?? '').trim()).filter(Boolean)));
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`;
}

const eur = (n: number) => `€${n.toFixed(2)}`;
const firstWord = (s?: string) => (s ?? '').trim().split(/\s+/)[0] ?? '';
const addr = (a?: { street?: string; postalCode?: string; city?: string }) =>
  a ? [a.street, [a.postalCode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';

/**
 * Values for one family. `matchedItemKeys` (`<type>-<id>`) limits child and
 * subscription variables to the subscriptions the audience matched; when
 * empty (a family with no subscriptions), every child counts.
 */
export function familyValues(
  g: FamilyGroup,
  matchedItemKeys: Set<string>,
  homeAddressOf: (childId: string) => { street?: string; postalCode?: string; city?: string } | undefined,
): VariableValues {
  const itemKey = (i: { _type: string; id: string }) => `${i._type}-${i.id}`;
  const kids = g.children
    .map(c => ({ ...c, items: c.items.filter(i => matchedItemKeys.has(itemKey(i))) }))
    .filter(c => c.items.length > 0);
  const children = kids.length ? kids : g.children;
  const items = children.flatMap(c => c.items).filter(i => i.status !== 'cancelled');

  const unpaid = g.bills.filter(isUnpaid).sort((a, b) => a.periodKey.localeCompare(b.periodKey));
  const overdue = unpaid.filter(b => isOverdue(b));
  const next = unpaid.find(b => !isOverdue(b));

  const hasStudy = items.some(i => i._type === 'study');
  const hasTransport = items.some(i => i._type === 'transport');
  const fee = items.reduce((s, i) => s + (i._type === 'study' ? i.monthlyPrice ?? 0 : i.monthlyFee ?? 0), 0);

  return {
    encarregado: g.contactName ?? '',
    primeiroNome: firstWord(g.contactName),
    email: g.contactEmail ?? '',
    telefone: g.contactPhone ?? '',
    morada: addr(g.family?.billingAddress),
    nif: g.family?.nif ?? '',
    criancas: joinPt(children.map(c => c.childName)),
    criancasPrimeiroNome: joinPt(children.map(c => firstWord(c.childName))),
    escolas: joinPt(children.map(c => c.schoolName)),
    anosEscolares: joinPt(children.map(c => c.schoolYear)),
    moradaCasa: joinPt(children.map(c => (c.childId ? addr(homeAddressOf(c.childId)) : ''))),
    servicos: joinPt([hasStudy ? 'Sala de Estudo' : '', hasTransport ? 'Transporte' : '']),
    mensalidadeTotal: items.length ? eur(fee) : '',
    valorEmDivida: overdue.length ? eur(overdue.reduce((s, b) => s + b.total, 0)) : '',
    mesesEmAtraso: joinPt(overdue.map(b => b.periodLabel)),
    proximaMensalidade: next?.periodLabel ?? '',
    proximaMensalidadeValor: next ? eur(next.total) : '',
    proximaMensalidadeData: next?.dueDate ? next.dueDate.toLocaleDateString('pt-PT') : '',
  };
}

export const EXAMPLE_VALUES: VariableValues =
  Object.fromEntries(VARIABLES.map(v => [v.key, v.example])) as VariableValues;

// ─── Templates ───────────────────────────────────────────────────────────────
// The body is the editor's HTML, where a variable is
// `<span data-variable="key">Label</span>`. The subject is plain text with
// `{{key}}`. Both forms are accepted in both places.

const SPAN_RE = /<span[^>]*data-variable="(\w+)"[^>]*>.*?<\/span>/g;
const TOKEN_RE = /\{\{(\w+)\}\}/g;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Variables a template uses, in order of first appearance. */
export function usedVariables(...templates: string[]): VariableKey[] {
  const out: string[] = [];
  for (const t of templates) {
    for (const re of [SPAN_RE, TOKEN_RE]) {
      for (const m of t.matchAll(re)) if (KNOWN.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
    }
  }
  return out as VariableKey[];
}

export function renderSubject(tpl: string, v: VariableValues): string {
  return tpl.replace(TOKEN_RE, (_, k) => v[k as VariableKey] ?? '').replace(SPAN_RE, (_, k) => v[k as VariableKey] ?? '');
}

export function renderBody(html: string, v: VariableValues): string {
  const fill = (_: string, k: string) => escapeHtml(v[k as VariableKey] ?? '');
  return html.replace(SPAN_RE, fill).replace(TOKEN_RE, fill);
}

/** The full email: rendered body inside a plain, mail-client-safe wrapper. */
export function wrapEmailHtml(bodyHtml: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:640px">${bodyHtml}</div>`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
