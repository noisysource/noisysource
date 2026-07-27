import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { api } from "../../lib/api";
import UsageWidget from "../../components/UsageWidget";
import { collection, getDocs, deleteDoc } from "firebase/firestore";
import { db } from "../../lib/firebase";
import { ENTITIES } from "../../hooks/EntityContext";

const ENTITY_COLLECTIONS = [
  "accounts",
  "categories",
  "employmentContracts",
  "people",
  "companies",
  "ecContracts",
  "payrollRuns",
  "recurring",
  "forecastEvents",
  "irsConfig",
];

export default function DevtoolsPage() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);

  // wipe state
  const [wipeSelected, setWipeSelected] = useState<Record<string, boolean>>({});
  const [wipeConfirmText, setWipeConfirmText] = useState("");

  const [wipeGlobal, setWipeGlobal] = useState(false);
  const wipeTargets = ENTITIES.filter(e => wipeSelected[e.id]);
  const CONFIRM_PHRASE = "DELETE";
  const wipeReady = (wipeTargets.length > 0 || wipeGlobal) && wipeConfirmText === CONFIRM_PHRASE;

  // --- INITIAL SETUP --- //
  async function createInitialSetup() {
    if (!confirm(
      "This will create all people, companies, accounts and contracts across all 3 entities.\n\n" +
      "Safe to run on an empty database. On a non-empty one it will add duplicates.\n\n" +
      "Financial amounts are set to 0 — fill them in afterwards. Proceed?"
    )) return;

    setBusy(true);
    setMsg("Creating setup…");

    try {
      // ── GLOBAL: people & companies (shared across all entities) ──────────────
      setMsg("Creating people…");
      const renatoId    = await api.people.save({ name: "Renato" } as any);
      const marisaId    = await api.people.save({ name: "Marisa" } as any);
      const bernardoId  = await api.people.save({ name: "Bernardo" } as any);

      setMsg("Creating companies…");
      const nsId = await api.companies.save({ name: "NoisySource", shortCode: "NS" } as any);
      const npId = await api.companies.save({ name: "NoisyPhocus", shortCode: "NP" } as any);
      await api.companies.save({ name: "Exquisite Talent" } as any);
      await api.companies.save({ name: "ASFD" } as any);
      await api.companies.save({ name: "European Commission" } as any);

      // ── PRIVATE: accounts (capture IDs for benefit wiring) ──────────────────
      api.setEntity("private");
      setMsg("Private: creating accounts…");
      await api.accounts.save({ type: "bank",   ownerType: "person", ownerId: renatoId, jointOwnerIds: [marisaId], name: "BPI Particular",          bankName: "BPI",      currency: "EUR" } as any);
      await api.accounts.save({ type: "bank",   ownerType: "person", ownerId: renatoId, jointOwnerIds: [marisaId], name: "CGD",                     bankName: "CGD",      currency: "EUR" } as any);
      await api.accounts.save({ type: "bank",   ownerType: "person", ownerId: renatoId, name: "Montepio",                bankName: "Montepio", currency: "EUR" } as any);
      await api.accounts.save({ type: "bank",   ownerType: "person", ownerId: renatoId, name: "Revolut",                 bankName: "Revolut",  currency: "EUR" } as any);
      await api.accounts.save({ type: "bonds",  ownerType: "person", ownerId: renatoId, name: "Certificados de Aforro",  provider: "CTT",      currency: "EUR" } as any);
      const renatoMealId      = await api.accounts.save({ type: "voucher", ownerType: "person", ownerId: renatoId, name: "Meal — NoisySource",          voucherType: "meal",      provider: "Edenred", issuingEmployer: "NoisySource",      currency: "EUR" } as any);
      const renatoChild1Id    = await api.accounts.save({ type: "voucher", ownerType: "person", ownerId: renatoId, name: "Childcare — NoisySource (1)", voucherType: "childcare", provider: "Edenred", issuingEmployer: "NoisySource",      currency: "EUR" } as any);
      await api.accounts.save({ type: "voucher", ownerType: "person", ownerId: renatoId, name: "Childcare — NoisySource (2)", voucherType: "childcare", provider: "Edenred", issuingEmployer: "NoisySource",      currency: "EUR" } as any);
      const renatoEducationId = await api.accounts.save({ type: "voucher", ownerType: "person", ownerId: renatoId, name: "Education — Exquisite Talent", voucherType: "education", provider: "Edenred", issuingEmployer: "Exquisite Talent", currency: "EUR" } as any);
      await api.accounts.save({ type: "voucher", ownerType: "person", ownerId: marisaId,   name: "Meal — ASFD",             voucherType: "meal",      provider: "Edenred", issuingEmployer: "ASFD",        currency: "EUR" } as any);
      const marisaChildId     = await api.accounts.save({ type: "voucher", ownerType: "person", ownerId: marisaId,   name: "Childcare — NoisySource",    voucherType: "childcare", provider: "Edenred", issuingEmployer: "NoisySource", currency: "EUR" } as any);
      const bernardoChildId   = await api.accounts.save({ type: "voucher", ownerType: "person", ownerId: bernardoId, name: "Childcare — NoisySource",    voucherType: "childcare", provider: "Edenred", issuingEmployer: "NoisySource", currency: "EUR" } as any);

      // ── NOISYSOURCE: accounts, categories & contracts ────────────────────────
      api.setEntity("noisysource");
      setMsg("NoisySource: creating accounts…");
      await api.accounts.save({ type: "bank", ownerType: "company", ownerId: nsId, name: "BPI Empresas", bankName: "BPI", currency: "EUR" } as any);

      setMsg("NoisySource: creating payroll categories…");
      const mealExpId      = await api.categories.save({ name: "Subsídio de Refeição",    code: "EXP_MEAL",       type: "expense" } as any);
      const childcareExpId = await api.categories.save({ name: "Vale Infância",           code: "EXP_CHILDCARE",  type: "expense" } as any);
      const educationExpId = await api.categories.save({ name: "Vale Educação",           code: "EXP_EDUCATION",  type: "expense" } as any);
      const allowanceExpId = await api.categories.save({ name: "Ajudas de Custo",         code: "EXP_ALLOWANCE",  type: "expense" } as any);
      const salaryExpId    = await api.categories.save({ name: "Salários",                code: "EXP_SALARY",     type: "expense" } as any);
      const ssErExpId      = await api.categories.save({ name: "SS Patronal",             code: "EXP_SS_ER",      type: "expense" } as any);
      const edenredPayId   = await api.categories.save({ name: "Edenred a Pagar",         code: "PAY_EDENRED",    type: "payable" } as any);
      const allowancePayId = await api.categories.save({ name: "Ajudas de Custo a Pagar", code: "PAY_ALLOWANCE",  type: "payable" } as any);
      await api.categories.save({ name: "IRS a Entregar",          code: "PAY_IRS",        type: "payable" } as any);
      await api.categories.save({ name: "SS a Entregar",           code: "PAY_SS",         type: "payable" } as any);
      await api.categories.save({ name: "Salários a Pagar",        code: "PAY_NET",        type: "payable" } as any);
      // suppress unused warnings
      void salaryExpId; void ssErExpId;

      setMsg("NoisySource: creating contracts…");
      await api.contracts.save({
        companyId: nsId, personId: renatoId,
        grossMonthlyCents: 200000, irsRatePct: 15.35, ssEmpPct: 11, ssErPct: 23.75,
        payDay: 25, startDate: "2026-01-01", active: true, netPayAccountId: "",
        benefits: [
          { type: "MEAL_CARD",        perDayCents: 1020,  daysPerMonth: 18, subjectToIRS: false, subjectToSS: false, benefitAccountId: renatoMealId,      expenseCategoryId: mealExpId,      payableCategoryId: edenredPayId   },
          { type: "CHILDCARE",        perMonthCents: 27000,                 subjectToIRS: false, subjectToSS: false, benefitAccountId: renatoChild1Id,    expenseCategoryId: childcareExpId, payableCategoryId: edenredPayId   },
          { type: "EDUCATION",        perMonthCents: 15000,                 subjectToIRS: false, subjectToSS: false, benefitAccountId: renatoEducationId, expenseCategoryId: educationExpId, payableCategoryId: edenredPayId   },
          { type: "EXPENSE_ALLOWANCE", perMonthCents: 66828,                subjectToIRS: false, subjectToSS: false, benefitAccountId: "",                expenseCategoryId: allowanceExpId, payableCategoryId: allowancePayId },
        ],
      } as any);
      await api.contracts.save({
        companyId: nsId, personId: marisaId,
        grossMonthlyCents: 95000, irsRatePct: 16.11, ssEmpPct: 11, ssErPct: 23.75,
        payDay: 25, startDate: "2026-01-01", active: true, netPayAccountId: "",
        benefits: [
          { type: "CHILDCARE", perMonthCents: 31250, subjectToIRS: false, subjectToSS: false, benefitAccountId: marisaChildId, expenseCategoryId: childcareExpId, payableCategoryId: edenredPayId },
        ],
      } as any);
      await api.contracts.save({
        companyId: nsId, personId: bernardoId,
        grossMonthlyCents: 120000, irsRatePct: 1.58, ssEmpPct: 11, ssErPct: 23.75,
        payDay: 25, startDate: "2026-01-01", active: true, netPayAccountId: "",
        benefits: [
          { type: "CHILDCARE", perMonthCents: 42000, subjectToIRS: false, subjectToSS: false, benefitAccountId: bernardoChildId, expenseCategoryId: childcareExpId, payableCategoryId: edenredPayId },
        ],
      } as any);
      await api.ecContracts.save({ clientName: "European Commission", projectName: "", dailyRateCents: 59424, totalDays: 189, expectedDaysPerMonth: 19, startDate: "2026-03-26", endDate: "2027-01-26", active: true } as any);

      // ── NOISYPHOCUS: accounts ────────────────────────────────────────────────
      api.setEntity("noisyphocus");
      setMsg("NoisyPhocus: creating accounts…");
      await api.accounts.save({ type: "bank", ownerType: "company", ownerId: npId, name: "BPI Empresas", bankName: "BPI", currency: "EUR" } as any);

      api.setEntity("private");
      setMsg("Done! Fill in IBANs and net pay accounts via Setup → Accounts / Contracts.");
    } catch (e: any) {
      setMsg(`Failed: ${e?.message ?? "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  // --- BACKUP / RESTORE --- //
  async function exportAllData() {
    try {
      setBusy(true);
      setMsg("Exporting all data...");
      const dump = await api.backup.export();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      setExportUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      setMsg("Export created successfully.");
    } catch (e: any) {
      setMsg(e?.message ?? "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function importAllData(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    if (!confirm("This will overwrite data in your database. Are you sure?")) return;
    try {
      setBusy(true);
      setMsg("Importing data...");
      const text = await file.text();
      const data = JSON.parse(text);
      const { written } = await api.backup.import(data);
      setMsg(`Import complete. ${written} documents processed.`);
    } catch (e: any) {
      setMsg(e?.message ?? "Import failed");
    } finally {
      setBusy(false);
      ev.target.value = "";
    }
  }

  // --- DATA DELETION --- //
  async function runWipe() {
    if (!wipeReady) return;
    setBusy(true);
    setMsg("Wiping…");
    try {
      let totalDeleted = 0;

      // global collections
      if (wipeGlobal) {
        for (const col of ["finances_people", "finances_companies"]) {
          const snap = await getDocs(collection(db, col));
          for (const d of snap.docs) { await deleteDoc(d.ref); totalDeleted++; }
          if (snap.size > 0) setMsg(`Global: deleted ${snap.size} from ${col} (${totalDeleted} total)…`);
        }
      }

      // entity-scoped collections
      for (const entity of wipeTargets) {
        let n = 0;
        for (const col of ENTITY_COLLECTIONS) {
          const snap = await getDocs(collection(db, "finances_entities", entity.id, col));
          for (const d of snap.docs) { await deleteDoc(d.ref); n++; totalDeleted++; }
          if (snap.size > 0) setMsg(`${entity.name}: deleted ${snap.size} from ${col} (${totalDeleted} total)…`);
        }
        setMsg(`${entity.name}: ${n} documents deleted. Continuing…`);
      }

      setWipeSelected({});
      setWipeGlobal(false);
      setWipeConfirmText("");
      setMsg(`Done. ${totalDeleted} documents deleted.`);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to wipe data");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8 p-4">
      <h1 className="text-2xl font-bold">Dev Tools</h1>

      {msg && <div className="p-4 bg-zinc-800 rounded-md text-sm text-emerald-400 whitespace-pre-wrap">{msg}</div>}

      <Card className="p-4">
        <h2 className="text-lg font-semibold mb-1">Initial Setup</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Bootstraps all entities with people, companies, accounts and contracts.<br />
          Run once on a clean database. Financial amounts are set to 0 — fill them in via Setup afterwards.
        </p>
        <Button onClick={createInitialSetup} disabled={busy}>
          Create Initial Setup
        </Button>
      </Card>

      <Card className="p-4">
        <h2 className="text-lg font-semibold mb-2">Backup & Restore</h2>
        <p className="text-sm text-zinc-400 mb-4">Export all data as JSON, or import from a backup file.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={exportAllData} disabled={busy}>Export All Data (JSON)</Button>
          {exportUrl && (
            <a href={exportUrl} download={`backup-${new Date().toISOString().slice(0, 19)}.json`} className="text-blue-400 underline">
              Download Export
            </a>
          )}
          <div className="ml-4">
            <label className="text-sm mr-2">Import from JSON:</label>
            <input type="file" accept="application/json" onChange={importAllData} />
          </div>
        </div>
      </Card>

      <Card className="p-4 border-red-500/50 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Permanently deletes all documents in every collection for the selected entities.
            This cannot be undone — export a backup first.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-xs text-zinc-400 font-semibold uppercase tracking-wide">Select what to wipe</div>
          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={wipeGlobal}
              onChange={e => setWipeGlobal(e.target.checked)}
              className="accent-red-500 w-4 h-4"
            />
            <span className="text-sm text-zinc-200 group-hover:text-white">Global data</span>
            <span className="text-xs text-zinc-600">people, companies</span>
          </label>
          <div className="text-xs text-zinc-600 pl-7">Entity data:</div>
          {ENTITIES.map(e => (
            <label key={e.id} className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={!!wipeSelected[e.id]}
                onChange={ev => setWipeSelected(s => ({ ...s, [e.id]: ev.target.checked }))}
                className="accent-red-500 w-4 h-4"
              />
              <span className="text-sm text-zinc-200 group-hover:text-white">{e.name}</span>
              <span className="text-xs text-zinc-600">{e.id}</span>
            </label>
          ))}
        </div>

        {wipeTargets.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-zinc-800">
            <div className="text-xs text-zinc-400">
              Type <span className="font-mono font-bold text-red-400">{CONFIRM_PHRASE}</span> to confirm deletion of{" "}
              <span className="text-white font-medium">{wipeTargets.map(e => e.name).join(", ")}</span>
            </div>
            <div className="flex items-center gap-3">
              <Input
                value={wipeConfirmText}
                onChange={e => setWipeConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                className="w-36 font-mono text-red-400 border-red-900 bg-zinc-950"
              />
              <Button variant="destructive" onClick={runWipe} disabled={busy || !wipeReady}>
                Wipe {wipeTargets.length === ENTITIES.length ? "All Entities" : wipeTargets.map(e => e.name).join(" & ")}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <UsageWidget />
      </Card>
    </div>
  );
}
