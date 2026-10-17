import { useMemo, useState } from "react";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import type { Account } from "@shared/models/Account";
import { buildPayrollPreview, payrollRunId, splitConfirmedRows } from "@shared/lib/payroll";
import { formatEUR } from "@shared/lib/money";
import { api } from "../../lib/api";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const ymNow = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
};

/**
 * Equipa → Processar mês: the payroll of one or more months from the contracts in force, and
 * "Confirmar" to save them as payroll runs. A month that already has a run (seeded from a payslip
 * or confirmed before) is shown "confirmado" and skipped: one run per company, person and month
 * (`payrollRunId`), each saved under its own month.
 */
export default function ProcessPayrollModal({
  companyName, contracts, runs, people, companyAccounts, entityId, onDone, onClose,
}: {
  companyName: string;
  contracts: EmploymentContractDoc[];
  runs: PayrollRunDoc[];
  people: Array<{ id: string; name: string }>;
  companyAccounts: Account[];
  entityId: string;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(ymNow());
  const [span, setSpan] = useState(1);
  const [sourceAccountId, setSourceAccountId] = useState(companyAccounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const rows = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return buildPayrollPreview(contracts, { year: y, month1to12: m, span, companyBankAccountId: sourceAccountId || null });
  }, [contracts, month, span, sourceAccountId]);
  const { pending, confirmed } = useMemo(() => splitConfirmedRows(rows, runs), [rows, runs]);
  const done = useMemo(() => new Set(confirmed.map(r => r.key)), [confirmed]);
  const name = (id: string) => people.find(p => p.id === id)?.name ?? id;

  async function confirmRuns() {
    if (!pending.length) return;
    setBusy(true); setMsg(null);
    try {
      api.setEntity(entityId);
      await Promise.all(pending.map(r => {
        const [yy, mm] = r.yearMonth.split("-").map(Number);
        return api.payrollRuns.upsertWithId(payrollRunId(r.companyId, r.personId, r.yearMonth), {
          contractId: r.contractId, companyId: r.companyId, personId: r.personId, year: yy, month: mm,
          grossCents: r.grossCents, irsCents: r.irsCents, ssEmpCents: r.ssEmpCents, ssErCents: r.ssErCents,
          netCents: r.netCents, benefitsCents: r.totals.benefitsCents,
          costToEmployerCents: r.totals.costToEmployerCents, cashOutCents: r.totals.cashOutCents,
          confirmedAt: new Date(), sourceAccountId: sourceAccountId || undefined,
        });
      }));
      await onDone();
      setMsg(`Confirmados ${pending.length} ✔`);
    } catch (e: any) {
      setMsg(e?.message ?? "Erro ao confirmar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-4xl p-5 overflow-y-auto max-h-[92vh] space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold">Processar salários</div>
            <div className="text-xs text-zinc-500">{companyName} · a partir dos contratos em vigor em cada mês</div>
          </div>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white text-sm">✕</button>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Mês</div>
            <Input type="month" value={month} onChange={e => setMonth(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Período</div>
            <select value={span} onChange={e => setSpan(parseInt(e.target.value) || 1)}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
              <option value={1}>1 mês</option>
              <option value={3}>3 meses</option>
              <option value={6}>6 meses</option>
            </select>
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Conta de onde sai</div>
            <select value={sourceAccountId} onChange={e => setSourceAccountId(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 min-w-[200px]">
              <option value="">— escolher depois —</option>
              {companyAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="py-1.5 pr-3">Pessoa</th><th className="pr-3">Mês</th><th className="pr-3 text-right">Bruto</th>
                <th className="pr-3 text-right">IRS</th><th className="pr-3 text-right">SS</th><th className="pr-3 text-right">SS empresa</th>
                <th className="pr-3 text-right">Benefícios</th><th className="pr-3 text-right">Líquido</th><th className="pr-3 text-right">Custo</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className={`border-b border-zinc-900 ${done.has(r.key) ? "text-zinc-600" : "text-zinc-300"}`}>
                  <td className="py-1.5 pr-3">{name(r.personId)}</td>
                  <td className="pr-3 capitalize">{monthLabel(r.yearMonth)}</td>
                  <td className="pr-3 text-right tabular-nums">{formatEUR(r.grossCents)}</td>
                  <td className="pr-3 text-right tabular-nums">{formatEUR(r.irsCents)}</td>
                  <td className="pr-3 text-right tabular-nums">{formatEUR(r.ssEmpCents)}</td>
                  <td className="pr-3 text-right tabular-nums">{formatEUR(r.ssErCents)}</td>
                  <td className="pr-3 text-right tabular-nums">{formatEUR(r.totals.benefitsCents)}</td>
                  <td className="pr-3 text-right tabular-nums">{formatEUR(r.netCents)}</td>
                  <td className="pr-3 text-right tabular-nums">{formatEUR(r.totals.costToEmployerCents)}</td>
                  <td>{done.has(r.key)
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">confirmado</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">por confirmar</span>}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={10} className="py-4 text-zinc-500">Nenhum contrato em vigor neste período.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={confirmRuns} disabled={busy || !pending.length}>Confirmar {pending.length}</Button>
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
          {confirmed.length > 0 && <span className="text-xs text-zinc-500">{confirmed.length} já confirmado(s), ficam como estão.</span>}
          {msg && <span className="text-sm text-emerald-400">{msg}</span>}
        </div>
      </Card>
    </div>
  );
}
