import { useMemo, useState } from "react";
import type { BenefitConfig, EmploymentContractDoc } from "@shared/models/Employment";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { api } from "../../lib/api";
import { syncEmploymentContractRecurring } from "../../lib/contractSync";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BenefitsEditor } from "../BenefitsEditor";

type Person = { id: string; name: string };

function toEUR(cents: number) { return cents > 0 ? (cents / 100).toFixed(2) : ""; }
function fromEUR(s: string)   { return Math.round((parseFloat(s) || 0) * 100); }
function pct(s: string)       { return parseFloat(s) || 0; }
/** Contract dates: ISO strings (the form) or Timestamps (older docs). */
function isoDate(d: unknown): string {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  const date = typeof (d as any).toDate === "function" ? (d as any).toDate() : new Date(d as any);
  return isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}
/** The ISO date one day before `iso`. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const EMPTY_FORM = {
  contractType: "employee" as "employee" | "green_receipt",
  personId: "",
  grossEUR: "",
  irsPct: "",
  ssEmpPct: "11",
  ssErPct: "23.75",
  payDay: "25",
  startDate: "",
  endDate: "",
  active: true,
  flowToPrivate: false,
  netPayAccountId: "",
  benefits: [] as BenefitConfig[],
};
type Form = typeof EMPTY_FORM;

function formFrom(c: EmploymentContractDoc): Form {
  return {
    contractType: c.contractType === "green_receipt" ? "green_receipt" : "employee",
    personId: c.personId,
    grossEUR: toEUR(c.grossMonthlyCents ?? 0),
    irsPct: String(c.irsRatePct ?? ""),
    ssEmpPct: String(c.ssEmpPct ?? "11"),
    ssErPct: String(c.ssErPct ?? "23.75"),
    payDay: String(c.payDay ?? "25"),
    startDate: isoDate(c.startDate),
    endDate: isoDate(c.endDate),
    active: c.active !== false,
    flowToPrivate: c.flowToPrivate ?? false,
    netPayAccountId: c.netPayAccountId || "",
    benefits: Array.isArray(c.benefits) ? c.benefits : [],
  };
}

export type ContractFormMode =
  | { kind: "new"; personId?: string }
  | { kind: "edit"; contract: EmploymentContractDoc }
  /** A raise or any change from a date: a copy of `from`; saving ends `from` the day before. */
  | { kind: "version"; from: EmploymentContractDoc };

/**
 * Create or edit an employment contract (Equipa). Saving syncs its recurring entries
 * (contractSync), exactly as the old Contratos page did. A new version ends the previous one the
 * day before it starts, so each month has one version in force.
 */
export default function ContractFormModal({
  mode, companyId, companyName, people, accounts, entityId, onSaved, onClose,
}: {
  mode: ContractFormMode;
  companyId: string;
  companyName: string;
  people: Person[];
  /** Entity accounts + Casa's (net pay goes to a personal account; vouchers to cards). */
  accounts: Account[];
  entityId: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(() =>
    mode.kind === "edit" ? formFrom(mode.contract)
    : mode.kind === "version" ? { ...formFrom(mode.from), startDate: "", endDate: "" }
    : { ...EMPTY_FORM, personId: mode.personId ?? "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));
  const bankAccounts = useMemo(() => accounts.filter(a => a.type === "bank"), [accounts]);
  const personName = (id: string) => people.find(p => p.id === id)?.name ?? id;

  const previous = mode.kind === "version" ? mode.from : null;
  const previousStart = previous ? isoDate(previous.startDate) : "";
  const versionDateError =
    previous && form.startDate && previousStart && form.startDate <= previousStart
      ? `A nova versão tem de começar depois de ${previousStart}.` : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId || !form.personId || versionDateError) return;
    if (previous && !form.startDate) { setMsg("Indica a data de início da nova versão."); return; }
    setBusy(true); setMsg(null);
    try {
      const isGreenReceipt = form.contractType === "green_receipt";
      const payload = {
        id: mode.kind === "edit" ? mode.contract.id : undefined,
        companyId,
        personId: form.personId,
        contractType: form.contractType,
        grossMonthlyCents: fromEUR(form.grossEUR),
        irsRatePct: pct(form.irsPct),
        // Green receipt: no SS, whatever stale value sits in these fields.
        ssEmpPct: isGreenReceipt ? 0 : pct(form.ssEmpPct),
        ssErPct: isGreenReceipt ? 0 : pct(form.ssErPct),
        payDay: Math.max(1, Math.min(31, parseInt(form.payDay || "25", 10))),
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
        active: form.active,
        flowToPrivate: form.flowToPrivate,
        netPayAccountId: form.netPayAccountId || undefined,
        // Benefits (subsídios) don't apply to a green receipt.
        benefits: isGreenReceipt ? [] : form.benefits,
      };
      api.setEntity(entityId);
      const id = await (api.contracts as any).save(payload);
      const name = personName(form.personId);
      const saved = await api.contracts.get(id) as EmploymentContractDoc;
      await syncEmploymentContractRecurring(saved, name, entityId);

      // New version: the previous one ends the day before (and its recurring entries with it).
      if (previous && form.startDate && (!previous.endDate || isoDate(previous.endDate) >= form.startDate)) {
        api.setEntity(entityId);
        await api.contracts.update(previous.id, { ...previous, endDate: dayBefore(form.startDate) as any });
        const prevSaved = await api.contracts.get(previous.id) as EmploymentContractDoc;
        await syncEmploymentContractRecurring(prevSaved, name, entityId);
      }
      await onSaved();
      onClose();
    } catch (e: any) {
      setMsg(e?.message ?? "Erro ao guardar");
    } finally {
      setBusy(false);
    }
  }

  const title = mode.kind === "edit" ? `Editar contrato — ${personName(form.personId)}`
    : mode.kind === "version" ? `Nova versão — ${personName(form.personId)}`
    : "Novo contrato";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-2xl p-5 overflow-y-auto max-h-[92vh]">
        <form onSubmit={save} className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-semibold">{title}</div>
              <div className="text-xs text-zinc-500">{companyName}</div>
            </div>
            <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white text-sm">✕</button>
          </div>

          {previous && (
            <div className="text-xs text-zinc-400 bg-zinc-900 border border-zinc-800 rounded px-3 py-2">
              Cópia da versão em vigor desde {previousStart || "…"}. Muda o que mudou e indica a data de início:
              a versão anterior termina no dia anterior.
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Pessoa</div>
              <select value={form.personId} onChange={e => set("personId", e.target.value)} disabled={mode.kind !== "new"}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 disabled:opacity-60">
                <option value="">— escolher —</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Tipo de contrato</div>
              <div className="grid grid-cols-2 gap-1">
                {(["employee", "green_receipt"] as const).map(t => (
                  <button key={t} type="button" onClick={() => set("contractType", t)}
                    className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                      form.contractType === t ? "border-blue-500 bg-blue-900/50 text-blue-200" : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                    }`}>
                    {t === "employee" ? "Contrato de trabalho" : "Recibo verde"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {form.contractType === "green_receipt" && (
            <div className="text-[11px] text-zinc-500 -mt-2">Prestador de serviços: sem SS a cargo da empresa, sem subsídios.</div>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">
                {form.contractType === "green_receipt" ? "Valor mensal do recibo (€)" : "Vencimento bruto mensal (€)"}
              </div>
              <Input type="number" step="0.01" placeholder="0.00" value={form.grossEUR} onChange={e => set("grossEUR", e.target.value)} />
              {form.grossEUR && <div className="text-xs text-zinc-500 mt-1">{formatEUR(fromEUR(form.grossEUR))}</div>}
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Dia de pagamento</div>
              <Input type="number" min={1} max={31} value={form.payDay} onChange={e => set("payDay", e.target.value)} />
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">{form.contractType === "green_receipt" ? "Retenção na fonte %" : "IRS %"}</div>
              <Input type="number" step="0.01" placeholder="15" value={form.irsPct} onChange={e => set("irsPct", e.target.value)} />
            </div>
            {form.contractType === "employee" && (
              <>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">SS trabalhador %</div>
                  <Input type="number" step="0.01" value={form.ssEmpPct} onChange={e => set("ssEmpPct", e.target.value)} />
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">SS empresa %</div>
                  <Input type="number" step="0.01" value={form.ssErPct} onChange={e => set("ssErPct", e.target.value)} />
                </div>
              </>
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Início</div>
              <Input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} />
              {versionDateError && <div className="text-xs text-red-400 mt-1">{versionDateError}</div>}
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Fim (opcional)</div>
              <Input type="date" value={form.endDate} onChange={e => set("endDate", e.target.value)} />
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-400 mb-1">Conta do líquido</div>
            <select value={form.netPayAccountId} onChange={e => set("netPayAccountId", e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1">
              <option value="">— não acompanhada —</option>
              {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          {form.contractType === "employee" && (
            <div>
              <div className="text-sm font-medium mb-2">Benefícios</div>
              <BenefitsEditor benefits={form.benefits} accountsForPerson={accounts} onChange={v => set("benefits", v)} />
            </div>
          )}

          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
              Ativo
            </label>
            <label className="flex items-center gap-2 text-sm" title="O líquido e os vales entram como rendimento da Casa">
              <input type="checkbox" checked={form.flowToPrivate} onChange={e => set("flowToPrivate", e.target.checked)} />
              Membro da casa
            </label>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" disabled={busy || !companyId || !form.personId || !!versionDateError}>
              {mode.kind === "edit" ? "Guardar" : mode.kind === "version" ? "Criar nova versão" : "Criar contrato"}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
            {msg && <span className="text-sm text-red-400">{msg}</span>}
          </div>
        </form>
      </Card>
    </div>
  );
}
