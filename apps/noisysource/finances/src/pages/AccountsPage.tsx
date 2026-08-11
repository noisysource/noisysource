import { useEffect, useMemo, useState } from "react";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { AccountForm } from "../components/forms/AccountsForm";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import { Plus, Pencil, Trash2, Landmark, CreditCard, Ticket, TrendingUp, Wallet, Banknote, Upload, X, FileSpreadsheet, ChevronDown, ChevronRight, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { parseBpiXlsx, type ParsedBpiStatement } from '../lib/parsers/bpiXlsx';
import type { BankTransactionDoc } from '@shared/models/BankTransaction';

const TYPE_LABEL: Record<string, string> = {
  bank: 'Banco', credit: 'Crédito', voucher: 'Voucher',
  bonds: 'Obrigações', wallet: 'Wallet', cash: 'Dinheiro',
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  bank:    <Landmark  size={16} className="text-blue-400" />,
  credit:  <CreditCard size={16} className="text-purple-400" />,
  voucher: <Ticket    size={16} className="text-amber-400" />,
  bonds:   <TrendingUp size={16} className="text-emerald-400" />,
  wallet:  <Wallet    size={16} className="text-cyan-400" />,
  cash:    <Banknote  size={16} className="text-zinc-400" />,
};

function accountSubtitle(a: Account): string {
  const parts: string[] = [];
  if (a.type === 'bank') {
    if ((a as any).bankName) parts.push((a as any).bankName);
    if ((a as any).iban) parts.push(`··· ${((a as any).iban as string).slice(-4)}`);
  } else if (a.type === 'credit') {
    if ((a as any).issuer) parts.push((a as any).issuer);
    if ((a as any).last4) parts.push(`···· ${(a as any).last4}`);
  } else if (a.type === 'voucher') {
    const vt = (a as any).voucherType;
    if (vt) parts.push({ meal: 'Refeição', childcare: 'Creche', education: 'Educação' }[vt as string] ?? vt);
    if ((a as any).employerName) parts.push((a as any).employerName);
    if ((a as any).provider) parts.push((a as any).provider);
  } else if (a.type === 'bonds') {
    if ((a as any).provider) parts.push((a as any).provider);
  }
  return parts.join(' · ');
}

type ImportStep = 'idle' | 'preview' | 'importing' | 'done';

function BpiImportModal({ account, entityId, onClose, onRefresh }: {
  account: Account & { id: string };
  entityId: string;
  onClose: () => void;
  onRefresh: (accountId: string) => void;
}) {
  const [step, setStep] = useState<ImportStep>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [statement, setStatement] = useState<ParsedBpiStatement | null>(null);
  const [result, setResult] = useState<{ newCount: number; duplicateCount: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(f: File) {
    setError(null);
    try {
      const buf = await f.arrayBuffer();
      const stmt = parseBpiXlsx(buf);
      if (!stmt.transactions.length) throw new Error('no rows');
      setFile(f);
      setStatement(stmt);
      setStep('preview');
    } catch {
      setError('Erro ao ler o ficheiro. Verifica que é um extrato BPI válido.');
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) void handleFile(f);
  }

  async function confirm() {
    if (!statement || !file) return;
    setStep('importing');
    try {
      const imp = await api.bankTransactions.importXlsx(account.id, entityId, file.name, statement);
      setResult({ newCount: imp.newCount, duplicateCount: imp.duplicateCount, total: imp.transactionCount });
      setStep('done');
      // Bust tx cache so the list reloads on next expand
      onRefresh(account.id);
    } catch {
      setError('Erro ao importar. Tenta novamente.');
      setStep('preview');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-base font-semibold">Importar Extrato — {account.name}</div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X size={16} /></button>
        </div>

        {step === 'idle' && (
          <label
            className="block border-2 border-dashed border-zinc-700 rounded-lg p-8 text-center cursor-pointer hover:border-zinc-500 transition-colors"
            onDragOver={e => e.preventDefault()}
            onDrop={onDrop}
          >
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
            <FileSpreadsheet size={32} className="mx-auto mb-3 text-zinc-500" />
            <div className="text-sm text-zinc-300">Arrasta o extrato XLSX aqui</div>
            <div className="text-xs text-zinc-500 mt-1">ou clica para selecionar</div>
            <div className="text-xs text-zinc-600 mt-3">Extrato BPI Empresas (.xlsx)</div>
          </label>
        )}

        {step === 'preview' && statement && (
          <div className="space-y-4">
            <div className="bg-zinc-800 rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Ficheiro</span>
                <span className="text-zinc-200 truncate max-w-52 text-right">{file?.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Período</span>
                <span className="text-zinc-200">{statement.dateFrom} → {statement.dateTo}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Movimentos</span>
                <span className="text-zinc-200">{statement.transactions.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Saldo final</span>
                <span className={statement.closingBalanceCents >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {formatEUR(statement.closingBalanceCents)}
                </span>
              </div>
              {statement.holderName && (
                <div className="flex justify-between">
                  <span className="text-zinc-400">Titular</span>
                  <span className="text-zinc-200 text-right max-w-52 truncate">{statement.holderName}</span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { setStep('idle'); setStatement(null); setFile(null); }}>
                Cancelar
              </Button>
              <Button className="flex-1" onClick={() => void confirm()}>
                Importar
              </Button>
            </div>
          </div>
        )}

        {step === 'importing' && (
          <div className="py-8 text-center text-zinc-400 text-sm">A importar movimentos…</div>
        )}

        {step === 'done' && result && (
          <div className="space-y-4">
            <div className="bg-zinc-800 rounded-lg p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Novos movimentos</span>
                <span className="text-emerald-400 font-semibold">{result.newCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Duplicados ignorados</span>
                <span className="text-zinc-500">{result.duplicateCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Total no ficheiro</span>
                <span className="text-zinc-200">{result.total}</span>
              </div>
            </div>
            <Button className="w-full" onClick={onClose}>Fechar</Button>
          </div>
        )}

        {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
      </Card>
    </div>
  );
}

function AccountModal({
  editing, onSaved, onClose,
}: {
  editing: Account | null;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-md p-5 overflow-y-auto max-h-[90vh]">
        <div className="text-base font-semibold mb-4">{editing ? 'Editar conta' : 'Nova conta'}</div>
        <AccountForm
          initial={editing}
          onSaved={async () => { await onSaved(); onClose(); }}
          onCancel={onClose}
        />
      </Card>
    </div>
  );
}

export default function AccountsPage() {
  const { selectedEntity } = useEntity();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [eventBalances, setEventBalances] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [importingAccount, setImportingAccount] = useState<(Account & { id: string }) | null>(null);
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [txCache, setTxCache] = useState<Record<string, BankTransactionDoc[]>>({});
  const [txLoading, setTxLoading] = useState(false);

  async function toggleTransactions(accountId: string) {
    if (expandedAccountId === accountId) { setExpandedAccountId(null); return; }
    setExpandedAccountId(accountId);
    if (txCache[accountId]) return;
    setTxLoading(true);
    try {
      const txs = await api.bankTransactions.listByAccount(accountId);
      setTxCache(prev => ({ ...prev, [accountId]: txs }));
    } finally {
      setTxLoading(false);
    }
  }

  async function reload() {
    if (!selectedEntity.id) return;
    setLoading(true);
    try {
      const [as, events] = await Promise.all([
        api.accounts.list(),
        api.financeEvents.listByEntity(selectedEntity.id as any),
      ]);
      setAccounts(as as Account[]);
      const balMap = new Map<string, number>();
      for (const e of events) {
        if (e.status === 'confirmed' && e.accountId) {
          balMap.set(e.accountId, (balMap.get(e.accountId) ?? 0) + e.amountCents);
        }
      }
      setEventBalances(balMap);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, [selectedEntity.id]);

  async function deleteOne(id: string) {
    if (!confirm('Eliminar esta conta?')) return;
    await api.accounts.delete(id);
    await reload();
  }

  function openNew() { setEditingAccount(null); setModalOpen(true); }
  function openEdit(a: Account) { setEditingAccount(a); setModalOpen(true); }

  // Group accounts by type for display
  const grouped = useMemo(() => {
    const order = ['bank', 'credit', 'voucher', 'bonds', 'wallet', 'cash'];
    const map = new Map<string, Account[]>();
    for (const a of accounts) {
      if (!map.has(a.type)) map.set(a.type, []);
      map.get(a.type)!.push(a);
    }
    return order.filter(t => map.has(t)).map(t => ({ type: t, items: map.get(t)! }));
  }, [accounts]);

  // Summary: total by category
  const totalBankCents = useMemo(() =>
    accounts.filter(a => a.type === 'bank' || a.type === 'wallet' || a.type === 'cash')
      .reduce((s, a) => s + (a.balanceCents ?? 0) + (eventBalances.get((a as any).id) ?? 0), 0),
    [accounts, eventBalances]);

  const totalVoucherCents = useMemo(() =>
    accounts.filter(a => a.type === 'voucher')
      .reduce((s, a) => s + (a.balanceCents ?? 0), 0),
    [accounts]);

  const totalBondsCents = useMemo(() =>
    accounts.filter(a => a.type === 'bonds')
      .reduce((s, a) => s + (a.balanceCents ?? 0), 0),
    [accounts]);

  if (loading) return <div className="text-zinc-500 text-sm p-4">A carregar…</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Contas</h1>
          <p className="text-xs text-zinc-500 mt-0.5">{selectedEntity.name}</p>
        </div>
        <Button onClick={openNew}>
          <Plus size={14} className="mr-1" /> Nova conta
        </Button>
      </div>

      {/* Summary strip */}
      {accounts.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-3">
            <div className="text-xs text-zinc-400 mb-1">Contas / Wallet</div>
            <div className="text-lg font-bold text-emerald-400">{formatEUR(totalBankCents)}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-zinc-400 mb-1">Vouchers</div>
            <div className="text-lg font-bold text-amber-400">{formatEUR(totalVoucherCents)}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-zinc-400 mb-1">Obrigações</div>
            <div className="text-lg font-bold text-blue-400">{formatEUR(totalBondsCents)}</div>
          </Card>
        </div>
      )}

      {/* Account groups */}
      {grouped.length === 0 && (
        <div className="text-center py-12 text-zinc-600">
          <div className="text-4xl mb-3">🏦</div>
          <div>Sem contas configuradas.</div>
          <div className="text-sm mt-1">Clica em "Nova conta" para começar.</div>
        </div>
      )}

      {grouped.map(({ type, items }) => (
        <div key={type}>
          <div className="flex items-center gap-2 mb-2">
            {TYPE_ICON[type]}
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              {TYPE_LABEL[type] ?? type}
            </span>
          </div>
          <div className="space-y-2">
            {items.map(a => {
              const id = (a as any).id as string;
              const baseBal = a.balanceCents ?? 0;
              const eventDelta = eventBalances.get(id) ?? 0;
              const bal = baseBal + eventDelta;
              const subtitle = accountSubtitle(a);
              const isExpanded = expandedAccountId === id;
              const txs = txCache[id];
              return (
                <Card key={id} className="overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-zinc-100">{a.name}</span>
                        {a.active === false && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">inativo</span>
                        )}
                      </div>
                      {subtitle && (
                        <div className="text-xs text-zinc-500 mt-0.5">{subtitle}</div>
                      )}
                      {a.balanceCents != null && (a as any).balanceAsOf && (
                        <div className="text-xs text-zinc-600 mt-0.5">saldo a {(a as any).balanceAsOf}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <div className="text-right">
                        <div className={`font-mono font-semibold text-sm ${bal > 0 ? 'text-emerald-400' : bal < 0 ? 'text-red-400' : 'text-zinc-500'}`}>
                          {formatEUR(bal)}
                        </div>
                        {eventDelta !== 0 && a.balanceCents != null && (
                          <div className="text-xs text-zinc-600">base {formatEUR(baseBal)}</div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        {a.type === 'bank' && (
                          <>
                            <button
                              onClick={() => void toggleTransactions(id)}
                              title="Ver movimentos"
                              className={`p-1.5 rounded transition-colors hover:bg-zinc-800 ${isExpanded ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-200'}`}>
                              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                            <button
                              onClick={() => setImportingAccount(a as Account & { id: string })}
                              title="Importar extrato"
                              className="p-1.5 rounded text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors">
                              <Upload size={13} />
                            </button>
                          </>
                        )}
                        <button onClick={() => openEdit(a)}
                          className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => deleteOne(id)}
                          className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-zinc-800">
                      {txLoading && !txs && (
                        <div className="px-4 py-3 text-xs text-zinc-500">A carregar movimentos…</div>
                      )}
                      {txs && txs.length === 0 && (
                        <div className="px-4 py-3 text-xs text-zinc-500">Sem movimentos importados.</div>
                      )}
                      {txs && txs.length > 0 && (
                        <div className="divide-y divide-zinc-800/60 max-h-80 overflow-y-auto">
                          {txs.map(tx => (
                            <div key={tx.id} className="px-4 py-2 flex items-center justify-between gap-3 hover:bg-zinc-800/30">
                              <div className="flex items-center gap-2 min-w-0">
                                {tx.amountCents >= 0
                                  ? <ArrowDownLeft size={12} className="text-emerald-500 shrink-0" />
                                  : <ArrowUpRight size={12} className="text-red-500 shrink-0" />
                                }
                                <div className="min-w-0">
                                  <div className="text-xs text-zinc-200 truncate">{tx.description}</div>
                                  <div className="text-xs text-zinc-600">{tx.date}</div>
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className={`font-mono text-xs font-medium ${tx.amountCents >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {tx.amountCents >= 0 ? '+' : ''}{formatEUR(tx.amountCents)}
                                </div>
                                {tx.balanceCents != null && (
                                  <div className="text-xs text-zinc-600 font-mono">{formatEUR(tx.balanceCents)}</div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      ))}

      {modalOpen && (
        <AccountModal
          editing={editingAccount}
          onSaved={reload}
          onClose={() => setModalOpen(false)}
        />
      )}
      {importingAccount && (
        <BpiImportModal
          account={importingAccount}
          entityId={selectedEntity.id}
          onClose={() => { setImportingAccount(null); void reload(); }}
          onRefresh={(aid) => setTxCache(prev => { const n = { ...prev }; delete n[aid]; return n; })}
        />
      )}
    </div>
  );
}
