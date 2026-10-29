import type { CheckStatus } from '@shared/finhub/noisysource/acceptance';
import type { ItemState, LineState } from '@shared/finhub/noisysource/reconcile';
import { Badge } from './ui';

const CHECK: Record<CheckStatus, { tone: 'emerald' | 'sky' | 'red' | 'zinc'; label: string; title: string }> = {
  ok: { tone: 'emerald', label: 'passa', title: 'Passa com o que já foi confirmado' },
  sugerido: { tone: 'sky', label: 'passa com sugestões', title: 'Passa quando as sugestões forem confirmadas' },
  falha: { tone: 'red', label: 'não passa', title: 'Ver os detalhes' },
  na: { tone: 'zinc', label: '—', title: 'Nada a verificar ainda' },
};

export function CheckBadge({ status, title }: { status: CheckStatus; title?: string }) {
  const c = CHECK[status];
  return <Badge tone={c.tone} title={title ?? c.title}>{c.label}</Badge>;
}

export const LINE_STATE: Record<LineState, { tone: 'emerald' | 'sky' | 'red' | 'zinc' | 'amber'; label: string }> = {
  confirmado: { tone: 'emerald', label: 'confirmada' },
  classificado: { tone: 'emerald', label: 'ocasional' },
  sugerido: { tone: 'sky', label: 'sugestão' },
  'classificacao-sugerida': { tone: 'sky', label: 'ocasional?' },
  'por-explicar': { tone: 'red', label: 'por explicar' },
};

export const ITEM_STATE: Record<ItemState, { tone: 'emerald' | 'sky' | 'red' | 'zinc' | 'amber'; label: string }> = {
  confirmado: { tone: 'emerald', label: 'no banco' },
  sugerido: { tone: 'sky', label: 'no banco?' },
  explicado: { tone: 'amber', label: 'sem movimento (razão)' },
  'sem-movimento': { tone: 'red', label: 'sem movimento' },
  futuro: { tone: 'zinc', label: 'por vir' },
};
