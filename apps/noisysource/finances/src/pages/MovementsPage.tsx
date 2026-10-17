import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Account } from "@shared/models/Account";
import type { BankTransactionDoc, BankTransactionMatch, MovementRuleDoc } from "@shared/models/BankTransaction";
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import type { CreditContractDoc } from "@shared/models/CreditContract";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import { formatEUR } from "@shared/lib/money";
import { VAT_CODES, type VatCode } from "@shared/lib/vat";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  expectedForMonth, missingExpected, normalizeDescription, suggestMatches,
  type ExpectedItem, type MovementSuggestion,
} from "../lib/movementMatching";

type Cat = { id: string; label: string; type: string };
const pad = (n: number) => String(n).padStart(2, "0");
const ymOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const todayIso = () => { const d = new Date(); return `${ymOf(d)}-${pad(d.getDate())}`; };
const shiftYM = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); return ymOf(new Date(y, m - 1 + n, 1)); };
const monthLabel = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" }); };
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const KIND_LABEL: Record<BankTransactionMatch["kind"], string> = {
  recurring: "previsto", credit: "crédito", payroll: "salário", adhoc: "avulso", transfer: "transferência",
};

/**
 * Movimentos (HANDOFF-finhub-redesign.md step 4): an account's statement lines month by month, with
 * the running balance, each matched to what was expected (recurring entries, credit instalments,
 * salaries) or classified ad hoc; expected items with no line; movements typed by hand.
 * Suggestions are confirmed by a click, never on their own.
 */
export default function MovementsPage() {
  const { selectedEntity } = useEntity();
  const entityId = selectedEntity.id;
  const isPrivate = entityId === "private";

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [ym, setYm] = useState(ymOf(new Date()));
  const [txs, setTxs] = useState<BankTransactionDoc[]>([]);
  const [entries, setEntries] = useState<RecurringEntryDoc[]>([]);
  const [credits, setCredits] = useState<CreditContractDoc[]>([]);
  const [runs, setRuns] = useState<PayrollRunDoc[]>([]);
  const [peopleById, setPeopleById] = useState<Record<string, string>>({});
  const [cats, setCats] = useState<Cat[]>([]);
  const [rules, setRules] = useState<MovementRuleDoc[]>([]);
  const [classifying, setClassifying] = useState<BankTransactionDoc | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      api.setEntity(entityId);
      const [accs, recs, crs, prs, people, categories, rs] = await Promise.all([
        api.accounts.list(), api.recurring.list(), api.credits.list(), api.payrollRuns.list(),
        api.people.list() as Promise<Array<{ id: string; name: string }>>, api.categories.list(), api.movementRules.list(),
      ]);
      setAccounts(accs as Account[]);
      setEntries(recs); setCredits(crs); setRuns(prs); setRules(rs);
      setPeopleById(Object.fromEntries(people.map(p => [p.id, p.name])));
      const name = new Map(categories.map(c => [c.id, c.name]));
      setCats(categories
        .map(c => ({ id: c.id, type: (c.type ?? "").toUpperCase(), label: c.parentId && name.has(c.parentId) ? `${name.get(c.parentId)} › ${c.name}` : c.name }))
        .sort((a, b) => a.label.localeCompare(b.label)));
      const first = (accs as Account[]).find(a => a.type === "bank") ?? (accs as Account[])[0];
      setAccountId(first?.id ?? "");
    })().catch(e => setMsg(e?.message ?? "Erro ao carregar"));
  }, [entityId]);

  async function reloadTxs(keepMonth = true) {
    if (!accountId) { setTxs([]); return; }
    const list = await api.bankTransactions.listByAccount(accountId);
    setTxs(list);
    if (!keepMonth && list.length) setYm(list[0].date.slice(0, 7)); // newest month with movements
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reloadTxs(false); }, [accountId]);

  const lines = useMemo(() => txs.filter(t => t.date.startsWith(ym)).sort((a, b) => a.date.localeCompare(b.date)), [txs, ym]);
  const expected = useMemo(
    () => (accountId ? expectedForMonth({ ym, accountId, entries, credits, payrollRuns: runs, peopleById }) : []),
    [ym, accountId, entries, credits, runs, peopleById],
  );
  const suggestions = useMemo(() => suggestMatches(lines, expected, rules), [lines, expected, rules]);
  const missing = useMemo(() => missingExpected(expected, lines, todayIso()), [expected, lines]);
  const statement = lines.filter(l => l.sourceType !== "manual" && l.balanceCents != null);
  const opening = statement.length ? statement[0].balanceCents! - statement[0].amountCents : null;
  const closing = statement.length ? statement[statement.length - 1].balanceCents! : null;
  const totalIn = lines.filter(l => l.amountCents > 0).reduce((s, l) => s + l.amountCents, 0);
  const totalOut = lines.filter(l => l.amountCents < 0).reduce((s, l) => s + l.amountCents, 0);
  const open = lines.filter(l => !l.match).length;
  const months = useMemo(() => [...new Set(txs.map(t => t.date.slice(0, 7)))].sort().reverse(), [txs]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setMsg(null);
    try { await action(); await reloadTxs(); } catch (e: any) { setMsg(e?.message ?? "Erro"); } finally { setBusy(false); }
  }
  const confirmSuggestion = (t: BankTransactionDoc, s: MovementSuggestion) =>
    run(() => api.bankTransactions.setMatch(t.id, { ...s.match, confirmedAt: new Date().toISOString() }));
  const confirmAll = () => run(async () => {
    for (const t of lines) {
      const s = suggestions.get(t.id);
      if (!t.match && s) await api.bankTransactions.setMatch(t.id, { ...s.match, confirmedAt: new Date().toISOString() });
    }
  });
  async function saveClassification(t: BankTransactionDoc, match: Omit<BankTransactionMatch, "confirmedAt">, remember: boolean) {
    await run(async () => {
      await api.bankTransactions.setMatch(t.id, { ...match, confirmedAt: new Date().toISOString() });
      if (remember) {
        api.setEntity(entityId);
        const { yearMonth: _ym, ...rest } = match;
        await api.movementRules.remember({ key: normalizeDescription(t.description), accountId: t.accountId, match: rest });
        setRules(await api.movementRules.list());
      }
    });
    setClassifying(null);
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Movimentos — {selectedEntity.name}</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Linhas dos extratos com o saldo corrido; cada uma ligada ao que estava previsto ou classificada à parte.
            As sugestões só contam depois de confirmadas.
          </p>
        </div>
        <Button onClick={() => setManualOpen(true)} disabled={!accountId}>+ Movimento manual</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select value={accountId} onChange={e => setAccountId(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm">
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="flex items-center gap-1">
          <button onClick={() => setYm(shiftYM(ym, -1))} className="p-1 rounded hover:bg-zinc-800"><ChevronLeft size={16} /></button>
          <select value={ym} onChange={e => setYm(e.target.value)} className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm capitalize">
            {[...new Set([ym, ...months])].sort().reverse().map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button onClick={() => setYm(shiftYM(ym, 1))} className="p-1 rounded hover:bg-zinc-800"><ChevronRight size={16} /></button>
        </div>
        {open > 0 && suggestions.size > 0 && (
          <Button variant="secondary" onClick={confirmAll} disabled={busy}>Confirmar todas as sugestões ({suggestions.size})</Button>
        )}
      </div>

      {msg && <div className="text-red-400 text-xs bg-red-950/30 px-3 py-2 rounded">{msg}</div>}

      <Card className="p-3 grid grid-cols-2 sm:grid-cols-5 gap-3 text-center text-xs">
        <div><div className="text-zinc-500">Saldo inicial</div><div className="text-sm font-semibold">{opening == null ? "—" : formatEUR(opening)}</div></div>
        <div><div className="text-zinc-500">Entradas</div><div className="text-sm font-semibold text-emerald-400">{formatEUR(totalIn)}</div></div>
        <div><div className="text-zinc-500">Saídas</div><div className="text-sm font-semibold text-red-400">{formatEUR(totalOut)}</div></div>
        <div><div className="text-zinc-500">Saldo final</div><div className="text-sm font-semibold">{closing == null ? "—" : formatEUR(closing)}</div></div>
        <div><div className="text-zinc-500">Por classificar</div><div className={`text-sm font-semibold ${open ? "text-amber-300" : "text-zinc-400"}`}>{open} de {lines.length}</div></div>
      </Card>

      <div className="rounded-lg border border-zinc-800 overflow-hidden">
        {lines.length === 0 && <div className="text-sm text-zinc-500 p-4">Sem movimentos neste mês. Os extratos importam-se em Contas.</div>}
        {lines.map(t => {
          const s = suggestions.get(t.id);
          return (
            <div key={t.id} className="flex items-center gap-3 px-3 py-2 border-b border-zinc-900 text-sm hover:bg-zinc-900/60">
              <span className="w-12 text-xs text-zinc-500 tabular-nums shrink-0">{ddmm(t.date)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-zinc-200" title={t.description}>{t.description}</span>
                <span className="flex items-center gap-1.5 flex-wrap mt-0.5">
                  {t.sourceType === "manual" && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">manual</span>}
                  {t.match ? (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                      ✓ {t.match.label} <span className="text-emerald-500/70">· {KIND_LABEL[t.match.kind]}</span>
                    </span>
                  ) : s ? (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300" title={s.reason}>
                      ≈ {s.match.label} <span className="text-blue-400/70">· {s.reason}</span>
                    </span>
                  ) : null}
                </span>
              </span>
              <span className={`w-24 text-right tabular-nums shrink-0 ${t.amountCents < 0 ? "text-red-400" : "text-emerald-400"}`}>{formatEUR(t.amountCents)}</span>
              <span className="w-24 text-right tabular-nums text-zinc-500 shrink-0">{t.balanceCents != null ? formatEUR(t.balanceCents) : "—"}</span>
              <span className="w-44 flex justify-end gap-2 text-xs shrink-0">
                {t.match ? (
                  <button className="text-zinc-500 hover:text-zinc-200" disabled={busy} onClick={() => run(() => api.bankTransactions.setMatch(t.id, null))}>desfazer</button>
                ) : s ? (
                  <>
                    <button className="text-emerald-400 hover:underline" disabled={busy} onClick={() => confirmSuggestion(t, s)}>Confirmar</button>
                    <button className="text-zinc-400 hover:underline" onClick={() => setClassifying(t)}>Outro…</button>
                  </>
                ) : (
                  <button className="text-blue-400 hover:underline" onClick={() => setClassifying(t)}>Classificar…</button>
                )}
                {t.sourceType === "manual" && (
                  <button className="text-red-400 hover:underline" disabled={busy}
                    onClick={() => { if (confirm("Apagar este movimento manual?")) void run(() => api.bankTransactions.deleteManual(t)); }}>apagar</button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {missing.length > 0 && (
        <Card className="p-3 space-y-1.5">
          <div className="text-xs font-semibold text-amber-300 uppercase tracking-wider">Esperado sem movimento ({missing.length})</div>
          {missing.map(i => (
            <div key={i.key} className="flex items-center justify-between text-xs text-zinc-400">
              <span>{ddmm(i.date)} · {i.label}</span>
              <span className="tabular-nums">{formatEUR(i.amountCents)}</span>
            </div>
          ))}
        </Card>
      )}

      {classifying && (
        <ClassifyModal
          tx={classifying}
          expected={expected.filter(i => Math.sign(i.amountCents) === Math.sign(classifying.amountCents))}
          cats={cats}
          withVat={!isPrivate}
          onSave={(m, remember) => saveClassification(classifying, m, remember)}
          onClose={() => setClassifying(null)}
        />
      )}
      {manualOpen && (
        <ManualModal
          accountName={accounts.find(a => a.id === accountId)?.name ?? ""}
          cats={cats}
          withVat={!isPrivate}
          onSave={input => run(() => api.bankTransactions.addManual({ ...input, accountId, entityId })).then(() => setManualOpen(false))}
          onClose={() => setManualOpen(false)}
        />
      )}
    </div>
  );
}

/** Category + VAT fields for an ad hoc classification. */
function AdhocFields({ cats, sign, withVat, categoryId, setCategoryId, vatCode, setVatCode }: {
  cats: Cat[]; sign: number; withVat: boolean;
  categoryId: string; setCategoryId: (v: string) => void; vatCode: VatCode; setVatCode: (v: VatCode) => void;
}) {
  return (
    <div className="grid sm:grid-cols-2 gap-2">
      <div>
        <div className="text-xs text-zinc-400 mb-1">Categoria</div>
        <select value={categoryId} onChange={e => setCategoryId(e.target.value)} className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm">
          <option value="">— sem categoria —</option>
          {cats.filter(c => c.type === (sign > 0 ? "INCOME" : "EXPENSE")).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      {withVat && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">IVA</div>
          <select value={String(vatCode)} onChange={e => { const v = VAT_CODES.find(c => String(c.code) === e.target.value); if (v) setVatCode(v.code); }}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm">
            {VAT_CODES.map(c => <option key={String(c.code)} value={String(c.code)}>{c.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

function ClassifyModal({ tx, expected, cats, withVat, onSave, onClose }: {
  tx: BankTransactionDoc; expected: ExpectedItem[]; cats: Cat[]; withVat: boolean;
  onSave: (m: Omit<BankTransactionMatch, "confirmedAt">, remember: boolean) => void; onClose: () => void;
}) {
  const [kind, setKind] = useState<"expected" | "adhoc" | "transfer">(expected.length ? "expected" : "adhoc");
  const [itemKey, setItemKey] = useState(expected[0]?.key ?? "");
  const [label, setLabel] = useState(normalizeDescription(tx.description).toLowerCase().replace(/^./, c => c.toUpperCase()));
  const [categoryId, setCategoryId] = useState("");
  const [vatCode, setVatCode] = useState<VatCode>("por_confirmar");
  const [remember, setRemember] = useState(true);
  const sign = Math.sign(tx.amountCents);

  function save() {
    const ym = tx.date.slice(0, 7);
    if (kind === "expected") {
      const i = expected.find(e => e.key === itemKey);
      if (!i) return;
      onSave({ kind: i.kind, ref: i.ref, yearMonth: i.yearMonth, label: i.label }, remember);
    } else if (kind === "adhoc") {
      onSave({ kind: "adhoc", yearMonth: ym, label: label.trim() || tx.description, categoryId: categoryId || undefined, vatCode: withVat ? vatCode : undefined }, remember);
    } else {
      onSave({ kind: "transfer", yearMonth: ym, label: label.trim() || "Transferência" }, remember);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-lg p-5 space-y-4">
        <div>
          <div className="text-base font-semibold">Classificar movimento</div>
          <div className="text-xs text-zinc-400 mt-1">{ddmm(tx.date)} · {tx.description}</div>
          <div className={`text-sm font-semibold tabular-nums ${tx.amountCents < 0 ? "text-red-400" : "text-emerald-400"}`}>{formatEUR(tx.amountCents)}</div>
        </div>
        <div className="grid grid-cols-3 gap-1 text-xs">
          {([["expected", "Previsto"], ["adhoc", sign > 0 ? "Receita avulsa" : "Despesa avulsa"], ["transfer", "Transferência"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setKind(k)} disabled={k === "expected" && !expected.length}
              className={`py-1.5 rounded border ${kind === k ? "border-blue-500 bg-blue-900/40 text-blue-200" : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"} disabled:opacity-40`}>
              {l}
            </button>
          ))}
        </div>
        {kind === "expected" && (
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {expected.map(i => (
              <label key={i.key} className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded border text-xs cursor-pointer ${itemKey === i.key ? "border-blue-600 bg-blue-950/30" : "border-zinc-800"}`}>
                <span className="flex items-center gap-2">
                  <input type="radio" checked={itemKey === i.key} onChange={() => setItemKey(i.key)} />
                  {ddmm(i.date)} · {i.label}
                </span>
                <span className="tabular-nums text-zinc-400">{formatEUR(i.amountCents)}</span>
              </label>
            ))}
          </div>
        )}
        {kind !== "expected" && (
          <div className="space-y-2">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Descrição</div>
              <Input value={label} onChange={e => setLabel(e.target.value)} />
            </div>
            {kind === "adhoc" && (
              <AdhocFields cats={cats} sign={sign} withVat={withVat} categoryId={categoryId} setCategoryId={setCategoryId} vatCode={vatCode} setVatCode={setVatCode} />
            )}
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Lembrar para movimentos com esta descrição (fica como sugestão)
        </label>
        <div className="flex gap-2">
          <Button onClick={save}>Guardar</Button>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        </div>
      </Card>
    </div>
  );
}

function ManualModal({ accountName, cats, withVat, onSave, onClose }: {
  accountName: string; cats: Cat[]; withVat: boolean;
  onSave: (input: { date: string; description: string; amountCents: number; match: BankTransactionMatch }) => void;
  onClose: () => void;
}) {
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [amountEUR, setAmountEUR] = useState("");
  const [out, setOut] = useState(true);
  const [transfer, setTransfer] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [vatCode, setVatCode] = useState<VatCode>("por_confirmar");
  const cents = Math.round((parseFloat(amountEUR.replace(",", ".")) || 0) * 100);

  function save() {
    if (!description.trim() || !cents || !date) return;
    const amountCents = out ? -Math.abs(cents) : Math.abs(cents);
    const match: BankTransactionMatch = transfer
      ? { kind: "transfer", yearMonth: date.slice(0, 7), label: description.trim(), confirmedAt: new Date().toISOString() }
      : { kind: "adhoc", yearMonth: date.slice(0, 7), label: description.trim(), categoryId: categoryId || undefined, vatCode: withVat ? vatCode : undefined, confirmedAt: new Date().toISOString() };
    onSave({ date, description: description.trim(), amountCents, match });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-lg p-5 space-y-3">
        <div>
          <div className="text-base font-semibold">Movimento manual</div>
          <div className="text-xs text-zinc-500">{accountName} · para o que não vem num extrato (dinheiro, cartões, Revolut…)</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><div className="text-xs text-zinc-400 mb-1">Data</div><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Valor (€)</div>
            <div className="flex gap-1">
              <button type="button" onClick={() => setOut(!out)} className={`px-2 rounded border text-xs ${out ? "border-red-800 text-red-300" : "border-emerald-800 text-emerald-300"}`}>{out ? "saída" : "entrada"}</button>
              <Input value={amountEUR} onChange={e => setAmountEUR(e.target.value)} placeholder="0,00" />
            </div>
          </div>
        </div>
        <div><div className="text-xs text-zinc-400 mb-1">Descrição</div><Input value={description} onChange={e => setDescription(e.target.value)} /></div>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={transfer} onChange={e => setTransfer(e.target.checked)} /> Transferência entre contas próprias
        </label>
        {!transfer && (
          <AdhocFields cats={cats} sign={out ? -1 : 1} withVat={withVat} categoryId={categoryId} setCategoryId={setCategoryId} vatCode={vatCode} setVatCode={setVatCode} />
        )}
        <div className="flex gap-2">
          <Button onClick={save} disabled={!description.trim() || !cents}>Guardar</Button>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        </div>
      </Card>
    </div>
  );
}
