import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@shared/firebase";

type GLType = "INCOME" | "EXPENSE" | "EQUITY";
type OwnerKind = "company" | "person";

export type CategoryOption = {
  id: string;            // Firestore doc id
  name: string;
  code?: string;
  type: GLType;
  ownerType: OwnerKind;
  ownerId: string;
};

export default function CategorySelect({
  value,
  onChange,
  placeholder = "Select category…",
  filterType,            // optional: "INCOME" | "EXPENSE" | "EQUITY"
  filterOwnerType,       // optional: "company" | "person"
  filterOwnerId,         // optional: specific owner id
  allowEmpty = false,
  className = "w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  filterType?: GLType;
  filterOwnerType?: OwnerKind;
  filterOwnerId?: string;
  allowEmpty?: boolean;
  className?: string;
}) {
  const [cats, setCats] = useState<CategoryOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const snap = await getDocs(collection(db, "orgs", "personal", "accounts"));
      const rows: CategoryOption[] = snap.docs.map(d => {
        const x = d.data() as any;
        return {
          id: d.id,
          name: x.name ?? d.id,
          code: typeof x.code === "string" ? x.code : undefined,
          type: x.type as GLType,
          ownerType: x.ownerType as OwnerKind,
          ownerId: x.ownerId,
          // only categories have role = "category"
        };
      }).filter(r => (r as any) && (snap.docs.find(dd => dd.id === r.id)?.data() as any).role === "category");
      rows.sort((a,b) => (a.code ?? a.name).localeCompare(b.code ?? b.name));
      setCats(rows);
      setLoaded(true);
    })();
  }, []);

  const options = useMemo(() => {
    return cats.filter(c => {
      if (filterType && c.type !== filterType) return false;
      if (filterOwnerType && c.ownerType !== filterOwnerType) return false;
      if (filterOwnerId && c.ownerId !== filterOwnerId) return false;
      return true;
    });
  }, [cats, filterType, filterOwnerType, filterOwnerId]);

  const hasValueInList = value ? options.some(o => o.id === value) || cats.some(o => o.id === value) : false;

  return (
    <select
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      <option value="">{placeholder}</option>
      {/* If current value is not in filtered list (e.g., filters changed), show it to avoid data loss */}
      {value && loaded && !hasValueInList && (
        <option value={value}>{`(current) ${value}`}</option>
      )}
      {allowEmpty && <option value="">— none —</option>}
      {options.map(o => (
        <option key={o.id} value={o.id}>
          {(o.code ?? o.name)} — {o.name}
        </option>
      ))}
    </select>
  );
}