import { collection, getDocs, doc, writeBatch } from "firebase/firestore";
import { db } from "../../firebase";
import { deepReviveDates, deepSerializeDates } from "../utils";

// Sensible defaults; adjust to your schema
const ROOT_COLLECTIONS = [
  "bookings",
  "config",
  "emailCampaigns",
  "emailOutbox",
  "settings",
  "studyroom",
  "users",
];

const ORG_COLLECTIONS = [
  "companies",
  "people",
  "accounts",
  "employmentContracts",
  "categories",
  "templates",
  "plannedInstances",
];

type DumpShape = Record<string, Record<string, any>>;

function chunk<T>(arr: T[], size = 400) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function makeBackupDomain(getOrgId: () => string) {
  async function exportOrg(): Promise<DumpShape> {
    const orgId = getOrgId();
    const dump: DumpShape = {};

    // 1. Export root collections
    for (const col of ROOT_COLLECTIONS) {
      const snap = await getDocs(collection(db, col));
      const map: Record<string, any> = {};
      for (const d of snap.docs) {
        map[d.id] = deepSerializeDates(d.data());
      }
      dump[`root/${col}`] = map;
    }

    // 2. Export org-specific collections
    for (const col of ORG_COLLECTIONS) {
      const snap = await getDocs(collection(db, "orgs", orgId, col));
      const map: Record<string, any> = {};
      for (const d of snap.docs) {
        map[d.id] = deepSerializeDates(d.data());
      }
      dump[`orgs/${orgId}/${col}`] = map;
    }
    return dump;
  }

  async function importOrg(
    data: DumpShape,
    opts?: {
      mode?: "merge" | "overwrite";
      reviveDates?: boolean;
    }
  ): Promise<{ written: number }> {
    const merge = (opts?.mode ?? "merge") === "merge";
    const revive = opts?.reviveDates ?? true;

    let written = 0;
    for (const [path, docs] of Object.entries(data)) {
      const entries = Object.entries(docs || {});
      if (!entries.length) continue;

      for (const group of chunk(entries, 400)) {
        const batch = writeBatch(db);
        for (const [id, raw] of group) {
          const payload = revive ? deepReviveDates(raw) : raw;
          const pathSegments = path.replace(/^root\//, '').split('/');
          const docRef = doc(db, ...pathSegments, id);
          batch.set(docRef, payload, { merge });
          written++;
        }
        await batch.commit();
      }
    }
    return { written };
  }

  return { export: exportOrg, import: importOrg };
}