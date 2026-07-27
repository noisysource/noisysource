import { useEffect, useMemo, useState } from "react";
import type { BenefitConfig, EmploymentContractDoc } from "@shared/models/Employment";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../lib/firebase";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import { syncEmploymentContractRecurring, deactivateEmploymentContractRecurring } from "../lib/contractSync";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { BenefitsEditor } from "../components/BenefitsEditor";

type Company = { id: string; name: string };
type Person  = { id: string; name: string };

function toEUR(cents: number) { return cents > 0 ? (cents / 100).toFixed(2) : ""; }
function fromEUR(s: string)   { return Math.round((parseFloat(s) || 0) * 100); }
function pct(s: string)       { return parseFloat(s) || 0; }

const EMPTY_FORM = {
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

export default function EmploymentContractsPage() {
  const { selectedEntity } = useEntity();

  const [companies, setCompanies]   = useState<Company[]>([]);
  const [people, setPeople]         = useState<Person[]>([]);
  const [accounts, setAccounts]     = useState<Account[]>([]);
  const [contracts, setContracts]   = useState<EmploymentContractDoc[]>([]);

  const [companyId, setCompanyId]   = useState("");
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [form, setForm]             = useState(EMPTY_FORM);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState<string | null>(null);

  const set = <K extends keyof typeof EMPTY_FORM>(k: K, v: (typeof EMPTY_FORM)[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  // person's bank accounts for net pay wiring (includes joint-owned accounts)
  const bankAccountsForPerson = useMemo(
    () => accounts.filter(a =>
      a.type === "bank" && a.ownerType === "person" &&
      (a.ownerId === form.personId || a.jointOwnerIds?.includes(form.personId))
    ),
    [accounts, form.personId]
  );

  // all accounts for benefits editor (includes joint-owned accounts)
  const accountsForPerson = useMemo(
    () => accounts.filter(a =>
      a.ownerType === "person" &&
      (a.ownerId === form.personId || a.jointOwnerIds?.includes(form.personId))
    ),
    [accounts, form.personId]
  );

  // load reference data when entity changes
  useEffect(() => {
    (async () => {
      // personal bank accounts live in the `private` entity regardless of current context
      const [cs, ps, entityAccounts, privateSnap] = await Promise.all([
        api.companies.list(),
        api.people.list(),
        api.accounts.list(),
        getDocs(collection(db, "finances_entities", "private", "accounts")),
      ]);
      const companiesList = cs as Company[];
      setCompanies(companiesList);
      setPeople(ps as Person[]);
      const privateAccounts = privateSnap.docs.map(d => ({ id: d.id, ...d.data() } as Account));
      const combined = [...(entityAccounts as Account[]), ...privateAccounts];
      const seen = new Set<string>();
      setAccounts(combined.filter(a => seen.has(a.id) ? false : (seen.add(a.id), true)));
      const match = companiesList.find(
        c => c.name.toLowerCase() === selectedEntity.name.toLowerCase()
      ) ?? companiesList[0];
      if (match) setCompanyId(match.id);
    })();
  }, [selectedEntity.id]);

  // load contracts when company changes
  useEffect(() => {
    if (!companyId) { setContracts([]); return; }
    (api.contracts as any).listByCompany(companyId).then(setContracts).catch(() => setContracts([]));
  }, [companyId]);

  function startNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setMsg(null);
  }

  async function startEdit(id: string) {
    setMsg(null);
    const c = await api.contracts.get(id);
    if (!c) return;
    setEditingId(id);
    setForm({
      personId: c.personId,
      grossEUR: toEUR(c.grossMonthlyCents ?? 0),
      irsPct: String(c.irsRatePct ?? ""),
      ssEmpPct: String(c.ssEmpPct ?? "11"),
      ssErPct: String(c.ssErPct ?? "23.75"),
      payDay: String(c.payDay ?? "25"),
      startDate: c.startDate ? new Date(c.startDate as any).toISOString().slice(0, 10) : "",
      endDate: c.endDate ? new Date(c.endDate as any).toISOString().slice(0, 10) : "",
      active: c.active !== false,
      flowToPrivate: c.flowToPrivate ?? false,
      netPayAccountId: c.netPayAccountId || "",
      benefits: Array.isArray(c.benefits) ? c.benefits : [],
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!companyId || !form.personId) return;
    setBusy(true); setMsg(null);
    try {
      const payload = {
        id: editingId ?? undefined,
        companyId,
        personId: form.personId,
        grossMonthlyCents: fromEUR(form.grossEUR),
        irsRatePct: pct(form.irsPct),
        ssEmpPct: pct(form.ssEmpPct),
        ssErPct: pct(form.ssErPct),
        payDay: Math.max(1, Math.min(31, parseInt(form.payDay || "25", 10))),
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
        active: form.active,
        flowToPrivate: form.flowToPrivate,
        netPayAccountId: form.netPayAccountId || undefined,
        benefits: form.benefits,
      };
      const id = await (api.contracts as any).save(payload);
      setEditingId(id);

      // sync recurring entries
      const name = people.find(p => p.id === form.personId)?.name ?? form.personId;
      const saved = await api.contracts.get(id) as EmploymentContractDoc;
      await syncEmploymentContractRecurring(saved, name, selectedEntity.id);

      setContracts(await (api.contracts as any).listByCompany(companyId));
      setMsg("Saved ✔  — Recurring updated");
    } catch (e: any) {
      setMsg(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteContract(id: string) {
    if (!confirm("Delete this contract?")) return;
    setBusy(true);
    try {
      await deactivateEmploymentContractRecurring(id, selectedEntity.id);
      await api.contracts.delete(id);
      if (editingId === id) startNew();
      setContracts(await (api.contracts as any).listByCompany(companyId));
    } catch (e: any) {
      setMsg(e?.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const personName = (id: string) => people.find(p => p.id === id)?.name ?? id;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6">
      {/* LEFT: form */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Employment Contracts</h2>

        {/* Company label + employee selector */}
        <Card className="p-4">
          <div className="grid sm:grid-cols-3 gap-3 items-end">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Company</div>
              <div className="px-2 py-1 rounded border border-zinc-800 bg-zinc-950 text-sm text-zinc-300">
                {companies.find(c => c.id === companyId)?.name ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Employee</div>
              <select
                value={form.personId}
                onChange={e => set("personId", e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
              >
                <option value="">— pick —</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <Button variant="secondary" onClick={startNew} type="button">New contract</Button>
          </div>
        </Card>

        {/* Contract fields */}
        <Card className="p-4">
          <form onSubmit={save} className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Gross monthly (€)</div>
                <Input
                  type="number" step="0.01" placeholder="0.00"
                  value={form.grossEUR}
                  onChange={e => set("grossEUR", e.target.value)}
                />
                {form.grossEUR && (
                  <div className="text-xs text-zinc-500 mt-1">{formatEUR(fromEUR(form.grossEUR))}</div>
                )}
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Pay day</div>
                <Input
                  type="number" min={1} max={31}
                  value={form.payDay}
                  onChange={e => set("payDay", e.target.value)}
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">IRS %</div>
                <Input
                  type="number" step="0.1" placeholder="15"
                  value={form.irsPct}
                  onChange={e => set("irsPct", e.target.value)}
                />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">SS employee %</div>
                <Input
                  type="number" step="0.01"
                  value={form.ssEmpPct}
                  onChange={e => set("ssEmpPct", e.target.value)}
                />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">SS employer %</div>
                <Input
                  type="number" step="0.01"
                  value={form.ssErPct}
                  onChange={e => set("ssErPct", e.target.value)}
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Start date</div>
                <Input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">End date</div>
                <Input type="date" value={form.endDate} onChange={e => set("endDate", e.target.value)} />
              </div>
            </div>

            {/* Net pay account */}
            <div>
              <div className="text-xs text-zinc-400 mb-1">Net pay account</div>
              <select
                value={form.netPayAccountId}
                onChange={e => set("netPayAccountId", e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
              >
                <option value="">— pick —</option>
                {bankAccountsForPerson.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            {/* Benefits */}
            <div>
              <div className="text-sm font-medium mb-2">Benefits</div>
              <BenefitsEditor
                benefits={form.benefits}
                accountsForPerson={accountsForPerson}
                onChange={v => set("benefits", v)}
              />
            </div>

            <div className="flex items-center gap-4 pt-1 flex-wrap">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                Active
              </label>
              <label className="flex items-center gap-2 text-sm" title="Syncs net salary as monthly income in the Private entity">
                <input type="checkbox" checked={form.flowToPrivate} onChange={e => set("flowToPrivate", e.target.checked)} />
                Household member
              </label>
              <Button type="submit" disabled={busy || !companyId || !form.personId}>
                {editingId ? "Save changes" : "Create contract"}
              </Button>
              {editingId && (
                <Button type="button" variant="secondary" onClick={startNew}>Cancel</Button>
              )}
              {msg && <span className="text-sm text-emerald-400">{msg}</span>}
            </div>
          </form>
        </Card>
      </div>

      {/* RIGHT: contracts list */}
      <div className="xl:sticky xl:top-4 h-fit">
        <Card className="p-4">
          <div className="text-sm font-medium text-zinc-300 mb-3">
            {companies.find(c => c.id === companyId)?.name ?? "Contracts"}
          </div>
          {contracts.length === 0 ? (
            <div className="text-sm text-zinc-500">No contracts yet.</div>
          ) : (
            <div className="space-y-2">
              {contracts.map(c => (
                <div
                  key={c.id}
                  className={`flex items-center justify-between px-3 py-2 rounded border ${editingId === c.id ? "border-emerald-600 bg-emerald-950/30" : "border-zinc-800 bg-zinc-900"}`}
                >
                  <div>
                    <div className="text-sm font-medium">
                      {personName(c.personId)}
                      {c.flowToPrivate && <span className="ml-1 text-xs text-blue-400" title="Synced to Private">⇢ Private</span>}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {formatEUR(c.grossMonthlyCents ?? 0)}/mo
                      {c.active === false && " · inactive"}
                    </div>
                  </div>
                  <div className="flex gap-3 text-xs">
                    <button className="text-blue-400 underline" onClick={() => startEdit(c.id)}>Edit</button>
                    <button className="text-red-400 underline" onClick={() => deleteContract(c.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
