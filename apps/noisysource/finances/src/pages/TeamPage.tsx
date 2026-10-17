import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { BenefitConfig, EmploymentContractDoc } from "@shared/models/Employment";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { contractDateYM } from "@shared/lib/payroll";
import { db } from "../lib/firebase";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import { deactivateEmploymentContractRecurring } from "../lib/contractSync";
import { benefitLabel } from "../lib/recurringItems";
import { buildTeam, type VersionStatus } from "../lib/team";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import ContractFormModal, { type ContractFormMode } from "../components/team/ContractFormModal";
import ProcessPayrollModal from "../components/team/ProcessPayrollModal";

type Named = { id: string; name: string };
const CASH_TYPES = new Set(["bank", "wallet", "cash", "credit"]);
const ymNow = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const monthLabel = (y: number, m: number) => new Date(y, m - 1, 1).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
const date = (d: unknown) => (typeof d === "string" ? d.slice(0, 10) : contractDateYM(d) ?? "");
const STATUS: Record<VersionStatus, { label: string; cls: string }> = {
  current: { label: "em vigor", cls: "bg-emerald-900/40 text-emerald-300" },
  future: { label: "futura", cls: "bg-blue-900/40 text-blue-300" },
  ended: { label: "terminada", cls: "bg-zinc-800 text-zinc-500" },
  inactive: { label: "inativa", cls: "bg-zinc-800 text-zinc-500" },
};
function benefitsText(bs: BenefitConfig[] | undefined): string {
  return (bs ?? []).map(b => {
    const perDay = (b as any).perDayCents as number | undefined;
    const days = (b as any).daysPerMonth as number | undefined;
    const value = perDay ? `${formatEUR(perDay)} × ${days ?? "?"}` : formatEUR((b as any).perMonthCents ?? 0);
    return `${benefitLabel(b.type)} ${value}`;
  }).join(" · ");
}

/**
 * Equipa (HANDOFF-finhub-redesign.md step 3): Contratos + Salários in one page per company.
 * Each person expands to their contract versions and the payroll already processed; "Novo
 * contrato", "Nova versão" and "Processar mês" open modals.
 */
export default function TeamPage() {
  const { selectedEntity } = useEntity();
  const entityId = selectedEntity.id;
  const ym = ymNow();

  const [companies, setCompanies] = useState<Named[]>([]);
  const [people, setPeople] = useState<Named[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entityAccounts, setEntityAccounts] = useState<Account[]>([]);
  const [contracts, setContracts] = useState<EmploymentContractDoc[]>([]);
  const [runs, setRuns] = useState<PayrollRunDoc[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [openRun, setOpenRun] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<ContractFormMode | null>(null);
  const [processing, setProcessing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Reference data: the company matching the entity, people, the entity's and Casa's accounts.
  useEffect(() => {
    (async () => {
      api.setEntity(entityId);
      const [cs, ps, entAccs, privateSnap] = await Promise.all([
        api.companies.list(),
        api.people.list(),
        api.accounts.list(),
        getDocs(collection(db, "finances_entities", "private", "accounts")),
      ]);
      setCompanies(cs as Named[]);
      setPeople(ps as Named[]);
      setEntityAccounts(entAccs as Account[]);
      const priv = privateSnap.docs.map(d => ({ id: d.id, ...d.data() } as Account));
      const seen = new Set<string>();
      setAccounts([...(entAccs as Account[]), ...priv].filter(a => (seen.has(a.id) ? false : (seen.add(a.id), true))));
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
      const match = (cs as Named[]).find(c => norm(c.name) === norm(selectedEntity.name));
      setCompanyId(match?.id ?? "");
      if (!match) setMsg(`Nenhuma empresa chamada "${selectedEntity.name}" em Empresas.`);
    })().catch(e => setMsg(e?.message ?? "Erro ao carregar"));
  }, [entityId, selectedEntity.name]);

  async function reload() {
    if (!companyId) { setContracts([]); setRuns([]); return; }
    api.setEntity(entityId);
    const [cs, rs] = await Promise.all([api.contracts.listByCompany(companyId), api.payrollRuns.listByCompany(companyId)]);
    setContracts(cs);
    setRuns(rs);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [companyId, entityId]);

  const nameOf = (id: string) => people.find(p => p.id === id)?.name ?? id;
  const accountName = (id?: string) => (id ? accounts.find(a => a.id === id)?.name ?? id : "não acompanhada");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const team = useMemo(() => buildTeam(contracts, runs, ym, nameOf), [contracts, runs, ym, people]);
  const companyName = companies.find(c => c.id === companyId)?.name ?? selectedEntity.name;
  const lastRun = runs.reduce<PayrollRunDoc | null>((a, r) => (!a || r.year * 12 + r.month > a.year * 12 + a.month ? r : a), null);
  const monthlyCost = team.reduce((s, t) => s + t.monthlyCostCents, 0);
  const toggle = (set: (f: (s: Set<string>) => Set<string>) => void, k: string) =>
    set(s => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; });

  async function deleteContract(c: EmploymentContractDoc) {
    if (!confirm(`Apagar esta versão do contrato de ${nameOf(c.personId)}? As entradas recorrentes dela ficam inativas.`)) return;
    try {
      await deactivateEmploymentContractRecurring(c.id, entityId);
      api.setEntity(entityId);
      await api.contracts.delete(c.id);
      await reload();
    } catch (e: any) {
      setMsg(e?.message ?? "Erro ao apagar");
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Equipa — {companyName}</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {team.filter(t => t.current).length} com contrato em vigor · custo mensal {formatEUR(monthlyCost)}
            {lastRun && <> · último mês processado: {monthLabel(lastRun.year, lastRun.month)}</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setProcessing(true)} disabled={!companyId}>Processar mês</Button>
          <Button onClick={() => setModal({ kind: "new" })} disabled={!companyId}>+ Novo contrato</Button>
        </div>
      </div>

      {msg && <div className="text-red-400 text-xs bg-red-950/30 px-3 py-2 rounded">{msg}</div>}
      {companyId && team.length === 0 && <div className="text-sm text-zinc-500">Ainda sem contratos.</div>}

      <div className="space-y-2">
        {team.map(t => {
          const isOpen = open.has(t.personId);
          const c = t.current;
          return (
            <Card key={t.personId} className="p-0 overflow-hidden">
              <button onClick={() => toggle(setOpen, t.personId)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-800/40">
                <span className="flex items-center gap-2 flex-wrap">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="font-medium">{nameOf(t.personId)}</span>
                  {(c ?? t.latest).contractType === "green_receipt" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">recibo verde</span>
                  )}
                  {(c ?? t.latest).flowToPrivate && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300">membro da casa</span>
                  )}
                  {!c && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">sem contrato em vigor</span>}
                  {c && <span className="text-xs text-zinc-500">desde {date(c.startDate) || "…"}</span>}
                </span>
                {c && (
                  <span className="flex gap-4 text-sm tabular-nums">
                    <span className="text-zinc-300">bruto {formatEUR(c.grossMonthlyCents ?? 0)}</span>
                    <span className="text-amber-300">custo {formatEUR(t.monthlyCostCents)}/mês</span>
                  </span>
                )}
              </button>

              {isOpen && (
                <div className="px-4 pb-4 space-y-4 border-t border-zinc-800">
                  <div>
                    <div className="flex items-center justify-between pt-3 pb-1.5">
                      <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Versões do contrato</span>
                      <button className="text-xs text-blue-400 hover:underline" onClick={() => setModal({ kind: "version", from: t.latest })}>
                        + Nova versão
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {t.versions.map(({ contract: v, status }) => (
                        <div key={v.id} className={`rounded border border-zinc-800 px-3 py-2 text-xs ${status === "current" ? "bg-zinc-900" : "bg-zinc-950 text-zinc-500"}`}>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="flex items-center gap-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS[status].cls}`}>{STATUS[status].label}</span>
                              <span>{date(v.startDate) || "…"} → {date(v.endDate) || "sem fim"}</span>
                            </span>
                            <span className="flex gap-3">
                              <button className="text-blue-400 hover:underline" onClick={() => setModal({ kind: "edit", contract: v })}>Editar</button>
                              <button className="text-red-400 hover:underline" onClick={() => deleteContract(v)}>Apagar</button>
                            </span>
                          </div>
                          <div className="mt-1 text-zinc-400 flex flex-wrap gap-x-4 gap-y-0.5">
                            <span>bruto {formatEUR(v.grossMonthlyCents ?? 0)}</span>
                            <span>IRS {v.irsRatePct ?? 0}%</span>
                            {v.contractType !== "green_receipt" && <span>SS {v.ssEmpPct ?? 0}% / empresa {v.ssErPct ?? 0}%</span>}
                            <span>dia {v.payDay}</span>
                            <span>líquido para {accountName(v.netPayAccountId)}</span>
                          </div>
                          {(v.benefits ?? []).length > 0 && <div className="mt-0.5 text-zinc-500">{benefitsText(v.benefits)}</div>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider pb-1.5">Salários processados</div>
                    {t.runs.length === 0 ? (
                      <div className="text-xs text-zinc-600">Nenhum mês processado.</div>
                    ) : (
                      <div className="space-y-1">
                        {t.runs.map(r => {
                          const runOpen = openRun.has(r.id);
                          return (
                            <div key={r.id} className="rounded border border-zinc-800 bg-zinc-900/60 text-xs">
                              <button onClick={() => toggle(setOpenRun, r.id)} className="w-full flex items-center justify-between px-3 py-1.5 text-left">
                                <span className="flex items-center gap-2 capitalize">
                                  {runOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  {monthLabel(r.year, r.month)}
                                </span>
                                <span className="flex gap-4 tabular-nums">
                                  <span className="text-zinc-400">líquido {formatEUR(r.netCents)}</span>
                                  <span className="text-amber-300">custo {formatEUR(r.costToEmployerCents)}</span>
                                </span>
                              </button>
                              {runOpen && (
                                <div className="px-8 pb-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-0.5 text-zinc-400 tabular-nums">
                                  <span>Bruto {formatEUR(r.grossCents)}</span>
                                  <span>IRS {formatEUR(r.irsCents)}</span>
                                  <span>SS {formatEUR(r.ssEmpCents)}</span>
                                  <span>SS empresa {formatEUR(r.ssErCents)}</span>
                                  <span>Benefícios {formatEUR(r.benefitsCents)}</span>
                                  <span>Líquido {formatEUR(r.netCents)}</span>
                                  <span>Saída total {formatEUR(r.cashOutCents)}</span>
                                  <span>Custo {formatEUR(r.costToEmployerCents)}</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {modal && (
        <ContractFormModal
          mode={modal}
          companyId={companyId}
          companyName={companyName}
          people={people}
          accounts={accounts}
          entityId={entityId}
          onSaved={reload}
          onClose={() => setModal(null)}
        />
      )}
      {processing && (
        <ProcessPayrollModal
          companyName={companyName}
          contracts={contracts}
          runs={runs}
          people={people}
          companyAccounts={entityAccounts.filter(a => CASH_TYPES.has(a.type))}
          entityId={entityId}
          onDone={reload}
          onClose={() => setProcessing(false)}
        />
      )}
    </div>
  );
}
