import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

import type { EmploymentContractDoc, BenefitConfig } from "@shared/models/Employment";
import { eurosToCents, formatEUR } from "@shared/lib/money";
import { BenefitsEditor } from "../BenefitsEditor";

// Company roles (UI-only type; align with your domain)
export type CompanyRoleType = "CEO" | "CFO" | "Worker" | "Intern";

type Person  = { id: string; name: string };
type Company = { id: string; name: string };
type Account = { id: string; name: string; code?: string; type?: string; ownerType?: string; ownerId?: string };

export function ContractForm({
  companies,
  people,
  accountsForPerson,
  contracts,
  // selection + editing
  companyId, setCompanyId,
  personId, setPersonId,
  editingId, onPickContract,
  // contract fields
  grossEUR, setGrossEUR,
  irsPct, setIrsPct,
  ssEmpPct, setSsEmpPct,
  ssErPct, setSsErPct,
  payDay, setPayDay,
  startDate, setStartDate,
  endDate, setEndDate,
  active, setActive,
  netPayAccountId, setNetPayAccountId,
  benefits, setBenefits,
  // role fields (new)
  roleEnabled, setRoleEnabled,
  roleType, setRoleType,
  roleSalaryEUR, setRoleSalaryEUR,
  roleCurrency, setRoleCurrency,
  roleStartDate, setRoleStartDate,
  roleEndDate, setRoleEndDate,
  // actions
  onNew, onSave,
  msg, busy,
}: {
  companies: Company[];
  people: Person[];
  accountsForPerson: Account[];
  contracts: EmploymentContractDoc[];

  companyId: string; setCompanyId: (v: string) => void;
  personId: string; setPersonId: (v: string) => void;
  editingId: string | null; onPickContract: (id: string) => void;

  grossEUR: string; setGrossEUR: (v: string) => void;
  irsPct: string; setIrsPct: (v: string) => void;
  ssEmpPct: string; setSsEmpPct: (v: string) => void;
  ssErPct: string; setSsErPct: (v: string) => void;
  payDay: string; setPayDay: (v: string) => void;
  startDate: string; setStartDate: (v: string) => void;
  endDate: string; setEndDate: (v: string) => void;
  active: boolean; setActive: (v: boolean) => void;

  netPayAccountId: string; setNetPayAccountId: (v: string) => void;

  benefits: BenefitConfig[]; setBenefits: (v: BenefitConfig[]) => void;

  // NEW — role assignment controls
  roleEnabled: boolean; setRoleEnabled: (v: boolean) => void;
  roleType: CompanyRoleType; setRoleType: (v: CompanyRoleType) => void;
  roleSalaryEUR: string; setRoleSalaryEUR: (v: string) => void;
  roleCurrency: "EUR"; setRoleCurrency: (v: "EUR") => void;
  roleStartDate: string; setRoleStartDate: (v: string) => void;
  roleEndDate: string; setRoleEndDate: (v: string) => void;

  onNew: () => void;
  onSave: () => void;
  msg: string | null;
  busy: boolean;
}) {
  const personBankAccounts = accountsForPerson.filter(a => (a.type || "").toLowerCase() === "bank");
  const personNameById = (id: string) => people.find(p => p.id === id)?.name || id;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
      {/* LEFT: setup (context, role, contract, benefits, wiring) */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Employment Contracts</h2>

        {/* Context selectors */}
        <Card className="p-4 space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Company</div>
              <select
                value={companyId}
                onChange={(e)=>{ setCompanyId(e.target.value); onNew(); }}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
              >
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Employee</div>
              <select
                value={personId}
                onChange={(e)=>setPersonId(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
              >
                <option value="">— pick —</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <Button onClick={onNew} variant="secondary">New contract</Button>
            </div>
          </div>
        </Card>

        {/* Role assignment (NEW) */}
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-lg font-medium">Role assignment</div>
            <label className="text-xs flex items-center gap-2">
              <input
                type="checkbox"
                checked={roleEnabled}
                onChange={(e)=>setRoleEnabled(e.target.checked)}
              />
              <span>Save role with contract</span>
            </label>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Role</div>
              <select
                value={roleType}
                onChange={e=>setRoleType(e.target.value as CompanyRoleType)}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                disabled={!roleEnabled}
              >
                <option value="Worker">Worker</option>
                <option value="CFO">CFO</option>
                <option value="CEO">CEO</option>
                <option value="Intern">Intern</option>
              </select>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Role salary (EUR)</div>
              <Input
                value={roleSalaryEUR}
                onChange={e=>setRoleSalaryEUR(e.target.value)}
                placeholder="e.g. 2.000,00"
                disabled={!roleEnabled}
              />
              <div className="text-xs text-zinc-500 mt-1">{formatEUR(eurosToCents(parseFloat(roleSalaryEUR) || 0))}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Currency</div>
              <select
                value={roleCurrency}
                onChange={e=>setRoleCurrency(e.target.value as "EUR")}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                disabled={!roleEnabled}
              >
                <option value="EUR">EUR</option>
              </select>
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Role start</div>
              <Input type="date" value={roleStartDate} onChange={e=>setRoleStartDate(e.target.value)} disabled={!roleEnabled} />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">Role end</div>
              <Input type="date" value={roleEndDate} onChange={e=>setRoleEndDate(e.target.value)} disabled={!roleEnabled} />
            </div>
          </div>

          <div className="text-xs text-zinc-500">
            Tip: keep role salary in sync with the contract’s gross if you want them aligned.
          </div>
        </Card>

        {/* Contract form */}
        <Card className="p-4 space-y-3">
          <div className="text-lg font-medium">Contract</div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-zinc-400 mb-1">Gross monthly (EUR)</div>
              <Input value={grossEUR} onChange={e=>setGrossEUR(e.target.value)} placeholder="e.g. 2.000,00" />
              <div className="text-xs text-zinc-500 mt-1">{formatEUR(eurosToCents(parseFloat(grossEUR) || 0))}</div>
            </div>
            <div><div className="text-xs text-zinc-400 mb-1">IRS %</div><Input value={irsPct} onChange={e=>setIrsPct(e.target.value)} /></div>
            <div><div className="text-xs text-zinc-400 mb-1">SS Employee %</div><Input value={ssEmpPct} onChange={e=>setSsEmpPct(e.target.value)} /></div>
            <div><div className="text-xs text-zinc-400 mb-1">SS Employer %</div><Input value={ssErPct} onChange={e=>setSsErPct(e.target.value)} /></div>
            <div><div className="text-xs text-zinc-400 mb-1">Pay day (1–31)</div><Input type="number" min={1} max={31} value={payDay} onChange={e=>setPayDay(e.target.value)} /></div>
            <div><div className="text-xs text-zinc-400 mb-1">Start date</div><Input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} /></div>
            <div><div className="text-xs text-zinc-400 mb-1">End date</div><Input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} /></div>
            <label className="flex items-center gap-2 text-sm mt-5">
              <input type="checkbox" checked={active} onChange={(e)=>setActive(e.target.checked)} />
              Active
            </label>
          </div>

          <div className="mt-4">
            <div className="text-md font-medium mb-2">Benefits</div>
            <BenefitsEditor
              benefits={benefits}
              accountsForPerson={accountsForPerson}
              onChange={setBenefits}
              // supports decimals and meal-as-day already in your component
            />
          </div>

          {/* Wiring BELOW the form (left column) */}
          <div className="mt-4">
            <div className="text-md font-medium mb-2">Wiring</div>
            <div className="text-xs text-zinc-400 mb-1">Net pay account (employee)</div>
            <select
              value={netPayAccountId}
              onChange={(e)=>setNetPayAccountId(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
            >
              <option value="">— pick —</option>
              {personBankAccounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.code ? ` — ${a.code}` : ""}
                </option>
              ))}
            </select>
            <div className="text-xs text-zinc-500 mt-1">
              Net salary transfers will use this destination account.
            </div>
          </div>

          <div className="pt-3">
            <Button onClick={onSave} disabled={busy || !companyId || !personId}>
              {editingId ? "Save changes" : "Create contract"}
            </Button>
            {msg && <span className="ml-3 text-sm text-emerald-400">{msg}</span>}
          </div>
        </Card>
      </div>

      {/* RIGHT: contracts list */}
      <div className="lg:sticky lg:top-4 h-fit space-y-4">
        <Card className="p-4">
          <div className="text-sm text-zinc-300 mb-2">Contracts in this company</div>
          <div className="flex flex-wrap gap-2">
            {contracts.map(c => (
              <button
                key={c.id}
                onClick={()=>onPickContract(c.id)}
                className={`px-2 py-1 rounded border ${editingId===c.id ? "border-emerald-500" : "border-zinc-700"} bg-zinc-900 hover:bg-zinc-800 text-sm`}
                title={c.id}
              >
                {personNameById(c.personId)} · {c.active===false ? "inactive" : "active"}
              </button>
            ))}
            {!contracts.length && <div className="text-sm text-zinc-500">No contracts yet.</div>}
          </div>
        </Card>
      </div>
    </div>
  );
}