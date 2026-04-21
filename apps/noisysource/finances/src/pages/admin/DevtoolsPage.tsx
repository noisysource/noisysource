import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { api } from "../../lib/api";
import UsageWidget from "../../components/UsageWidget";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../lib/firebase";

type Org = { id: string; name: string };

export default function DevtoolsPage() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [wipeOrgId, setWipeOrgId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const companies = await api.companies.list();
      setOrgs([{ id: "personal", name: "Personal" }, ...companies]);
      if (companies.length > 0) {
        setWipeOrgId(companies[0].id);
      }
    })();
  }, []);

  // --- DATA SEEDING --- //
  async function createInitialSetup() {
    if (!confirm("This will create the standard set of 2 companies and 4 people, along with their accounts. It is intended to be run on a clean database. Proceed?")) return;
    setBusy(true);
    setMsg("Creating initial setup...");
    try {
      const nsId = await api.companies.save({ name: "NoisySource", shortCode: "NS" });
      const npId = await api.companies.save({ name: "NoisyPhocus", shortCode: "NP" });
      const renatoId = await api.people.save({ name: "Renato" });
      const marisaId = await api.people.save({ name: "Marisa" });
      const bernardoId = await api.people.save({ name: "Bernardo" });
      const anaId = await api.people.save({ name: "Ana" });

      await api.accounts.save({ type: "bank", ownerType: "company", ownerId: nsId, name: `NoisySource Bank` });
      await api.accounts.save({ type: "bank", ownerType: "company", ownerId: npId, name: `NoisyPhocus Bank` });
      await api.accounts.save({ type: "bank", ownerType: "person", ownerId: renatoId, name: `Renato Bank` });
      await api.accounts.save({ type: "bank", ownerType: "person", ownerId: marisaId, name: `Marisa Bank` });

      setMsg("Initial setup created successfully!");
      const companies = await api.companies.list();
      setOrgs([{ id: "personal", name: "Personal" }, ...companies]);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to create setup");
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
  async function wipeOrgData() {
    if (!wipeOrgId || wipeOrgId === "personal") {
      alert("You must select a valid company to wipe. The 'Personal' org cannot be wiped from this tool.");
      return;
    }
    if (prompt(`This is a destructive action. To confirm, type the ID of the organization to wipe: ${wipeOrgId}`) !== wipeOrgId) {
      alert("Confirmation failed. No data was deleted.");
      return;
    }

    setBusy(true);
    setMsg(`Wiping all data for org: ${wipeOrgId}...`);
    try {
      const collections = ["accounts", "categories", "ledgerTransactions", "people", "plannedInstances", "templates"];
      for (const coll of collections) {
        const snapshot = await getDocs(collection(db, "orgs", wipeOrgId, coll));
        for (const doc of snapshot.docs) {
          await doc.ref.delete();
        }
      }
      await api.companies.delete(wipeOrgId);

      setMsg(`Successfully wiped all data for ${wipeOrgId}.`);
      const companies = await api.companies.list();
      setOrgs([{ id: "personal", name: "Personal" }, ...companies]);
      setWipeOrgId(companies.length > 0 ? companies[0].id : "");

    } catch (e: any) {
      setMsg(e?.message ?? "Failed to wipe data");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8 p-4">
      <h1 className="text-2xl font-bold">Dev Tools</h1>

      {msg && <div className="p-4 bg-zinc-800 rounded-md text-sm text-emerald-400">{msg}</div>}

      <Card className="p-4">
        <h2 className="text-lg font-semibold mb-2">Test Data Setup</h2>
        <p className="text-sm text-gray-400 mb-4">Use these actions to quickly set up a clean environment for testing.</p>
        <div className="flex items-center gap-4">
          <Button onClick={createInitialSetup} disabled={busy}>Create Initial Company & Personal Setup</Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-lg font-semibold mb-2">Backup & Restore</h2>
        <p className="text-sm text-gray-400 mb-4">Export all data from the current environment, or import data from a file to overwrite it.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={exportAllData} disabled={busy}>Export All Data (JSON)</Button>
          {exportUrl && (
            <a href={exportUrl} download={`backup-${new Date().toISOString().slice(0,19)}.json`} className="text-blue-400 underline">
              Download Export
            </a>
          )}
          <div className="ml-4">
            <label className="text-sm mr-2">Import from JSON:</label>
            <input type="file" accept="application/json" onChange={importAllData} />
          </div>
        </div>
      </Card>

      <Card className="p-4 border-red-500/50">
        <h2 className="text-lg font-semibold text-red-400 mb-2">Danger Zone</h2>
        <p className="text-sm text-gray-400 mb-4">Permanently delete all data associated with a specific company.</p>
        <div className="flex items-center gap-4">
          <select value={wipeOrgId} onChange={e => setWipeOrgId(e.target.value)} className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1">
            <option value="" disabled>Select a company to wipe...</option>
            {orgs.filter(o => o.id !== 'personal').map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <Button variant="destructive" onClick={wipeOrgData} disabled={busy || !wipeOrgId || wipeOrgId === 'personal'}>Wipe Selected Company</Button>
        </div>
      </Card>

      <Card className="p-4">
        <UsageWidget />
      </Card>

    </div>
  );
}
