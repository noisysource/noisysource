import { ListSource, FamilyInfo, Filters, FlagFilter, ServiceFilter, buildFamilyIndex, buildRows, buildFamilyGroup, matchesChips, matchesSearch, familyLabel } from '../subscriptions/listModel';
import { SubStatus, normalizeName } from '../../../lib/utils';
import { FamilyGroup } from '../subscriptions/model';
import { familyValues, VariableValues } from './variables';

/**
 * Who an email goes to. Same status / service / flag chips as the families
 * page, plus school. A family is in the audience if any of its subscriptions
 * matches; it receives one email.
 */
export interface AudienceFilters extends Filters {
  schools: string[];
}

export const DEFAULT_AUDIENCE: AudienceFilters = {
  statuses: ['active'],
  services: [],
  flags: [],
  search: '',
  showEmpty: false,
  schools: [],
};

export interface Recipient {
  familyKey: string;
  familyId?: string;
  label: string;
  email?: string;
  values: VariableValues;
}

export interface AudienceSource extends ListSource {
  index: Map<string, FamilyInfo>;
}

export function prepareSource(src: ListSource): AudienceSource {
  return { ...src, index: buildFamilyIndex(src) };
}

export const schoolKey = (s?: string) => normalizeName(s ?? '');

/** Every school named on a subscription, for the filter chips. */
export function schoolOptions(src: AudienceSource): string[] {
  const byKey = new Map<string, string>();
  for (const r of buildRows(src, src.index)) {
    if (r.schoolName && !byKey.has(schoolKey(r.schoolName))) byKey.set(schoolKey(r.schoolName), r.schoolName);
  }
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, 'pt'));
}

export function buildAudience(src: AudienceSource, f: AudienceFilters): Recipient[] {
  const schools = new Set(f.schools.map(schoolKey));
  const matched = new Map<string, Set<string>>();
  for (const row of buildRows(src, src.index)) {
    if (!matchesChips(row, f) || !matchesSearch(row, f.search)) continue;
    if (schools.size && !schools.has(schoolKey(row.schoolName))) continue;
    const keys = matched.get(row.familyKey) ?? new Set<string>();
    if (row.item) keys.add(`${row.item._type}-${row.item.id}`);
    matched.set(row.familyKey, keys);
  }

  const homeAddressOf = (childId: string) => src.children.get(childId)?.homeAddress;
  const out: Recipient[] = [];
  for (const [familyKey, itemKeys] of matched) {
    const group = buildFamilyGroup(familyKey, src, src.index) as FamilyGroup | null;
    if (!group) continue;
    out.push({
      familyKey,
      familyId: group.familyId,
      label: familyLabel(src.index.get(familyKey)!),
      email: group.contactEmail?.trim() || undefined,
      values: familyValues(group, itemKeys, homeAddressOf),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'pt'));
}

export const STATUS_OPTIONS: { value: SubStatus; label: string }[] = [
  { value: 'active', label: 'Ativas' },
  { value: 'pending', label: 'Pendentes' },
  { value: 'cancelled', label: 'Canceladas' },
];

export const SERVICE_OPTIONS: { value: ServiceFilter; label: string }[] = [
  { value: 'study', label: 'Sala de Estudo' },
  { value: 'transport', label: 'Transporte' },
];

/** The flags that make sense as an email audience. */
export const FLAG_OPTIONS: { value: FlagFilter; label: string }[] = [
  { value: 'overdue', label: 'Pagamentos em atraso' },
  { value: 'invoiceError', label: 'Fatura por emitir' },
  { value: 'nifInvalid', label: 'NIF inválido' },
  { value: 'clientReview', label: 'À espera do encarregado' },
];
