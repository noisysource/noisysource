import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import UsageWidget from "../../components/UsageWidget";
import SeedImportCard from "../../components/SeedImportCard";
import { collection, getDocs, deleteDoc, query, where } from "firebase/firestore";
import { db } from "../../lib/firebase";
import { ENTITIES } from "../../hooks/EntityContext";

const PROJECT_ID = db.app.options.projectId ?? "?";

/** Every collection under finances_entities/{entityId}. */
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
  "incomeSources",
  "creditContracts",
  "loans",
  "insurances",
  "costSummary",
  "movementRules",
];

/** Root collections whose documents belong to one entity (entityId field). */
const ENTITY_ROOT_COLLECTIONS = ["finances_bank_transactions", "finances_bank_imports", "finances_events"];

/** Root collections shared by every entity. */
const GLOBAL_COLLECTIONS = ["finances_people", "finances_companies", "finances_notifications"];

export default function DevtoolsPage() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // wipe state
  const [wipeSelected, setWipeSelected] = useState<Record<string, boolean>>({});
  const [wipeConfirmText, setWipeConfirmText] = useState("");

  const [wipeGlobal, setWipeGlobal] = useState(false);
  const wipeTargets = ENTITIES.filter(e => wipeSelected[e.id]);
  const CONFIRM_PHRASE = "DELETE";
  const wipeReady = (wipeTargets.length > 0 || wipeGlobal) && wipeConfirmText === CONFIRM_PHRASE;
  const wipeLabel = [...(wipeGlobal ? ["Global"] : []), ...wipeTargets.map(e => e.name)].join(" & ");

  // --- DATA DELETION --- //
  async function runWipe() {
    if (!wipeReady) return;
    setBusy(true);
    setMsg("Wiping…");
    try {
      let totalDeleted = 0;

      // global collections
      if (wipeGlobal) {
        for (const col of GLOBAL_COLLECTIONS) {
          const snap = await getDocs(collection(db, col));
          for (const d of snap.docs) { await deleteDoc(d.ref); totalDeleted++; }
          if (snap.size > 0) setMsg(`Global: deleted ${snap.size} from ${col} (${totalDeleted} total)…`);
        }
      }

      // entity-scoped collections, and the entity's documents in root collections
      for (const entity of wipeTargets) {
        let n = 0;
        for (const col of ENTITY_COLLECTIONS) {
          const snap = await getDocs(collection(db, "finances_entities", entity.id, col));
          for (const d of snap.docs) { await deleteDoc(d.ref); n++; totalDeleted++; }
          if (snap.size > 0) setMsg(`${entity.name}: deleted ${snap.size} from ${col} (${totalDeleted} total)…`);
        }
        for (const col of ENTITY_ROOT_COLLECTIONS) {
          const snap = await getDocs(query(collection(db, col), where("entityId", "==", entity.id)));
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

      <SeedImportCard />

      <Card className="p-4 border-red-500/50 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-red-400">Danger Zone</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Permanently deletes every FinHub document of the selected entities in project{" "}
            <span className="font-mono text-zinc-200">{PROJECT_ID}</span>: their collections, bank statement
            imports and movements, and events. This cannot be undone. KidClub's data is not touched; insurance
            attachments stay in Storage.
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
            <span className="text-xs text-zinc-600">people, companies, notifications</span>
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

        {(wipeTargets.length > 0 || wipeGlobal) && (
          <div className="space-y-2 pt-2 border-t border-zinc-800">
            <div className="text-xs text-zinc-400">
              Type <span className="font-mono font-bold text-red-400">{CONFIRM_PHRASE}</span> to confirm deletion of{" "}
              <span className="text-white font-medium">{wipeLabel}</span> in{" "}
              <span className="font-mono text-white">{PROJECT_ID}</span>
            </div>
            <div className="flex items-center gap-3">
              <Input
                value={wipeConfirmText}
                onChange={e => setWipeConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                className="w-36 font-mono text-red-400 border-red-900 bg-zinc-950"
              />
              <Button variant="destructive" onClick={runWipe} disabled={busy || !wipeReady}>
                Wipe {wipeLabel}
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
