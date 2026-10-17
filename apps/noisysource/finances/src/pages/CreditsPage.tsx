import { useEffect, useMemo, useState } from "react";
import type { CreditContractDoc, CreditType, RateType } from "@shared/models/CreditContract";
import type { FinanceEntityId } from "@shared/models/FinanceEvent";
import { buildAmortizationSchedule, getCreditStats } from "@shared/lib/amortization";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";

const TYPE_LABELS: Record<CreditType, string> = {
  mortgage: 'Habitação',
  auto: 'Automóvel',
  personal: 'Pessoal',
  business: 'Empresarial',
};
const TYPE_COLORS: Record<CreditType, string> = {
  mortgage: 'text-blue-400 bg-blue-950/40 border-blue-800/60',
  auto:     'text-purple-400 bg-purple-950/40 border-purple-800/60',
  personal: 'text-amber-400 bg-amber-950/40 border-amber-800/60',
  business: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/60',
};

const ENTITY_IDS: FinanceEntityId[] = ['private', 'noisysource', 'noisyphocus'];
const ENTITY_LABELS: Record<FinanceEntityId, string> = {
  private: 'Casa', noisysource: 'NoisySource', noisyphocus: 'NoisyPhocus',
};
const ENTITY_BADGE: Record<FinanceEntityId, string> = {
  private:     'text-blue-400 bg-blue-950/40 border-blue-800/60',
  noisysource: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/60',
  noisyphocus: 'text-purple-400 bg-purple-950/40 border-purple-800/60',
};

function currentYM(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}
function formatPct(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, '') + '%';
}
function ymLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${months[parseInt(m) - 1]} ${y}`;
}
function ymToMonths(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m;
}
function addMonthsToYM(ym: string, n: number): string {
  const total = ymToMonths(ym) + n;
  const m = ((total - 1) % 12) + 1;
  const y = (total - m) / 12;
  return `${y}-${String(m).padStart(2, '0')}`;
}
function pmt(balanceCents: number, monthlyRate: number, n: number): number {
  if (n <= 0) return 0;
  if (monthlyRate === 0) return Math.round(balanceCents / n);
  return Math.round(balanceCents * monthlyRate * Math.pow(1 + monthlyRate, n) / (Math.pow(1 + monthlyRate, n) - 1));
}

// ── Conversion simulator ───────────────────────────────────────────────────────

function ConversionSimulator({ contract }: { contract: CreditContractDoc }) {
  const now = currentYM();
  const monthsElapsed = Math.max(0, ymToMonths(now) - ymToMonths(contract.startYearMonth));
  const remainingMonths = Math.max(1, contract.termMonths - monthsElapsed);

  const [finalAmountEUR, setFinalAmountEUR] = useState(String((contract.loanAmountCents / 100).toFixed(2)));
  const [simRate, setSimRate] = useState(String(contract.annualRatePct));

  const result = useMemo(() => {
    const amount = Math.round(parseFloat(finalAmountEUR || '0') * 100);
    const rate   = parseFloat(simRate || '0');
    if (amount <= 0 || rate < 0) return null;
    const monthly = pmt(amount, rate / 12 / 100, remainingMonths);
    const totalPaid = monthly * remainingMonths;
    const totalInterest = totalPaid - amount;
    const payoffYM = addMonthsToYM(now, remainingMonths);
    const currentInterest = Math.round(contract.loanAmountCents * (contract.annualRatePct / 12 / 100));
    return { monthly, totalInterest, payoffYM, currentInterest, remainingMonths };
  }, [finalAmountEUR, simRate, remainingMonths, now, contract]);

  return (
    <div className="rounded-xl border border-orange-800/40 bg-orange-950/10 p-4 space-y-4">
      <div>
        <div className="text-xs font-semibold text-orange-400 uppercase tracking-widest">Simulador de conversão</div>
        <div className="text-xs text-zinc-500 mt-0.5">
          Projeta a prestação quando a obra terminar. Meses já decorridos: {monthsElapsed} · Restam: {remainingMonths} prestações após conversão.
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-zinc-400 mb-1">Capital final previsto (€)</div>
          <Input type="number" step="100" min="0" value={finalAmountEUR} onChange={e => setFinalAmountEUR(e.target.value)} />
          <div className="text-[10px] text-zinc-600 mt-1">Atual: {formatEUR(contract.loanAmountCents)}</div>
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-1">Taxa prevista — TAN (%)</div>
          <Input type="number" step="0.001" min="0" max="30" value={simRate} onChange={e => setSimRate(e.target.value)} />
          <div className="text-[10px] text-zinc-600 mt-1">Atual: {contract.annualRatePct}%</div>
        </div>
      </div>
      {result && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Prestação mensal', value: formatEUR(result.monthly), color: 'text-white', note: 'após conversão' },
            { label: 'Juros agora (mês)', value: formatEUR(result.currentInterest), color: 'text-orange-300', note: 'fase construção' },
            { label: 'Total juros', value: formatEUR(result.totalInterest), color: 'text-amber-400', note: `em ${result.remainingMonths} prestações` },
            { label: 'Liquidação', value: ymLabel(result.payoffYM), color: 'text-zinc-300', note: 'data fim prevista' },
          ].map(s => (
            <div key={s.label} className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">{s.label}</div>
              <div className={`text-sm font-semibold tabular-nums ${s.color}`}>{s.value}</div>
              <div className="text-[10px] text-zinc-600 mt-0.5">{s.note}</div>
            </div>
          ))}
        </div>
      )}
      {result && (
        <div className="text-xs text-zinc-500 border-t border-zinc-800 pt-3">
          Diferença para prestação atual: <span className={`font-medium ${result.monthly > result.currentInterest ? 'text-red-400' : 'text-emerald-400'}`}>
            +{formatEUR(result.monthly - result.currentInterest)}/mês
          </span> quando converter.
        </div>
      )}
    </div>
  );
}

// ── Balance sync modal ─────────────────────────────────────────────────────────

function BalanceSyncModal({
  contract, onClose, onSaved,
}: { contract: CreditContractDoc; onClose: () => void; onSaved: () => void }) {
  const now = currentYM();
  const stats = useMemo(() => getCreditStats(contract, now), [contract, now]);

  const [ym, setYm]               = useState(now);
  const [actualEUR, setActualEUR] = useState('');
  const [note, setNote]           = useState('');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState<string | null>(null);

  const actualCents   = Math.round(parseFloat(actualEUR || '0') * 100);
  const computedCents = stats.outstandingCents;
  const deltaCents    = actualCents - computedCents;
  const hasActual     = actualEUR.trim() !== '' && actualCents > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasActual) return;
    setBusy(true); setErr(null);
    try {
      await api.credits.addBalanceSync(contract.id, {
        syncYearMonth: ym,
        actualOutstandingCents: actualCents,
        computedOutstandingCents: computedCents,
        deltaCents,
        note: note.trim() || undefined,
      });
      onSaved(); onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'Erro');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <Card className="w-full max-w-md p-5 space-y-4">
        <div>
          <div className="text-base font-semibold">Sincronizar saldo — {contract.description}</div>
          <div className="text-xs text-zinc-500 mt-0.5">Entra o saldo real do banco. O motor recalibra a amortização a partir deste ponto.</div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Mês de referência</div>
              <Input type="month" value={ym} onChange={e => setYm(e.target.value)} required />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Saldo real no banco (€)</div>
              <Input type="number" step="0.01" min="0" placeholder="ex: 23388.60"
                value={actualEUR} onChange={e => setActualEUR(e.target.value)} required autoFocus />
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Calculado pelo app</span>
              <span className="tabular-nums text-zinc-300">{formatEUR(computedCents)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Saldo real</span>
              <span className="tabular-nums text-white">{hasActual ? formatEUR(actualCents) : '—'}</span>
            </div>
            {hasActual && (
              <div className="flex justify-between text-xs border-t border-zinc-800 pt-2">
                <span className="text-zinc-500">Diferença (não explicada)</span>
                <span className={`tabular-nums font-medium ${deltaCents > 0 ? 'text-red-400' : deltaCents < 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                  {deltaCents > 0 ? '+' : ''}{formatEUR(Math.abs(deltaCents))}
                  {deltaCents > 0 ? ' (banco tem mais dívida)' : deltaCents < 0 ? ' (banco tem menos dívida)' : ' (em sincronia)'}
                </span>
              </div>
            )}
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Nota (opcional)</div>
            <Input placeholder="ex: Sincronização manual — Ago 2026" value={note} onChange={e => setNote(e.target.value)} />
          </div>
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex gap-2 pt-1">
            <Button type="submit" className="flex-1" disabled={busy || !hasActual}>Sincronizar</Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ── Rate adjust modal ──────────────────────────────────────────────────────────

function RateAdjustModal({
  contract, onClose, onSaved,
}: { contract: CreditContractDoc; onClose: () => void; onSaved: () => void }) {
  const [ym, setYm]     = useState(currentYM());
  const [rate, setRate] = useState(String(contract.annualRatePct));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.credits.addRateHistory(contract.id, {
        effectiveYearMonth: ym,
        annualRatePct: parseFloat(rate),
        note: note.trim() || undefined,
      });
      onSaved(); onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'Erro');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <Card className="w-full max-w-sm p-5 space-y-4">
        <div className="text-base font-semibold">Ajustar taxa — {contract.description}</div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Efectiva a partir de</div>
            <Input type="month" value={ym} onChange={e => setYm(e.target.value)} required />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Nova TAN (%)</div>
            <Input type="number" step="0.001" min="0" max="30" value={rate} onChange={e => setRate(e.target.value)} required />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Nota (opcional)</div>
            <Input placeholder="ex: Euribor 6M revisão — Out 2026" value={note} onChange={e => setNote(e.target.value)} />
          </div>
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex gap-2 pt-1">
            <Button type="submit" className="flex-1" disabled={busy}>Guardar</Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ── Amortization preview ───────────────────────────────────────────────────────

function AmortizationPreview({ contract }: { contract: CreditContractDoc }) {
  const now = currentYM();
  const schedule = useMemo(() => buildAmortizationSchedule(contract), [contract]);
  const stats    = useMemo(() => getCreditStats(contract, now), [contract, now]);
  const [expanded, setExpanded] = useState(false);

  const visibleRows = expanded ? schedule : schedule.filter(r => r.ym >= now).slice(0, 6);
  const paidRows    = schedule.filter(r => r.ym < now);
  const totalPaid   = paidRows.reduce((s, r) => s + r.paymentCents, 0);
  const totalInterestPaid = paidRows.reduce((s, r) => s + r.interestCents, 0);

  return (
    <div className="mt-3 space-y-3">
      {contract.interestOnlyPhase && (
        <div className="rounded-lg border border-orange-800/40 bg-orange-950/20 px-3 py-2 text-xs text-orange-300">
          Fase de construção — apenas juros. Quando a obra terminar, edita o crédito: desativa esta opção, atualiza o capital para o valor final desembolsado.
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Prestação atual', value: formatEUR(stats.monthlyPaymentCents), color: 'text-white' },
          { label: 'Capital em dívida', value: formatEUR(stats.outstandingCents), color: 'text-red-400' },
          { label: 'Juros restantes', value: formatEUR(stats.totalRemainingInterestCents), color: 'text-amber-400' },
          { label: 'Liquidação', value: ymLabel(stats.payoffYearMonth), color: 'text-zinc-300' },
        ].map(s => (
          <div key={s.label} className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">{s.label}</div>
            <div className={`text-sm font-semibold tabular-nums ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>
      {schedule.length > 0 && (() => {
        const paid = contract.loanAmountCents - stats.outstandingCents;
        const pct  = Math.round((paid / contract.loanAmountCents) * 100);
        return (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-zinc-500">
              <span>Capital amortizado: {formatEUR(paid)} ({pct}%)</span>
              <span>Restante: {stats.remainingMonths} prestações</span>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}
      {schedule.length > 0 && (
        <div>
          <div className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1.5">
            {expanded ? 'Plano de amortização completo' : 'Próximas prestações'}
          </div>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="text-left px-3 py-2 font-normal">Mês</th>
                  <th className="text-right px-3 py-2 font-normal">Prestação</th>
                  <th className="text-right px-3 py-2 font-normal">Capital</th>
                  <th className="text-right px-3 py-2 font-normal">Juros</th>
                  <th className="text-right px-3 py-2 font-normal">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(row => (
                  <tr key={row.ym} className={`border-b border-zinc-800/50 last:border-0 ${row.ym === now ? 'bg-zinc-800/60' : ''} ${row.ym < now ? 'opacity-40' : ''}`}>
                    <td className="px-3 py-1.5 tabular-nums text-zinc-300">{ymLabel(row.ym)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-white">{formatEUR(row.paymentCents)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">{formatEUR(row.capitalCents)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-amber-400/80">{formatEUR(row.interestCents)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">{formatEUR(row.outstandingCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!expanded && schedule.filter(r => r.ym >= now).length > 6 && (
            <button onClick={() => setExpanded(true)} className="mt-2 text-xs text-blue-400 hover:underline">
              Ver plano completo ({schedule.filter(r => r.ym >= now).length} prestações)
            </button>
          )}
          {expanded && (
            <button onClick={() => setExpanded(false)} className="mt-2 text-xs text-blue-400 hover:underline">Mostrar menos</button>
          )}
        </div>
      )}
      {(contract.rateHistory ?? []).length > 0 && (
        <div>
          <div className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1.5">Histórico de taxa</div>
          <div className="space-y-1">
            <div className="flex gap-3 text-xs text-zinc-400 px-1">
              <span className="w-20">{ymLabel(contract.startYearMonth)}</span>
              <span className="font-medium">{formatPct(contract.annualRatePct)}</span>
              <span className="text-zinc-600">Taxa inicial</span>
            </div>
            {[...(contract.rateHistory ?? [])].sort((a, b) => a.effectiveYearMonth.localeCompare(b.effectiveYearMonth)).map((h, i) => (
              <div key={i} className="flex gap-3 text-xs text-zinc-400 px-1">
                <span className="w-20">{ymLabel(h.effectiveYearMonth)}</span>
                <span className="font-medium text-zinc-200">{formatPct(h.annualRatePct)}</span>
                {h.note && <span className="text-zinc-500 truncate">{h.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {paidRows.length > 0 && (
        <div className="text-xs text-zinc-600">
          Total pago: {formatEUR(totalPaid)} · Juros pagos: {formatEUR(totalInterestPaid)}
        </div>
      )}
    </div>
  );
}

// ── Form types ─────────────────────────────────────────────────────────────────

type Form = {
  entityId: FinanceEntityId;
  type: CreditType;
  description: string;
  creditor: string;
  loanAmountEUR: string;
  startYearMonth: string;
  termMonths: string;
  rateType: RateType;
  annualRatePct: string;
  spreadPct: string;
  interestOnlyPhase: boolean;
  accountId: string;
  dayOfMonth: string;
  active: boolean;
  notes: string;
};
const emptyForm = (entityId: FinanceEntityId = 'private'): Form => ({
  entityId, type: 'mortgage', description: '', creditor: '',
  loanAmountEUR: '', startYearMonth: '', termMonths: '',
  rateType: 'variable', annualRatePct: '', spreadPct: '',
  interestOnlyPhase: false, accountId: '', dayOfMonth: '15', active: true, notes: '',
});
function fromDoc(d: CreditContractDoc, entityId: FinanceEntityId): Form {
  return {
    entityId, type: d.type, description: d.description, creditor: d.creditor,
    loanAmountEUR: (d.loanAmountCents / 100).toFixed(2),
    startYearMonth: d.startYearMonth, termMonths: String(d.termMonths),
    rateType: d.rateType, annualRatePct: String(d.annualRatePct),
    spreadPct: d.spreadPct != null ? String(d.spreadPct) : '',
    interestOnlyPhase: d.interestOnlyPhase ?? false,
    accountId: d.accountId ?? '', dayOfMonth: String(d.dayOfMonth ?? 15),
    active: d.active, notes: d.notes ?? '',
  };
}

type AccountsByEntity = Record<FinanceEntityId, { id: string; name: string }[]>;

// ── Credit form modal ──────────────────────────────────────────────────────────

function CreditFormModal({
  editingId,
  initial,
  accountsByEntity,
  onSave,
  onClose,
}: {
  editingId: string | null;
  initial: Form;
  accountsByEntity: AccountsByEntity;
  onSave: (form: Form, id: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));
  const accounts = accountsByEntity[form.entityId] ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
        <div className="text-base font-semibold mb-4">{editingId ? 'Editar crédito' : 'Novo crédito'}</div>
        <form onSubmit={submit} className="space-y-3">
          {/* Entity selector */}
          <div>
            <div className="text-xs text-zinc-400 mb-1">Entidade</div>
            <div className="grid grid-cols-3 gap-1">
              {ENTITY_IDS.map(eid => (
                <button key={eid} type="button" onClick={() => set('entityId', eid)}
                  className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                    form.entityId === eid
                      ? ENTITY_BADGE[eid]
                      : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                  }`}>
                  {ENTITY_LABELS[eid]}
                </button>
              ))}
            </div>
          </div>

          {/* Type */}
          <div className="grid grid-cols-2 gap-1">
            {(['mortgage','auto','personal','business'] as CreditType[]).map(t => (
              <button key={t} type="button" onClick={() => set('type', t)}
                className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                  form.type === t ? TYPE_COLORS[t] : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                }`}>
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">Descrição</div>
            <Input placeholder="Casa Lisboa, Tesla Model Y…" value={form.description}
              onChange={e => set('description', e.target.value)} required autoFocus />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Credor</div>
            <Input placeholder="BPI, CGD, Montepio…" value={form.creditor}
              onChange={e => set('creditor', e.target.value)} required />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Capital inicial (€)</div>
              <Input type="number" step="0.01" placeholder="0.00" value={form.loanAmountEUR}
                onChange={e => set('loanAmountEUR', e.target.value)} required />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Nº prestações</div>
              <Input type="number" min="1" placeholder="360" value={form.termMonths}
                onChange={e => set('termMonths', e.target.value)} required />
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">1.ª prestação</div>
            <Input type="month" value={form.startYearMonth} onChange={e => set('startYearMonth', e.target.value)} required />
          </div>

          <div className="grid grid-cols-2 gap-1 mb-1">
            {(['fixed','variable'] as RateType[]).map(r => (
              <button key={r} type="button" onClick={() => set('rateType', r)}
                className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                  form.rateType === r
                    ? 'border-purple-500 bg-purple-900/50 text-purple-200'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                }`}>
                {r === 'fixed' ? 'Taxa fixa' : 'Taxa variável'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs text-zinc-400 mb-1">TAN (%)</div>
              <Input type="number" step="0.001" min="0" max="30" placeholder="3.5"
                value={form.annualRatePct} onChange={e => set('annualRatePct', e.target.value)} required />
            </div>
            {form.rateType === 'variable' && (
              <div>
                <div className="text-xs text-zinc-400 mb-1">Spread (%)</div>
                <Input type="number" step="0.001" min="0" max="10" placeholder="1.0"
                  value={form.spreadPct} onChange={e => set('spreadPct', e.target.value)} />
              </div>
            )}
          </div>

          <label className="flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 cursor-pointer hover:border-orange-800/50 transition-colors">
            <input type="checkbox" checked={form.interestOnlyPhase}
              onChange={e => set('interestOnlyPhase', e.target.checked)} className="mt-0.5 shrink-0" />
            <div>
              <div className="text-sm text-zinc-200">Fase de construção (só juros)</div>
              <div className="text-xs text-zinc-500 mt-0.5">O capital não amortiza — apenas juros até obra concluída</div>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Conta</div>
              <select value={form.accountId} onChange={e => set('accountId', e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm">
                <option value="">— selecionar —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Dia do mês</div>
              <Input type="number" min="1" max="31" value={form.dayOfMonth}
                onChange={e => set('dayOfMonth', e.target.value)} />
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">Notas</div>
            <Input placeholder="Notas opcionais…" value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>

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

type ContractWithEntity = CreditContractDoc & { _entityId: FinanceEntityId };

export default function CreditsPage() {
  const [allContracts, setAllContracts]   = useState<ContractWithEntity[]>([]);
  const [accountsByEntity, setAccountsByEntity] = useState<AccountsByEntity>({
    private: [], noisysource: [], noisyphocus: [],
  });
  const [expandedId, setExpandedId]       = useState<string | null>(null);
  const [rateModalContract, setRateModalContract]   = useState<ContractWithEntity | null>(null);
  const [syncModalContract, setSyncModalContract]   = useState<ContractWithEntity | null>(null);
  const [busy, setBusy]                   = useState(false);
  const [msg, setMsg]                     = useState<string | null>(null);

  // Modal state
  const [modalOpen, setModalOpen]   = useState(false);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [formInit, setFormInit]     = useState<Form>(emptyForm());

  async function reload() {
    setBusy(true);
    try {
      const allC: ContractWithEntity[] = [];
      const allA: AccountsByEntity = { private: [], noisysource: [], noisyphocus: [] };
      for (const eid of ENTITY_IDS) {
        api.setEntity(eid);
        const [cs, as] = await Promise.all([api.credits.list(), api.accounts.list()]);
        for (const c of cs) allC.push({ ...c, _entityId: eid });
        allA[eid] = as.map(a => ({ id: a.id, name: a.name }));
      }
      setAllContracts(allC);
      setAccountsByEntity(allA);
    } catch (e: any) {
      setMsg(e?.message ?? 'Erro ao carregar');
    } finally { setBusy(false); }
  }

  useEffect(() => { void reload(); }, []);

  function openCreate() {
    setEditingId(null);
    setFormInit(emptyForm('private'));
    setModalOpen(true);
    setMsg(null);
  }
  function openEdit(c: ContractWithEntity) {
    setEditingId(c.id);
    setFormInit(fromDoc(c, c._entityId));
    setModalOpen(true);
    setMsg(null);
  }

  async function handleSave(form: Form, id: string | null) {
    api.setEntity(form.entityId);
    const existing = id ? allContracts.find(c => c.id === id) : null;
    await api.credits.save({
      id: id ?? undefined,
      type: form.type,
      description: form.description.trim(),
      creditor: form.creditor.trim(),
      loanAmountCents: Math.round(parseFloat(form.loanAmountEUR || '0') * 100),
      startYearMonth: form.startYearMonth,
      termMonths: parseInt(form.termMonths || '0', 10),
      rateType: form.rateType,
      annualRatePct: parseFloat(form.annualRatePct || '0'),
      spreadPct: form.spreadPct ? parseFloat(form.spreadPct) : undefined,
      interestOnlyPhase: form.interestOnlyPhase || undefined,
      accountId: form.accountId || undefined,
      dayOfMonth: parseInt(form.dayOfMonth || '15', 10),
      active: form.active,
      notes: form.notes.trim() || undefined,
      rateHistory: existing?.rateHistory ?? [],
    });
    await reload();
    setMsg('Guardado ✔');
  }

  async function deleteOne(c: ContractWithEntity) {
    if (!confirm('Eliminar este crédito?')) return;
    setBusy(true);
    try {
      api.setEntity(c._entityId);
      await api.credits.delete(c.id);
      await reload();
    } catch (e: any) {
      setMsg(e?.message ?? 'Erro ao eliminar');
    } finally { setBusy(false); }
  }

  const now = currentYM();

  const summary = useMemo(() => {
    const active = allContracts.filter(c => c.active);
    const totalOutstanding = active.reduce((s, c) => s + getCreditStats(c, now).outstandingCents, 0);
    const totalMonthly = active.reduce((s, c) => s + getCreditStats(c, now).monthlyPaymentCents, 0);
    return { totalOutstanding, totalMonthly, count: active.length };
  }, [allContracts, now]);

  // Group contracts by entity for display
  const byEntity = useMemo(() => {
    const map = new Map<FinanceEntityId, ContractWithEntity[]>();
    for (const eid of ENTITY_IDS) {
      const cs = allContracts.filter(c => c._entityId === eid);
      if (cs.length) map.set(eid, cs);
    }
    return map;
  }, [allContracts]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Créditos</h2>
          <p className="text-sm text-zinc-400 mt-0.5">Todos os créditos · habitação, automóvel, pessoal, empresarial</p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-sm text-emerald-400">{msg}</span>}
          <Button onClick={openCreate} type="button" disabled={busy}>+ Novo crédito</Button>
        </div>
      </div>

      {/* Summary strip */}
      {summary.count > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Prestação mensal total', value: formatEUR(summary.totalMonthly) + '/mês', color: 'text-red-400' },
            { label: 'Capital em dívida total', value: formatEUR(summary.totalOutstanding), color: 'text-amber-400' },
            { label: 'Créditos ativos', value: String(summary.count), color: 'text-zinc-200' },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{s.label}</div>
              <div className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {allContracts.length === 0 && !busy && (
        <div className="text-sm text-zinc-500 text-center py-10">Nenhum crédito registado.</div>
      )}

      {/* Contracts grouped by entity */}
      {[...byEntity.entries()].map(([eid, contracts]) => (
        <div key={eid} className="space-y-3">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded border ${ENTITY_BADGE[eid]}`}>
              {ENTITY_LABELS[eid]}
            </span>
            <div className="flex-1 h-px bg-zinc-800" />
          </div>

          {contracts.map(c => {
            const isExpanded = expandedId === c.id;
            const stats      = getCreditStats(c, now);

            return (
              <div key={c.id}
                className={`rounded-xl border transition-colors ${
                  editingId === c.id ? 'border-emerald-700 bg-emerald-950/10'
                    : 'border-zinc-800 bg-zinc-900'
                } ${!c.active ? 'opacity-50' : ''}`}>
                <div className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{c.description}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${TYPE_COLORS[c.type]}`}>
                        {TYPE_LABELS[c.type]}
                      </span>
                      {c.rateType === 'variable' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-950/40 border border-purple-800/60 text-purple-400">variável</span>
                      )}
                      {c.interestOnlyPhase && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-950/40 border border-orange-800/60 text-orange-400">só juros · construção</span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1 flex items-center gap-2 flex-wrap">
                      <span>{c.creditor}</span>
                      <span className="text-zinc-700">·</span>
                      <span>{formatPct(c.annualRatePct)} TAN</span>
                      <span className="text-zinc-700">·</span>
                      <span>{c.termMonths} prestações</span>
                      <span className="text-zinc-700">·</span>
                      <span>{formatEUR(c.loanAmountCents)} inicial</span>
                    </div>
                    <div className="flex items-center gap-4 mt-2">
                      <div className="text-xs text-zinc-400">
                        Prestação: <span className="text-white font-medium">{formatEUR(stats.monthlyPaymentCents)}/mês</span>
                      </div>
                      <div className="text-xs text-zinc-400">
                        Em dívida: <span className="text-red-400 font-medium">{formatEUR(stats.outstandingCents)}</span>
                      </div>
                      <div className="text-xs text-zinc-400">
                        Liquidação: <span className="text-zinc-300">{ymLabel(stats.payoffYearMonth)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 text-xs shrink-0 mt-0.5">
                    <button onClick={() => setExpandedId(isExpanded ? null : c.id)} className="text-zinc-400 hover:text-white">
                      {isExpanded ? 'Fechar' : 'Detalhes'}
                    </button>
                    {c.rateType === 'variable' && (
                      <button onClick={() => { api.setEntity(c._entityId); setRateModalContract(c); }}
                        className="text-purple-400 hover:underline">Ajustar taxa</button>
                    )}
                    {!c.interestOnlyPhase && (
                      <button onClick={() => { api.setEntity(c._entityId); setSyncModalContract(c); }}
                        className="text-teal-400 hover:underline">Sincronizar saldo</button>
                    )}
                    <button onClick={() => openEdit(c)} className="text-blue-400 hover:underline">Editar</button>
                    <button onClick={() => deleteOne(c)} className="text-red-400 hover:underline">Apagar</button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-zinc-800 px-4 pb-4 space-y-4 pt-4">
                    {c.interestOnlyPhase && <ConversionSimulator contract={c} />}
                    <AmortizationPreview contract={c} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Modals */}
      {modalOpen && (
        <CreditFormModal
          editingId={editingId}
          initial={formInit}
          accountsByEntity={accountsByEntity}
          onSave={handleSave}
          onClose={() => { setModalOpen(false); setEditingId(null); }}
        />
      )}
      {rateModalContract && (
        <RateAdjustModal
          contract={rateModalContract}
          onClose={() => setRateModalContract(null)}
          onSaved={reload}
        />
      )}
      {syncModalContract && (
        <BalanceSyncModal
          contract={syncModalContract}
          onClose={() => setSyncModalContract(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
