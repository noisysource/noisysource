import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@shared/firebase';

type Account = { id: string; name?: string; type?: string };

type Props = {
  orgId: string;
  value: string;
  onChange: (id: string) => void;
  types?: string[]; // e.g. ['bank','cash'] or ['expense','income']
  placeholder?: string;
  className?: string;
};

export default function AccountSelect({
  orgId,
  value,
  onChange,
  types,
  placeholder = 'Select account',
  className = '',
}: Props) {
  const [rows, setRows] = useState<Account[]>([]);

  useEffect(() => {
    (async () => {
      const snap = await getDocs(collection(db, 'orgs', orgId, 'accounts'));
      let list = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Account[];
      if (types?.length) list = list.filter(a => a.type && types.includes(a.type));
      list.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
      setRows(list);
    })();
  }, [orgId, JSON.stringify(types)]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 ${className}`}
    >
      <option value="">{placeholder}</option>
      {rows.map((a) => (
        <option key={a.id} value={a.id}>
          {(a.name ?? a.id)} — {a.id}
        </option>
      ))}
    </select>
  );
}