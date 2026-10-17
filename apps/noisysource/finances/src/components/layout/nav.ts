import type { LucideIcon } from 'lucide-react';
import {
  Banknote, BarChart2, ListChecks, Briefcase, CreditCard, FileText, Handshake,
  PiggyBank, Receipt, RefreshCw, Shield, Store, TrendingUp,
} from 'lucide-react';

export type EntityId = 'private' | 'noisysource' | 'noisyphocus';

export const ENTITY_OPTIONS: { id: EntityId; label: string; emoji: string }[] = [
  { id: 'private',     label: 'Casa',        emoji: '🏠' },
  { id: 'noisysource', label: 'NoisySource', emoji: '🏢' },
  { id: 'noisyphocus', label: 'NoisyPhocus', emoji: '📸' },
];

const COMPANIES: EntityId[] = ['noisysource', 'noisyphocus'];
const ALL: EntityId[] = ['private', ...COMPANIES];

export type NavItem = { feature: string; label: string; icon: LucideIcon; entities: EntityId[] };
export type NavGroup = { title: string; items: NavItem[] };

/**
 * One menu, same shape for every entity. The sidebar shows only the items
 * whose `entities` include the entity picked at the top; a group with no
 * items for that entity is hidden. Links are `/${entity}/${feature}`.
 */
export const ENTITY_NAV: NavGroup[] = [
  {
    title: 'Receitas',
    items: [
      { feature: 'income',       label: 'Rendimento', icon: Briefcase,  entities: ['private'] },
      // NoisySource-only until Clientes is generalised: Forecast/Dashboard
      // treat the first active ecContract they find as "the" EC contract.
      { feature: 'ec-contracts', label: 'Clientes',   icon: TrendingUp, entities: ['noisysource'] },
      { feature: 'revenue',      label: 'KidClub',    icon: Store,      entities: ['noisyphocus'] },
    ],
  },
  {
    title: 'Equipa',
    items: [
      { feature: 'contracts', label: 'Equipa', icon: FileText, entities: COMPANIES },
    ],
  },
  {
    title: 'Despesas',
    items: [
      { feature: 'recurring', label: 'Recorrentes',   icon: RefreshCw, entities: ALL },
      { feature: 'costs',     label: 'Despesas do mês', icon: PiggyBank, entities: ALL },
    ],
  },
  {
    title: 'Dinheiro',
    items: [
      { feature: 'accounts',   label: 'Contas',      icon: Banknote,  entities: ALL },
      { feature: 'movements',  label: 'Movimentos',  icon: ListChecks, entities: ALL },
      { feature: 'loans',      label: 'Empréstimos', icon: Handshake, entities: ['private'] },
      { feature: 'insurances', label: 'Seguros',     icon: Shield,    entities: ALL },
    ],
  },
  {
    title: 'Impostos',
    items: [
      { feature: 'irs', label: 'IRS', icon: Receipt, entities: ['private'] },
      { feature: 'vat', label: 'IVA', icon: Receipt, entities: COMPANIES },
    ],
  },
];

/** Pages that already show every entity together, whatever the URL entity. */
export const GLOBAL_NAV: { feature: string; label: string; icon: LucideIcon }[] = [
  { feature: 'forecast', label: 'Previsão', icon: BarChart2 },
  { feature: 'credits',  label: 'Créditos', icon: CreditCard },
];

export function isEntityId(v: unknown): v is EntityId {
  return v === 'private' || v === 'noisysource' || v === 'noisyphocus';
}

export function featureAvailable(feature: string, entity: EntityId): boolean {
  if (GLOBAL_NAV.some(g => g.feature === feature)) return true;
  return ENTITY_NAV.some(g => g.items.some(i => i.feature === feature && i.entities.includes(entity)));
}

const STORE_KEY = 'finhub:entity';

export function readStoredEntity(): EntityId | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return isEntityId(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredEntity(entity: EntityId): void {
  try { localStorage.setItem(STORE_KEY, entity); } catch { /* storage unavailable */ }
}
