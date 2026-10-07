import { normalizeName, SubStatus } from '../../../lib/utils';
import { isValidNif } from '../../../lib/nif';
import {
  SubItem, FamilyDoc, ChildDoc, BillRow, FamilyGroup, ChildGroup,
  familyKeyOf, locationStr, isOverdue, isUnlinked, needsAdminReview,
} from './model';

// ─── What the list is built from ─────────────────────────────────────────────
// One row per subscription. A family (or an unclaimed child) with no
// subscription at all gets a single placeholder row, shown only when the
// "sem inscrições" toggle is on. Every row belongs to a family key — the key
// the side panel opens on (see familyKeyOf).

export interface ListSource {
  items: SubItem[];
  families: Map<string, FamilyDoc>;
  children: Map<string, ChildDoc>;
  bills: BillRow[];
}

/** Family-level facts every row of that family shares. */
export interface FamilyInfo {
  key: string;
  familyId?: string;
  family?: FamilyDoc;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  bills: BillRow[];
  invoiceErrors: BillRow[];
  /** Unpaid bills past their due date. Future months don't count. */
  overdue: BillRow[];
  /** Another families/ doc has the same guardian email. */
  duplicate: boolean;
  /** A NIF is on file and fails the checksum — Vendus will refuse its invoices. */
  nifInvalid: boolean;
}

export interface Row {
  key: string;
  familyKey: string;
  /** Absent on a "no subscriptions" placeholder row. */
  item?: SubItem;
  childName: string;
  schoolName?: string;
  fam: FamilyInfo;
  /** Normalized text of every field shown or edited for this row. */
  haystack: string;
}

const MERGED_CHILD = 'merged';

const norm = (s: string | undefined | null) => normalizeName(s ?? '');

export function buildFamilyIndex(src: ListSource): Map<string, FamilyInfo> {
  const index = new Map<string, FamilyInfo>();
  const emailCount = new Map<string, number>();
  for (const f of src.families.values()) {
    const em = f.primaryContact?.email?.toLowerCase();
    if (em) emailCount.set(em, (emailCount.get(em) ?? 0) + 1);
  }
  const billsByFamily = new Map<string, BillRow[]>();
  for (const b of src.bills) {
    if (!b.familyId) continue;
    const list = billsByFamily.get(b.familyId) ?? [];
    list.push(b);
    billsByFamily.set(b.familyId, list);
  }

  const ensure = (key: string, familyId: string | undefined, fallback?: SubItem): FamilyInfo => {
    let info = index.get(key);
    if (info) return info;
    const family = familyId ? src.families.get(familyId) : undefined;
    const bills = (familyId ? billsByFamily.get(familyId) ?? [] : [])
      .slice().sort((a, b) => a.periodKey.localeCompare(b.periodKey));
    const email = family?.primaryContact?.email ?? fallback?.contactEmail;
    info = {
      key, familyId, family,
      contactName: family?.primaryContact?.name || fallback?.contactName,
      contactEmail: email,
      contactPhone: family?.primaryContact?.phone || fallback?.contactPhone,
      bills,
      invoiceErrors: bills.filter(b => b.invoiceError),
      overdue: bills.filter(b => isOverdue(b)),
      duplicate: !!family && (emailCount.get(email?.toLowerCase() ?? '') ?? 0) > 1,
      nifInvalid: !!family?.nif && !isValidNif(family.nif),
    };
    index.set(key, info);
    return info;
  };

  for (const item of src.items) ensure(familyKeyOf(item), item.familyId, item);
  for (const f of src.families.values()) ensure(f.id, f.id);
  return index;
}

export function buildRows(src: ListSource, index: Map<string, FamilyInfo>): Row[] {
  const rows: Row[] = [];
  const keysWithSubs = new Set<string>();
  const childIdsWithSubs = new Set<string>();

  const famText = (fam: FamilyInfo) => [
    fam.contactName, fam.contactEmail, fam.contactPhone, fam.familyId,
    fam.family?.nif, fam.family?.notes,
    fam.family?.billingAddress?.street, fam.family?.billingAddress?.city, fam.family?.billingAddress?.postalCode,
    ...fam.bills.map(b => b.invoiceNumber),
  ];
  const childText = (c: ChildDoc | undefined) => [
    c?.firstName, c?.lastName, c?.schoolName, c?.schoolYear,
    // Legacy child address (no longer written); family billingAddress is in famText.
    c?.homeAddress?.street, c?.homeAddress?.city, c?.homeAddress?.postalCode,
  ];

  for (const item of src.items) {
    const familyKey = familyKeyOf(item);
    keysWithSubs.add(familyKey);
    if (item.childId) childIdsWithSubs.add(item.childId);
    const fam = index.get(familyKey)!;
    const child = item.childId ? src.children.get(item.childId) : undefined;
    const scheduleText = item._type === 'transport'
      ? (item.schedule ?? []).flatMap((s: any) => [locationStr(s.pickupLocation), locationStr(s.dropoffLocation)])
      : [];
    rows.push({
      key: `${item._type}-${item.id}`,
      familyKey,
      item,
      childName: item.childName,
      schoolName: item.schoolName,
      fam,
      haystack: norm([
        item.childName, item.schoolName, item.schoolYear, item.note, item.statusReason,
        item.id, item.childId,
        item._type === 'study' ? 'sala de estudo' : 'transporte',
        ...scheduleText, ...famText(fam), ...childText(child),
      ].filter(Boolean).join(' | ')),
    });
  }

  // Families registered without any subscription.
  const childrenByFamily = new Map<string, ChildDoc[]>();
  for (const c of src.children.values()) {
    if (c.status === MERGED_CHILD || !c.familyId) continue;
    const list = childrenByFamily.get(c.familyId) ?? [];
    list.push(c);
    childrenByFamily.set(c.familyId, list);
  }
  for (const f of src.families.values()) {
    if (keysWithSubs.has(f.id)) continue;
    const fam = index.get(f.id)!;
    const kids = childrenByFamily.get(f.id) ?? [];
    const names = kids.map(c => `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()).filter(Boolean);
    rows.push({
      key: `empty-${f.id}`, familyKey: f.id, fam,
      childName: names.join(', ') || 'Sem crianças registadas',
      haystack: norm([...names, ...famText(fam), 'sem inscricoes'].filter(Boolean).join(' | ')),
    });
  }

  // Children that belong to no known family and hold no subscription —
  // typically admin-created and never claimed.
  for (const c of src.children.values()) {
    if (c.status === MERGED_CHILD || childIdsWithSubs.has(c.id)) continue;
    if (c.familyId && src.families.has(c.familyId)) continue;
    const key = `child:${c.id}`;
    const fam: FamilyInfo = {
      key, bills: [], invoiceErrors: [], overdue: [], duplicate: false, nifInvalid: false,
    };
    index.set(key, fam);
    const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '—';
    rows.push({
      key: `empty-${key}`, familyKey: key, fam, childName: name, schoolName: c.schoolName,
      haystack: norm([name, c.schoolName, c.id, ...childText(c), 'sem familia sem inscricoes'].filter(Boolean).join(' | ')),
    });
  }
  return rows;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export type ServiceFilter = 'transport' | 'study';
export type FlagFilter =
  | 'adminReview' | 'clientReview' | 'unlinked' | 'feeReview' | 'noRoute'
  | 'invoiceError' | 'overdue' | 'nifInvalid' | 'duplicate';

export interface Filters {
  statuses: SubStatus[];
  services: ServiceFilter[];
  flags: FlagFilter[];
  search: string;
  showEmpty: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  statuses: ['pending', 'active'],
  services: [],
  flags: [],
  search: '',
  showEmpty: false,
};

export const FLAG_TEST: Record<FlagFilter, (r: Row) => boolean> = {
  adminReview: r => !!r.item && needsAdminReview(r.item),
  clientReview: r => !!r.item?.clientReviewPending,
  unlinked: r => !!r.item && isUnlinked(r.item),
  feeReview: r => !!r.item?.feeReviewRequired,
  noRoute: r => r.item?._type === 'transport' && r.item.status !== 'cancelled' && !r.item.routeAssigned,
  invoiceError: r => r.fam.invoiceErrors.length > 0,
  overdue: r => r.fam.overdue.length > 0,
  nifInvalid: r => r.fam.nifInvalid,
  duplicate: r => r.fam.duplicate,
};

/** Every search word must appear somewhere in the row, in any field. */
export function matchesSearch(row: Row, search: string): boolean {
  const words = norm(search).split(' ').filter(Boolean);
  return words.every(w => row.haystack.includes(w));
}

/** Status / service / flag chips only — search is applied separately. */
export function matchesChips(row: Row, f: Filters): boolean {
  if (!row.item) return f.showEmpty && f.services.length === 0
    && (f.flags.length === 0 || f.flags.some(fl => FLAG_TEST[fl](row)));
  if (f.statuses.length && !f.statuses.includes(row.item.status)) return false;
  if (f.services.length && !f.services.includes(row.item._type)) return false;
  // Flags narrow to rows needing any of the selected kinds of attention.
  if (f.flags.length && !f.flags.some(fl => FLAG_TEST[fl](row))) return false;
  return true;
}

// ─── Grouping ────────────────────────────────────────────────────────────────

export type GroupBy = 'family' | 'child' | 'school' | 'service' | 'status' | 'none';

export interface RowGroup {
  key: string;
  label: string;
  /** Set when the group is one family — the header then opens its panel. */
  fam?: FamilyInfo;
  rows: Row[];
}

const STATUS_ORDER: Record<SubStatus, number> = { pending: 0, active: 1, cancelled: 2 };
const STATUS_GROUP_LABEL: Record<SubStatus, string> = { pending: 'Pendentes', active: 'Ativas', cancelled: 'Canceladas' };

/** Needs a decision from the admin: a pending request or a client action to review. */
export const needsAttention = (r: Row) =>
  !!r.item && (r.item.status === 'pending' || needsAdminReview(r.item));

const rowOrder = (a: Row, b: Row) =>
  Number(needsAttention(b)) - Number(needsAttention(a))
  || (a.item ? STATUS_ORDER[a.item.status] : 3) - (b.item ? STATUS_ORDER[b.item.status] : 3)
  || a.childName.localeCompare(b.childName, 'pt');

export function familyLabel(fam: FamilyInfo): string {
  return fam.contactName || fam.contactEmail || (fam.key.startsWith('child:') ? 'Sem família' : 'Sem conta vinculada');
}

export function groupRows(rows: Row[], by: GroupBy): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  const put = (key: string, label: string, row: Row, fam?: FamilyInfo) => {
    let g = groups.get(key);
    if (!g) { g = { key, label, fam, rows: [] }; groups.set(key, g); }
    g.rows.push(row);
  };
  for (const r of rows) {
    switch (by) {
      case 'family': put(r.familyKey, familyLabel(r.fam), r, r.fam); break;
      case 'child': put(r.item?.childId || `name:${normalizeName(r.childName)}`, r.childName, r); break;
      case 'school': put(norm(r.schoolName) || '~', r.schoolName || 'Sem escola', r); break;
      case 'service': put(r.item?._type ?? '~', r.item ? (r.item._type === 'study' ? 'Sala de Estudo' : 'Transporte') : 'Sem inscrições', r); break;
      case 'status': put(r.item ? String(STATUS_ORDER[r.item.status]) : '9', r.item ? STATUS_GROUP_LABEL[r.item.status] : 'Sem inscrições', r); break;
      case 'none': put('all', '', r); break;
    }
  }
  const list = Array.from(groups.values());
  for (const g of list) g.rows.sort(rowOrder);
  if (by === 'status' || by === 'service') return list.sort((a, b) => a.key.localeCompare(b.key));
  return list.sort((a, b) =>
    Number(b.rows.some(needsAttention)) - Number(a.rows.some(needsAttention))
    || (a.key === '~' ? 1 : 0) - (b.key === '~' ? 1 : 0)
    || a.label.localeCompare(b.label, 'pt'));
}

// ─── One family, for the side panel ──────────────────────────────────────────

/**
 * Everything the panel shows for one family key: all of its subscriptions
 * (never filtered — the panel is the full picture), grouped by child, plus
 * children registered to the family without a subscription.
 */
export function buildFamilyGroup(familyKey: string, src: ListSource, index: Map<string, FamilyInfo>): FamilyGroup | null {
  const fam = index.get(familyKey);
  if (!fam) return null;
  const items = src.items.filter(i => familyKeyOf(i) === familyKey);

  const children: ChildGroup[] = [];
  for (const item of items) {
    // childId is the real identity. A subscription with none yet falls back
    // to the normalized name, so an unlinked transport + study pair for the
    // same kid still collapses into one row rather than appearing twice.
    const childKey = item.childId || `name:${normalizeName(item.childName)}` || item.id;
    let kid = children.find(c => c.key === childKey);
    if (!kid) {
      kid = {
        key: childKey, childId: item.childId, familyId: item.familyId,
        childName: item.childName, schoolName: item.schoolName, schoolYear: item.schoolYear,
        items: [],
      };
      children.push(kid);
    }
    // Both subscriptions resolve school from the same child document, so
    // these agree — ?? only covers a child record that has no value at all.
    kid.schoolName ??= item.schoolName;
    kid.schoolYear ??= item.schoolYear;
    kid.items.push(item);
  }

  const extraChildren = familyKey.startsWith('child:')
    ? [src.children.get(familyKey.slice('child:'.length))].filter(Boolean) as ChildDoc[]
    : fam.familyId
      ? Array.from(src.children.values()).filter(c => c.familyId === fam.familyId && c.status !== MERGED_CHILD)
      : [];
  for (const c of extraChildren) {
    if (children.some(k => k.childId === c.id)) continue;
    children.push({
      key: c.id, childId: c.id, familyId: c.familyId || undefined,
      childName: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '—',
      schoolName: c.schoolName, schoolYear: c.schoolYear, items: [],
    });
  }
  children.sort((a, b) => a.childName.localeCompare(b.childName, 'pt'));

  return {
    key: familyKey,
    label: familyLabel(fam),
    familyId: fam.familyId,
    contactName: fam.contactName,
    contactEmail: fam.contactEmail,
    contactPhone: fam.contactPhone,
    children,
    count: items.length,
    family: fam.family,
    bills: fam.bills,
  };
}
