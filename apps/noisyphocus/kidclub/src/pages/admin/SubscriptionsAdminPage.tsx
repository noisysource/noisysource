import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SubStatus } from '../../lib/utils';
import { familyKeyOf, SubItem } from './subscriptions/model';
import { DAY_PT } from './subscriptions/badges';
import { useAdminData } from './subscriptions/useAdminData';
import { useSubscriptionActions } from './subscriptions/useSubscriptionActions';
import {
  buildFamilyIndex, buildRows, buildFamilyGroup, groupRows, matchesChips, matchesSearch, familyLabel,
  Filters, DEFAULT_FILTERS, FLAG_TEST, FlagFilter, ServiceFilter, GroupBy, Row,
} from './subscriptions/listModel';
import { FamilyTags, SubscriptionTags } from './subscriptions/tags';
import FamilyPanel from './subscriptions/FamilyPanel';
import ManualEnrollForm from './subscriptions/ManualEnrollForm';

const STATUS_CHIPS: { key: SubStatus; label: string; on: string }[] = [
  { key: 'pending', label: 'Pendentes', on: 'bg-yellow-500 border-yellow-500' },
  { key: 'active', label: 'Ativas', on: 'bg-green-600 border-green-600' },
  { key: 'cancelled', label: 'Canceladas', on: 'bg-gray-600 border-gray-600' },
];
const SERVICE_CHIPS: { key: ServiceFilter; label: string }[] = [
  { key: 'transport', label: '🚌 Transporte' },
  { key: 'study', label: '📚 Sala de Estudo' },
];
// Only chips with something to show are rendered (plus any already selected),
// so the bar stays short on a quiet day.
const FLAG_CHIPS: { key: FlagFilter; label: string; on: string; title?: string }[] = [
  { key: 'adminReview', label: '🔔 Ação do cliente', on: 'bg-pink-600 border-pink-600', title: 'O encarregado fez uma alteração que precisa da sua revisão' },
  { key: 'clientReview', label: '⏳ Aguarda encarregado', on: 'bg-purple-600 border-purple-600' },
  { key: 'invoiceError', label: '🧾 Erro de fatura', on: 'bg-red-600 border-red-600' },
  { key: 'nifInvalid', label: 'NIF inválido', on: 'bg-red-600 border-red-600' },
  { key: 'overdue', label: '⏰ Em atraso', on: 'bg-red-600 border-red-600', title: 'Mensalidades por pagar depois da data de vencimento' },
  { key: 'unlinked', label: '🔗 Não vinculado', on: 'bg-orange-500 border-orange-500' },
  { key: 'feeReview', label: '⚠ Rever mensalidade', on: 'bg-amber-500 border-amber-500' },
  { key: 'noRoute', label: '🗺 Sem rota', on: 'bg-teal-600 border-teal-600' },
  { key: 'duplicate', label: '⚠ Possível duplicado', on: 'bg-orange-500 border-orange-500' },
];
const FAMILY_LEVEL_FLAGS: FlagFilter[] = ['invoiceError', 'overdue', 'nifInvalid', 'duplicate'];
const GROUP_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: 'family', label: 'Família' },
  { key: 'child', label: 'Criança' },
  { key: 'school', label: 'Escola' },
  { key: 'service', label: 'Serviço' },
  { key: 'status', label: 'Estado' },
  { key: 'none', label: 'Sem agrupar' },
];

const chipCls = (active: boolean, on = 'bg-gray-800 border-gray-800') =>
  `text-xs px-3 py-1.5 rounded-full border font-medium transition-colors whitespace-nowrap ${active ? `${on} text-white` : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`;

const toggle = <T,>(list: T[], v: T) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];

function scheduleSummary(item: SubItem): string {
  if (item._type === 'transport') {
    const days = [...new Set((item.schedule ?? []).map((s: any) => s.dayOfWeek))];
    const trips = (item.schedule ?? []).length;
    return `${days.map(d => DAY_PT[d] ?? d).join(', ')}${trips ? ` · ${trips} viage${trips !== 1 ? 'ns' : 'm'}` : ''}`;
  }
  return (item.days ?? [])
    .map((d: any) => typeof d === 'string' ? d : d?.day ?? d?.dayOfWeek ?? '')
    .map((d: string) => DAY_PT[d] ?? d).join(', ');
}

const monthly = (item: SubItem) => item._type === 'transport' ? (item.monthlyFee ?? 0) : (item.monthlyPrice ?? 0);

// ─── Page ────────────────────────────────────────────────────────────────────
// Families and their subscriptions, in one list. Search reaches every field;
// chips narrow by status, service and what needs attention; rows group by
// family (default), child, school, service or status. Clicking any row opens
// that family in the side panel, where everything is edited.
export default function SubscriptionsAdminPage() {
  const data = useAdminData();
  const actions = useSubscriptionActions(data);
  const [searchParams, setSearchParams] = useSearchParams();
  const openKey = searchParams.get('family');
  const highlightId = searchParams.get('highlight');

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>('family');
  const [showManualForm, setShowManualForm] = useState(false);

  const src = useMemo(() => ({ items: data.items, families: data.families, children: data.children, bills: data.bills }),
    [data.items, data.families, data.children, data.bills]);
  const { index, rows } = useMemo(() => {
    const index = buildFamilyIndex(src);
    return { index, rows: buildRows(src, index) };
  }, [src]);

  const searched = useMemo(() => rows.filter(r => matchesSearch(r, filters.search)), [rows, filters.search]);
  const visible = useMemo(() => searched.filter(r => matchesChips(r, filters)), [searched, filters]);
  const groups = useMemo(() => groupRows(visible, groupBy), [visible, groupBy]);
  const hiddenBySearchChips = filters.search.trim() ? searched.length - visible.length : 0;

  const count = useMemo(() => {
    const subRows = rows.filter(r => r.item);
    const byStatus = (s: SubStatus) => subRows.filter(r => r.item!.status === s).length;
    const byService = (s: ServiceFilter) => subRows.filter(r => r.item!._type === s).length;
    // Family-level flags count families, not their subscriptions.
    const byFlag = (f: FlagFilter) => FAMILY_LEVEL_FLAGS.includes(f)
      ? new Set(rows.filter(FLAG_TEST[f]).map(r => r.familyKey)).size
      : subRows.filter(FLAG_TEST[f]).length;
    return {
      status: Object.fromEntries(STATUS_CHIPS.map(c => [c.key, byStatus(c.key)])) as Record<SubStatus, number>,
      service: Object.fromEntries(SERVICE_CHIPS.map(c => [c.key, byService(c.key)])) as Record<ServiceFilter, number>,
      flag: Object.fromEntries(FLAG_CHIPS.map(c => [c.key, byFlag(c.key)])) as Record<FlagFilter, number>,
      empty: rows.length - subRows.length,
      families: new Set(rows.filter(r => !r.familyKey.startsWith('child:')).map(r => r.familyKey)).size,
    };
  }, [rows]);

  const isDefaultFilters = JSON.stringify({ ...filters, search: '' }) === JSON.stringify({ ...DEFAULT_FILTERS, search: '' });

  // ─── Panel / URL ───────────────────────────────────────────────────────────
  const openFamily = useCallback((familyKey: string, subId?: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('family', familyKey);
    if (subId) next.set('highlight', subId); else next.delete('highlight');
    // Opening pushes a history entry (Back closes the panel); switching
    // between families while it's open doesn't pile them up.
    setSearchParams(next, { replace: !!searchParams.get('family') });
  }, [searchParams, setSearchParams]);
  const closePanel = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('family'); next.delete('highlight');
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  // ?highlight=<subId> alone (Transport Planner's "Ver inscrição" link) opens
  // that subscription's family.
  useEffect(() => {
    if (data.isLoading || openKey || !highlightId) return;
    const target = data.items.find(i => i.id === highlightId);
    if (target) openFamily(familyKeyOf(target), target.id);
  }, [data.isLoading, data.items, openKey, highlightId, openFamily]);

  const openGroup = useMemo(() => openKey ? buildFamilyGroup(openKey, src, index) : null, [openKey, src, index]);
  const openFam = openKey ? index.get(openKey) : undefined;

  if (data.isLoading) return <div className="flex justify-center items-center h-64 text-gray-500">A carregar…</div>;
  if (data.error) return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6">
      <h2 className="font-semibold text-red-800 mb-2">Erro ao carregar</h2>
      <p className="text-red-700 text-sm mb-4">{data.error}</p>
      <button onClick={data.reload} className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 text-sm">Tentar novamente</button>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-start gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Famílias e inscrições</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {count.status.pending > 0 && <span className="text-yellow-700 font-medium">{count.status.pending} a analisar · </span>}
            {count.status.active} ativas · {count.families} famílias
            {count.flag.adminReview > 0 && <span className="text-pink-600 font-medium"> · {count.flag.adminReview} com ação do cliente</span>}
            {count.flag.invoiceError > 0 && <span className="text-red-600 font-medium"> · {count.flag.invoiceError} com erro de fatura</span>}
          </p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <button onClick={() => setShowManualForm(v => !v)}
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
            {showManualForm ? '✕ Cancelar' : '+ Inscrever'}
          </button>
          <button onClick={data.reload} disabled={data.refreshing} className="text-sm text-blue-600 hover:underline disabled:opacity-50"
            title="Recarregar a partir da base de dados (esta página não atualiza sozinha)">
            {data.refreshing ? 'A atualizar…' : '↻ Atualizar'}
          </button>
        </div>
      </div>

      {showManualForm && (
        <ManualEnrollForm
          transportConfig={data.transportConfig}
          studyConfig={data.studyConfig}
          discountRules={data.discountRules}
          onSave={newItems => { data.setItems(prev => [...newItems, ...prev]); setShowManualForm(false); }}
          onCancel={() => setShowManualForm(false)}
        />
      )}

      {/* Search + filters */}
      <div className="space-y-2.5 mb-5">
        <input
          type="search"
          value={filters.search}
          onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
          placeholder="Pesquisar em tudo: criança, encarregado, email, telefone, NIF, escola, morada, nota…"
          className="w-full text-sm border border-gray-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <div className="flex flex-wrap gap-1.5 items-center">
          {STATUS_CHIPS.map(c => (
            <button key={c.key} onClick={() => setFilters(f => ({ ...f, statuses: toggle(f.statuses, c.key) }))}
              className={chipCls(filters.statuses.includes(c.key), c.on)}>
              {c.label} <span className="opacity-70">{count.status[c.key]}</span>
            </button>
          ))}
          <span className="w-px h-5 bg-gray-200 mx-1" />
          {SERVICE_CHIPS.map(c => (
            <button key={c.key} onClick={() => setFilters(f => ({ ...f, services: toggle(f.services, c.key) }))}
              className={chipCls(filters.services.includes(c.key))}>
              {c.label} <span className="opacity-70">{count.service[c.key]}</span>
            </button>
          ))}
          <span className="w-px h-5 bg-gray-200 mx-1" />
          {FLAG_CHIPS.filter(c => count.flag[c.key] > 0 || filters.flags.includes(c.key)).map(c => (
            <button key={c.key} title={c.title} onClick={() => setFilters(f => ({ ...f, flags: toggle(f.flags, c.key) }))}
              className={chipCls(filters.flags.includes(c.key), c.on)}>
              {c.label} <span className="opacity-70">{count.flag[c.key]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 items-center text-xs text-gray-600">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={filters.showEmpty} className="accent-blue-600"
              onChange={e => setFilters(f => ({ ...f, showEmpty: e.target.checked }))} />
            Mostrar famílias sem inscrições ({count.empty})
          </label>
          <label className="flex items-center gap-1.5">
            Agrupar por
            <select value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)}
              className="border border-gray-200 rounded px-2 py-1 bg-white">
              {GROUP_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
          {!isDefaultFilters && (
            <button onClick={() => setFilters(f => ({ ...DEFAULT_FILTERS, search: f.search }))} className="text-blue-600 hover:underline">
              Repor filtros
            </button>
          )}
          <span className="ml-auto text-gray-400">{visible.filter(r => r.item).length} inscrições</span>
        </div>
        {hiddenBySearchChips > 0 && (
          <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5">
            Mais {hiddenBySearchChips} resultado{hiddenBySearchChips !== 1 ? 's' : ''} para esta pesquisa, escondido{hiddenBySearchChips !== 1 ? 's' : ''} pelos filtros.{' '}
            <button className="text-blue-600 hover:underline"
              onClick={() => setFilters(f => ({ ...f, statuses: [], services: [], flags: [], showEmpty: true }))}>
              Mostrar todos
            </button>
          </p>
        )}
      </div>

      {/* List */}
      {groups.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          Nada corresponde a estes filtros.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(g => (
            <div key={g.key} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {groupBy !== 'none' && (g.fam ? (
                <button onClick={() => openFamily(g.fam!.key)}
                  className={`w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left border-b border-gray-100 hover:bg-gray-50 ${openKey === g.fam.key ? 'bg-blue-50' : 'bg-gray-50/60'}`}>
                  <span className="text-sm">👨‍👩‍👧</span>
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-gray-800">{familyLabel(g.fam)}</span>
                    {g.fam.contactName && g.fam.contactEmail && (
                      <span className="text-xs text-gray-400 ml-2">{g.fam.contactEmail}{g.fam.contactPhone ? ` · ${g.fam.contactPhone}` : ''}</span>
                    )}
                  </span>
                  <FamilyTags fam={g.fam} />
                </button>
              ) : (
                <div className="px-4 py-2 border-b border-gray-100 bg-gray-50/60 text-sm font-semibold text-gray-700">
                  {g.label} <span className="text-xs font-normal text-gray-400 ml-1">{g.rows.length}</span>
                </div>
              ))}
              <div className="divide-y divide-gray-100">
                {g.rows.map(r => (
                  <ListRow key={r.key} row={r} showFamily={groupBy !== 'family'}
                    selected={openKey === r.familyKey}
                    onOpen={() => openFamily(r.familyKey, r.item?.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {openGroup && openFam && (
        <FamilyPanel
          group={openGroup}
          fam={openFam}
          data={data}
          actions={actions}
          highlightId={highlightId}
          onClose={closePanel}
          onFamilyKeyChange={key => openFamily(key)}
        />
      )}
    </div>
  );
}

function ListRow({ row, showFamily, selected, onOpen }: {
  row: Row;
  showFamily: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const { item } = row;
  return (
    <button onClick={onOpen}
      className={`w-full text-left px-4 py-2.5 flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-1 hover:bg-blue-50/50 ${selected ? 'bg-blue-50' : ''}`}>
      <span className="text-lg shrink-0 w-6 text-center">{item ? (item._type === 'study' ? '📚' : '🚌') : '👤'}</span>
      <span className="min-w-0 md:w-56 shrink-0">
        <span className="block text-sm font-medium text-gray-900 truncate">{row.childName}</span>
        <span className="block text-xs text-gray-400 truncate">
          {item ? (item._type === 'study' ? 'Sala de Estudo' : 'Transporte') : 'Sem inscrições'}
          {row.schoolName ? ` · ${row.schoolName}` : ''}
        </span>
      </span>
      {showFamily && (
        <span className="min-w-0 md:w-48 shrink-0 text-xs text-gray-500 truncate">{familyLabel(row.fam)}</span>
      )}
      <span className="text-xs text-gray-500 md:w-40 shrink-0 truncate">{item ? scheduleSummary(item) : ''}</span>
      <span className="flex-1 min-w-0 flex flex-wrap gap-1.5">
        {item && <SubscriptionTags item={item} />}
        {showFamily && <FamilyTags fam={row.fam} />}
      </span>
      {item && <span className="text-sm font-medium text-gray-700 shrink-0 w-24 text-right">€{monthly(item).toFixed(2)}/mês</span>}
    </button>
  );
}
