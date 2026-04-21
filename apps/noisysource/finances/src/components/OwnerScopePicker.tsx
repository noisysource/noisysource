// apps/finhub/src/components/OwnerScopePicker.tsx
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@shared/firebase";

export type OwnerScope = { ownerType: "" | "company" | "person"; ownerId: string };

type Company = { id: string; name: string };
type Person  = { id: string; name: string };

const ORG_ID = "personal";

export default function OwnerScopePicker({
  value, onChange, className = ""
}: {
  value: OwnerScope; onChange: (v: OwnerScope) => void; className?: string;
}) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    (async () => {
      const [cSnap, pSnap] = await Promise.all([
        getDocs(collection(db, "orgs", ORG_ID, "companies")),
        getDocs(collection(db, "orgs", ORG_ID, "people")),
      ]);
      setCompanies(cSnap.docs.map(d => ({ id:d.id, name:(d.data() as any).name ?? d.id }))
        .sort((a,b)=>a.name.localeCompare(b.name)));
      setPeople(pSnap.docs.map(d => ({ id:d.id, name:(d.data() as any).name ?? d.id }))
        .sort((a,b)=>a.name.localeCompare(b.name)));
    })();
  }, []);

  const label = useMemo(() => {
    if (!value.ownerType) return "All owners";
    const list = value.ownerType === "company" ? companies : people;
    const name = list.find(x => x.id === value.ownerId)?.name ?? value.ownerId;
    return `${value.ownerType === "company" ? "Company" : "Person"} · ${name}`;
  }, [value, companies, people]);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="text-xs text-zinc-400">Scope</div>
      <select
        className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
        value={`${value.ownerType}:${value.ownerId}`}
        onChange={e => {
          const [type, id] = e.target.value.split(":");
          onChange({ ownerType: (type as any) || "", ownerId: id || "" });
        }}
      >
        <option value=":">All owners</option>
        <optgroup label="Companies">
          {companies.map(c => (
            <option key={c.id} value={`company:${c.id}`}>{c.name}</option>
          ))}
        </optgroup>
        <optgroup label="People">
          {people.map(p => (
            <option key={p.id} value={`person:${p.id}`}>{p.name}</option>
          ))}
        </optgroup>
      </select>
      <span className="text-xs text-zinc-500">{label}</span>
    </div>
  );
}