import { useState, useEffect } from 'react';
import { getDocs, getDoc, updateDoc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { DiscountRule, DiscountTrigger, DiscountScope, AppliedDiscount } from '@shared/models/Discount';
import { getDiscountRules, saveDiscountRules, resolveAutoDiscounts, applyDiscounts } from '../../services/discountService';
import { getTransportationConfig } from '../../services/transportationService';
import { activeWeeksInPattern } from '@shared/models/weekPattern';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TRIGGER_LABELS: Record<DiscountTrigger, string> = {
  auto_sibling: 'Auto — Irmão',
  auto_multitrip: 'Auto — Multi-viagem/dia',
  auto_school: 'Auto — Escola',
  manual: 'Manual (por inscrição)',
};
const TRIGGER_ICONS: Record<DiscountTrigger, string> = {
  auto_sibling: '👨‍👧', auto_multitrip: '🔄', auto_school: '🏫', manual: '✋',
};
const SCOPE_LABEL: Record<DiscountScope, string> = { study: '📚 Sala de Estudo', transport: '🚌 Transporte' };

function uid() { return Math.random().toString(36).slice(2, 10); }

const BLANK_RULE: Omit<DiscountRule, 'id'> = {
  name: '', percentage: 0, appliesTo: ['transport'], trigger: 'manual', active: true,
};

// ─── Bulk recalculate preview row ─────────────────────────────────────────────
interface RecalcRow {
  id: string; type: 'study' | 'transport';
  childName: string; contactName?: string; status: string;
  currentFee: number; newFee: number; grossFee: number;
  discountsApplied: AppliedDiscount[];
}

// ─── Rule Form ────────────────────────────────────────────────────────────────
function RuleForm({ initial, onSave, onCancel }: {
  initial: Partial<DiscountRule>;
  onSave: (r: DiscountRule) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Omit<DiscountRule, 'id'>>({
    name: initial.name ?? '',
    percentage: initial.percentage ?? 0,
    appliesTo: initial.appliesTo ?? ['transport'],
    trigger: initial.trigger ?? 'manual',
    active: initial.active ?? true,
    minTripsPerDay: initial.minTripsPerDay,
    schoolName: initial.schoolName,
  });

  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));

  const toggleScope = (s: DiscountScope) =>
    set({ appliesTo: form.appliesTo.includes(s) ? form.appliesTo.filter(x => x !== s) : [...form.appliesTo, s] });

  const isValid = form.name.trim().length > 0 && form.percentage > 0 && form.appliesTo.length > 0;

  const fieldCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400';

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-blue-900">{initial.id ? 'Editar desconto' : 'Novo desconto'}</h3>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-gray-500 mb-1 block">Nome *</label>
          <input value={form.name} onChange={e => set({ name: e.target.value })}
            placeholder="ex: Desconto de irmão" className={fieldCls} autoFocus />
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Percentagem *</label>
          <div className="relative">
            <input type="number" min={0} max={100} value={Math.round(form.percentage * 100)}
              onChange={e => set({ percentage: parseFloat(e.target.value) / 100 || 0 })}
              className={fieldCls + ' pr-7'} />
            <span className="absolute right-3 top-2 text-sm text-gray-400">%</span>
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Trigger</label>
          <select value={form.trigger} onChange={e => set({ trigger: e.target.value as DiscountTrigger })}
            className={fieldCls}>
            {(Object.keys(TRIGGER_LABELS) as DiscountTrigger[]).map(t => (
              <option key={t} value={t}>{TRIGGER_ICONS[t]} {TRIGGER_LABELS[t]}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Scope */}
      <div>
        <label className="text-xs text-gray-500 mb-1 block">Aplica a *</label>
        <div className="flex gap-2">
          {(['study', 'transport'] as DiscountScope[]).map(s => (
            <button key={s} type="button" onClick={() => toggleScope(s)}
              className={`text-sm px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                form.appliesTo.includes(s) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
              }`}>
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {/* Trigger-specific config */}
      {form.trigger === 'auto_multitrip' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Viagens mínimas por dia</label>
          <input type="number" min={2} value={form.minTripsPerDay ?? 2}
            onChange={e => set({ minTripsPerDay: parseInt(e.target.value) || 2 })}
            className={fieldCls} style={{ maxWidth: 120 }} />
        </div>
      )}
      {form.trigger === 'auto_school' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Nome da escola (correspondência parcial)</label>
          <input value={form.schoolName ?? ''} onChange={e => set({ schoolName: e.target.value })}
            placeholder="ex: Colégio Bissaya Barreto" className={fieldCls} />
        </div>
      )}

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
          <input type="checkbox" checked={form.active} onChange={e => set({ active: e.target.checked })}
            className="accent-blue-600" />
          Ativo
        </label>
      </div>

      <div className="flex gap-2">
        <button onClick={() => isValid && onSave({ id: initial.id ?? uid(), ...form })}
          disabled={!isValid}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
          Guardar
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-600">
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function DiscountsAdminPage() {
  const [rules, setRules] = useState<DiscountRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  // Migration
  const [migrationRules, setMigrationRules] = useState<DiscountRule[] | null>(null);
  const [migrating, setMigrating] = useState(false);

  // Bulk recalculate
  const [recalcRows, setRecalcRows] = useState<RecalcRow[] | null>(null);
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try { setRules(await getDiscountRules()); } finally { setLoading(false); }
  };

  const persist = async (updated: DiscountRule[]) => {
    setSaving(true);
    try { await saveDiscountRules(updated); setRules(updated); } finally { setSaving(false); }
  };

  const upsert = (rule: DiscountRule) => {
    const idx = rules.findIndex(r => r.id === rule.id);
    persist(idx >= 0 ? rules.map(r => r.id === rule.id ? rule : r) : [...rules, rule]);
    setEditId(null);
    setShowNew(false);
  };

  const remove = (id: string) => {
    if (!confirm('Eliminar este desconto?')) return;
    persist(rules.filter(r => r.id !== id));
  };

  const toggleActive = (id: string) =>
    persist(rules.map(r => r.id === id ? { ...r, active: !r.active } : r));

  // ── Migration ───────────────────────────────────────────────────────────────
  const previewMigration = async () => {
    setMigrating(true);
    try {
      const [tCfg, studySnap] = await Promise.all([
        getTransportationConfig(),
        getDoc(docRef('config', 'studyCenter')),
      ]);
      const studyCfg = studySnap.exists() ? studySnap.data() : null;
      const proposed: DiscountRule[] = [];

      if (tCfg?.multiTripDiscountPercentage && tCfg.multiTripDiscountPercentage > 0) {
        proposed.push({
          id: uid(), name: 'Multi-viagem', percentage: tCfg.multiTripDiscountPercentage,
          appliesTo: ['transport'], trigger: 'auto_multitrip', active: true,
          minTripsPerDay: tCfg.minTripsForDiscount ?? 2,
        });
      }
      if (tCfg?.siblingDiscountPercentage && tCfg.siblingDiscountPercentage > 0) {
        proposed.push({
          id: uid(), name: 'Desconto de irmão', percentage: tCfg.siblingDiscountPercentage,
          appliesTo: ['transport'], trigger: 'auto_sibling', active: true,
        });
      }
      // Returning student — merge transport + study into one rule if percentages match
      const tReturn = tCfg?.returningStudentDiscountPercentage ?? 0;
      const sReturn = studyCfg?.returningStudentDiscountPercentage ?? 0;
      if (tReturn > 0 || sReturn > 0) {
        const scopes: DiscountScope[] = [];
        if (tReturn > 0) scopes.push('transport');
        if (sReturn > 0) scopes.push('study');
        proposed.push({
          id: uid(), name: 'Aluno do ano anterior', percentage: tReturn || sReturn,
          appliesTo: scopes, trigger: 'manual', active: true,
        });
      }
      // School discounts from old transport config
      for (const sd of (tCfg?.schoolDiscounts ?? [])) {
        if (sd.discountPercentage > 0) {
          proposed.push({
            id: uid(), name: `Escola: ${sd.schoolName}`, percentage: sd.discountPercentage,
            appliesTo: ['transport'], trigger: 'auto_school', active: true,
            schoolName: sd.schoolName,
          });
        }
      }
      // Filter out rules that already exist (by name match)
      const existingNames = new Set(rules.map(r => r.name.toLowerCase()));
      setMigrationRules(proposed.filter(r => !existingNames.has(r.name.toLowerCase())));
    } finally { setMigrating(false); }
  };

  const applyMigration = async () => {
    if (!migrationRules?.length) return;
    setMigrating(true);
    try {
      await persist([...rules, ...migrationRules]);
      setMigrationRules(null);
    } finally { setMigrating(false); }
  };

  // ── Bulk recalculate ────────────────────────────────────────────────────────
  const recalculate = async () => {
    setRecalcLoading(true);
    setRecalcRows(null);
    try {
      const [transportSnap, studySnap, childrenSnap, tCfg] = await Promise.all([
        getDocs(col('transportationSubscriptions')),
        getDocs(col('studyroom')),
        getDocs(col('children')),
        getTransportationConfig(),
      ]);

      const childSchool: Record<string, string> = {};
      childrenSnap.docs.forEach(d => { if (d.data().schoolName) childSchool[d.id] = d.data().schoolName; });

      // Unified sibling map: all non-cancelled childIds per family across BOTH collections
      const familySiblingCounts: Record<string, Set<string>> = {};
      const addToSiblingMap = (docs: typeof transportSnap.docs) => {
        docs.forEach(d => {
          const x = d.data();
          if (x.familyId && x.status !== 'cancelled' && x.status !== 'canceled') {
            if (!familySiblingCounts[x.familyId]) familySiblingCounts[x.familyId] = new Set();
            if (x.childId) familySiblingCounts[x.familyId].add(x.childId);
          }
        });
      };
      addToSiblingMap(transportSnap.docs);
      addToSiblingMap(studySnap.docs);

      const rows: RecalcRow[] = [];

      for (const d of transportSnap.docs) {
        const x = d.data();
        if (x.status === 'cancelled') continue;
        const gross = (x.schedule?.length ?? 0) * (tCfg?.flatRatePerTrip ?? 0) * activeWeeksInPattern(x.weekPattern ?? 'all');
        const schoolName = x.childId ? (childSchool[x.childId] ?? x.schoolName) : x.schoolName;
        const siblingCount = x.familyId ? ((familySiblingCounts[x.familyId]?.size ?? 1) - 1) : 0;
        // Build minimal DayConfig representation for multi-trip check
        const dayMap: Record<string, number> = {};
        (x.schedule ?? []).forEach((s: any) => { dayMap[s.dayOfWeek] = (dayMap[s.dayOfWeek] ?? 0) + 1; });
        const fakeDays = Object.entries(dayMap).map(([weekday, count]) => ({
          weekday, hour: '', services: { transportTrips: Array(count).fill({ time: '', pickupAddress: 'x', dropoffAddress: 'x' }) },
        }));
        const discounts = resolveAutoDiscounts(rules, 'transport', fakeDays as any, schoolName, siblingCount);
        // Also preserve existing manual discounts
        const existing: AppliedDiscount[] = (x.appliedDiscounts ?? []).filter((ad: AppliedDiscount) => {
          const rule = rules.find(r => r.id === ad.ruleId);
          return rule?.trigger === 'manual';
        });
        const allDiscounts = [...discounts, ...existing];
        const grossFee = gross > 0 ? gross : (x.monthlyFee ?? 0);
        const newFee = applyDiscounts(grossFee, allDiscounts);
        rows.push({
          id: d.id, type: 'transport', childName: x.childName ?? '—',
          contactName: x.contactName ?? undefined, status: x.status,
          currentFee: x.monthlyFee ?? 0, newFee, grossFee, discountsApplied: allDiscounts,
        });
      }

      for (const d of studySnap.docs) {
        const x = d.data();
        if (x.status === 'cancelled' || x.status === 'archived') continue;
        const siblingCount = x.familyId ? ((familySiblingCounts[x.familyId]?.size ?? 1) - 1) : 0;
        const existing: AppliedDiscount[] = (x.appliedDiscounts ?? []).filter((ad: AppliedDiscount) => {
          const rule = rules.find(r => r.id === ad.ruleId);
          return rule?.trigger === 'manual';
        });
        const discounts = resolveAutoDiscounts(rules, 'study', [], x.schoolName, siblingCount);
        const allDiscounts = [...discounts, ...existing];
        const grossFee = x.basePrice ?? x.monthlyPrice ?? 0;
        const newFee = applyDiscounts(grossFee, allDiscounts);
        rows.push({
          id: d.id, type: 'study', childName: x.childName ?? x.studentName ?? '—',
          contactName: x.contactName ?? x.guardianName ?? undefined, status: x.status,
          currentFee: x.monthlyPrice ?? 0, newFee, grossFee, discountsApplied: allDiscounts,
        });
      }

      setRecalcRows(rows.sort((a, b) => a.childName.localeCompare(b.childName)));
    } finally { setRecalcLoading(false); }
  };

  const applyAll = async () => {
    if (!recalcRows) return;
    setApplying(true);
    try {
      await Promise.all(recalcRows.map(row => {
        const colName = row.type === 'transport' ? 'transportationSubscriptions' : 'studyroom';
        const feeField = row.type === 'transport' ? 'monthlyFee' : 'monthlyPrice';
        return updateDoc(docRef(colName, row.id), {
          [feeField]: row.newFee,
          appliedDiscounts: row.discountsApplied,
          updatedAt: new Date(),
        });
      }));
      setRecalcRows(null);
      alert(`${recalcRows.length} inscrições atualizadas com sucesso.`);
    } finally { setApplying(false); }
  };

  const toggleRowDiscount = (rowId: string, rule: DiscountRule) => {
    setRecalcRows(prev => prev?.map(row => {
      if (row.id !== rowId) return row;
      const isApplied = row.discountsApplied.some(d => d.ruleId === rule.id);
      const newDiscounts: AppliedDiscount[] = isApplied
        ? row.discountsApplied.filter(d => d.ruleId !== rule.id)
        : [...row.discountsApplied, { ruleId: rule.id, name: rule.name, percentage: rule.percentage, appliedAt: new Date(), appliedBy: 'admin' as const }];
      return { ...row, discountsApplied: newDiscounts, newFee: applyDiscounts(row.grossFee, newDiscounts) };
    }) ?? null);
  };

  if (loading) return <div className="flex justify-center items-center h-64 text-gray-500">A carregar…</div>;

  const activeRules = rules.filter(r => r.active);
  const inactiveRules = rules.filter(r => !r.active);

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold">Descontos</h1>
          <p className="text-sm text-gray-500 mt-0.5">{activeRules.length} ativo{activeRules.length !== 1 ? 's' : ''} · {rules.length} total</p>
        </div>
        <button onClick={() => { setShowNew(true); setEditId(null); }}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 font-medium">
          + Novo desconto
        </button>
      </div>

      {/* New rule form */}
      {showNew && (
        <RuleForm initial={BLANK_RULE} onSave={upsert} onCancel={() => setShowNew(false)} />
      )}

      {/* Rules list */}
      {rules.length === 0 && !showNew ? (
        <div className="bg-white rounded-xl border border-dashed border-gray-200 p-12 text-center text-gray-400">
          Nenhum desconto definido ainda. Crie o primeiro acima.
        </div>
      ) : (
        <div className="space-y-3">
          {[...activeRules, ...inactiveRules].map(rule => (
            editId === rule.id ? (
              <RuleForm key={rule.id} initial={rule} onSave={upsert} onCancel={() => setEditId(null)} />
            ) : (
              <div key={rule.id} className={`bg-white rounded-xl border p-4 flex items-start gap-4 ${rule.active ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
                <span className="text-2xl mt-0.5">{TRIGGER_ICONS[rule.trigger]}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">{rule.name}</span>
                    <span className="text-sm font-bold text-blue-700">−{Math.round(rule.percentage * 100)}%</span>
                    {!rule.active && <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">inativo</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-xs text-gray-500">{TRIGGER_LABELS[rule.trigger]}</span>
                    {rule.trigger === 'auto_multitrip' && rule.minTripsPerDay && (
                      <span className="text-xs text-gray-400">· ≥{rule.minTripsPerDay} viagens/dia</span>
                    )}
                    {rule.trigger === 'auto_school' && rule.schoolName && (
                      <span className="text-xs text-gray-400">· {rule.schoolName}</span>
                    )}
                    <span className="text-gray-300">·</span>
                    {rule.appliesTo.map(s => (
                      <span key={s} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{SCOPE_LABEL[s]}</span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => toggleActive(rule.id)} disabled={saving}
                    className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-colors disabled:opacity-50 ${
                      rule.active ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100' : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                    }`}>
                    {rule.active ? 'Ativo' : 'Inativo'}
                  </button>
                  <button onClick={() => setEditId(rule.id)} className="text-gray-400 hover:text-blue-600 text-sm p-1">✏️</button>
                  <button onClick={() => remove(rule.id)} className="text-gray-300 hover:text-red-500 text-sm p-1">🗑</button>
                </div>
              </div>
            )
          ))}
        </div>
      )}

      {/* Migration from old config */}
      {rules.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="font-semibold text-amber-900">Importar descontos existentes</h2>
              <p className="text-sm text-amber-700 mt-0.5">
                Detectamos que ainda não há regras definidas. Podemos importar os valores das configurações antigas de transporte e sala de estudo.
              </p>
            </div>
            <button onClick={previewMigration} disabled={migrating}
              className="bg-amber-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-amber-700 disabled:opacity-50 font-medium shrink-0 ml-4">
              {migrating ? 'A verificar…' : '🔍 Verificar'}
            </button>
          </div>

          {migrationRules !== null && (
            <>
              {migrationRules.length === 0 ? (
                <p className="text-sm text-amber-700">Nenhum desconto encontrado nas configurações antigas (ou todos já existem).</p>
              ) : (
                <>
                  <div className="space-y-2">
                    {migrationRules.map(r => (
                      <div key={r.id} className="bg-white rounded-lg border border-amber-200 px-4 py-2.5 flex items-center gap-3">
                        <span className="text-lg">{TRIGGER_ICONS[r.trigger]}</span>
                        <div className="flex-1">
                          <span className="font-medium text-gray-900 text-sm">{r.name}</span>
                          <span className="ml-2 text-sm font-bold text-blue-700">−{Math.round(r.percentage * 100)}%</span>
                          <span className="ml-2 text-xs text-gray-400">{TRIGGER_LABELS[r.trigger]}</span>
                          {r.trigger === 'auto_multitrip' && r.minTripsPerDay && (
                            <span className="ml-1 text-xs text-gray-400">· ≥{r.minTripsPerDay}/dia</span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          {r.appliesTo.map(s => (
                            <span key={s} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{SCOPE_LABEL[s]}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setMigrationRules(null)}
                      className="text-sm px-4 py-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-600">
                      Cancelar
                    </button>
                    <button onClick={applyMigration} disabled={migrating}
                      className="bg-amber-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-amber-700 disabled:opacity-50 font-medium">
                      {migrating ? 'A importar…' : `✓ Importar ${migrationRules.length} desconto${migrationRules.length !== 1 ? 's' : ''}`}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Bulk recalculate */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="font-semibold text-gray-900">Recalcular mensalidades</h2>
            <p className="text-sm text-gray-500 mt-0.5">Aplica os descontos ativos a todas as inscrições ativas e pendentes.</p>
          </div>
          <button onClick={recalculate} disabled={recalcLoading || activeRules.length === 0}
            className="bg-gray-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-gray-900 disabled:opacity-50 font-medium">
            {recalcLoading ? 'A calcular…' : '🔄 Pré-visualizar'}
          </button>
        </div>

        {recalcRows && (
          <>
            <div className="space-y-2">
              {recalcRows.map(row => {
                const changed = Math.abs(row.newFee - row.currentFee) > 0.001;
                const pct = (v: number) => `−${Math.round(v * 100)}%`;
                const appliedIds = new Set(row.discountsApplied.map(d => d.ruleId));
                const availableToAdd = rules.filter(r =>
                  r.active && r.appliesTo.includes(row.type) && !appliedIds.has(r.id)
                );
                return (
                  <div key={`${row.type}-${row.id}`}
                    className={`rounded-lg border px-4 py-3 ${changed ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
                    <div className="flex items-start gap-3">
                      <span className="text-lg mt-0.5 shrink-0">{row.type === 'transport' ? '🚌' : '📚'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-semibold text-gray-900 text-sm">{row.childName}</span>
                          {row.contactName && <span className="text-xs text-gray-400">{row.contactName}</span>}
                          <span className="text-xs text-gray-300">·</span>
                          <span className="text-xs text-gray-400">{row.status}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {/* Applied discounts — click to remove */}
                          {row.discountsApplied.map(d => {
                            const rule = rules.find(r => r.id === d.ruleId);
                            return (
                              <button key={d.ruleId}
                                onClick={() => rule && toggleRowDiscount(row.id, rule)}
                                className="text-xs px-2 py-0.5 rounded-full border border-blue-300 bg-blue-100 text-blue-800 font-medium hover:bg-blue-50 transition-colors"
                                title="Clique para remover">
                                ★ {d.name} {pct(d.percentage)}
                              </button>
                            );
                          })}
                          {/* Available rules not yet applied — click to add */}
                          {availableToAdd.map(r => (
                            <button key={r.id}
                              onClick={() => toggleRowDiscount(row.id, r)}
                              className="text-xs px-2 py-0.5 rounded-full border border-gray-200 bg-white text-gray-400 font-medium hover:border-gray-400 hover:text-gray-600 transition-colors"
                              title="Clique para aplicar">
                              ☆ {r.name} {pct(r.percentage)}
                            </button>
                          ))}
                          {row.discountsApplied.length === 0 && availableToAdd.length === 0 && (
                            <span className="text-xs text-gray-300">sem descontos</span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        {row.grossFee > row.newFee + 0.001 && (
                          <div className="text-xs text-gray-400 line-through">€{row.grossFee.toFixed(2)}</div>
                        )}
                        <div className={`text-sm font-bold ${(row.grossFee > row.newFee + 0.001 || changed) ? 'text-green-700' : 'text-gray-700'}`}>
                          €{row.newFee.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-gray-400">
                {recalcRows.filter(r => Math.abs(r.newFee - r.currentFee) > 0.001).length} inscrição(ões) com alteração
              </p>
              <div className="flex gap-2">
                <button onClick={() => setRecalcRows(null)}
                  className="text-sm px-4 py-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 text-gray-600">
                  Cancelar
                </button>
                <button onClick={applyAll} disabled={applying}
                  className="bg-green-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">
                  {applying ? 'A aplicar…' : '✓ Aplicar a todos'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
