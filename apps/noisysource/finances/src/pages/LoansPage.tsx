import { useEffect, useMemo, useState } from 'react';
import type { LoanEntryDoc, LoanKind } from '@shared/models/Loan';
import { loanBalance } from '@shared/models/Loan';
import { formatEUR } from '@shared/lib/money';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { api } from '../lib/api';
import { ChevronDown, ChevronRight, Plus, Pencil, Trash2 } from 'lucide-react';

const KIND_LABELS: Record<LoanKind, string> = {
  lent:          'Emprestei',
  borrowed:      'Recebi emprestado',
  repayment_in:  'Recebi reembolso',
  repayment_out: 'Reembolsei',
  covered_for_me:'Pagou por mim',
};

const KIND_SIGN: Record<LoanKind, number> = {
  lent: 1, borrowed: -1, repayment_in: -1, repayment_out: 1, covered_for_me: -1,
};

type Form = {
  counterparty: string;
  amountEUR: string;
  description: string;
  date: string;
  kind: LoanKind;
  notes: string;
};

const today = () => new Date().toISOString().slice(0, 10);

const emptyForm = (): Form => ({
  counterparty: '', amountEUR: '', description: '',
  date: today(), kind: 'lent', notes: '',
});

function fromDoc(e: LoanEntryDoc): Form {
  const absEUR = Math.abs(e.amountCents) / 100;
  return {
    counterparty: e.counterparty,
    amountEUR: absEUR.toFixed(2),
    description: e.description,
    date: e.date,
    kind: e.kind,
    notes: e.notes ?? '',
  };
}

function EntryModal({
  editingId, initial, prefillCounterparty, onSave, onClose,
}: {
  editingId: string | null;
  initial: Form;
  prefillCounterparty?: string;
  onSave: (form: Form, id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>({ ...initial, counterparty: prefillCounterparty ?? initial.counterparty });
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.counterparty.trim() || !form.amountEUR || !form.description.trim()) return;
    setBusy(true); setErr(null);
    try { await onSave(form, editingId); onClose(); }
    catch (e: any) { setErr(e?.message ?? 'Erro ao guardar'); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-md p-5">
        <div className="text-base font-semibold mb-4">{editingId ? 'Editar movimento' : 'Novo movimento'}</div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Contraparte</div>
            <Input placeholder="João, Marisa, ..." value={form.counterparty}
              onChange={e => set('counterparty', e.target.value)} required autoFocus />
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">Tipo</div>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {(Object.entries(KIND_LABELS) as [LoanKind, string][]).map(([k, label]) => (
                <button key={k} type="button" onClick={() => set('kind', k)}
                  className={`py-1.5 px-2 rounded text-xs font-medium border transition-colors ${
                    form.kind === k
                      ? 'border-blue-500 bg-blue-900/50 text-blue-200'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Valor (€)</div>
              <Input type="number" step="0.01" min="0" placeholder="0.00"
                value={form.amountEUR} onChange={e => set('amountEUR', e.target.value)} required />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Data</div>
              <Input type="date" value={form.date} onChange={e => set('date', e.target.value)} required />
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">Descrição</div>
            <Input placeholder="Empréstimo para carro, Renda de Agosto, ..."
              value={form.description} onChange={e => set('description', e.target.value)} required />
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">Notas (opcional)</div>
            <Input placeholder="..." value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>

          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex gap-2 pt-1">
            <Button type="submit" className="flex-1" disabled={busy}>
              {editingId ? 'Guardar' : 'Criar'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function balanceColor(cents: number) {
  if (cents > 0)  return 'text-emerald-400';
  if (cents < 0)  return 'text-amber-400';
  return 'text-zinc-500';
}

function CounterpartyRow({
  counterparty, entries, onAdd, onEdit, onDelete,
}: {
  counterparty: string;
  entries: LoanEntryDoc[];
  onAdd: (cp: string) => void;
  onEdit: (e: LoanEntryDoc) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const balance = loanBalance(entries);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/50 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />}
          <span className="font-medium text-sm">{counterparty}</span>
          <span className="text-xs text-zinc-500">{entries.length} mov.</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-mono text-sm font-semibold ${balanceColor(balance)}`}>
            {balance > 0 ? '+' : ''}{formatEUR(balance)}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded ${
            balance > 0 ? 'bg-emerald-900/40 text-emerald-400' :
            balance < 0 ? 'bg-amber-900/40 text-amber-400' :
            'bg-zinc-800 text-zinc-500'
          }`}>
            {balance > 0 ? 'a receber' : balance < 0 ? 'a pagar' : 'saldado'}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-zinc-800">
          <div className="divide-y divide-zinc-800/50">
            {entries.map(e => (
              <div key={e.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-zinc-800/30">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500">{e.date}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                      {KIND_LABELS[e.kind]}
                    </span>
                  </div>
                  <div className="text-sm text-zinc-200 truncate mt-0.5">{e.description}</div>
                  {e.notes && <div className="text-xs text-zinc-500 mt-0.5">{e.notes}</div>}
                </div>
                <div className="flex items-center gap-3 ml-3 shrink-0">
                  <span className={`font-mono text-sm ${e.amountCents >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {e.amountCents >= 0 ? '+' : ''}{formatEUR(e.amountCents)}
                  </span>
                  <button onClick={() => onEdit(e)} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => onDelete(e.id)} className="text-zinc-600 hover:text-red-400 transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 border-t border-zinc-800/50">
            <button onClick={() => onAdd(counterparty)}
              className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 transition-colors">
              <Plus size={12} /> Adicionar movimento
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LoansPage() {
  const [entries, setEntries] = useState<LoanEntryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen]   = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [formInit, setFormInit]     = useState<Form>(emptyForm());
  const [prefillCp, setPrefillCp]   = useState<string | undefined>(undefined);
  const [showSettled, setShowSettled] = useState(false);

  async function reload() {
    api.setEntity('private');
    const all = await api.loans.listAll();
    setEntries(all);
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, LoanEntryDoc[]>();
    for (const e of entries) {
      if (!map.has(e.counterparty)) map.set(e.counterparty, []);
      map.get(e.counterparty)!.push(e);
    }
    return Array.from(map.entries())
      .map(([cp, es]) => ({ cp, entries: es, balance: loanBalance(es) }))
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  }, [entries]);

  const active   = grouped.filter(g => g.balance !== 0);
  const settled  = grouped.filter(g => g.balance === 0);

  const totalOwedToMe = grouped.reduce((s, g) => s + Math.max(0, g.balance), 0);
  const totalIOwe     = grouped.reduce((s, g) => s + Math.min(0, g.balance), 0);

  function openNew(cp?: string) {
    setEditingId(null);
    setFormInit(emptyForm());
    setPrefillCp(cp);
    setModalOpen(true);
  }

  function openEdit(e: LoanEntryDoc) {
    setEditingId(e.id);
    setFormInit(fromDoc(e));
    setPrefillCp(undefined);
    setModalOpen(true);
  }

  async function handleSave(form: Form, id: string | null) {
    const sign = KIND_SIGN[form.kind];
    const amountCents = Math.round(parseFloat(form.amountEUR) * 100) * sign;
    api.setEntity('private');
    await api.loans.save({
      id: id ?? undefined,
      counterparty: form.counterparty.trim(),
      amountCents,
      description: form.description.trim(),
      date: form.date,
      kind: form.kind,
      notes: form.notes.trim() || undefined,
    });
    await reload();
  }

  async function handleDelete(id: string) {
    if (!confirm('Eliminar este movimento?')) return;
    api.setEntity('private');
    await api.loans.delete(id);
    await reload();
  }

  if (loading) return <div className="text-zinc-500 text-sm p-4">A carregar...</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Empréstimos</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Controlo de dívidas e reembolsos</p>
        </div>
        <Button onClick={() => openNew()}>
          <Plus size={14} className="mr-1" /> Novo movimento
        </Button>
      </div>

      {/* Summary strip */}
      {grouped.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <Card className="p-3">
            <div className="text-xs text-zinc-400 mb-1">A receber</div>
            <div className="text-lg font-bold text-emerald-400">{formatEUR(totalOwedToMe)}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-zinc-400 mb-1">A pagar</div>
            <div className="text-lg font-bold text-amber-400">{formatEUR(Math.abs(totalIOwe))}</div>
          </Card>
        </div>
      )}

      {/* Active */}
      {active.length === 0 && settled.length === 0 && (
        <div className="text-center py-12 text-zinc-600">
          <div className="text-4xl mb-3">🤝</div>
          <div>Sem empréstimos registados.</div>
          <div className="text-sm mt-1">Clica em "Novo movimento" para começar.</div>
        </div>
      )}

      <div className="space-y-2">
        {active.map(g => (
          <CounterpartyRow key={g.cp} counterparty={g.cp} entries={g.entries}
            onAdd={openNew} onEdit={openEdit} onDelete={handleDelete} />
        ))}
      </div>

      {/* Settled */}
      {settled.length > 0 && (
        <div>
          <button onClick={() => setShowSettled(s => !s)}
            className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 mb-2 transition-colors">
            {showSettled ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {settled.length} saldado{settled.length !== 1 ? 's' : ''}
          </button>
          {showSettled && (
            <div className="space-y-2">
              {settled.map(g => (
                <CounterpartyRow key={g.cp} counterparty={g.cp} entries={g.entries}
                  onAdd={openNew} onEdit={openEdit} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </div>
      )}

      {modalOpen && (
        <EntryModal
          editingId={editingId}
          initial={formInit}
          prefillCounterparty={prefillCp}
          onSave={handleSave}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
