// apps/finhub/src/pages/EmploymentContractsPage.tsx
import { useEffect, useMemo, useState } from "react";
import { where } from "firebase/firestore";
import type { BenefitConfig, EmploymentContractDoc } from "@shared/models/Employment";
import type { Account } from "@shared/models/Account";
import { eurosToCents } from "@shared/lib/money";
import { cleanUndefined } from "@shared/lib/clean";
import { parsePercent } from "@shared/lib/number";
import { api } from "../lib/api";
import { ContractForm } from "../components/forms/ContractForm";

type Company = { id: string; name: string };
type Person  = { id: string; name: string };

// Save shape without id
type ContractSave = Omit<EmploymentContractDoc, "id">;

export default function EmploymentContractsPage() {
  // master lists
  const [companies, setCompanies] = useState<Company[]>([]);
  const [people, setPeople]       = useState<Person[]>([]);
  const [accounts, setAccounts]   = useState<Account[]>([]);
  const [contracts, setContracts] = useState<EmploymentContractDoc[]>([]);

  // selection
  const [companyId, setCompanyId] = useState("");
  const [personId, setPersonId]   = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // contract fields
  const [grossEUR, setGrossEUR]   = useState("");
  const [irsPct, setIrsPct]       = useState("");
  const [ssEmpPct, setSsEmpPct]   = useState("");
  const [ssErPct, setSsErPct]     = useState("");
  const [payDay, setPayDay]       = useState("25");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate]     = useState("");
  const [active, setActive]       = useState(true);
  const [netPayAccountId, setNetPayAccountId] = useState("");

  // role fields (as expected by ContractForm)
  const [roleEnabled, setRoleEnabled]       = useState(false);
  const [roleType, setRoleType]             = useState<"CEO"|"CFO"|"Worker"|"Intern">("Worker");
  const [roleSalaryEUR, setRoleSalaryEUR]   = useState("");
  const [roleCurrency, setRoleCurrency]     = useState<"EUR">("EUR");
  const [roleStartDate, setRoleStartDate]   = useState("");
  const [roleEndDate, setRoleEndDate]       = useState("");

  // benefits
  const [benefits, setBenefits] = useState<BenefitConfig[]>([]);

  // ui
  const [msg, setMsg]   = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // employee-owned accounts for wiring
  const accountsForPerson = useMemo(
    () => accounts.filter(a => a.ownerType === "person" && a.ownerId === personId),
    [accounts, personId]
  );

  // bootstrap
  useEffect(() => {
    (async () => {
      const [cs, ps, as] = await Promise.all([
        api.companies.list(),
        api.people.list(),
        api.accounts.list(),
      ]);
      setCompanies(cs as Company[]);
      if (!companyId && cs.length) setCompanyId((cs[0] as Company).id);
      setPeople(ps as Person[]);
      setAccounts(as as Account[]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // contracts loader (works with new/old api)
  async function fetchContractsForCompany(cid: string) {
    const anyApi = api.contracts as any;
    if (typeof anyApi.listByCompany === "function") {
      return await anyApi.listByCompany(cid);
    }
    if (typeof anyApi.list === "function") {
      try {
        return await anyApi.list([where("companyId", "==", cid)]);
      } catch {
        return await anyApi.list(cid); // legacy
      }
    }
    return [] as EmploymentContractDoc[];
  }

  // reload when company changes
  useEffect(() => {
    (async () => {
      if (!companyId) { setContracts([]); return; }
      setContracts(await fetchContractsForCompany(companyId));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  function startNew() {
    setEditingId(null);
    setPersonId("");
    setGrossEUR(""); setIrsPct(""); setSsEmpPct(""); setSsErPct("");
    setPayDay("25"); setStartDate(""); setEndDate(""); setActive(true);
    setNetPayAccountId("");
    setBenefits([]);
    setRoleEnabled(false);
    setRoleType("Worker");
    setRoleSalaryEUR("");
    setRoleCurrency("EUR");
    setRoleStartDate("");
    setRoleEndDate("");
    setMsg(null);
  }

  async function pickContract(id: string) {
    setMsg(null);
    const c = await api.contracts.get(id);
    if (!c) return;
    setEditingId(id);
    setPersonId(c.personId);
    setGrossEUR(((c.grossMonthlyCents ?? 0) / 100).toString());
    setIrsPct((c.irsRatePct ?? 0).toString());
    setSsEmpPct((c.ssEmpPct ?? 0).toString());
    setSsErPct((c.ssErPct ?? 0).toString());
    setPayDay((c.payDay ?? 25).toString());
    setStartDate(c.startDate ? new Date(c.startDate as any).toISOString().slice(0,10) : "");
    setEndDate(c.endDate ? new Date(c.endDate as any).toISOString().slice(0,10) : "");
    setActive(c.active !== false);
    setNetPayAccountId(c.netPayAccountId || "");
    setBenefits(Array.isArray(c.benefits) ? c.benefits : []);

    // if you later load role from backend, hydrate it here; for now reset
    setRoleEnabled(false);
    setRoleType("Worker");
    setRoleSalaryEUR("");
    setRoleCurrency("EUR");
    setRoleStartDate("");
    setRoleEndDate("");
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      if (!companyId) throw new Error("Pick a company.");
      if (!personId)  throw new Error("Pick an employee.");

      const base = cleanUndefined({
        orgId: api.orgId,
        companyId,
        personId,
        grossMonthlyCents: eurosToCents(grossEUR),
        irsRatePct: parsePercent(irsPct),
        ssEmpPct: parsePercent(ssEmpPct),
        ssErPct: parsePercent(ssErPct),
        payDay: Math.max(1, Math.min(31, parseInt(payDay || "25", 10))),
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        active,
        netPayAccountId: netPayAccountId || undefined,
        benefits,
        // NOTE: role persistence can be added here when your roles API is ready.
        // e.g., call api.companyRoles.upsert(...) or attach meta if your contracts allow it.
      }) as ContractSave;

      let id: string;
      const anyApi = api.contracts as any;
      if (editingId) {
        if (typeof anyApi.update === "function") {
          await anyApi.update(editingId, base);
          id = editingId;
        } else {
          id = await anyApi.save({ id: editingId, ...base });
        }
      } else {
        if (typeof anyApi.create === "function") {
          id = await anyApi.create(base);
        } else {
          id = await anyApi.save(base);
        }
      }

      setEditingId(id);
      setContracts(await fetchContractsForCompany(companyId));
      setMsg("Saved ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ContractForm
      companies={companies}
      people={people}
      accountsForPerson={accountsForPerson}
      contracts={contracts}
      companyId={companyId} setCompanyId={setCompanyId}
      personId={personId} setPersonId={setPersonId}
      editingId={editingId} onPickContract={pickContract}
      grossEUR={grossEUR} setGrossEUR={setGrossEUR}
      irsPct={irsPct} setIrsPct={setIrsPct}
      ssEmpPct={ssEmpPct} setSsEmpPct={setSsEmpPct}
      ssErPct={ssErPct} setSsErPct={setSsErPct}
      payDay={payDay} setPayDay={setPayDay}
      startDate={startDate} setStartDate={setStartDate}
      endDate={endDate} setEndDate={setEndDate}
      active={active} setActive={setActive}
      netPayAccountId={netPayAccountId} setNetPayAccountId={setNetPayAccountId}
      benefits={benefits} setBenefits={setBenefits}
      roleEnabled={roleEnabled} setRoleEnabled={setRoleEnabled}
      roleType={roleType} setRoleType={setRoleType}
      roleSalaryEUR={roleSalaryEUR} setRoleSalaryEUR={setRoleSalaryEUR}
      roleCurrency={roleCurrency} setRoleCurrency={setRoleCurrency}
      roleStartDate={roleStartDate} setRoleStartDate={setRoleStartDate}
      roleEndDate={roleEndDate} setRoleEndDate={setRoleEndDate}
      onNew={startNew}
      onSave={save}
      msg={msg}
      busy={busy}
    />
  );
}