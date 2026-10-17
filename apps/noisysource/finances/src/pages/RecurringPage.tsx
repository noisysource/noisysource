import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RecurringEntryDoc, RecurringType, RecurringFrequency, RecurringCostModel } from "@shared/models/RecurringEntry";
import { recurringVatCode } from "@shared/models/RecurringEntry";
import { formatEUR } from "@shared/lib/money";
import { VAT_CODES, formatVatBreakdown, grossFromNet, vatCodeChargesVat, type VatCode } from "@shared/lib/vat";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { useEntity, ENTITIES } from "../hooks/EntityContext";
import type { CreditContractDoc } from "@shared/models/CreditContract";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { buildRecurringItems, groupRecurringItems, type RecurringItem, type RecurringItemKind } from "../lib/recurringItems";

const TYPE_LABELS: Record<RecurringType, string> = {
  expense: 'Despesa', income: 'Rendimento', transfer: 'Transferência',
};
const FREQ_LABELS: Record<RecurringFrequency, string> = {
  monthly: 'Mensal', quarterly: 'Trimestral', annual: 'Anual', once: 'Única vez',
};
const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
/** Badge for items Recorrentes shows but another page owns. */
const KIND_LABEL: Partial<Record<RecurringItemKind, string>> = {
  salary_cost: 'do contrato', salary: 'do contrato', benefit: 'do contrato', income_source: 'do rendimento',
  ec: 'do cliente', insurance: 'do seguro', credit: 'do crédito',
};
const ENTITY_TABS = [
  { id: 'private',     label: 'Casa',        emoji: '🏠' },
  { id: 'noisysource', label: 'NoisySource',  emoji: '🏢' },
  { id: 'noisyphocus', label: 'NoisyPhocus',  emoji: '📸' },
];

function currentYM(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}
function ymToMonths(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m;
}
function monthsOwed(entry: RecurringEntryDoc): number {
  const now = currentYM();
  const from = entry.lastReimbursedYM
    ? (() => {
        const [y, m] = entry.lastReimbursedYM.split('-').map(Number);
        const nm = m === 12 ? 1 : m + 1;
        const ny = m === 12 ? y + 1 : y;
        return `${ny}-${String(nm).padStart(2, '0')}`;
      })()
    : (entry.startYearMonth ?? now);
  if (from > now) return 0;
  return ymToMonths(now) - ymToMonths(from) + 1;
}

type Form = {
  type: RecurringType;
  description: string;
  amountEUR: string;
  accountId: string;
  toAccountId: string;
  categoryId: string;
  frequency: RecurringFrequency;
  dayOfMonth: string;
  monthOfYear: string;
  startYearMonth: string;
  endYearMonth: string;
  onceYearMonth: string;
  active: boolean;
  reimbursable: boolean;
  paidByAccountId: string;
  vatCode: VatCode;
  /** The typed amount includes VAT ("com IVA", default). Saved amounts always do. */
  amountIncludesVat: boolean;
  /** Synced from an employment contract or income source: VAT doesn't apply. */
  vatNotApplicable: boolean;
  /** Saved before the VAT convention: the old rate, shown as a hint until re-saved. */
  legacyUnconfirmed: boolean;
  legacyRatePct?: number;
  costModel: RecurringCostModel;
  commissionPct: string;
};
const emptyForm = (): Form => ({
  type: 'expense', description: '', amountEUR: '',
  accountId: '', toAccountId: '', categoryId: '', frequency: 'monthly',
  dayOfMonth: '1', monthOfYear: '1', startYearMonth: '',
  endYearMonth: '', onceYearMonth: '', active: true,
  reimbursable: false, paidByAccountId: '',
  vatCode: 'por_confirmar', amountIncludesVat: true, vatNotApplicable: false, legacyUnconfirmed: false,
  costModel: 'fixed', commissionPct: '',
});
function fromDoc(d: RecurringEntryDoc): Form {
  const vatCode = recurringVatCode(d);
  return {
    type: d.type, description: d.description,
    amountEUR: (d.amountCents / 100).toFixed(2),
    accountId: d.accountId ?? '', toAccountId: d.toAccountId ?? '', categoryId: d.categoryId ?? '',
    frequency: d.frequency, dayOfMonth: String(d.dayOfMonth),
    monthOfYear: String(d.monthOfYear ?? 1),
    startYearMonth: d.startYearMonth ?? '', endYearMonth: d.endYearMonth ?? '',
    onceYearMonth: d.onceYearMonth ?? '', active: d.active,
    reimbursable: d.reimbursable ?? false,
    paidByAccountId: d.paidByAccountId ?? '',
    vatCode: vatCode ?? 'por_confirmar',
    amountIncludesVat: true,
    vatNotApplicable: vatCode == null && d.type !== 'transfer',
    legacyUnconfirmed: d.vatCode === undefined && vatCode === 'por_confirmar',
    legacyRatePct: d.ivaRatePct,
    costModel: d.costModel === 'commission' ? 'commission' : 'fixed',
    commissionPct: d.commissionPct != null ? String(d.commissionPct) : '',
  };
}

/** VAT is chosen for company income/expenses only: not for Casa, transfers or synced pay. */
function formVatEditable(form: Form, isPrivate: boolean): boolean {
  return form.type !== 'transfer' && !isPrivate && !form.vatNotApplicable;
}

/** The amount as saved: always VAT-inclusive, converted when typed "sem IVA". */
function formAmountCents(form: Form, isPrivate: boolean): number {
  const typedCents = Math.round(parseFloat(form.amountEUR || '0') * 100);
  if (!formVatEditable(form, isPrivate) || form.amountIncludesVat) return typedCents;
  return grossFromNet(typedCents, form.vatCode)?.grossCents ?? typedCents;
}

type AccountOpt = { id: string; name: string; entityId: string };
/** The entity's categories, labelled "Parent › Child" and filtered by entry type in the form. */
type CategoryOpt = { id: string; label: string; type: string };
type CrossEntityEntry = RecurringEntryDoc & { ownerEntityId: string; ownerEntityName: string };

// ── Form modal ─────────────────────────────────────────────────────────────────

function RecurringFormModal({
  editingId,
  initial,
  isPrivate,
  accounts,
  crossAccounts,
  categories,
  onSave,
  onClose,
}: {
  editingId: string | null;
  initial: Form;
  isPrivate: boolean;
  accounts: AccountOpt[];
  crossAccounts: AccountOpt[];
  categories: CategoryOpt[];
  onSave: (form: Form, id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));
  const vatEditable = formVatEditable(form, isPrivate);
  const showVatSwitch = vatEditable && vatCodeChargesVat(form.vatCode);
  const savedCents = formAmountCents(form, isPrivate);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.description.trim()) return;
    setBusy(true); setErr(null);
    try {
      await onSave(form, editingId);
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'Erro ao guardar');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto">
        <div className="text-base font-semibold mb-4">{editingId ? 'Editar entrada' : 'Nova entrada recorrente'}</div>
        <form onSubmit={submit} className="space-y-3">
          {/* Type */}
          <div className="grid grid-cols-3 gap-1">
            {(['expense', 'income', 'transfer'] as RecurringType[]).map(t => (
              <button key={t} type="button" onClick={() => set('type', t)}
                className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                  form.type === t
                    ? t === 'income'  ? 'border-emerald-500 bg-emerald-900/50 text-emerald-200'
                    : t === 'expense' ? 'border-red-500 bg-red-900/50 text-red-200'
                    :                  'border-blue-500 bg-blue-900/50 text-blue-200'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                }`}>
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">Descrição</div>
            <Input placeholder="Netflix, Crédito Habitação, Claude…"
              value={form.description} onChange={e => set('description', e.target.value)} required autoFocus />
          </div>

          {form.type === 'expense' && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">Modelo de custo</div>
              <div className="grid grid-cols-2 gap-1">
                {(['fixed', 'commission'] as RecurringCostModel[]).map(m => (
                  <button key={m} type="button" onClick={() => set('costModel', m)}
                    className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                      form.costModel === m
                        ? 'border-blue-500 bg-blue-900/50 text-blue-200'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                    }`}>
                    {m === 'fixed' ? 'Fixo' : 'Comissão'}
                  </button>
                ))}
              </div>
              {form.costModel === 'commission' && (
                <div className="text-[11px] text-zinc-500 mt-1">
                  Ex.: EasyPay — percentagem sobre o volume processado pelo KidClub nesse mês.
                </div>
              )}
            </div>
          )}

          {vatEditable && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">IVA</div>
              <div className="grid grid-cols-4 gap-1">
                {VAT_CODES.map(({ code, label }) => (
                  <button key={String(code)} type="button" onClick={() => set('vatCode', code)}
                    className={`py-1 rounded text-xs font-medium border transition-colors ${
                      form.vatCode === code
                        ? code === 'por_confirmar'
                          ? 'border-amber-500 bg-amber-900/40 text-amber-200'
                          : 'border-blue-500 bg-blue-900/50 text-blue-200'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              {form.legacyUnconfirmed && (
                <div className="text-[11px] text-amber-400/90 mt-1">
                  Entrada guardada antes da regra do IVA
                  {form.legacyRatePct != null ? ` (taxa ${form.legacyRatePct}%)` : ''}: não se sabe se o valor inclui IVA.
                  Escolhe a taxa e indica se o valor abaixo é com ou sem IVA.
                </div>
              )}
            </div>
          )}

          <div>
            <div className="text-xs text-zinc-400 mb-1">
              {form.costModel === 'commission' ? 'Valor estimado (€) — usado se o volume ainda não estiver disponível' : 'Valor (€)'}
            </div>
            <div className="flex gap-2">
              <Input type="number" step="0.01" placeholder="0.00"
                value={form.amountEUR} onChange={e => set('amountEUR', e.target.value)} required />
              {showVatSwitch && (
                <div className="grid grid-cols-2 gap-0.5 shrink-0">
                  {([true, false] as const).map(incl => (
                    <button key={String(incl)} type="button" onClick={() => set('amountIncludesVat', incl)}
                      className={`px-2 rounded text-xs font-medium border transition-colors whitespace-nowrap ${
                        form.amountIncludesVat === incl
                          ? 'border-blue-500 bg-blue-900/50 text-blue-200'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                      }`}>
                      {incl ? 'com IVA' : 'sem IVA'}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {vatEditable && savedCents !== 0 && (
              <div className="text-[11px] text-zinc-500 mt-1">
                {form.vatCode === 'por_confirmar'
                  ? 'Sem taxa: o valor é guardado como está e fica "IVA por confirmar".'
                  : <>Guarda <span className="text-zinc-300">{formatEUR(savedCents)}</span> com IVA · {formatVatBreakdown(savedCents, form.vatCode)}</>}
              </div>
            )}
          </div>

          {form.type === 'expense' && form.costModel === 'commission' && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">Comissão (% sem IVA)</div>
              <Input type="number" step="0.01" min="0" max="100" placeholder="ex: 1.5"
                value={form.commissionPct} onChange={e => set('commissionPct', e.target.value)} />
              <div className="text-[11px] text-zinc-500 mt-1">
                Percentagem antes do IVA; o IVA (taxa acima) é somado à comissão.
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Frequência</div>
              <select value={form.frequency} onChange={e => set('frequency', e.target.value as RecurringFrequency)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm">
                {(['monthly','quarterly','annual','once'] as RecurringFrequency[]).map(f => (
                  <option key={f} value={f}>{FREQ_LABELS[f]}</option>
                ))}
              </select>
            </div>
            {form.frequency !== 'once' && (
              <div>
                <div className="text-xs text-zinc-400 mb-1">Dia do mês</div>
                <Input type="number" min="1" max="31"
                  value={form.dayOfMonth} onChange={e => set('dayOfMonth', e.target.value)} />
              </div>
            )}
          </div>

          {form.frequency === 'annual' && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">Mês</div>
              <select value={form.monthOfYear} onChange={e => set('monthOfYear', e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm">
                {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
          )}
          {form.frequency === 'once' && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">Mês</div>
              <Input type="month" value={form.onceYearMonth} onChange={e => set('onceYearMonth', e.target.value)} />
            </div>
          )}

          <div>
            <div className="text-xs text-zinc-400 mb-1">{form.type === 'transfer' ? 'Conta de origem' : 'Conta'}</div>
            <select value={form.accountId} onChange={e => set('accountId', e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm">
              <option value="">— selecionar —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          {form.type !== 'transfer' && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">Categoria</div>
              <select value={form.categoryId} onChange={e => set('categoryId', e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm">
                <option value="">— sem categoria —</option>
                {categories
                  .filter(c => c.type === (form.type === 'income' ? 'INCOME' : 'EXPENSE') || c.id === form.categoryId)
                  .map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          )}
          {form.type === 'transfer' && (
            <div>
              <div className="text-xs text-zinc-400 mb-1">Conta de destino</div>
              <select value={form.toAccountId} onChange={e => set('toAccountId', e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm">
                <option value="">— selecionar —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}

          {form.frequency !== 'once' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Desde</div>
                <Input type="month" value={form.startYearMonth} onChange={e => set('startYearMonth', e.target.value)} />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Até (vazio = sem fim)</div>
                <Input type="month" value={form.endYearMonth} onChange={e => set('endYearMonth', e.target.value)} />
              </div>
            </div>
          )}

          {form.type === 'expense' && !isPrivate && (
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 cursor-pointer hover:border-amber-800/50 transition-colors">
                <input type="checkbox" checked={form.reimbursable}
                  onChange={e => set('reimbursable', e.target.checked)} className="mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm text-zinc-200">Pago pessoalmente</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    Esta despesa é paga de uma conta pessoal e aguarda reembolso
                  </div>
                </div>
              </label>

              {form.reimbursable && crossAccounts.length > 0 && (
                <div>
                  <div className="text-xs text-amber-400/80 mb-1">Conta de pagamento (Privado)</div>
                  <select value={form.paidByAccountId} onChange={e => set('paidByAccountId', e.target.value)}
                    className="w-full bg-zinc-900 border border-amber-800/60 text-white rounded px-2 py-1 text-sm">
                    <option value="">— selecionar conta —</option>
                    {crossAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            Ativo
          </label>

          {err && <div className="text-xs text-red-400">{err}</div>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" className="flex-1" disabled={busy || !form.description.trim()}>
              {editingId ? 'Guardar' : 'Criar'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function RecurringPage() {
  const { selectedEntity } = useEntity();
  const navigate = useNavigate();
  const isPrivate = selectedEntity.id === 'private';

  const [rows, setRows]             = useState<RecurringEntryDoc[]>([]);
  const [accounts, setAccounts]     = useState<AccountOpt[]>([]);
  const [crossAccounts, setCrossAccounts] = useState<AccountOpt[]>([]);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [catDocs, setCatDocs]       = useState<Array<{ id: string; name: string; parentId?: string }>>([]);
  const [credits, setCredits]       = useState<CreditContractDoc[]>([]);
  const [contracts, setContracts]   = useState<EmploymentContractDoc[]>([]);
  const [groupBy, setGroupBy]       = useState<'category' | 'account'>('category');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openItems, setOpenItems]   = useState<Set<string>>(new Set());
  const [crossOwed, setCrossOwed]   = useState<CrossEntityEntry[]>([]);
  const [busy, setBusy]             = useState(false);
  const [msg, setMsg]               = useState<string | null>(null);

  // Modal state
  const [modalOpen, setModalOpen]   = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [formInit, setFormInit]     = useState<Form>(emptyForm());

  async function reload() {
    try {
      api.setEntity(selectedEntity.id);
      const [rs, as, cats, crs, ctrs] = await Promise.all([
        api.recurring.list(), api.accounts.list(), api.categories.list(), api.credits.list(), api.contracts.list(),
      ]);
      setRows(rs);
      setCredits(crs);
      setContracts(ctrs as EmploymentContractDoc[]);
      setCatDocs(cats.map(c => ({ id: c.id, name: c.name, parentId: c.parentId })));
      setAccounts(as.map(a => ({ id: a.id, name: a.name, entityId: selectedEntity.id })));
      const catName = new Map(cats.map(c => [c.id, c.name]));
      setCategories(cats
        .map(c => ({
          id: c.id,
          label: c.parentId && catName.has(c.parentId) ? `${catName.get(c.parentId)} › ${c.name}` : c.name,
          type: (c.type ?? '').toUpperCase(),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)));

      if (!isPrivate) {
        api.setEntity('private');
        const privAccs = await api.accounts.list();
        setCrossAccounts(privAccs.map(a => ({ id: a.id, name: a.name, entityId: 'private' })));
        api.setEntity(selectedEntity.id);
      }

      if (isPrivate) {
        const allCross: CrossEntityEntry[] = [];
        for (const e of ENTITIES.filter(e => e.id !== 'private')) {
          api.setEntity(e.id);
          const entries = await api.recurring.listActive();
          for (const entry of entries) {
            if (entry.reimbursable && entry.paidByAccountId) {
              allCross.push({ ...entry, ownerEntityId: e.id, ownerEntityName: e.name });
            }
          }
        }
        api.setEntity('private');
        setCrossOwed(allCross);
      }
    } catch (e: any) {
      setMsg(e?.message ?? 'Erro ao carregar');
    }
  }

  useEffect(() => { void reload(); }, [selectedEntity.id]);

  function openCreate() {
    setEditingId(null);
    setFormInit(emptyForm());
    setModalOpen(true);
    setMsg(null);
  }
  function openEdit(d: RecurringEntryDoc) {
    setEditingId(d.id);
    setFormInit(fromDoc(d));
    setModalOpen(true);
    setMsg(null);
  }

  async function handleSave(form: Form, id: string | null) {
    api.setEntity(selectedEntity.id);
    await api.recurring.save({
      id: id ?? undefined,
      type: form.type,
      description: form.description.trim(),
      amountCents: formAmountCents(form, isPrivate),
      vatCode: formVatEditable(form, isPrivate) ? form.vatCode : undefined,
      accountId: form.accountId || undefined,
      toAccountId: form.type === 'transfer' ? (form.toAccountId || undefined) : undefined,
      categoryId: form.type !== 'transfer' ? (form.categoryId || undefined) : undefined,
      frequency: form.frequency,
      dayOfMonth: parseInt(form.dayOfMonth || '1', 10),
      monthOfYear: form.frequency === 'annual' ? parseInt(form.monthOfYear || '1', 10) : undefined,
      startYearMonth: form.startYearMonth || undefined,
      endYearMonth: form.endYearMonth || undefined,
      onceYearMonth: form.frequency === 'once' ? (form.onceYearMonth || undefined) : undefined,
      active: form.active,
      reimbursable: form.reimbursable || undefined,
      paidByAccountId: (form.reimbursable && form.paidByAccountId) ? form.paidByAccountId : undefined,
      costModel: (form.type === 'expense' && form.costModel === 'commission') ? 'commission' : undefined,
      commissionPct: (form.type === 'expense' && form.costModel === 'commission' && form.commissionPct !== '')
        ? parseFloat(form.commissionPct)
        : undefined,
    });
    await reload();
    setMsg('Guardado ✔');
  }

  async function deleteOne(id: string) {
    if (!confirm('Eliminar esta entrada?')) return;
    setBusy(true);
    try {
      api.setEntity(selectedEntity.id);
      await api.recurring.delete(id);
      await reload();
    } catch (e: any) {
      setMsg(e?.message ?? 'Erro ao eliminar');
    } finally { setBusy(false); }
  }

  async function registerReimbursement(entry: RecurringEntryDoc) {
    const ym = currentYM();
    setBusy(true);
    try {
      api.setEntity(selectedEntity.id);
      await api.recurring.save({ ...entry, lastReimbursedYM: ym });
      await reload();
    } catch (e: any) {
      setMsg(e?.message ?? 'Erro ao registar');
    } finally { setBusy(false); }
  }

  // Everything that repeats (entries, derived entries, credit instalments); totals = in force this month.
  const ym = currentYM();
  const items = useMemo(
    () => buildRecurringItems({ ym, entries: rows, credits, categories: catDocs, contracts }),
    [ym, rows, credits, catDocs, contracts],
  );
  const accountLabel = (id?: string) =>
    id ? ((accounts.find(a => a.id === id) ?? crossAccounts.find(a => a.id === id))?.name ?? id) : undefined;
  const groups = useMemo(
    () => groupRecurringItems(items, groupBy, id => accountLabel(id) ?? 'Sem conta'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, groupBy, accounts, crossAccounts],
  );
  const history = useMemo(() => items.filter(i => i.status !== 'current'), [items]);
  const totals = useMemo(() => {
    const cur = items.filter(i => i.status === 'current');
    const expense = cur.filter(i => i.type === 'expense').reduce((s, i) => s + i.monthlyCents, 0);
    const income  = cur.filter(i => i.type === 'income').reduce((s, i) => s + i.monthlyCents, 0);
    return { expense, income, net: income - expense };
  }, [items]);
  const toggleIn = (set: (f: (s: Set<string>) => Set<string>) => void, k: string) =>
    set(s => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; });
  const allOpen = groups.length > 0 && groups.every(g => openGroups.has(g.name));

  const reimbursableEntries = useMemo(
    () => rows.filter(r => r.reimbursable && r.active && r.type === 'expense'),
    [rows],
  );
  const totalOwed = useMemo(
    () => reimbursableEntries.reduce((s, r) => s + monthsOwed(r) * r.amountCents, 0),
    [reimbursableEntries],
  );

  const owedByCompany = useMemo(() => {
    const map = new Map<string, { name: string; entries: CrossEntityEntry[]; total: number }>();
    for (const e of crossOwed) {
      const months = monthsOwed(e);
      const owed = months * e.amountCents;
      if (!map.has(e.ownerEntityId)) map.set(e.ownerEntityId, { name: e.ownerEntityName, entries: [], total: 0 });
      const rec = map.get(e.ownerEntityId)!;
      rec.entries.push(e);
      rec.total += owed;
    }
    return map;
  }, [crossOwed]);

  const paidByLabel = (r: RecurringEntryDoc) => {
    if (!r.paidByAccountId) return null;
    const name = crossAccounts.find(a => a.id === r.paidByAccountId)?.name ?? r.paidByAccountId;
    return `Pago por Renato · ${name}`;
  };

  /** "sem IVA … · IVA 23% …" under a company entry's amount; the badge covers por_confirmar. */
  const vatLine = (r: RecurringEntryDoc) => {
    if (isPrivate) return null;
    const code = recurringVatCode(r);
    if (code == null || code === 'por_confirmar') return null;
    return formatVatBreakdown(r.amountCents, code);
  };
  const unconfirmedCount = isPrivate ? 0 : rows.filter(r => recurringVatCode(r) === 'por_confirmar').length;

  const freqLabel = (r: Pick<RecurringItem, 'frequency' | 'dayOfMonth' | 'monthOfYear' | 'onceYearMonth'>) => {
    if (r.frequency === 'monthly')   return `mensal · dia ${r.dayOfMonth}`;
    if (r.frequency === 'quarterly') return `trimestral · dia ${r.dayOfMonth}`;
    if (r.frequency === 'annual')    return `anual · ${MONTHS[(r.monthOfYear ?? 1) - 1]} · dia ${r.dayOfMonth}`;
    if (r.frequency === 'once')      return r.onceYearMonth ?? 'única vez';
    return FREQ_LABELS[r.frequency];
  };

  /** Where a derived item is edited. */
  const sourceLink = (i: RecurringItem): { to: string; label: string } | null => {
    const src = i.entry?.sourceId ?? '';
    switch (i.kind) {
      case 'salary_cost':   return { to: `/${selectedEntity.id}/contracts`, label: 'Contrato' };
      case 'salary':        return { to: '/noisysource/contracts', label: 'Contrato' };
      case 'benefit':       return src.startsWith('inc:') ? { to: '/private/income', label: 'Rendimento' } : { to: '/noisysource/contracts', label: 'Contrato' };
      case 'income_source': return { to: '/private/income', label: 'Rendimento' };
      case 'ec':            return { to: '/noisysource/ec-contracts', label: 'Cliente' };
      case 'insurance':     return { to: `/${selectedEntity.id}/insurances`, label: 'Seguro' };
      case 'credit':        return { to: `/${selectedEntity.id}/credits`, label: 'Crédito' };
      default:              return null;
    }
  };
  const statusLabel = (i: RecurringItem) =>
    i.status === 'ended' ? `terminou ${i.endYearMonth ?? i.onceYearMonth ?? ''}`
    : i.status === 'future' ? `a partir de ${i.startYearMonth ?? i.onceYearMonth ?? ''}`
    : i.status === 'inactive' ? 'inativo' : null;
  const categoryLabel = (id?: string) => (id ? categories.find(c => c.id === id)?.label : undefined);

  const renderItem = (i: RecurringItem) => {
    const r = i.entry;
    const color = i.type === 'income' ? 'text-emerald-400' : i.type === 'transfer' ? 'text-blue-400' : 'text-red-400';
    const sign = i.type === 'income' ? '+' : i.type === 'expense' ? '−' : '';
    const open = openItems.has(i.key);
    const link = sourceLink(i);
    const status = statusLabel(i);
    const from = accountLabel(i.accountId);
    const to = accountLabel(i.toAccountId);
    return (
      <div key={i.key} className="rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-700 transition-colors">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <button onClick={() => toggleIn(setOpenItems, i.key)} className="text-zinc-500 hover:text-zinc-200 shrink-0" aria-label="Detalhe">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium truncate">{i.description}</span>
              {KIND_LABEL[i.kind] && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0">{KIND_LABEL[i.kind]}</span>
              )}
              {status && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 shrink-0">{status}</span>}
              {r?.costModel === 'commission' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400 border border-blue-800/60 shrink-0">
                  comissão {r.commissionPct ?? 0}% sem IVA
                </span>
              )}
              {r && !isPrivate && recurringVatCode(r) === 'por_confirmar' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/60 shrink-0">
                  IVA por confirmar
                </span>
              )}
              {r?.reimbursable && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/60 shrink-0">
                  reembolso pendente
                </span>
              )}
            </div>
            <div className="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>{freqLabel(i)}</span>
              {from && <><span className="text-zinc-700">·</span><span>{i.type === 'income' ? 'para' : 'de'} {from}</span></>}
              {i.type === 'transfer' && to && <span>→ {to}</span>}
              {r?.reimbursable && r.paidByAccountId && (
                <><span className="text-zinc-700">·</span><span className="text-amber-500/80">{paidByLabel(r)}</span></>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <div className={`text-sm font-semibold tabular-nums ${color}`}>
                {sign}{formatEUR(i.amountCents)}
                {r?.costModel === 'commission' && <span className="text-[10px] text-zinc-500 font-normal ml-1">(estimado)</span>}
              </div>
              {i.frequency !== 'monthly' && i.monthlyCents > 0 && (
                <div className="text-[10px] text-zinc-500 tabular-nums">≈ {formatEUR(i.monthlyCents)}/mês</div>
              )}
              {r && vatLine(r) && <div className="text-[10px] text-zinc-500 tabular-nums">{vatLine(r)}</div>}
            </div>
            <div className="flex gap-2 text-xs w-24 justify-end">
              {i.kind === 'manual' && r ? (
                <>
                  <button className="text-blue-400 hover:underline" onClick={() => openEdit(r)}>Editar</button>
                  <button className="text-red-400 hover:underline" onClick={() => deleteOne(r.id)}>Apagar</button>
                </>
              ) : link ? (
                <button className="text-zinc-400 hover:text-zinc-100 flex items-center gap-1" onClick={() => navigate(link.to)}>
                  {link.label} <ExternalLink size={11} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
        {open && (
          <div className="pl-10 pr-4 pb-3 space-y-1 text-xs">
            {i.details.map((d, k) => (
              <div key={k} className="flex justify-between gap-3 text-zinc-400">
                <span>{d.label}</span>
                <span className="tabular-nums text-zinc-300">{d.amountCents !== undefined ? formatEUR(d.amountCents) : d.text}</span>
              </div>
            ))}
            {categoryLabel(r?.categoryId) && (
              <div className="flex justify-between gap-3 text-zinc-400">
                <span>Categoria</span><span className="text-zinc-300">{categoryLabel(r?.categoryId)}</span>
              </div>
            )}
            {i.details.length === 0 && !categoryLabel(r?.categoryId) && <div className="text-zinc-600">Sem mais detalhe.</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* Entity tabs */}
      <div className="flex items-center gap-1 border-b border-zinc-800 pb-0">
        {ENTITY_TABS.map(tab => {
          const active = selectedEntity.id === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => navigate(`/${tab.id}/recurring`)}
              className={`px-4 py-2 text-sm font-medium rounded-t transition-colors border-b-2 -mb-px ${
                active
                  ? 'border-emerald-500 text-white bg-zinc-900'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
            >
              {tab.emoji} {tab.label}
            </button>
          );
        })}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Recorrentes</h2>
          <p className="text-sm text-zinc-400 mt-0.5">{selectedEntity.name} · tudo o que se repete: contratos, créditos, seguros, subscrições e entradas</p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-sm text-emerald-400">{msg}</span>}
          <Button onClick={openCreate} type="button" disabled={busy}>+ Nova entrada</Button>
        </div>
      </div>

      {/* Monthly summary: what's in force this month, as a monthly equivalent */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm px-1">
          <span className="text-zinc-400">Saídas: <span className="text-red-400 font-medium">{formatEUR(totals.expense)}</span>/mês</span>
          {totals.income > 0 && <span className="text-zinc-400">Entradas: <span className="text-emerald-400 font-medium">{formatEUR(totals.income)}</span>/mês</span>}
          <span className="text-zinc-400">Saldo: <span className={`font-medium ${totals.net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatEUR(totals.net)}</span>/mês</span>
          <span className="text-xs text-zinc-600">equivalente mensal do que está em vigor em {ym}</span>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-zinc-500 mr-1">Agrupar por</span>
          {(['category', 'account'] as const).map(g => (
            <button key={g} onClick={() => setGroupBy(g)}
              className={`px-2 py-1 rounded border ${groupBy === g ? 'border-emerald-600 bg-emerald-900/30 text-emerald-200' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>
              {g === 'category' ? 'Categoria' : 'Conta'}
            </button>
          ))}
          <button onClick={() => setOpenGroups(allOpen ? new Set() : new Set(groups.map(g => g.name)))}
            className="ml-2 px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800">
            {allOpen ? 'Fechar todos' : 'Abrir todos'}
          </button>
        </div>
      </div>

      {unconfirmedCount > 0 && (
        <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-800/50 px-3 py-2 rounded">
          {unconfirmedCount === 1 ? '1 entrada tem' : `${unconfirmedCount} entradas têm`} IVA por confirmar.
          Abre cada uma, escolhe a taxa de IVA e indica se o valor é com ou sem IVA. Até lá ficam fora das
          contas do IVA e entram pelo valor guardado nos Custos do mês.
        </div>
      )}

      {/* Groups (current items only) */}
      <div className="space-y-2">
        {groups.map(g => {
          const open = openGroups.has(g.name);
          return (
            <div key={g.name} className="rounded-lg border border-zinc-800 bg-zinc-900/60">
              <button onClick={() => toggleIn(setOpenGroups, g.name)}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/40 rounded-lg">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {g.name}
                  <span className="text-xs text-zinc-500 font-normal">{g.items.length}</span>
                </span>
                <span className="flex gap-3 text-sm tabular-nums">
                  {g.expenseCents > 0 && <span className="text-red-400">−{formatEUR(g.expenseCents)}/mês</span>}
                  {g.incomeCents > 0 && <span className="text-emerald-400">+{formatEUR(g.incomeCents)}/mês</span>}
                </span>
              </button>
              {open && <div className="px-2 pb-2 space-y-1.5">{g.items.map(renderItem)}</div>}
            </div>
          );
        })}
      </div>

      {items.length === 0 && (
        <div className="text-sm text-zinc-500 text-center py-10">Nenhuma entrada configurada.</div>
      )}

      {/* Not in force this month: out of the totals */}
      {history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
            Fora deste mês ({history.length}) — terminados, futuros ou inativos, fora dos totais
          </summary>
          <div className="mt-2 space-y-1.5 opacity-75">{history.map(renderItem)}</div>
        </details>
      )}

      {/* Company: reimbursement tracker */}
      {!isPrivate && reimbursableEntries.length > 0 && (
        <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-amber-400 uppercase tracking-widest">Reembolsos a pagar</div>
              <div className="text-xs text-zinc-500 mt-0.5">{selectedEntity.name} deve a Renato por despesas pagas pessoalmente</div>
            </div>
            {totalOwed > 0 && (
              <span className="text-base font-bold tabular-nums text-amber-300">{formatEUR(totalOwed)}</span>
            )}
          </div>
          <div className="space-y-2">
            {reimbursableEntries.map(r => {
              const months = monthsOwed(r);
              const owed = months * r.amountCents;
              const since = r.lastReimbursedYM
                ? (() => {
                    const [y, m] = r.lastReimbursedYM.split('-').map(Number);
                    const nm = m === 12 ? 1 : m + 1;
                    const ny = m === 12 ? y + 1 : y;
                    return `${ny}-${String(nm).padStart(2, '0')}`;
                  })()
                : (r.startYearMonth ?? currentYM());
              const paidVia = crossAccounts.find(a => a.id === r.paidByAccountId)?.name ?? r.paidByAccountId ?? '—';
              return (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{r.description}</div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {formatEUR(r.amountCents)}/mês × {months} {months === 1 ? 'mês' : 'meses'} desde {since}
                      <span className="text-zinc-600"> · via {paidVia}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-semibold tabular-nums text-amber-300">
                      {owed > 0 ? formatEUR(owed) : '—'}
                    </span>
                    {owed > 0 ? (
                      <button onClick={() => registerReimbursement(r)} disabled={busy}
                        className="text-xs px-2 py-1 rounded bg-amber-900/60 hover:bg-amber-900 border border-amber-700 text-amber-300 disabled:opacity-50 whitespace-nowrap">
                        Registar reembolso
                      </button>
                    ) : (
                      <span className="text-xs text-zinc-600">Em dia</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Private: what companies owe you */}
      {isPrivate && owedByCompany.size > 0 && (
        <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/10 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-emerald-400 uppercase tracking-widest">Empresas que te devem</div>
              <div className="text-xs text-zinc-500 mt-0.5">Despesas pagas pessoalmente a aguardar reembolso</div>
            </div>
            <span className="text-base font-bold tabular-nums text-emerald-300">
              {formatEUR([...owedByCompany.values()].reduce((s, v) => s + v.total, 0))}
            </span>
          </div>
          {[...owedByCompany.entries()].map(([entityId, { name, entries, total }]) => (
            <div key={entityId} className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-400">{name}</span>
                <span className="text-xs font-medium tabular-nums text-emerald-400">{formatEUR(total)}</span>
              </div>
              {entries.map(e => {
                const months = monthsOwed(e);
                const owed = months * e.amountCents;
                const since = e.lastReimbursedYM
                  ? (() => {
                      const [y, m] = e.lastReimbursedYM.split('-').map(Number);
                      const nm = m === 12 ? 1 : m + 1;
                      const ny = m === 12 ? y + 1 : y;
                      return `${ny}-${String(nm).padStart(2, '0')}`;
                    })()
                  : (e.startYearMonth ?? currentYM());
                const paidVia = accounts.find(a => a.id === e.paidByAccountId)?.name ?? e.paidByAccountId ?? '—';
                return (
                  <div key={e.id} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2.5 pl-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{e.description}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        {formatEUR(e.amountCents)}/mês × {months} {months === 1 ? 'mês' : 'meses'} desde {since}
                        <span className="text-zinc-600"> · pago via {paidVia}</span>
                      </div>
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-emerald-300 shrink-0">
                      {owed > 0 ? formatEUR(owed) : 'Em dia'}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Form modal */}
      {modalOpen && (
        <RecurringFormModal
          editingId={editingId}
          initial={formInit}
          isPrivate={isPrivate}
          accounts={accounts}
          crossAccounts={crossAccounts}
          categories={categories}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditingId(null); }}
        />
      )}
    </div>
  );
}
