import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import type { Account } from "@shared/models/Account";

type Company = { id: string; name: string; shortCode?: string };
type Person  = { id: string; name: string };

export function useAccountsData() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [as, cs, ps] = await Promise.all([
        api.accounts.list(),
        api.companies.list(),
        api.people.list(),
      ]);
      setAccounts(as as Account[]);
      setCompanies((cs as any[]).map(c => ({ id: c.id, name: c.name, shortCode: c.shortCode })).sort((a,b)=>a.name.localeCompare(b.name)));
      setPeople((ps as any[]).map(p => ({ id: p.id, name: p.name })).sort((a,b)=>a.name.localeCompare(b.name)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const remove = async (id: string) => {
    await api.accounts.delete(id);
    await reload();
  };

  return { accounts, companies, people, loading, reload, remove };
}